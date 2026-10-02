import { describe, expect, it } from 'vitest';
import {
  CodexExecChildren,
  PENDING_TTL_MS,
  codexExecCwdFromCommand,
  isCodexExecCommand,
  isHeadlessCodexOriginator,
  nearestAncestorPeer,
  type CodexExecChild,
  type ExecChildPeer,
} from '../codex-exec-children.js';
import type { LocatedCodexRolloutSummary, ProcInfo } from '../passive-observer.js';

const CLAUDE_SID = '4f55869a-38a5-494c-8577-7afad72aae35';
const CHILD_SID = '01a0f35b-74a5-7bc0-827d-ef80f440478e';
const CWD = '/tmp/scratch/gen/work/2020s_ai_ai';
/** What Codex writes into the rollout for `-C /tmp/…` on macOS. */
const CWD_REAL = '/private/tmp/scratch/gen/work/2020s_ai_ai';

function proc(pid: number, ppid: number, command: string): ProcInfo {
  return { pid, ppid, rssKb: 100, command };
}

/** The 2026-10-01 shape: claude → zsh → run.sh → xargs → bash → timeout → node → codex. */
function batchTable(): ProcInfo[] {
  return [
    proc(71456, 1872, 'claude'),
    proc(16524, 71456, '/bin/zsh -c source snapshot.sh && bash run.sh'),
    proc(17382, 16524, '/bin/bash /tmp/scratch/gen/run.sh 4 1970s_mainframe_ai'),
    proc(17384, 17382, 'xargs -P 4 -I{} bash -c gen_one {}'),
    proc(49448, 17384, 'bash -c gen_one 2020s_ai_ai'),
    proc(49451, 49448, `timeout 1500 codex exec --skip-git-repo-check -s workspace-write -C ${CWD} -`),
    proc(49452, 49451, `node /opt/homebrew/bin/codex exec --skip-git-repo-check -s workspace-write -C ${CWD} -`),
    proc(49460, 49452, `/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex exec --skip-git-repo-check -s workspace-write -C ${CWD} -`),
    proc(49470, 49460, '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex-code-mode-host'),
  ];
}

const claudePeer: ExecChildPeer = { sessionId: CLAUDE_SID, pid: 71456, agentType: 'claude-code', projectName: 'epoch-of-tech' };

function rollout(originator: string, extra: Partial<LocatedCodexRolloutSummary['summary']> = {}): LocatedCodexRolloutSummary {
  return {
    path: `/rollouts/rollout-${CHILD_SID}.jsonl`,
    mtimeMs: 1,
    summary: { state: 'processing', isSubagent: false, originator, cwd: CWD_REAL, ...extra },
  };
}

interface Recorded { starts: CodexExecChild[]; stops: Array<{ child: CodexExecChild; summary: string | undefined }> }

/** macOS's /tmp symlink, without touching the real filesystem. */
const fakeRealpath = (p: string) => (p.startsWith('/tmp/') ? `/private${p}` : p);

function registry(opts: {
  rollout?: LocatedCodexRolloutSummary | null;
  lastMessage?: string;
  now?: () => number;
} = {}): { reg: CodexExecChildren; seen: Recorded } {
  const seen: Recorded = { starts: [], stops: [] };
  const reg = new CodexExecChildren({
    locateRollout: () => (opts.rollout === undefined ? rollout('codex_exec') : opts.rollout),
    lastMessage: () => opts.lastMessage ?? '',
    realpath: fakeRealpath,
    now: opts.now,
  });
  reg.lifecycle = {
    onStart: (child) => { seen.starts.push({ ...child }); },
    onStop: (child, summary) => { seen.stops.push({ child: { ...child }, summary }); },
  };
  return { reg, seen };
}

