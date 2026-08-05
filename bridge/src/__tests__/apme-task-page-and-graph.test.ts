import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { buildApmeGraph, filePathFromToolPayload, shortenPath } from '../apme/graph.js';

/**
 * The task browse surface and the graph projection.
 *
 * Tasks are the canonical evaluation unit, but the only way to reach one used to
 * be drilling into its run — `listAllTasks` returns bare rows that name no
 * agent, model or project. And the row model, while a clean containment tree,
 * had two severed edges (event→turn, run→continued-run) plus six hub entities
 * living as denormalized strings, so nothing could be walked as a graph.
 */

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-graph-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  const ok = await store.init();
  if (!ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('APME store failed to initialize — is better-sqlite3 installed?');
  }
  (store as unknown as { _tmpDir: string })._tmpDir = dir;
  return store;
}

function cleanup(store: ApmeStore) {
  store.close();
  const dir = (store as unknown as { _tmpDir?: string })._tmpDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** One run holding one task, one turn, and `tools` tool events. */
function seedTask(store: ApmeStore, o: {
  run: string; task: string; ts: number;
  agent?: string; project?: string; projectPath?: string; model?: string; session?: string;
  category?: string | null; parentRun?: string | null;
  tools?: Array<{ name: string; file?: string }>;
  response?: string | null;
}) {
  store.insertRun({
    id: o.run, sessionId: o.session ?? `sess-${o.run}`,
    agentType: (o.agent ?? 'claude-code') as never,
    modelId: o.model ?? 'claude-opus-5',
    projectName: o.project ?? 'AgentDeck',
    ...(o.projectPath ? { projectPath: o.projectPath } : {}),
    taskPrompt: 'seed prompt', startedAt: o.ts,
  });
  if (o.parentRun) store.updateRun(o.run, { parentRunId: o.parentRun });
  store.insertTask({
    id: o.task, runId: o.run, taskIndex: 0, boundarySignal: 'session_end', startedAt: o.ts,
  });
  // `insertTask` writes only the opening columns — a task is always born open
  // and closed later, so the closed state has to come through updateTask.
  store.updateTask(o.task, {
    endedAt: o.ts + 1000,
    ...(o.category != null ? { taskCategory: o.category } : {}),
  });
  const turnId = `turn-${o.task}`;
  store.insertTurn({ id: turnId, runId: o.run, taskId: o.task, turnIndex: 0, prompt: 'do it', startedAt: o.ts });
  if (o.response) store.updateTurn(turnId, { response: o.response });
  (o.tools ?? []).forEach((t, i) => {
    store.insertSampleEvent({
      taskId: o.task, runId: o.run, turnIndex: 0, turnId,
      seq: i, ts: o.ts + i, kind: 'tool', toolName: t.name, toolStatus: 'success',
      payload: JSON.stringify({ input: t.file ? { file_path: t.file } : {} }),
      dedupKey: `t${i}`,
    });
  });
}

describe('task page', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('carries the run context a bare task row lacks', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 2000, project: 'apple', model: 'claude-fable-5', response: 'done', tools: [{ name: 'Read' }] });
    const { total, tasks } = store.listTaskPage({});
    expect(total).toBe(1);
    expect(tasks[0]).toMatchObject({
      id: 't1', agentType: 'claude-code', projectName: 'apple', modelId: 'claude-fable-5',
      turnCount: 1, answeredTurns: 1, toolCount: 1, firstPrompt: 'do it',
    });
  });

  it('counts turns whose reply was never archived', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 1000, response: null });
    const [t] = store.listTaskPage({}).tasks;
    // The gap the response-capture fix closed — a unit the judge can only
    // partly see must be distinguishable from one that was fully captured.
    expect(t.turnCount).toBe(1);
    expect(t.answeredTurns).toBe(0);
  });

  it('pages without losing the unfiltered total', () => {
    for (let i = 0; i < 5; i++) seedTask(store, { run: `r${i}`, task: `t${i}`, ts: 1000 + i });
    const p1 = store.listTaskPage({ limit: 2, offset: 0 });
    const p2 = store.listTaskPage({ limit: 2, offset: 2 });
    expect(p1.total).toBe(5);
    expect(p2.total).toBe(5);
    expect(p1.tasks.map(t => t.id)).toEqual(['t4', 't3']);   // newest first
    expect(p2.tasks.map(t => t.id)).toEqual(['t2', 't1']);
  });

  it('filters by agent, project and open/closed state', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 1000, agent: 'codex-cli', project: 'apple' });
    seedTask(store, { run: 'r2', task: 't2', ts: 2000, agent: 'claude-code', project: 'AgentDeck' });
    store.insertTask({ id: 't3', runId: 'r2', taskIndex: 1, boundarySignal: 'open', startedAt: 3000 });

    expect(store.listTaskPage({ agentType: 'codex-cli' }).tasks.map(t => t.id)).toEqual(['t1']);
    expect(store.listTaskPage({ projectName: 'AgentDeck' }).tasks.map(t => t.id).sort()).toEqual(['t2', 't3']);
    expect(store.listTaskPage({ state: 'open' }).tasks.map(t => t.id)).toEqual(['t3']);
    expect(store.listTaskPage({ state: 'closed' }).tasks.map(t => t.id)).toEqual(['t2', 't1']);
  });

  it('hides bookkeeping shells the collector tagged _empty', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 1000 });
    store.updateRun('r1', { taskCategory: '_empty' });
    expect(store.listTaskPage({}).total).toBe(0);
  });

  it('offers facets from the whole store, not the current page', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 1000, agent: 'codex-cli', project: 'apple' });
    seedTask(store, { run: 'r2', task: 't2', ts: 2000, project: 'AgentDeck' });
    const f = store.taskFacets();
    expect(f.agents.sort()).toEqual(['claude-code', 'codex-cli']);
    expect(f.projects.sort()).toEqual(['AgentDeck', 'apple']);
  });
});

