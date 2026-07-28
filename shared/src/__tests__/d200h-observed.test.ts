// Capability-aware detail cells for observed (hook-only) sessions on the
// D200H shared layout. Invariants: no button may map to an undeliverable
// command (the old silent-drop trap), and gate Allow/Deny appears ONLY when a
// held PreToolUse requestId is present.

import { describe, it, expect } from 'vitest';
import { buildSessionDeck, type DeckAction } from '../d200h-layout.js';

const POSITIONS = ['0_0', '1_0', '2_0', '3_0', '4_0', '0_1', '1_1', '2_1'];

function observedStateEvt(session: Record<string, unknown>) {
  return {
    type: 'state_update',
    state: 'idle',
    allSessions: [{
      id: 'observed:claude:uuid-1',
      port: 0,
      alive: true,
      projectName: 'proj',
      agentType: 'claude-code',
      controlMode: 'observed',
      ...session,
    }],
  };
}

function detailCells(stateEvt: unknown) {
  const view = { mode: 'detail' as const, openSessionId: 'observed:claude:uuid-1' };
  return buildSessionDeck(stateEvt, view, POSITIONS);
}

type CommandAction = Extract<NonNullable<DeckAction>, { kind: 'command' }>;

function commandsOf(cells: Map<string, { svg: string; action: DeckAction }>) {
  return [...cells.values()]
    .map((c) => c.action)
    .filter((a): a is CommandAction => a != null && a.kind === 'command')
    .map((a) => a.command);
}

