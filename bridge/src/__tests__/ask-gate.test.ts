import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setAskUserQuestionOverlay,
  advanceAskUserQuestionOverlay,
  getAskUserQuestionAnswers,
  getAwaitingOverlay,
  clearAskUserQuestionOverlay,
  _resetAwaitingOverlay,
} from '../awaiting-overlay.js';
import {
  beginAskGate, gateReleased, buildAskAnswerReason, _resetSteering,
} from '../observed-steering.js';
import {
  registerPending, resolvePendingWithReason, drainAllPending, _pendingCount,
} from '../permission-resolver.js';

/**
 * End-to-end contract for the AskUserQuestion ask-gate: the only channel a
 * daemon that cannot type into the user's terminal has for delivering a device
 * answer to the agent.
 *
 * These compose the real overlay/steering/resolver modules in the order
 * `daemon-server.ts` drives them. The wiring itself is re-stated here rather
 * than executed, so this suite proves the pieces fit — not that the daemon
 * calls them correctly; the decisions that guard the daemon's own wiring live
 * in `ask-gate.ts` and are covered by `ask-gate-decisions.test.ts`.
 * Claude's hook contract has no field for supplying a chosen option, so an
 * answered question resolves as `deny` whose reason states the answer; an
 * unanswered one releases with an EMPTY body so Claude's own picker appears in
 * the terminal exactly as if the daemon had never been involved.
 */

/** Minimal ServerResponse stub capturing what the hook script would echo. */
function fakeRes() {
  return {
    body: undefined as undefined | string,
    ended: false,
    writeHead() { return this; },
    end(body?: string) { this.body = body; this.ended = true; },
  };
}

const hookOutput = (body: string | undefined) => {
  if (!body) return undefined;
  return JSON.parse(body).hookSpecificOutput as {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

const SID = 'uuid-ask-gate';
const TOOL_USE_ID = 'toolu-ask-1';

const twoQuestions = {
  questions: [
    { question: 'Pick a language', options: [{ label: 'TypeScript' }, { label: 'Swift' }] },
    { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'Not yet' }] },
  ],
};

/** The daemon's PreToolUse path: lift the prompt, then hold the response. */
function receiveAskUserQuestion(toolInput: Record<string, unknown>, clientCount = 1) {
  expect(setAskUserQuestionOverlay(SID, TOOL_USE_ID, toolInput)).toBe(true);
  const gate = beginAskGate({ sessionId: SID, clientCount, enabled: true });
  const res = fakeRes();
  if (gate.hold && gate.requestId) {
    registerPending(gate.requestId, res as never, {
      sessionId: SID, tool: 'AskUserQuestion', timeoutMs: 45_000,
      onResolved: (decision) => {
        gateReleased(SID, gate.requestId!, { undecided: false, tool: 'AskUserQuestion' });
        // A denied call never runs, so no PostToolUse arrives to clear the
        // prompt — the daemon must clear it itself or the session stays stuck.
        if (decision === 'deny') clearAskUserQuestionOverlay(SID, TOOL_USE_ID);
      },
    });
  }
  return { gate, res };
}

/** The daemon's device-command path for one `select_option` press. */
function pressOption(requestId: string, index: number): 'advanced' | 'answered' {
  const label = getAwaitingOverlay(SID)?.options?.[index]?.label;
  expect(label).toBeTruthy();
  const step = advanceAskUserQuestionOverlay(SID, label);
  if (step === 'complete') {
    resolvePendingWithReason(requestId, 'deny', buildAskAnswerReason(getAskUserQuestionAnswers(SID)));
    return 'answered';
  }
  return 'advanced';
}

