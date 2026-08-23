// The OpenClaw Gateway row on the D200H detail view.
//
// Two traps this pins, both of which left a real exec approval unanswerable
// from any deck (2026-08-17):
//
//  1. The daemon relays its GLOBAL state_update stamped with the focused
//     session's id. That machine is fed by every observed hook session, so an
//     unrelated Claude turn going idle overwrites it — and the detail view,
//     trusting `focusedSessionId`, rendered STOP/idle over a session whose own
//     row said "awaiting, here are the options".
//  2. The live-answer path was gated on `controlMode === 'observed'`. The
//     Gateway row is `managed` and has no terminal, so its options rendered as
//     an inert mirror of a prompt with nowhere to answer it.
import { describe, it, expect } from 'vitest';
import { buildSessionDeck, type DeckAction } from '../d200h-layout.js';

const POSITIONS = ['0_0', '1_0', '2_0', '3_0', '4_0', '0_1', '1_1', '2_1'];
const SID = 'openclaw-gateway';

const APPROVAL_OPTIONS = [
  { index: 0, label: 'Allow once', shortcut: 'y' },
  { index: 1, label: 'Always allow', shortcut: 'a' },
  { index: 2, label: 'Deny', shortcut: 'n' },
];

/** A gateway row mid-approval, relayed inside a global event that says idle. */
function stateEvt(session: Record<string, unknown>, global: Record<string, unknown> = {}) {
  return {
    type: 'state_update',
    // The contaminated global machine: another agent's turn ended.
    state: 'idle',
    focusedSessionId: SID,
    ...global,
    allSessions: [{
      id: SID, port: 18789, alive: true,
      projectName: 'OpenClaw', agentType: 'openclaw', controlMode: 'managed',
      ...session,
    }],
  };
}

function detailCells(evt: unknown) {
  return buildSessionDeck(evt, { mode: 'detail' as const, openSessionId: SID }, POSITIONS);
}

type CommandAction = Extract<NonNullable<DeckAction>, { kind: 'command' }>;
function commandsOf(cells: Map<string, { svg: string; action: DeckAction }>) {
  return [...cells.values()]
    .map((c) => c.action)
    .filter((a): a is CommandAction => a != null && a.kind === 'command')
    .map((a) => a.command);
}

describe('D200H — OpenClaw exec approval', () => {
  const pending = stateEvt({
    state: 'awaiting_permission',
    question: 'rg --files-with-matches TODO src',
    options: APPROVAL_OPTIONS,
    promptType: 'yes_no_always',
    liveAnswerable: true,
  });

  it('renders the real command and its decisions, not the global idle state', () => {
    const svgs = [...detailCells(pending).values()].map((c) => c.svg).join('');
    expect(svgs).toContain('Allow once');
    expect(svgs).toContain('Deny');
    // The dead-end tile: it means "go type in a terminal", and this session
    // does not have one.
    expect(svgs).not.toContain('answer in terminal');
  });

  it('every decision is a pressable select_option carrying its own index', () => {
    const cmds = commandsOf(detailCells(pending))
      .filter((c) => c.type === 'select_option');
    expect(cmds).toHaveLength(3);
    expect(cmds.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(cmds.every((c) => c.sessionId === SID)).toBe(true);
    // The echo guard: a press aimed at an approval the Gateway already moved
    // past must be droppable rather than applied to the new one.
    expect(cmds.every((c) => c.question === 'rg --files-with-matches TODO src')).toBe(true);
  });

  it('keeps the relayed event authoritative when IT is the one with the prompt', () => {
    // Only ever an upgrade — a focused session whose live event carries the
    // prompt (a PTY with a navigable cursor) must not be downgraded to the row.
    const cells = detailCells(stateEvt(
      { state: 'awaiting_permission', options: [], question: undefined },
      {
        state: 'awaiting_option',
        question: 'Which cleanup window?',
        options: [{ index: 0, label: '7 days' }, { index: 1, label: '14 days' }],
      },
    ));
    const svgs = [...cells.values()].map((c) => c.svg).join('');
    expect(svgs).toContain('7 days');
  });

  it('an idle gateway row still reads as idle', () => {
    const svgs = [...detailCells(stateEvt({ state: 'idle' })).values()].map((c) => c.svg).join('');
    expect(svgs).not.toContain('Allow once');
  });
});

// The detail view is the D200H's whole answer surface for a Gateway approval,
// and until 2026-08-23 it rendered three live decision keys over ZERO pixels of
// subject: `question` was resolved only to be echoed back on a press, and the
// hero cell drew project + state. Measured that day: 8 real approvals, 7 closed
// unanswered after 75–402s, because nothing on the deck said what was being
// approved or why it needed approving.
describe('D200H — the approval says what it is', () => {
  const CMD = "sed -n '20,35p' ~/github/OpenClaw/yt_dubber/config.py";
  const WHY = 'Warning: strict inline-eval mode requires reviewer or explicit approval for sed inline program.';

  const pending = stateEvt({
    state: 'awaiting_permission',
    question: CMD,
    questionDetail: `${WHY}\ncwd: /Users/x/.openclaw/workspace\nsession: agent:main:eval-a03__r2`,
    options: APPROVAL_OPTIONS,
    promptType: 'yes_no_always',
    liveAnswerable: true,
  });

  it('renders the command on the hero cell, not only in the press echo', () => {
    const svgs = [...detailCells(pending).values()].map((c) => c.svg).join('');
    expect(svgs).toContain('config.py');
  });

  it('renders WHY approval was demanded — the head of questionDetail', () => {
    const svgs = [...detailCells(pending).values()].map((c) => c.svg).join('');
    // Most-decisive-first ordering means the policy warning is the head, not
    // the cwd (which is identical for every request and distinguishes nothing).
    expect(svgs).toContain('strict inline-eval');
    expect(svgs).not.toContain('cwd:');
  });

  it('still echoes the question on a press (the answer path is unchanged)', () => {
    const cmds = commandsOf(detailCells(pending));
    const selects = cmds.filter((c) => c.type === 'select_option');
    expect(selects.length).toBe(3);
    expect(selects.every((c) => (c as { question?: string }).question === CMD)).toBe(true);
  });

  it('an idle row draws no prompt text — this is not a permanent header', () => {
    const idle = stateEvt({ state: 'idle', question: CMD, questionDetail: WHY });
    const svgs = [...detailCells(idle).values()].map((c) => c.svg).join('');
    expect(svgs).not.toContain('config.py');
    expect(svgs).not.toContain('strict inline-eval');
  });
});
