import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computePareto } from '../apme/pareto.js';
import { ApmeStore } from '../apme/store.js';
import { ApmeRecommender } from '../apme/recommend.js';
import type { ApmeSampleScorecardRow } from '@agentdeck/shared';

function sc(modelId: string, quality: number, totalCost: number, samples = 10): ApmeSampleScorecardRow {
  return { agentType: 'claude-code', modelId, provider: null, taskCategory: 'coding', samples, avgQuality: quality, totalCost, costKnown: true, avgLatencyMs: 1000, costPerQuality: quality > 0 ? totalCost / samples / quality : null };
}

describe('computePareto', () => {
  it('keeps non-dominated points and drops dominated ones', () => {
    // opus: high quality, high cost. mlx: lower quality, free. sonnet: mid/mid.
    // "bad": lower quality AND higher cost than sonnet → dominated.
    const rows = [
      sc('claude-opus-4-8', 0.9, 1.0),   // 0.10/sample
      sc('mlx:qwen3-30b', 0.6, 0.0),     // 0.00/sample
      sc('claude-sonnet-4-6', 0.75, 0.3), // 0.03/sample
      sc('bad-model', 0.5, 0.5),          // 0.05/sample, worse than sonnet on both
    ];
    const { frontier, dominated } = computePareto(rows);
    const fIds = frontier.map((p) => p.modelId);
    expect(fIds).toContain('claude-opus-4-8');
    expect(fIds).toContain('mlx:qwen3-30b');
    expect(fIds).toContain('claude-sonnet-4-6');
    expect(dominated.map((p) => p.modelId)).toEqual(['bad-model']);
  });

  it('sorts the frontier cheapest → most expensive', () => {
    const { frontier } = computePareto([sc('a', 0.9, 1.0), sc('b', 0.6, 0.0), sc('c', 0.75, 0.3)]);
    const costs = frontier.map((p) => p.costPerSample);
    expect(costs).toEqual([...costs].sort((x, y) => x - y));
  });

  it('ignores models below minSamples', () => {
    const { frontier } = computePareto([sc('thin', 0.95, 0.0, 1), sc('zero-quality', 0, 0)], 3);
    expect(frontier.length).toBe(0);
  });

  it('never promotes placeholder identities or compares different categories', () => {
    const result = computePareto([
      sc('unknown', 1, 0), sc('<synthetic>', 1, 0), sc('mixed', 1, 0),
      sc('real-coding', 0.7, 2), { ...sc('real-chat', 1, 0), taskCategory: 'conversation' },
    ]);
    expect(result.frontier.map(p => p.modelId).sort()).toEqual(['real-chat', 'real-coding']);
  });

  it('does not infer a price advantage over an unpriced model', () => {
    const rows = [sc('priced', 0.9, 1),
      { ...sc('unpriced', 0.8, 0), costKnown: false, totalCost: null },
      { ...sc('unpriced-lower-score', 0.7, 0), costKnown: false, totalCost: null }];
    expect(computePareto(rows).frontier).toHaveLength(3);
  });
});

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-pareto-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  await store.init();
  (store as unknown as { _tmpDir: string })._tmpDir = dir;
  return store;
}
function cleanup(store: ApmeStore) {
  store.close();
  const dir = (store as unknown as { _tmpDir?: string })._tmpDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

describe('ApmeRecommender on the Pareto frontier', () => {
  let store!: ApmeStore;
  let nextSampleId = 0;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  function seedSample(model: string, quality: number, costUsd: number): void {
    const runId = `run-${model}-${nextSampleId++}`;
    const taskId = `task-${runId}`;
    store.insertRun({ id: runId, sessionId: 's', agentType: 'claude-code', modelId: model, startedAt: 1, endedAt: 2 });
    store.insertTask({ id: taskId, runId, taskIndex: 0, boundarySignal: 'session_end', startedAt: 1 });
    store.updateTask(taskId, { endedAt: 2, taskCategory: 'coding', compositeScore: quality, costUsd, costKnown: true, modelId: model, latencyMs: 1000 });
  }

  it('recommends only frontier models, cheapest-first under a tight budget', () => {
    // Seed 5 samples each so they pass minSamples=3.
    for (let i = 0; i < 5; i++) {
      seedSample('claude-opus-4-8', 0.9 + i * 0.001, 0.1);
      seedSample('mlx:qwen3-30b', 0.6 + i * 0.001, 0.0);
      seedSample('worse', 0.5 + i * 0.001, 0.2); // dominated by mlx (lower q, higher cost)
    }
    const rec = new ApmeRecommender(store);
    const out = rec.recommend({ taskKind: 'coding', budgetUsd: 1, preferLocal: true });
    const ids = out.map((c) => c.modelId);
    expect(ids).not.toContain('worse');         // dominated → never recommended
    expect(ids[0]).toBe('mlx:qwen3-30b');        // cheapest on the frontier first
  });

  it('returns null for an unpriced model and excludes it from a dollar budget', () => {
    for (let i = 0; i < 3; i++) {
      const model = 'future-provider/model-without-price';
      const runId = `unpriced-run-${i}`;
      const taskId = `unpriced-task-${i}`;
      store.insertRun({ id: runId, sessionId: `s-${i}`, agentType: 'openclaw', modelId: model, startedAt: 1, endedAt: 2 });
      store.insertTask({ id: taskId, runId, taskIndex: 0, boundarySignal: 'session_end', startedAt: 1 });
      store.updateTask(taskId, {
        endedAt: 2, taskCategory: 'coding', compositeScore: 0.95,
        costUsd: 0, costKnown: false, modelId: model, latencyMs: 100,
      });
    }

    const rec = new ApmeRecommender(store);
    expect(rec.recommend({ taskKind: 'coding' })[0]).toMatchObject({
      modelId: 'future-provider/model-without-price',
      expectedCostUsd: null,
    });
    expect(rec.recommend({ taskKind: 'coding', budgetUsd: 1 })).toEqual([]);
  });

  it('filters unavailable and too-slow models before Pareto dominance', () => {
    for (let i = 0; i < 3; i++) {
      seedSample('unavailable', 0.95 + i * 0.001, 0.01);
      seedSample('available', 0.8 + i * 0.001, 0.1);
    }
    const rec = new ApmeRecommender(store);
    expect(rec.recommend({ taskKind: 'coding', availableModels: ['available'] }).map(c => c.modelId)).toEqual(['available']);
    expect(rec.recommend({ availableModels: [] })).toEqual([]);
    expect(rec.recommend({ taskKind: 'research' })).toEqual([]);
    expect(rec.recommend({ taskKind: '' })).toEqual([]);
    expect(rec.recommend({ taskKind: 'coding', latencyBudgetMs: 0 })).toEqual([]);
  });

  it('keeps average cost/quality invariant when the same observations are repeated, including reopening', async () => {
    for (let i = 0; i < 3; i++) seedSample('model', 0.8, 0.1 + i * 0.001);
    const first = store.sampleScorecard()[0];
    expect(first.costPerQuality).toBeCloseTo(0.101 / 0.8);
    for (let i = 0; i < 3; i++) seedSample('model', 0.8, 0.1 + i * 0.001);
    expect(store.sampleScorecard()[0].costPerQuality).toBeCloseTo(first.costPerQuality!);
    store.close();
    await store.init();
    expect(store.sampleScorecard()[0].costPerQuality).toBeCloseTo(first.costPerQuality!);
  });

  it('does not recommend legacy runs without comparable task evidence', () => {
    for (let i = 0; i < 4; i++) {
      store.insertRun({ id: `legacy-${i}`, sessionId: 's', agentType: 'claude-code', modelId: 'model', startedAt: 1, endedAt: 2 });
      store.insertEval({ runId: `legacy-${i}`, layer: 'llm_judge', metric: 'overall', score: 1, createdAt: 2 });
    }
    expect(new ApmeRecommender(store).recommend({})).toEqual([]);
  });

  it('normalizes the model scorecard by evaluated units, independent of repeated runs or unscored spending', () => {
    const seedRun = (id: string, scored: boolean) => {
      store.insertRun({ id, sessionId: id, agentType: 'claude-code', modelId: 'model',
        startedAt: 1, endedAt: 2, costUsd: scored ? 0.1 : 100, costKnown: true });
      if (scored) store.insertEval({ runId: id, layer: 'llm_judge', metric: 'overall', score: 0.8, createdAt: 2 });
    };
    seedRun('scored-1', true);
    const before = store.scorecard()[0].costPerQuality;
    expect(before).toBeCloseTo(0.125);
    seedRun('scored-2', true);
    seedRun('unscored', false);
    expect(store.scorecard()[0].costPerQuality).toBeCloseTo(before!);
  });
});
