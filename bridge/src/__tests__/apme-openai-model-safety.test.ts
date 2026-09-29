import { afterEach, expect, it, vi } from 'vitest';
import { callJudgeWithMeta } from '../apme/runner.js';
import { DEFAULT_APME_CONFIG } from '../apme/settings.js';
afterEach(() => vi.unstubAllGlobals());
it('an unconfigured OpenAI-compatible judge never loads the first of multiple downloads', async () => {
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    if (init?.method === 'POST') posts.push(init);
    return Response.json({ models: [{ name: 'qwen' }, { name: 'gemma' }], data: [{ id: 'qwen' }, { id: 'gemma' }] });
  }));
  await expect(callJudgeWithMeta('judge', { ...DEFAULT_APME_CONFIG.judge, backend: 'openai',
    endpoint: 'http://127.0.0.1:19800/v1', model: 'default', fallbackToMlx: false, fallbackToFoundationModels: false,
  })).rejects.toThrow(/explicit model or a singleton catalog/);
  expect(posts).toEqual([]);
});