describe('D200H observed session detail', () => {
  it('idle: REVIEW (independent eval) is the only actionable cell — no fake prompts, inert STOP', () => {
    const cells = detailCells(observedStateEvt({ state: 'idle' }));
    const cmds = commandsOf(cells);
    expect(cmds.map((c) => c.type)).toEqual(['review_run']);
    expect(cmds[0].sessionId).toBe('observed:claude:uuid-1');
    const svgs = [...cells.values()].map((c) => c.svg).join('');
    expect(svgs).toContain('OBSERVED');
    expect(svgs).not.toContain('GO ON');
  });

  it('processing: soft STOP is the only action; no queued task or REVIEW mid-turn', () => {
    const cells = detailCells(observedStateEvt({ state: 'processing' }));
    const cmds = commandsOf(cells);
    const stop = cmds.find((c) => c.type === 'session_command'
      && (c.command as { type?: string })?.type === 'interrupt');
    expect(stop).toBeTruthy();
    expect(stop?.sessionId).toBe('observed:claude:uuid-1');
    const prompts = cmds.filter((c) => c.type === 'session_command'
      && (c.command as { type?: string })?.type === 'send_prompt');
    expect(prompts).toHaveLength(0);
    const svgs = [...cells.values()].map((c) => c.svg).join('');
    expect(svgs).not.toContain('COMMIT');
    // The turn is still in flight — a review now would judge incomplete work.
    expect(cmds.filter((c) => c.type === 'review_run')).toHaveLength(0);
  });

  it('processing: last review verdict stays visible as an inert badge', () => {
    const cells = detailCells(observedStateEvt({
      state: 'processing', reviewRisk: 'medium', reviewFindings: 3,
    }));
    const cmds = commandsOf(cells);
    expect(cmds.filter((c) => c.type === 'review_run')).toHaveLength(0);
    const svgs = [...cells.values()].map((c) => c.svg).join('');
    expect(svgs).toContain('risk medium · 3');
  });

  it('processing + stopRequested: STOP replaced by STOPPING tile, no queue presets', () => {
    const cells = detailCells(observedStateEvt({ state: 'processing', stopRequested: true }));
    const cmds = commandsOf(cells);
    expect(cmds.find((c) => c.type === 'session_command')).toBeUndefined();
    const svgs = [...cells.values()].map((c) => c.svg).join('');
    expect(svgs).toContain('STOPPING');
  });

  it('awaiting + requestId: exactly ALLOW/DENY permission_decision cells', () => {
    const cells = detailCells(observedStateEvt({
      state: 'awaiting_permission', question: 'Allow Bash: git push', requestId: 'req-9',
    }));
    const cmds = commandsOf(cells).filter((c) => c.type === 'permission_decision');
    expect(cmds).toHaveLength(2);
    expect(cmds.map((c) => c.decision)).toEqual(['allow', 'deny']);
    expect(cmds.every((c) => c.requestId === 'req-9')).toBe(true);
  });

  it('awaiting WITHOUT requestId: answer-in-terminal only, never fabricated Allow/Deny', () => {
    const cells = detailCells(observedStateEvt({
      state: 'awaiting_permission', question: 'Claude needs your permission to use Bash',
    }));
    expect(commandsOf(cells)).toHaveLength(0);
    const svgs = [...cells.values()].map((c) => c.svg).join('');
    expect(svgs).toContain('PERMIT?');
    expect(svgs).not.toContain('ALLOW');
  });

  it('AskUserQuestion options are visible but inert without a live-answer host', () => {
    const cells = detailCells(observedStateEvt({
      state: 'awaiting_option',
      question: 'Which cleanup window?',
      options: [
        { index: 0, label: '7 days' },
        { index: 1, label: '14 days' },
      ],
    }));
    expect(commandsOf(cells)).toHaveLength(0);
    const svgs = [...cells.values()].map((c) => c.svg).join('');
    expect(svgs).toContain('7 days');
    expect(svgs).toContain('14 days');
  });

  it('liveAnswerable turns the same options into select_option presses', () => {
    const cells = detailCells(observedStateEvt({
      state: 'awaiting_option',
      question: 'Which cleanup window?',
      liveAnswerable: true,
      options: [
        { index: 0, label: '7 days' },
        { index: 1, label: '14 days' },
      ],
    }));
    const selects = commandsOf(cells).filter((c) => c.type === 'select_option');
    expect(selects).toHaveLength(2);
    // Observed answering injects on select_option only — a shortcut-`respond`
    // has no meaning there, so it must not be emitted even though the prompt
    // is not a navigable PTY.
    expect(commandsOf(cells).some((c) => c.type === 'respond')).toBe(false);
    expect(selects.map((c) => c.index)).toEqual([0, 1]);
    expect(selects.every((c) => c.sessionId === 'observed:claude:uuid-1')).toBe(true);
  });

  it('codex observed idle: REVIEW only — steering stays inert (notify-only hooks)', () => {
    const evt = {
      type: 'state_update', state: 'idle',
      allSessions: [{
        id: 'observed:codex:t1', port: 0, alive: true, projectName: 'proj',
        agentType: 'codex-cli', controlMode: 'observed', state: 'idle',
      }],
    };
    const cells = buildSessionDeck(evt, { mode: 'detail', openSessionId: 'observed:codex:t1' }, POSITIONS);
    const cmds = commandsOf(cells);
    // The independent eval needs no agent control, so it stays live even for
    // control-less codex; every steering command stays absent.
    expect(cmds.map((c) => c.type)).toEqual(['review_run']);
  });

  it('codex observed processing: nothing actionable — REVIEW waits for turn end', () => {
    const evt = {
      type: 'state_update', state: 'idle',
      allSessions: [{
        id: 'observed:codex:t1', port: 0, alive: true, projectName: 'proj',
        agentType: 'codex-cli', controlMode: 'observed', state: 'processing',
      }],
    };
    const cells = buildSessionDeck(evt, { mode: 'detail', openSessionId: 'observed:codex:t1' }, POSITIONS);
    expect(commandsOf(cells)).toHaveLength(0);
  });

  it('opencode observed idle: inject-now presets via session_command (plugin queue)', () => {
    const evt = {
      type: 'state_update', state: 'idle',
      allSessions: [{
        id: 'opencode:ses_1', port: 0, alive: true, projectName: 'proj',
        agentType: 'opencode', controlMode: 'observed', state: 'idle',
      }],
    };
    const cells = buildSessionDeck(evt, { mode: 'detail', openSessionId: 'opencode:ses_1' }, POSITIONS);
    const cmds = commandsOf(cells);
    const prompts = cmds.filter((c) => c.type === 'session_command'
      && (c.command as { type?: string })?.type === 'send_prompt');
    // GO ON + COMMIT inject immediately; REVIEW rides the independent eval.
    expect(prompts.map((p) => (p.command as { text?: string }).text))
      .toEqual(['continue', 'commit the changes']);
    expect(prompts.every((p) => p.sessionId === 'opencode:ses_1')).toBe(true);
    expect(cmds.filter((c) => c.type === 'review_run')).toHaveLength(1);
  });

  it('opencode observed permission gate: ALLOW/DENY carry the ocperm requestId', () => {
    const evt = {
      type: 'state_update', state: 'idle',
      allSessions: [{
        id: 'opencode:ses_1', port: 0, alive: true, projectName: 'proj',
        agentType: 'opencode', controlMode: 'observed',
        state: 'awaiting_permission', question: 'Run git push?', requestId: 'ocperm:ses_1:perm_9',
      }],
    };
    const cells = buildSessionDeck(evt, { mode: 'detail', openSessionId: 'opencode:ses_1' }, POSITIONS);
    const cmds = commandsOf(cells).filter((c) => c.type === 'permission_decision');
    expect(cmds.map((c) => c.decision)).toEqual(['allow', 'deny']);
    expect(cmds.every((c) => c.requestId === 'ocperm:ses_1:perm_9')).toBe(true);
  });

  it('managed sessions keep the original idle quick-actions (regression)', () => {
    const evt = {
      type: 'state_update', state: 'idle',
      allSessions: [{
        id: 'managed-1', port: 9121, alive: true, projectName: 'proj',
        agentType: 'claude-code', controlMode: 'managed', state: 'idle',
      }],
    };
    const cells = buildSessionDeck(evt, { mode: 'detail', openSessionId: 'managed-1' }, POSITIONS);
    const cmds = commandsOf(cells);
    const prompts = cmds.filter((c) => c.type === 'send_prompt').map((c) => c.text);
    expect(prompts).toContain('/clear');
    expect(prompts).toContain('continue');
    // REVIEW switched from a PTY prompt to the independent eval.
    expect(prompts).not.toContain('review the changes');
    expect(cmds.filter((c) => c.type === 'review_run')).toHaveLength(1);
    expect(cmds.find((c) => c.type === 'interrupt')).toBeTruthy();
  });
});
