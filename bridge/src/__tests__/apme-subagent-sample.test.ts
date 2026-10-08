import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeCollector } from '../apme/collector.js';
import { buildApmeGraph } from '../apme/graph.js';
import { buildTrajectoryLines } from '../apme/runner.js';
import { ApmeStore } from '../apme/store.js';
import { SubagentTimelineTracker } from '../subagent-timeline.js';

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-subagent-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  if (!await store.init()) throw new Error(store.lastInitError ?? 'APME store failed to initialize');
  (store as unknown as { _tmpDir: string })._tmpDir = dir;
  return store;
}

function cleanup(store: ApmeStore) {
  store.close();
  const dir = (store as unknown as { _tmpDir?: string })._tmpDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

describe('subagent census → SessionSample producer', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('records lifecycle evidence, preserves it through model updates, and exposes rollup + graph nodes', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({
      sessionId: 'parent-1', agentType: 'claude-code', modelId: 'claude-opus-5',
      projectName: 'AgentDeck',
    })!;
    collector.ingestHook('parent-1', 'UserPromptSubmit', {
      prompt: 'review the authentication changes in parallel',
    });
    const taskId = collector.getActiveTaskId('parent-1')!;

    let now = 1_000;
    const tracker = new SubagentTimelineTracker(() => {}, () => now);
    const started = tracker.handle({
      eventName: 'SubagentStart',
      payload: { agent_id: 'child-review-2', agent_type: 'reviewer' },
      sessionId: 'parent-1', agentType: 'claude-code', projectName: 'AgentDeck',
    }).sampleEvent!;
    expect(collector.noteSubagentLifecycle('parent-1', started)).toBe(true);

    // A later identity update must merge model_config, not erase subagents.
    collector.updateModel('parent-1', 'claude-opus-5-1');

    now = 6_000;
    const completed = tracker.handle({
      eventName: 'SubagentStop',
      payload: {
        agent_id: 'child-review-2', agent_type: 'reviewer',
        last_assistant_message: 'Found two authentication race conditions.',
      },
      sessionId: 'parent-1', agentType: 'claude-code', projectName: 'AgentDeck',
    }).sampleEvent!;
    expect(collector.noteSubagentLifecycle('parent-1', completed)).toBe(true);

    collector.setTurnResponse('parent-1', 'Integrated the review findings.');
    collector.noteTurnStop('parent-1');
    collector.closeRun('parent-1');

    const sample = store.getSample(taskId)!;
    expect(sample.model).toMatchObject({
      modelId: 'claude-opus-5-1',
      subagents: ['reviewer#iew2'],
    });
    expect(sample.events.filter((e) => e.kind === 'subagent')).toEqual([
      expect.objectContaining({ kind: 'subagent', id: 'child-review-2', phase: 'started' }),
      expect.objectContaining({
        kind: 'subagent', id: 'child-review-2', phase: 'completed', durationMs: 5_000,
        summary: 'Found two authentication race conditions.',
      }),
    ]);
    expect(buildTrajectoryLines(sample)).toContain(
      '  subagent reviewer#iew2 → completed (5s): Found two authentication race conditions.',
    );

    const graph = buildApmeGraph(store, { minHubDegree: 1, includeTurns: false });
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: 'subagent:parent-1:child-review-2',
      kind: 'subagent',
      label: 'reviewer#iew2',
      meta: expect.objectContaining({ phase: 'completed', durationMs: 5_000 }),
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: `task:${taskId}`,
      to: 'subagent:parent-1:child-review-2',
      kind: 'delegated',
      weight: 1,
    }));
    expect(runId).toBeTruthy();
  });

  it.each([false, true])('accounts for foreground CI blocking without changing Stop attribution (background=%s)', (background) => {
    const collector = new ApmeCollector(store);
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(100_000);
      const runId = collector.openRun({ sessionId: 'ci', agentType: 'claude-code', projectName: 'CI' })!;
      collector.ingestHook('ci', 'UserPromptSubmit', { prompt: 'watch the checks' });
      // An earlier background watcher must not hide a later foreground span.
      collector.ingestHook('ci', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'background-first',
        tool_input: { command: 'gh run watch 12', run_in_background: true } });
      clock.mockReturnValue(101_000);
      collector.ingestHook('ci', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'watch',
        tool_input: { command: 'gh pr checks 460 --watch --repo puritysb/AgentDeck', run_in_background: background } });
      clock.mockReturnValue(105_000);
      collector.ingestHook('ci', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'watch' });
      clock.mockReturnValue(106_000);
      collector.noteTurnStop('ci');
      const turn = store.listTurns(runId)[0];
      expect(turn.end_source).toBe('stop');
      expect(JSON.parse(turn.efficiency_json as string)).toMatchObject({
        wall_time_ms: 6000, ci_wait_ms: background ? 0 : 4000, agent_active_ms: background ? 6000 : 2000,
      });
      collector.closeRun('ci');
    } finally { clock.mockRestore(); }
  });

  it('refuses to guess a parent task edge when no task is active', () => {
    const collector = new ApmeCollector(store);
    collector.openRun({ sessionId: 'parent-2', agentType: 'codex-cli' });
    expect(collector.noteSubagentLifecycle('parent-2', {
      id: 'child-1', name: 'reviewer#ild1', phase: 'started', ts: 1_000,
    })).toBe(false);
  });
});