describe('tool payload path extraction', () => {
  it('reads a path from the tool input, wherever the shape puts it', () => {
    expect(filePathFromToolPayload(JSON.stringify({ input: { file_path: '/a/b/c.ts' } }))).toBe('/a/b/c.ts');
    expect(filePathFromToolPayload(JSON.stringify({ file_path: '/x/y.ts' }))).toBe('/x/y.ts');
    expect(filePathFromToolPayload(JSON.stringify({ input: { notebook_path: '/n.ipynb' } }))).toBe('/n.ipynb');
  });

  it('returns null rather than inventing a path', () => {
    // Bash, WebFetch and friends take no path — partial coverage is the honest
    // answer, and the slice reports the ratio instead of implying otherwise.
    expect(filePathFromToolPayload(JSON.stringify({ input: { command: 'ls' } }))).toBeNull();
    expect(filePathFromToolPayload('not json')).toBeNull();
    expect(filePathFromToolPayload(null)).toBeNull();
    expect(filePathFromToolPayload(JSON.stringify({ input: { file_path: '   ' } }))).toBeNull();
  });

  it('keys a file on its path relative to the project root', () => {
    // Two checkouts of the same repo, at different depths — the root is what
    // makes them one node.
    expect(shortenPath('/Users/x/github/AgentDeck/src/a.ts', '/Users/x/github/AgentDeck')).toBe('src/a.ts');
    expect(shortenPath('/Users/x/__worktrees/wt1/src/a.ts', '/Users/x/__worktrees/wt1')).toBe('src/a.ts');
    expect(shortenPath('/Users/x/github/AgentDeck/src/a.ts', '/Users/x/github/AgentDeck/')).toBe('src/a.ts');
  });

  it('falls back to the path tail without claiming two paths are one file', () => {
    // No root known, or the file lives outside it — the tail is a readable
    // label, and two genuinely different files keep different node ids.
    expect(shortenPath('/Users/x/github/AgentDeck/bridge/src/apme/store.ts')).toBe('src/apme/store.ts');
    expect(shortenPath('/usr/include/stdio.h', '/Users/x/github/AgentDeck')).toBe('usr/include/stdio.h');
    expect(shortenPath('a/b')).toBe('a/b');
  });
});

