import { describe, it, expect } from 'vitest';
import { parseExecApprovalRequest } from '@agentdeck/shared';
import { injectOpenClawSession } from '../openclaw-session.js';
import type { EnrichedSession } from '../session-aggregator.js';

const claude: EnrichedSession = {
  id: 'claude-1', port: 9121, projectName: 'Backend', agentType: 'claude-code', alive: true, state: 'idle',
};
const existingOpenClaw: EnrichedSession = {
  id: 'openclaw-gateway', port: 18789, projectName: 'OpenClaw', agentType: 'openclaw', alive: true, state: 'idle',
};

describe('injectOpenClawSession', () => {
  it('does NOT inject when the Gateway is reachable but not authenticated (regression: phantom trace)', () => {
    // The exact stuck state: index.ts used to gate on gatewayAvailable and
    // injected a phantom session whenever port 18789 answered. Authentication
    // (gatewayConnected) is now the only gate.
    const out = injectOpenClawSession([claude], { gatewayConnected: false });
    expect(out).toHaveLength(1);
    expect(out.some(s => s.agentType === 'openclaw')).toBe(false);
  });

  it('injects a minimal session when authenticated (CLI bridge shape)', () => {
    const out = injectOpenClawSession([claude], { gatewayConnected: true });
    expect(out).toHaveLength(2);
    const oc = out.find(s => s.agentType === 'openclaw')!;
    expect(oc.id).toBe('openclaw-gateway');
    expect(oc.port).toBe(18789);
    expect(oc.projectName).toBe('OpenClaw');
    // CLI bridge omits the daemon-hub extras.
    expect(oc.state).toBeUndefined();
    expect(oc.controlMode).toBeUndefined();
  });

  it('carries daemon-hub extras (state/projectName/modelName/controlMode) when provided', () => {
    const out = injectOpenClawSession([claude], {
      gatewayConnected: true,
      state: 'processing',
      projectName: 'my-repo',
      modelName: 'opus-4',
      controlMode: 'managed',
    });
    const oc = out.find(s => s.agentType === 'openclaw')!;
    expect(oc.state).toBe('processing');
    expect(oc.projectName).toBe('my-repo');
    expect(oc.modelName).toBe('opus-4');
    expect(oc.controlMode).toBe('managed');
  });

  it('carries the pending approval so decks render real, pressable options', () => {
    // Without these fields every deck falls through to its
    // "PERMIT? / answer in terminal" tile — and the Gateway session has no
    // terminal, so that tile is a dead end rather than a hint.
    const approval = parseExecApprovalRequest({
      id: 'ap-1',
      request: { command: 'rm -rf build', allowedDecisions: ['allow-once', 'deny'] },
    }, 0)!;
    const out = injectOpenClawSession([claude], {
      gatewayConnected: true, state: 'awaiting_permission', controlMode: 'managed', approval,
    });
    const oc = out.find(s => s.agentType === 'openclaw')!;
    expect(oc.question).toBe('rm -rf build');
    expect(oc.options?.map(o => o.label)).toEqual(['Allow once', 'Deny']);
    expect(oc.promptType).toBe('yes_no_always');
    expect(oc.liveAnswerable).toBe(true);
    // `requestId` would make surfaces draw a binary Allow/Deny gate over the
    // real option list.
    expect(oc.requestId).toBeUndefined();
  });

  it('leaves the prompt fields off when nothing is pending', () => {
    const out = injectOpenClawSession([claude], {
      gatewayConnected: true, state: 'processing', controlMode: 'managed', approval: null,
    });
    const oc = out.find(s => s.agentType === 'openclaw')!;
    expect(oc.question).toBeUndefined();
    expect(oc.options).toBeUndefined();
    expect(oc.liveAnswerable).toBeUndefined();
  });

  it('is idempotent — does not duplicate an already-present openclaw session', () => {
    const out = injectOpenClawSession([claude, existingOpenClaw], { gatewayConnected: true });
    expect(out).toHaveLength(2);
    expect(out.filter(s => s.agentType === 'openclaw')).toHaveLength(1);
  });

  it('returns the original array reference when not injecting (no needless copy)', () => {
    const input = [claude];
    expect(injectOpenClawSession(input, { gatewayConnected: false })).toBe(input);
  });
});

// `question` alone is a bare shell command, and a bare shell command is not a
// decision. Everything that makes it one — the policy reason, the cwd, and
// WHICH OpenClaw session asked — was parsed and then dropped at this boundary,
// so the deck asked the user to approve a benign-looking `sed -n` with no
// statement of what was being asked or why (2026-08-23: 7 of 8 unanswered).
describe('injectOpenClawSession — the approval carries its context', () => {
  const prompt = parseExecApprovalRequest({
    id: 'x1',
    request: {
      command: "sed -n '20,35p' ~/a/config.py",
      cwd: '/Users/x/.openclaw/workspace',
      warningText: 'strict inline-eval mode requires reviewer or explicit approval for sed inline program.',
      sessionKey: 'agent:main:eval-full-unified-a03__r2',
    },
  }, 0)!;

  const row = () => injectOpenClawSession([], { gatewayConnected: true, approval: prompt })
    .find((s) => s.agentType === 'openclaw')!;

  it('puts the reason approval was demanded at the head of questionDetail', () => {
    expect(row().questionDetail!.split('\n')[0]).toContain('strict inline-eval');
  });

  it('names WHICH OpenClaw session asked', () => {
    // `agent:main:main` (the chat on screen), `agent:main:cron:<id>` and
    // `agent:main:eval-…__r2` are wildly different things to approve, and the
    // row's projectName is pinned to the literal "OpenClaw" for all of them —
    // which is why the macOS app's chat view showed no such conversation.
    expect(row().questionDetail).toContain('session: agent:main:eval-full-unified-a03__r2');
  });

  it('leaves the question itself untouched — detail is additive', () => {
    expect(row().question).toBe("sed -n '20,35p' ~/a/config.py");
  });

  it('emits no questionDetail when the Gateway sent nothing to say', () => {
    const bare = parseExecApprovalRequest({ id: 'x2', request: { command: 'ls' } }, 0)!;
    const out = injectOpenClawSession([], { gatewayConnected: true, approval: bare })
      .find((s) => s.agentType === 'openclaw')!;
    expect(out.questionDetail).toBeUndefined();
    expect(out.question).toBe('ls');
  });

  it('carries nothing when there is no approval at all', () => {
    const out = injectOpenClawSession([], { gatewayConnected: true })
      .find((s) => s.agentType === 'openclaw')!;
    expect(out.questionDetail).toBeUndefined();
    expect(out.question).toBeUndefined();
  });
});