describe('codex exec shape predicates', () => {
  it('recognises the exec subcommand behind node and timeout wrappers, not the helpers', () => {
    expect(isCodexExecCommand(`timeout 1500 codex exec -C ${CWD} -`)).toBe(true);
    expect(isCodexExecCommand(`node /opt/homebrew/bin/codex exec -C ${CWD} -`)).toBe(true);
    expect(isCodexExecCommand('/x/bin/codex exec --skip-git-repo-check -s workspace-write -C /p -')).toBe(true);
    expect(isCodexExecCommand('/x/bin/codex --profile fast exec -')).toBe(true);
    expect(isCodexExecCommand('/x/bin/codex e "fix tests"')).toBe(true);
    expect(isCodexExecCommand('/x/bin/codex')).toBe(false);
    expect(isCodexExecCommand('/x/bin/codex resume abc')).toBe(false);
    expect(isCodexExecCommand('/x/bin/codex-code-mode-host')).toBe(false);
    expect(isCodexExecCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server')).toBe(false);
    expect(isCodexExecCommand('grep codex exec')).toBe(false);
  });

  it('reads the working directory from -C / --cd / --cd=', () => {
    expect(codexExecCwdFromCommand(`codex exec -C ${CWD} -`)).toBe(CWD);
    expect(codexExecCwdFromCommand('codex exec --cd /a/b -')).toBe('/a/b');
    expect(codexExecCwdFromCommand('codex exec --cd=/a/b -')).toBe('/a/b');
    expect(codexExecCwdFromCommand('codex exec -')).toBeNull();
  });

  it('treats only codex_exec as headless, case-insensitively', () => {
    expect(isHeadlessCodexOriginator('codex_exec')).toBe(true);
    expect(isHeadlessCodexOriginator('Codex_Exec')).toBe(true);
    expect(isHeadlessCodexOriginator('codex-tui')).toBe(false);
    expect(isHeadlessCodexOriginator('Codex Desktop')).toBe(false);
    expect(isHeadlessCodexOriginator(undefined)).toBe(false);
  });
});

describe('nearestAncestorPeer', () => {
  it('walks the wrapper chain up to the launching session', () => {
    expect(nearestAncestorPeer(49460, batchTable(), [claudePeer])).toEqual(claudePeer);
  });

  it('never matches the process itself and returns null with no peer ancestor', () => {
    const selfPeer: ExecChildPeer = { sessionId: CHILD_SID, pid: 49460, agentType: 'codex-cli' };
    expect(nearestAncestorPeer(49460, batchTable(), [selfPeer])).toBeNull();
    expect(nearestAncestorPeer(49460, batchTable(), [])).toBeNull();
  });

  it('survives a cyclic or truncated table', () => {
    const table = [proc(10, 11, 'a'), proc(11, 10, 'b')];
    expect(nearestAncestorPeer(10, table, [claudePeer])).toBeNull();
  });

  it('is deterministic when several peers share a pid (Codex Desktop conversations)', () => {
    const a: ExecChildPeer = { sessionId: 'conv-a', pid: 71456, agentType: 'codex-app' };
    const b: ExecChildPeer = { sessionId: 'conv-b', pid: 71456, agentType: 'codex-app' };
    expect(nearestAncestorPeer(49460, batchTable(), [a, b])).toEqual(a);
    expect(nearestAncestorPeer(49460, batchTable(), [b, a])).toEqual(b);
  });
});

describe('CodexExecChildren.noteHook', () => {
  it('attaches a headless run to its launcher on SessionStart when the process is visible', () => {
    const { reg, seen } = registry();
    const verdict = reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]);
    expect(verdict.childOnly).toBe(true);
    expect(verdict.child).toMatchObject({
      sessionId: CHILD_SID, parentSessionId: CLAUDE_SID, parentAgentType: 'claude-code', pid: 49460, pidExact: false, cwd: CWD_REAL,
    });
    expect(seen.starts).toHaveLength(1);
    expect(reg.knows(CHILD_SID)).toBe(true);
    expect(reg.parentOf(CHILD_SID)).toBe(CLAUDE_SID);
  });

  it('matches the argv -C path against the canonical rollout cwd (/tmp vs /private/tmp)', () => {
    const { reg } = registry();
    // The hook payload carries the canonical path; the argv carries the symlink.
    expect(reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]).childOnly).toBe(true);
  });

  it('completes the child on its Stop with the inline reply, once', () => {
    const { reg, seen } = registry();
    reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]);
    reg.noteHook('codex_tool_start', { session_id: CHILD_SID, cwd: CWD_REAL, tool_name: 'exec' }, batchTable(), [claudePeer]);
    const stop = reg.noteHook('codex_stop', { session_id: CHILD_SID, cwd: CWD_REAL, last_assistant_message: 'DONE' }, batchTable(), [claudePeer]);
    expect(stop.childOnly).toBe(true);
    expect(seen.stops).toHaveLength(1);
    expect(seen.stops[0].summary).toBe('DONE');
    // A trailing tool_end after the stop is still the child's, and no second stop.
    const trailing = reg.noteHook('codex_tool_end', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]);
    expect(trailing.childOnly).toBe(true);
    expect(seen.stops).toHaveLength(1);
  });

  it('falls back to the rollout reply when the Stop payload carries none', () => {
    const { reg, seen } = registry({ lastMessage: 'wrote 12 files' });
    reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]);
    reg.noteHook('codex_stop', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]);
    expect(seen.stops[0].summary).toBe('wrote 12 files');
  });

  it('lets an interactive TUI session through untouched', () => {
    const { reg, seen } = registry({ rollout: rollout('codex-tui') });
    const verdict = reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]);
    expect(verdict.childOnly).toBe(false);
    expect(verdict.wantsFreshTable).toBeUndefined();
    expect(seen.starts).toHaveLength(0);
    expect(reg.knows(CHILD_SID)).toBe(false);
  });

  it('judges a headless run with no session ancestor standalone', () => {
    const { reg, seen } = registry();
    const table = [
      proc(500, 1, '/bin/zsh'),
      proc(501, 500, `/x/bin/codex exec -C ${CWD} -`),
    ];
    const verdict = reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, table, [claudePeer]);
    expect(verdict.childOnly).toBe(false);
    expect(seen.starts).toHaveLength(0);
    expect(reg.knows(CHILD_SID)).toBe(false);
  });

  it('resolves a run launched without -C as the only unclaimed codex exec in the table', () => {
    const { reg } = registry();
    const table = [
      proc(71456, 1872, 'claude'),
      proc(16524, 71456, '/bin/zsh -c cd /somewhere && codex exec "fix tests"'),
      proc(16530, 16524, '/x/bin/codex exec fix tests'),
    ];
    const verdict = reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: '/somewhere' }, table, [claudePeer]);
    expect(verdict.childOnly).toBe(true);
    expect(verdict.child?.pid).toBe(16530);
  });

  it('asks for a fresh table once when the process is not visible yet, and lets the hooks flow meanwhile', () => {
    let now = 1_000;
    const { reg, seen } = registry({ now: () => now });
    // SessionStart lands before the 5 s scan refreshed the process table.
    const first = reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [], [claudePeer]);
    expect(first).toEqual({ childOnly: false, wantsFreshTable: true });
    expect(reg.knows(CHILD_SID)).toBe(false);
    expect(seen.starts).toHaveLength(0);
    // The caller's fresh table shows it: attached right away.
    const second = reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]);
    expect(second.childOnly).toBe(true);
    expect(seen.starts).toHaveLength(1);
  });

  it('does not ask for a fresh table twice for one session', () => {
    let now = 1_000;
    const { reg } = registry({ now: () => now });
    expect(reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [], [claudePeer]).wantsFreshTable).toBe(true);
    now += 10;
    const again = reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [], [claudePeer]);
    expect(again.childOnly).toBe(false);
    expect(again.wantsFreshTable).toBe(false);
    // Later hooks keep flowing; the observer's scan may still attach it.
    now += 3_000;
    expect(reg.noteHook('codex_tool_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [], [claudePeer]).childOnly).toBe(false);
  });

  it('gives up on a pending run after PENDING_TTL_MS and after a terminal hook', () => {
    let now = 1_000;
    const { reg } = registry({ now: () => now });
    reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [], [claudePeer]);
    now += PENDING_TTL_MS + 1;
    expect(reg.noteHook('codex_tool_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [], [claudePeer]).childOnly).toBe(false);
    // Sticky: the process showing up later does not re-open the question.
    expect(reg.noteHook('codex_tool_end', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]).childOnly).toBe(false);
    expect(reg.knows(CHILD_SID)).toBe(false);
  });

  it('re-checks a rollout that was not on disk at SessionStart', () => {
    let located: LocatedCodexRolloutSummary | null = null;
    let now = 1_000;
    const seen: Recorded = { starts: [], stops: [] };
    const reg = new CodexExecChildren({ locateRollout: () => located, realpath: fakeRealpath, now: () => now });
    reg.lifecycle = { onStart: (c) => seen.starts.push(c), onStop: () => {} };
    expect(reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]).childOnly).toBe(false);
    located = rollout('codex_exec');
    now += 2_500;
    expect(reg.noteHook('codex_user_prompt_submit', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]).childOnly).toBe(true);
    expect(seen.starts).toHaveLength(1);
  });

  it('ignores non-codex hooks and hooks without a session id', () => {
    const { reg } = registry();
    expect(reg.noteHook('SessionStart', { session_id: CHILD_SID }, batchTable(), [claudePeer]).childOnly).toBe(false);
    expect(reg.noteHook('codex_session_start', {}, batchTable(), [claudePeer]).childOnly).toBe(false);
  });

  it('does not let two same-cwd siblings claim one process', () => {
    const other = '01a0f35b-b2be-7ca1-955e-8ca991dd357b';
    const table = [
      ...batchTable(),
      proc(49548, 17384, 'bash -c gen_one 2020s_ai_ai'),
      proc(49551, 49548, `/x/bin/codex exec -C ${CWD} -`),
    ];
    const { reg } = registry();
    const a = reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, table, [claudePeer]);
    const b = reg.noteHook('codex_session_start', { session_id: other, cwd: CWD_REAL }, table, [claudePeer]);
    expect(a.child?.pid).toBeDefined();
    expect(b.child?.pid).toBeDefined();
    expect(a.child?.pid).not.toBe(b.child?.pid);
  });
});

