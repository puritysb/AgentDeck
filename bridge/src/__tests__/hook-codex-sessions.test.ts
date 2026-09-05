import { describe, expect, it } from 'vitest';
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
