import { describe, it, expect } from 'vitest';
import { buildSessionDeck } from '@agentdeck/shared';

// Locks the detail-view awaiting behaviour of the shared session deck (D200H /
// Ulanzi). Regression guard for the bug where a focused permission prompt's REAL
// options were discarded in favour of a hardcoded Yes/No/Always that couldn't
// drive a navigable Claude Code prompt.

const POS = ['0_0', '1_0', '2_0', '3_0', '4_0', '0_1', '1_1', '2_1', '3_1', '4_1', '0_2', '1_2', '2_2', '3_2', '4_2'];

function commandsOf(map: Map<string, { action: any }>): any[] {
  return [...map.values()]
    .map((c) => c.action)
    .filter((a) => a && a.kind === 'command')
    .map((a) => a.command);
}

const sess = (over: Record<string, unknown> = {}) => ({
  id: 's1', alive: true, port: 9121, projectName: 'p', agentType: 'claude-code',
  state: 'awaiting_permission', ...over,
});

describe('buildSessionDeck detail-view awaiting', () => {
  it('renders REAL options (navigable → select_option), not hardcoded Yes/No/Always', () => {
    const deck = buildSessionDeck({
      state: 'awaiting_permission',
      focusedSessionId: 's1',
      navigable: true,
      promptType: 'yes_no_always',
      options: [
        { index: 0, label: 'Yes' },
        { index: 1, label: "Yes, and don't ask again" },
        { index: 2, label: 'No, tell Claude what to do differently' },
      ],
      allSessions: [sess()],
    }, { mode: 'detail', openSessionId: 's1' }, POS);
    const cmds = commandsOf(deck);
    expect(cmds).toContainEqual({ type: 'select_option', index: 0, sessionId: 's1' });
    expect(cmds).toContainEqual({ type: 'select_option', index: 1, sessionId: 's1' });
    expect(cmds).toContainEqual({ type: 'select_option', index: 2, sessionId: 's1' });
    // The old bug emitted respond:'y'/'n'/'a' — must be gone for navigable prompts.
    expect(cmds.find((c) => c.type === 'respond')).toBeUndefined();
  });

  it('non-navigable inline prompt → respond with the option shortcut', () => {
    const deck = buildSessionDeck({
      state: 'awaiting_permission',
      focusedSessionId: 's1',
      navigable: false,
      promptType: 'yes_no',
      options: [{ index: 0, label: 'Yes', shortcut: 'y' }, { index: 1, label: 'No', shortcut: 'n' }],
      allSessions: [sess()],
    }, { mode: 'detail', openSessionId: 's1' }, POS);
    const cmds = commandsOf(deck);
    expect(cmds).toContainEqual({ type: 'respond', value: 'y' });
    expect(cmds).toContainEqual({ type: 'respond', value: 'n' });
  });

  it('observed native held request uses exact permission decisions rather than invented option indices', () => {
    // Observed (hook-only) sessions carry no real permission options, so the deck
    // must NOT synthesize an Allow/Deny that may not match Claude's actual prompt.
    const deck = buildSessionDeck({
      state: 'awaiting_permission',
      allSessions: [sess({ requestId: 'req-9' })],
    }, { mode: 'detail', openSessionId: 's1' }, POS);
    const cmds = commandsOf(deck);
    expect(cmds.filter((c) => c.type === 'permission_decision').map(c => c.decision)).toEqual(['allow', 'deny']);
    expect(cmds.find((c) => c.type === 'select_option')).toBeUndefined();
    expect(cmds.find((c) => c.type === 'respond')).toBeUndefined();
  });

  it('awaiting but not remotely answerable (no options, no requestId): no fake action commands', () => {
    const deck = buildSessionDeck({
      state: 'awaiting_permission',
      allSessions: [sess()],
    }, { mode: 'detail', openSessionId: 's1' }, POS);
    const cmds = commandsOf(deck);
    expect(cmds.find((c) => c.type === 'respond')).toBeUndefined();
    expect(cmds.find((c) => c.type === 'permission_decision')).toBeUndefined();
    expect(cmds.find((c) => c.type === 'select_option')).toBeUndefined();
  });
});