describe('graph projection', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  const ids = (s: { nodes: Array<{ id: string }> }) => s.nodes.map(n => n.id).sort();

  it('projects the containment spine and the derived entity hubs', () => {
    seedTask(store, {
      run: 'r1', task: 't1', ts: 1000, session: 's1', project: 'AgentDeck', model: 'claude-opus-5',
      tools: [{ name: 'Read', file: '/repo/src/a.ts' }],
    });
    const g = buildApmeGraph(store, { minHubDegree: 1 });
    expect(ids(g)).toContain('run:r1');
    expect(ids(g)).toContain('task:t1');
    // Session / project / model / agent are string columns, not rows — the
    // projection is what makes them addressable.
    expect(ids(g)).toContain('session:s1');
    expect(ids(g)).toContain('project:AgentDeck');
    expect(ids(g)).toContain('model:claude-opus-5');
    expect(ids(g)).toContain('agent:claude-code');
    expect(ids(g)).toContain('tool:Read');
    expect(ids(g)).toContain('file:repo/src/a.ts');
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'run:r1', to: 'task:t1', kind: 'contains' }));
  });

  it('connects two tasks that share only a file — the cross-link no ancestor gives', () => {
    // Same repo file, two checkouts at different depths — only the project root
    // makes them the same node; a fixed path-tail rule would split them.
    seedTask(store, { run: 'r1', task: 't1', ts: 1000, session: 's1',
      projectPath: '/Users/me/github/AgentDeck',
      tools: [{ name: 'Edit', file: '/Users/me/github/AgentDeck/src/shared.ts' }] });
    seedTask(store, { run: 'r2', task: 't2', ts: 2000, session: 's2',
      projectPath: '/Users/me/__worktrees/wt1',
      tools: [{ name: 'Edit', file: '/Users/me/__worktrees/wt1/src/shared.ts' }] });
    const g = buildApmeGraph(store, { minHubDegree: 1, includeTurns: false });
    const fileNode = g.nodes.find(n => n.kind === 'file');
    expect(fileNode).toBeDefined();
    const touching = g.edges.filter(e => e.to === fileNode!.id && e.kind === 'touched').map(e => e.from).sort();
    expect(touching).toEqual(['task:t1', 'task:t2']);
  });

  it('collapses repeated calls into one weighted edge', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 1000, tools: [{ name: 'Read' }, { name: 'Read' }, { name: 'Read' }] });
    const g = buildApmeGraph(store, { minHubDegree: 1, includeTurns: false });
    const used = g.edges.filter(e => e.kind === 'used');
    // Three Read calls is one relationship of strength 3, not three edges.
    expect(used).toHaveLength(1);
    expect(used[0].weight).toBe(3);
  });

  it('draws the /clear continuation edge only when both runs are in the slice', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 1000, session: 's1' });
    seedTask(store, { run: 'r2', task: 't2', ts: 2000, session: 's1', parentRun: 'r1' });
    const both = buildApmeGraph(store, { minHubDegree: 1, includeTurns: false });
    expect(both.edges).toContainEqual(expect.objectContaining({ from: 'run:r1', to: 'run:r2', kind: 'continues' }));

    // With only the child in view, a stub parent node would read as real work.
    const child = buildApmeGraph(store, { limit: 1, minHubDegree: 1, includeTurns: false });
    expect(child.edges.some(e => e.kind === 'continues')).toBe(false);
    expect(child.nodes.some(n => n.id === 'run:r1')).toBe(false);
  });

  it('prunes one-off hubs but never containment nodes', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 1000, tools: [{ name: 'Read' }, { name: 'Glob' }] });
    seedTask(store, { run: 'r2', task: 't2', ts: 2000, tools: [{ name: 'Read' }] });
    const g = buildApmeGraph(store, { minHubDegree: 2, includeTurns: false });
    expect(g.nodes.some(n => n.id === 'tool:Read')).toBe(true);   // degree 2
    expect(g.nodes.some(n => n.id === 'tool:Glob')).toBe(false);  // degree 1
    expect(g.nodes.some(n => n.id === 'task:t1')).toBe(true);
    // Pruning must not strand the edges that pointed at the removed hub.
    const present = new Set(g.nodes.map(n => n.id));
    for (const e of g.edges) { expect(present.has(e.from)).toBe(true); expect(present.has(e.to)).toBe(true); }
  });

  it('reports what it left out so a partial slice never reads as complete', () => {
    for (let i = 0; i < 5; i++) {
      seedTask(store, { run: `r${i}`, task: `t${i}`, ts: 1000 + i, tools: [{ name: 'Bash' }, { name: 'Read', file: '/r/a.ts' }] });
    }
    const g = buildApmeGraph(store, { limit: 2, minHubDegree: 1, includeTurns: false });
    expect(g.stats.taskCount).toBe(2);
    expect(g.stats.truncatedTasks).toBe(3);
    // Bash carries no path — the ratio says so instead of the graph implying
    // every tool event touched a file.
    expect(g.stats.fileCoverage).toEqual({ toolEvents: 4, withPath: 2 });
  });

  it('attaches trajectory to turns when asked, and to the task when not', () => {
    seedTask(store, { run: 'r1', task: 't1', ts: 1000, tools: [{ name: 'Read' }] });
    const withTurns = buildApmeGraph(store, { minHubDegree: 1, includeTurns: true });
    expect(withTurns.nodes.some(n => n.kind === 'turn')).toBe(true);
    expect(withTurns.edges).toContainEqual(expect.objectContaining({ from: 'turn:turn-t1', to: 'tool:Read', kind: 'used' }));

    const flat = buildApmeGraph(store, { minHubDegree: 1, includeTurns: false });
    expect(flat.nodes.some(n => n.kind === 'turn')).toBe(false);
    // The relationship survives at task altitude rather than being dropped.
    expect(flat.edges).toContainEqual(expect.objectContaining({ from: 'task:t1', to: 'tool:Read', kind: 'used' }));
  });
});
