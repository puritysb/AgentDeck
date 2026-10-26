import { describe, expect, it, vi } from 'vitest';
import { parseCodexRollout, type LocatedCodexRolloutSummary } from '../passive-observer.js';
import { HookCodexSessions, buildCodexPermissionQuestion } from '../hook-codex-sessions.js';
import type { ObservedSession } from '../passive-observer.js';

const SID = '019fc7c8-23b0-7aa1-bd65-8758d55a56e8';
const CWD = '/Users/dev/github/BabelForge';

function observedCodex(id = `observed:codex:${SID}`): ObservedSession {
  return {
    id,
    port: 0,
    pid: 4321,
    projectName: 'BabelForge',
    agentType: 'codex-cli',
    alive: true,
    state: 'processing',
    controlMode: 'observed',
    modelName: 'gpt-5.6-sol high',
    currentTask: 'exec_command pnpm build',
  };
}

describe('HookCodexSessions', () => {
  it('registers idle without resetting a turn on duplicate SessionStart', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_session_start', { sessionId: SID }, 1000);
    expect(hooks.applyTo([], 1001)[0].state).toBe('idle');
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1002);
    hooks.note('codex_session_start', { sessionId: SID }, 1003);
    expect(hooks.applyTo([], 1004)[0].state).toBe('processing');
  });

  it('surfaces a Codex the process scan never found', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('codex_user_prompt_submit', { sessionId: SID, cwd: CWD }, 1_100);

    const rows = hooks.applyTo([], 1_200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `observed:codex:${SID}`,
      agentType: 'codex-cli',
      controlMode: 'observed',
      state: 'processing',
      projectName: 'BabelForge',
      cwd: CWD,
    });
  });

  it('enriches a hook-only Windows row from its id-keyed desktop rollout', () => {
    const hooks = new HookCodexSessions(() => ({
      path: `C:\\Users\\dev\\.codex\\sessions\\rollout-${SID}.jsonl`,
      mtimeMs: 1_150,
      summary: {
        sessionId: SID,
        cwd: 'C:\\dev\\BabelForge',
        startedAt: 900,
        modelName: 'gpt-5.6-sol high',
        state: 'processing',
        currentTask: 'exec_command pnpm test',
        goal: 'fix the Windows observer',
        contextPercent: 42,
        totalTokens: 12_345,
        isSubagent: false,
        originator: 'Codex Desktop',
      },
    }));
    hooks.note('codex_session_start', { sessionId: SID }, 1_000);
    const row = hooks.applyTo([], 1_200)[0];
    expect(row).toMatchObject({
      id: `observed:codex-app:${SID}`,
      agentType: 'codex-app',
      appName: 'ChatGPT',
      cwd: 'C:\\dev\\BabelForge',
      modelName: 'gpt-5.6-sol high',
      currentTask: 'exec_command pnpm test',
      goal: 'fix the Windows observer',
      contextPercent: 42,
      totalTokens: 12_345,
      lastActivityAt: 1_150,
    });
  });

  it('yields to the observer instead of doubling the row', () => {
    // The observer's row carries model/tokens/goal the hooks can't know; a
    // second row for the same conversation would render as two creatures.
    const hooks = new HookCodexSessions();
    hooks.note('codex_session_start', { sessionId: SID, cwd: CWD }, 1_000);

    const observed = observedCodex();
    const rows = hooks.applyTo([observed], 1_100);
    expect(rows).toEqual([observed]);
  });

  it('matches the observer row in either id form', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    expect(hooks.applyTo([observedCodex(`observed:codex-app:${SID}`)], 1_100)).toHaveLength(1);
  });

  it('tracks tool state through a turn', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_user_prompt_submit', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('codex_tool_start', { sessionId: SID, toolName: 'apply_patch' }, 1_100);
    expect(hooks.applyTo([], 1_150)[0]).toMatchObject({ state: 'processing', currentTask: 'apply_patch' });

    hooks.note('codex_tool_end', { sessionId: SID, toolName: 'apply_patch' }, 1_200);
    expect(hooks.applyTo([], 1_250)[0]).toMatchObject({ state: 'processing', currentTask: undefined });

    hooks.note('codex_stop', { sessionId: SID }, 1_300);
    expect(hooks.applyTo([], 1_350)[0]).toMatchObject({ state: 'idle' });
  });

  it('reaps a finished session, and one that died without a stop hook', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_user_prompt_submit', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('codex_stop', { sessionId: SID }, 2_000);
    expect(hooks.applyTo([], 2_000 + 59_000)).toHaveLength(1);
    expect(hooks.applyTo([], 2_000 + 61_000)).toHaveLength(0);

    // Killed mid-turn: no terminal hook ever arrives, so only the silence TTL
    // can retire it — otherwise the creature stays "processing" forever.
    const killed = new HookCodexSessions();
    killed.note('codex_user_prompt_submit', { sessionId: SID, cwd: CWD }, 1_000);
    expect(killed.applyTo([], 1_000 + 29 * 60_000)).toHaveLength(1);
    expect(killed.applyTo([], 1_000 + 31 * 60_000)).toHaveLength(0);
  });

  it('lets a follow-up prompt revive a finished session', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('codex_stop', { sessionId: SID }, 2_000);
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 3_000);
    expect(hooks.applyTo([], 3_100)[0]).toMatchObject({ state: 'processing' });
  });

  it('opens a row from a mid-turn hook when the session start predates the daemon', () => {
    // Daemon restarted (or hooks installed) mid-session: the only events we
    // will ever see for this turn are tool hooks.
    const hooks = new HookCodexSessions();
    hooks.note('codex_tool_start', { sessionId: SID, cwd: CWD, toolName: 'exec_command' }, 1_000);
    expect(hooks.applyTo([], 1_100)).toHaveLength(1);
  });

  it('never lets a trailing tool callback resurrect a finished session', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('codex_stop', { sessionId: SID }, 2_000);
    // Row reaped 60 s later; a late companion-task callback arrives after that.
    expect(hooks.applyTo([], 2_000 + 61_000)).toHaveLength(0);
    hooks.note('codex_tool_end', { sessionId: SID, toolName: 'exec' }, 2_000 + 62_000);
    expect(hooks.applyTo([], 2_000 + 63_000)).toHaveLength(0);

    // …but the same session prompted again is a genuine re-engagement.
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 2_000 + 64_000);
    expect(hooks.applyTo([], 2_000 + 65_000)).toHaveLength(1);
  });

  it('keeps the first cwd instead of relabelling on a later hook', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('codex_tool_start', { sessionId: SID, cwd: '/tmp/build', toolName: 'exec' }, 1_100);
    expect(hooks.applyTo([], 1_200)[0]).toMatchObject({ cwd: CWD, projectName: 'BabelForge' });
  });

  it('ignores non-codex events and payloads with no session id', () => {
    const hooks = new HookCodexSessions();
    expect(hooks.note('SessionStart', { sessionId: SID, cwd: CWD })).toBe(false);
    expect(hooks.note('opencode_session_start', { sessionId: SID, cwd: CWD })).toBe(false);
    expect(hooks.note('codex_session_start', { cwd: CWD })).toBe(false);
    expect(hooks.snapshot()).toEqual([]);
  });
});

