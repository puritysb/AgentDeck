// Hook-derived OpenCode rows: the Node daemon's parity with the Swift daemon's
// `opencode:<id>` rows. Before this module the Node daemon classified
// `opencode_*` hooks for the timeline and dropped them for session state, so
// an OpenCode session blocked on a permission read `idle` while Swift showed
// PERM with an answerable requestId.
import { describe, expect, it } from 'vitest';
import { HookOpenCodeSessions, openCodePermissionRequestId } from '../hook-opencode-sessions.js';
import type { ObservedSession } from '../passive-observer.js';

const SID = 'ses_7f3c2a1b';
const CWD = '/Users/dev/github/epoch-of-tech';

function pidRow(pid: number, cwd?: string): ObservedSession {
  return {
    id: `observed:opencode:${pid}`,
    port: 0,
    pid,
    projectName: 'epoch-of-tech',
    agentType: 'opencode',
    alive: true,
    state: 'idle',
    controlMode: 'observed',
    cwd,
  };
}

describe('HookOpenCodeSessions', () => {
  it('surfaces a session from its hooks with the turn state the process scan cannot see', () => {
    const hooks = new HookOpenCodeSessions();
    hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('opencode_user_prompt_submit', { sessionId: SID, cwd: CWD }, 1_100);
    hooks.note('opencode_tool_start', { sessionId: SID, cwd: CWD, toolName: 'bash' }, 1_200);

    const rows = hooks.applyTo([], 1_300);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`observed:opencode:${SID}`);
    expect(rows[0].state).toBe('processing');
    expect(rows[0].currentTask).toBe('bash');
    expect(rows[0].agentType).toBe('opencode');
  });

  it('PERM: permission.asked is a genuine wait with an answerable requestId, cleared by the reply', () => {
    const hooks = new HookOpenCodeSessions();
    hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('opencode_permission_asked', {
      sessionId: SID, cwd: CWD, permissionId: 'perm_1', title: 'Run  bash: rm -rf build',
    }, 1_100);

    let [row] = hooks.applyTo([], 1_200);
    expect(row.state).toBe('awaiting_permission');
    expect(row.question).toBe('Run bash: rm -rf build');
    expect(row.requestId).toBe(openCodePermissionRequestId(SID, 'perm_1'));
    expect(row.requestId).toBe(`ocperm:${SID}:perm_1`);

    hooks.note('opencode_permission_replied', { sessionId: SID, permissionId: 'perm_1' }, 1_300);
    [row] = hooks.applyTo([], 1_400);
    expect(row.state).toBe('processing');
    expect(row.question).toBeUndefined();
    expect(row.requestId).toBeUndefined();
  });

  it('a permission without an id is not a wait anyone can answer (no PERM)', () => {
    const hooks = new HookOpenCodeSessions();
    hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('opencode_permission_asked', { sessionId: SID, cwd: CWD, title: 'x' }, 1_100);
    expect(hooks.applyTo([], 1_200)[0].state).toBe('idle');
  });

  it('any later lifecycle hook ends the wait (approval runs the tool, stop ends the turn)', () => {
    const hooks = new HookOpenCodeSessions();
    hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('opencode_permission_asked', { sessionId: SID, permissionId: 'p', title: 't' }, 1_100);
    hooks.note('opencode_tool_start', { sessionId: SID, toolName: 'bash' }, 1_200);
    expect(hooks.applyTo([], 1_300)[0].state).toBe('processing');
    hooks.note('opencode_permission_asked', { sessionId: SID, permissionId: 'p2', title: 't' }, 1_400);
    hooks.note('opencode_stop', { sessionId: SID }, 1_500);
    const [row] = hooks.applyTo([], 1_600);
    expect(row.state).toBe('idle');
    expect(row.requestId).toBeUndefined();
  });

  it('the PID row for the same working directory yields to the hook row (one TUI, one creature)', () => {
    const hooks = new HookOpenCodeSessions();
    hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    const rows = hooks.applyTo([pidRow(4242, CWD), pidRow(4343, '/elsewhere')], 1_100);
    expect(rows.map((r) => r.id).sort()).toEqual([
      'observed:opencode:4343',
      `observed:opencode:${SID}`,
    ].sort());
  });

  it('a PID row with no cwd is kept (nothing proves it is the same session)', () => {
    const hooks = new HookOpenCodeSessions();
    hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    expect(hooks.applyTo([pidRow(4242)], 1_100)).toHaveLength(2);
  });

  it('a hook on an unknown session is ignored unless it opens one', () => {
    const hooks = new HookOpenCodeSessions();
    expect(hooks.note('opencode_tool_end', { sessionId: SID }, 1_000)).toBe(false);
    expect(hooks.applyTo([], 1_100)).toHaveLength(0);
  });

  it('session_end removes the row; silence reaps it after the TTL', () => {
    const hooks = new HookOpenCodeSessions();
    hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('opencode_session_end', { sessionId: SID }, 1_100);
    expect(hooks.applyTo([], 1_200)).toHaveLength(0);

    hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD }, 2_000);
    expect(hooks.applyTo([], 2_000 + 31 * 60_000)).toHaveLength(0);
  });
});