describe('CodexExecChildren.reconcile', () => {
  it('attaches observer-found children and completes them when their process exits', () => {
    const { reg, seen } = registry({ lastMessage: 'DONE' });
    reg.reconcile([{ sessionId: CHILD_SID, pid: 49460, cwd: CWD_REAL, parent: claudePeer, goal: 'write the 2020s AI chapter' }], batchTable());
    expect(seen.starts).toHaveLength(1);
    expect(seen.starts[0]).toMatchObject({ parentSessionId: CLAUDE_SID, goal: 'write the 2020s AI chapter', pidExact: true });
    // Next scan: rollout closed, process gone.
    const without = batchTable().filter((p) => p.pid < 49451);
    reg.reconcile([], without);
    expect(seen.stops).toHaveLength(1);
    expect(seen.stops[0].summary).toBe('DONE');
    expect(reg.knows(CHILD_SID)).toBe(true); // tombstoned, still not a session
  });

  it('treats an empty process table as "could not look", not as every child finishing', () => {
    const { reg, seen } = registry();
    reg.reconcile([{ sessionId: CHILD_SID, pid: 49460, cwd: CWD_REAL, parent: claudePeer }], batchTable());
    reg.reconcile([], []);
    expect(seen.stops).toHaveLength(0);
  });

  it('attaches a pending hook-side run from the tick table when the observer did not report it', () => {
    const { reg, seen } = registry();
    expect(reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [], [claudePeer]).childOnly).toBe(false);
    reg.reconcile([], batchTable(), [claudePeer]);
    expect(seen.starts).toHaveLength(1);
    expect(seen.starts[0].pidExact).toBe(false);
    expect(reg.parentOf(CHILD_SID)).toBe(CLAUDE_SID);
  });

  it('marks a parentless observation standalone so its later hooks flow', () => {
    const { reg } = registry();
    reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [], []);
    reg.reconcile([{ sessionId: CHILD_SID, pid: 49460, cwd: CWD_REAL, parent: null }], batchTable());
    expect(reg.knows(CHILD_SID)).toBe(false);
    expect(reg.noteHook('codex_tool_start', { session_id: CHILD_SID, cwd: CWD_REAL }, batchTable(), [claudePeer]).childOnly).toBe(false);
  });

  it('corrects a best-effort hook-side pid with the observer\'s exact one', () => {
    const { reg } = registry();
    const table = [
      ...batchTable(),
      proc(49548, 17384, 'bash -c gen_one 2020s_ai_ai'),
      proc(49551, 49548, `/x/bin/codex exec -C ${CWD} -`),
    ];
    reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, table, [claudePeer]);
    reg.reconcile([{ sessionId: CHILD_SID, pid: 49551, cwd: CWD_REAL, parent: claudePeer }], table);
    const child = reg.snapshot().find((c) => c.sessionId === CHILD_SID);
    expect(child?.pid).toBe(49551);
    expect(child?.pidExact).toBe(true);
  });

  it('does not complete a guessed-pid child while a same-cwd run is still alive', () => {
    const { reg, seen } = registry();
    const sibling = [
      proc(49548, 17384, 'bash -c gen_one 2020s_ai_ai'),
      proc(49551, 49548, `/x/bin/codex exec -C ${CWD} -`),
    ];
    // Bound by argv to 49460 — which may be the sibling's process.
    reg.noteHook('codex_session_start', { session_id: CHILD_SID, cwd: CWD_REAL }, [...batchTable(), ...sibling], [claudePeer]);
    expect(seen.starts[0].pid).toBe(49460);
    // 49460's chain exits; 49551 for the same cwd is still running.
    const after = [...batchTable().filter((p) => p.pid < 49451), ...sibling];
    reg.reconcile([], after, [claudePeer]);
    expect(seen.stops).toHaveLength(0);
    // The last same-cwd run exits: now it is over.
    reg.reconcile([], batchTable().filter((p) => p.pid < 49451), [claudePeer]);
    expect(seen.stops).toHaveLength(1);
  });
});