describe('Codex PermissionRequest / Interrupt hooks', () => {
  it('a permission request keeps the row alive as progress; an interrupt is terminal', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_session_start', { sessionId: SID, cwd: CWD }, 1_000);
    hooks.note('codex_user_prompt_submit', { sessionId: SID, cwd: CWD }, 1_100);
    hooks.note('codex_permission_request', { sessionId: SID, cwd: CWD, toolName: 'shell' }, 1_200);
    // The row stays `processing` here: PERM rides the awaiting overlay, keyed
    // by session id, which the daemon applies on top of this row.
    expect(hooks.applyTo([], 1_300)[0].state).toBe('processing');
    hooks.note('codex_interrupt', { sessionId: SID, cwd: CWD }, 1_400);
    expect(hooks.applyTo([], 1_500)[0].state).toBe('idle');
  });

  it('a permission request can open a row the scan never found (the hook proves the session)', () => {
    const hooks = new HookCodexSessions();
    hooks.note('codex_permission_request', { sessionId: SID, cwd: CWD, toolName: 'shell' }, 1_000);
    expect(hooks.applyTo([], 1_100)).toHaveLength(1);
  });

  it('buildCodexPermissionQuestion names the command, never the whole input', () => {
    expect(buildCodexPermissionQuestion({ tool_name: 'shell', tool_input: { command: ['rm', '-rf', 'build'] } }))
      .toBe('Approve shell: rm -rf build');
    expect(buildCodexPermissionQuestion({ tool_name: 'shell', tool_input: { command: 'npm  test\n' } }))
      .toBe('Approve shell: npm test');
    expect(buildCodexPermissionQuestion({ tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch …' } }))
      .toBe('Approve apply_patch?');
    expect(buildCodexPermissionQuestion({ tool_name: 'network', tool_input: { host: 'registry.npmjs.org' } }))
      .toBe('Approve network: registry.npmjs.org');
    expect(buildCodexPermissionQuestion({})).toBe('Approve tool?');
  });
});

it('a resumed idle session is not reaped by its previous terminal timestamp', () => {
  const hooks = new HookCodexSessions();
  hooks.note('codex_session_start', { sessionId: 'resume' }, 1000);
  hooks.note('codex_stop', { sessionId: 'resume' }, 2000);
  hooks.note('codex_session_start', { sessionId: 'resume' }, 3000);
  expect(hooks.applyTo([], 180000)).toMatchObject([{ state: 'idle' }]);
});


describe('hook-only Codex terminal reconciliation', () => {
  function rollout(events: Array<{ type: string; at?: number; turnId?: string }>, sessionId = SID): LocatedCodexRolloutSummary {
    const raw = [
      { type: 'session_meta', payload: { id: sessionId, originator: 'codex_exec' } },
      ...events.map(event => ({
        timestamp: event.at === undefined ? undefined : new Date(event.at).toISOString(),
        type: 'event_msg',
        payload: { type: event.type, turn_id: event.turnId, ...(event.type === 'task_complete' ? { last_agent_message: null } : {}) },
      })),
    ].map(row => JSON.stringify(row)).join('\n');
    return { path: `C:\\Users\\dev\\.codex\\sessions\\rollout-${sessionId}.jsonl`, mtimeMs: 2_000, summary: parseCodexRollout(raw) };
  }

  it.each(['task_complete', 'turn_aborted'])('settles explicit %s without a Stop hook on every platform', type => {
    // A provider 429 ends with task_complete/last_agent_message:null; text is
    // not completion evidence. No process observation or PID is required.
    const located = rollout([{ type: 'task_started', at: 1_000, turnId: 'turn-1' }, { type: 'error', at: 1_400 }, { type, at: 1_500, turnId: 'turn-1' }]);
    const hooks = new HookCodexSessions(() => located);
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_100);
    expect(hooks.applyTo([], 2_000)[0]).toMatchObject({ state: 'idle', currentTask: undefined });
    expect(hooks.snapshot()[0].terminalAt).toBe(1_500);
    hooks.note('codex_tool_end', { sessionId: SID }, 3_000);
    expect(hooks.applyTo([], 7_000)[0].state).toBe('idle');
    expect(hooks.snapshot()[0].terminalAt).toBe(1_500);
    expect(hooks.applyTo([], 61_501)).toEqual([]);
    hooks.note('codex_tool_start', { sessionId: SID }, 62_000);
    expect(hooks.applyTo([], 62_001)).toEqual([]);
  });

  it.each([
    ['head only', []],
    ['undated terminal', [{ type: 'task_complete' }]],
    ['old terminal', [{ type: 'task_complete', at: 900 }]],
    ['future terminal', [{ type: 'task_complete', at: 20_000 }]],
    ['new task_started', [{ type: 'task_complete', at: 1_500 }, { type: 'task_started', at: 1_600 }]],
    ['new user_message', [{ type: 'task_complete', at: 1_500 }, { type: 'user_message', at: 1_600 }]],
  ])('keeps work for %s', (_, events) => {
    const hooks = new HookCodexSessions(() => rollout(events));
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    expect(hooks.applyTo([], 2_000)[0].state).toBe('processing');
  });

  it('rejects mismatched identity, failed reads and malformed/default idle summaries', () => {
    for (const resolve of [
      () => rollout([{ type: 'task_complete', at: 1_500 }], 'other-id'),
      () => null,
      () => { throw new Error('unreadable'); },
      () => ({ path: '/missing', mtimeMs: 2_000, summary: parseCodexRollout('{broken') }),
    ]) {
      const hooks = new HookCodexSessions(resolve);
      hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
      expect(hooks.applyTo([], 2_000)[0]).toMatchObject({ state: 'processing', lastActivityAt: 1_000 });
    }
  });

  it('preserves observer priority without starting disk lookup', () => {
    const resolve = vi.fn(() => rollout([{ type: 'task_complete', at: 1_500 }]));
    const hooks = new HookCodexSessions(resolve);
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    const observed = observedCodex();
    expect(hooks.applyTo([observed], 2_000)).toEqual([observed]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts terminal evidence after a delayed tool-end but not after new tool-start work', () => {
    for (const event of ['codex_tool_end', 'codex_tool_start']) {
      const hooks = new HookCodexSessions(() => rollout([{ type: 'task_complete', at: 1_500 }]));
      hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
      hooks.note(event, { sessionId: SID }, 1_700);
      expect(hooks.applyTo([], 2_000)[0].state).toBe(event === 'codex_tool_end' ? 'idle' : 'processing');
    }
  });

  it('does not close a new prompt from a cached previous terminal', () => {
    const hooks = new HookCodexSessions(() => rollout([{ type: 'task_complete', at: 1_500 }]));
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    expect(hooks.applyTo([], 2_000)[0].state).toBe('idle');
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 3_000);
    expect(hooks.applyTo([], 3_001)[0].state).toBe('processing');
  });

  it('bounds positive/negative reads and discards an async answer superseded by a same-ms prompt', async () => {
    let finish!: (value: LocatedCodexRolloutSummary | null) => void;
    const resolve = vi.fn(() => new Promise<LocatedCodexRolloutSummary | null>(done => { finish = done; }));
    const hooks = new HookCodexSessions(resolve);
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    hooks.applyTo([], 2_000);
    hooks.applyTo([], 9_000);
    expect(resolve).toHaveBeenCalledTimes(1); // in-flight, even past cadence
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    finish(rollout([{ type: 'task_complete', at: 1_500 }]));
    await Promise.resolve();
    expect(hooks.applyTo([], 9_001)[0].state).toBe('processing');
    finish(null);
    await Promise.resolve();
    hooks.applyTo([], 9_002);
    expect(resolve).toHaveBeenCalledTimes(2);
    hooks.applyTo([], 14_002);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('caches successful reads across repeated broadcasts without extending the terminal TTL', () => {
    const resolve = vi.fn(() => rollout([{ type: 'task_complete', at: 1_500 }]));
    const hooks = new HookCodexSessions(resolve);
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    hooks.applyTo([], 2_000);
    hooks.applyTo([], 6_999);
    expect(resolve).toHaveBeenCalledTimes(1);
    hooks.applyTo([], 7_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(hooks.snapshot()[0].terminalAt).toBe(1_500);
  });

  it('keeps Windows metadata stable while refreshing but invalidates it for a new prompt', async () => {
    let finish!: (value: LocatedCodexRolloutSummary | null) => void;
    const hooks = new HookCodexSessions(() => new Promise(done => { finish = done; }));
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    hooks.applyTo([], 2_000);
    const located = rollout([{ type: 'task_started', at: 1_000 }]);
    located.summary.modelName = 'test-model';
    finish(located);
    await Promise.resolve();
    expect(hooks.applyTo([], 2_001)[0].modelName).toBe('test-model');
    expect(hooks.applyTo([], 7_001)[0].modelName).toBe('test-model');
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 7_002);
    expect(hooks.applyTo([], 7_003)[0].modelName).toBeUndefined();
  });

  it('discards async evidence after forget and accepts a fresh successful read', async () => {
    let finish!: (value: LocatedCodexRolloutSummary | null) => void;
    const hooks = new HookCodexSessions(() => new Promise(done => { finish = done; }));
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    hooks.applyTo([], 2_000);
    const stale = finish;
    hooks.forget(SID);
    hooks.note('codex_user_prompt_submit', { sessionId: SID }, 1_000);
    stale(rollout([{ type: 'task_complete', at: 1_500 }]));
    await Promise.resolve();
    expect(hooks.applyTo([], 2_001)[0].state).toBe('processing');
    finish(rollout([{ type: 'task_complete', at: 1_500 }]));
    await Promise.resolve();
    expect(hooks.applyTo([], 2_002)[0].state).toBe('idle');
  });
});