describe('AskUserQuestion ask-gate (device answer → agent)', () => {
  beforeEach(() => {
    _resetAwaitingOverlay();
    _resetSteering();
    drainAllPending();
    vi.useFakeTimers();
  });
  afterEach(() => {
    drainAllPending();
    vi.useRealTimers();
  });

  it('delivers a single-question answer as the hook decision reason', () => {
    const { gate, res } = receiveAskUserQuestion({
      questions: [{ question: 'Pick a language', options: [{ label: 'TypeScript' }, { label: 'Swift' }] }],
    });
    expect(gate.hold).toBe(true);
    // Held: the hook has not answered yet, so Claude is still waiting.
    expect(res.ended).toBe(false);

    expect(pressOption(gate.requestId!, 1)).toBe('answered');

    const out = hookOutput(res.body);
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('Q: Pick a language\nA: Swift');
    expect(out?.permissionDecisionReason).toContain('do not call AskUserQuestion again');
    // The prompt is gone from every surface — no PostToolUse is coming.
    expect(getAwaitingOverlay(SID)).toBeUndefined();
  });

  it('walks a multi-question call one question at a time, then answers with all pairs', () => {
    const { gate, res } = receiveAskUserQuestion(twoQuestions);

    // Question 1 on screen.
    expect(getAwaitingOverlay(SID)?.question).toBe('Pick a language');
    expect(pressOption(gate.requestId!, 1)).toBe('advanced');

    // Question 2 replaces it — same session, same awaiting state, new indices.
    const second = getAwaitingOverlay(SID)!;
    expect(second.question).toBe('Ship it?');
    expect(second.options?.map((o) => o.label)).toEqual(['Yes', 'Not yet']);
    expect(second.activeGroup).toBe(1);
    // Still held: the agent must not hear a partial answer.
    expect(res.ended).toBe(false);

    expect(pressOption(gate.requestId!, 0)).toBe('answered');

    const reason = hookOutput(res.body)?.permissionDecisionReason ?? '';
    expect(reason).toContain('Q: Pick a language\nA: Swift');
    expect(reason).toContain('Q: Ship it?\nA: Yes');
  });

  it('releases with an EMPTY body when nobody answers, so the terminal picker shows', () => {
    const { gate, res } = receiveAskUserQuestion(twoQuestions);
    vi.advanceTimersByTime(45_000);

    // Empty body = "no hook decision": Claude runs its normal flow and renders
    // the question itself. Nothing auto-proceeds on the user's behalf.
    expect(res.ended).toBe(true);
    expect(res.body).toBe('');
    expect(_pendingCount()).toBe(0);
    // The prompt survives as display-only — the user is looking at it now.
    expect(getAwaitingOverlay(SID)?.question).toBe('Pick a language');
    // And the session is free to hold again for the next question.
    expect(beginAskGate({ sessionId: SID, clientCount: 1, enabled: true }).hold).toBe(true);
    void gate;
  });

  it('does not hold when nothing could answer, leaving zero added latency', () => {
    const { gate, res } = receiveAskUserQuestion(twoQuestions, 0);
    expect(gate.hold).toBe(false);
    expect(res.ended).toBe(false); // caller falls through to its own pass-through
    // The prompt still reaches devices — it is simply display-only.
    expect(getAwaitingOverlay(SID)?.question).toBe('Pick a language');
  });

  it('keeps a partially answered prompt out of the agent when the hold expires', () => {
    const { gate, res } = receiveAskUserQuestion(twoQuestions);
    expect(pressOption(gate.requestId!, 0)).toBe('advanced');
    vi.advanceTimersByTime(45_000);

    // One of two questions answered is not an answer — the agent hears nothing
    // and asks the user directly.
    expect(res.body).toBe('');
  });

  it('clears the prompt on PostToolUse when the tool did run (injection path)', () => {
    // No gate here: this is the CLI-daemon rung where the answer was typed into
    // the terminal, so the tool completes normally and Claude reports it.
    setAskUserQuestionOverlay(SID, TOOL_USE_ID, twoQuestions);
    expect(advanceAskUserQuestionOverlay(SID, 'Swift')).toBe('advanced');
    expect(getAwaitingOverlay(SID)?.question).toBe('Ship it?');
    expect(clearAskUserQuestionOverlay(SID, TOOL_USE_ID)).toBe(true);
    expect(getAwaitingOverlay(SID)).toBeUndefined();
  });
});
