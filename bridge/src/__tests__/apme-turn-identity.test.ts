import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import { readModelFromTranscript } from '../apme/claude-transcript-reader.js';

/**
 * `turns.model_id` / `turns.provider` are the scorecard's identity source.
 * Hook-observed sessions learn their model at Stop (Codex: the hook's own
 * `model`; Claude: the transcript), and that used to be written to the RUN
 * only — 465 Claude + 183 Codex turns in one week carried NULL, so the
 * per-model scorecard ranked nothing (2026-09-03).
 */
async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-ident-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  const ok = await store.init();
  if (!ok) { rmSync(dir, { recursive: true, force: true }); throw new Error('store init failed'); }
  (store as unknown as { _tmpDir: string })._tmpDir = dir;
  return store;
}
function cleanup(store: ApmeStore) {
  store.close();
  const dir = (store as unknown as { _tmpDir?: string })._tmpDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

describe('updateModel stamps the turn, not just the run', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('the active turn carries the model and its normalized provider', () => {
    const c = new ApmeCollector(store);
    const runId = c.openRun({ sessionId: 's', agentType: 'codex-cli', projectName: 'demo' })!;
    c.ingestHook('s', 'UserPromptSubmit', { prompt: 'do the thing' });
    c.updateModel('s', 'gpt-5.6-sol');
    c.noteTurnStop('s');
    const [t] = store.listTurns(runId);
    expect(t!.model_id).toBe('gpt-5.6-sol');
    expect(t!.provider).toBe('openai');
    expect(store.getRun(runId)!.modelId).toBe('gpt-5.6-sol');
  });

  it('a model learned at session_end, after the last turn closed, lands on that turn', () => {
    const c = new ApmeCollector(store);
    const runId = c.openRun({ sessionId: 's2', agentType: 'claude-code', projectName: 'demo' })!;
    c.ingestHook('s2', 'UserPromptSubmit', { prompt: 'do the thing' });
    c.noteTurnStop('s2');
    c.updateModel('s2', 'claude-opus-5');
    expect(store.listTurns(runId)[0]!.model_id).toBe('claude-opus-5');
  });

  it('a provider the producer names is the endpoint, ahead of the model id\'s maker', () => {
    // OpenCode's providerID, values from OpenCode 1.18.35's own store.
    const c = new ApmeCollector(store);
    const stamp = (sid: string, model: string, provider?: string) => {
      const runId = c.openRun({ sessionId: sid, agentType: 'opencode', projectName: 'demo' })!;
      c.ingestHook(sid, 'UserPromptSubmit', { prompt: 'go' });
      c.noteTurnStop(sid);
      c.updateModel(sid, model, provider);
      return store.listTurns(runId)[0]!;
    };
    expect(stamp('mlx', 'mlx-community/Qwen3.6-35B-A3B-4bit', 'mlx').provider).toBe('local');
    expect(stamp('bare', 'mlx-community/Qwen3.6-35B-A3B-4bit').provider).toBe('alibaba');
    // An endpoint name outside the allow-list falls back to the model id.
    expect(stamp('plan', 'glm-5.3', 'zai-coding-plan')).toMatchObject({ model_id: 'glm-5.3', provider: 'zai' });
    // Two unknowns stay unknown rather than combining into a claim.
    expect(stamp('zen', 'big-pickle', 'opencode').provider).toBeNull();
  });
});

describe('readModelFromTranscript', () => {
  it('skips the <synthetic> model Claude Code stamps on client abort notices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apme-tx-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, [
      JSON.stringify({ message: { role: 'assistant', model: 'claude-opus-5', content: [] } }),
      JSON.stringify({ message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [] } }),
    ].join('\n') + '\n');
    expect(readModelFromTranscript(p)).toBe('claude-opus-5');
    rmSync(dir, { recursive: true, force: true });
  });
});
