import { afterEach, expect, it, vi } from 'vitest';
import { OllamaProbe } from '../ollama-probe.js';
import { fetchMlxResidency } from '../mlx-probe.js';
afterEach(() => vi.unstubAllGlobals());
function serve(tags: unknown, ps: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.endsWith('/api/tags') ? tags : ps;
    return body === null ? new Response('', { status: 503 }) : Response.json(body);
  }));
}
it('separates installed models from verified zero resident models without changing legacy fields', async () => {
  serve({ models: [{ name: 'gemma', size: 42 }] }, { models: [] });
  expect(await new OllamaProbe().getStatus()).toEqual({ available: true, models: [{ name: 'gemma', size: 42, sizeVram: 0 }], installedModelsKnown: true, residency: { known: true, models: [] } });
});
it('CPU-only and embedding models in ps are resident even at zero GPU bytes', async () => {
  serve({ models: [{ name: 'bge-m3' }] }, { models: [{ name: 'bge-m3', size_vram: 0 }] });
  expect((await new OllamaProbe().getStatus()).residency).toEqual({ known: true, models: ['bge-m3'] });
});
it.each([null, {}, { models: [{ unknown: true }] }])('failed or malformed ps never means unloaded: %j', async ps => {
  serve({ models: [{ name: 'gemma' }] }, ps);
  expect((await new OllamaProbe().getStatus()).residency).toEqual({ known: false, models: [] });
});
it('a failed catalog does not hide CPU residency or claim an installed inventory', async () => {
  serve(null, { models: [{ name: 'cpu', size_vram: 0 }] });
  const status = await new OllamaProbe().getStatus();
  expect(status.available).toBe(true);
  expect(status.installedModelsKnown).toBe(false);
  expect(status.residency).toEqual({ known: true, models: ['cpu'] });
});
it.each([[{ loaded_model: 'gemma' }, true, ['gemma']], [{ loaded_model: null }, true, []], [{ status: 'healthy' }, false, []]])('MLX only explicit resident metadata establishes residency', async (body, known, models) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
  expect(await fetchMlxResidency()).toEqual({ known, models });
});
