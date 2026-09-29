import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { guardedMlxFetch, resolveSafeMlxModel, selectMlxModel, mlxMetricsProblem, mlxBaseUrl, clearMlxSafetyForTests, MLX_SAFETY } from '../mlx-safety.js';
// @ts-ignore generator is intentionally executable plain JS
import { emitSwift } from '../../../scripts/generate-mlx-safety.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../mlx-safety-vectors.json', import.meta.url), 'utf8'));
const post = (model: string | null = null) => ({ body: JSON.stringify({ model, messages: [], max_tokens: 1 }) });
const endpoint = 'http://localhost:18800/v1/chat/completions';
function residentFetch(handler: () => Promise<Response> = async () => Response.json({ choices: [] })) {
  return vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST') return handler();
    if (url.endsWith('/health')) return Response.json({ loaded_model: 'gemma' });
    if (url.endsWith('/metrics')) return Response.json({ summary: { in_flight: 0 } });
    throw new Error(`unexpected request ${url}`);
  });
}
afterEach(() => { vi.unstubAllGlobals(); clearMlxSafetyForTests(); });
describe('MLX operational safety', () => {
  for (const v of vectors) it(v.name, () => {
    const run = () => selectMlxModel(v.known, v.loaded ?? null, v.catalog, v.pin);
    if (v.expected === null) expect(run).toThrow(); else expect(run()).toBe(v.expected);
  });
  it('keeps the generated Swift policy synchronized', () => {
    expect(readFileSync(new URL('../../../apple/AgentDeck/Daemon/Apme/MlxSafetyRules.generated.swift', import.meta.url), 'utf8')).toBe(emitSwift(MLX_SAFETY));
  });
  it('canonicalizes base, v1 and chat URLs to one admission key', () => {
    for (const suffix of ['', '/', '/v1', '/v1/', '/chat/completions', '/v1/chat/completions/']) expect(mlxBaseUrl('http://localhost:18800' + suffix)).toBe('http://localhost:18800');
  });
  it('refuses a pinned model mismatch before any inference', async () => {
    const fetch = residentFetch(); vi.stubGlobal('fetch', fetch);
    await expect(guardedMlxFetch(endpoint, post('qwen'))).rejects.toThrow('mismatch');
    expect(fetch.mock.calls.some(([,init]) => init?.method === 'POST')).toBe(false);
  });
  it('does not interpret healthy as recovered after OOM', () => {
    expect(mlxMetricsProblem({ latest: { timestamp_unix: 1 }, summary: { last_error: { timestamp_unix: 2, error: 'Insufficient Memory' } } })).toContain('out of memory');
    expect(mlxMetricsProblem({ latest: { timestamp_unix: 3 }, summary: { last_error: { timestamp_unix: 2, error: 'Insufficient Memory' } } })).toBeNull();
  });
  it('refuses external in-flight requests and queued generation', () => {
    expect(mlxMetricsProblem({ summary: { in_flight: 1 } })).toContain('busy');
    expect(mlxMetricsProblem({ server: { request_queue_depth: 1 } })).toContain('busy');
  });
  it('holds admission until response body completion, including aliases', async () => {
    let finish!: () => void;
    const pendingBody = new ReadableStream({ start(c) { finish = () => { c.enqueue(new TextEncoder().encode('{}')); c.close(); }; } });
    let headers!: () => void;
    const gotHeaders = new Promise<void>(r => { headers = r; });
    const fetch = residentFetch(async () => { headers(); return new Response(pendingBody); });
    vi.stubGlobal('fetch', fetch);
    const first = guardedMlxFetch(endpoint, post()); await gotHeaders;
    await expect(guardedMlxFetch('http://localhost:18800', post())).rejects.toThrow('paused');
    finish(); await first;
    expect(fetch.mock.calls.filter(([,i]) => i?.method === 'POST')).toHaveLength(1);
  });
  it('quarantines timed out generation across callers without sending another POST', async () => {
    const fetch = residentFetch(async () => { throw new DOMException('timeout', 'TimeoutError'); }); vi.stubGlobal('fetch', fetch);
    await expect(guardedMlxFetch(endpoint, post())).rejects.toThrow('timeout');
    await expect(guardedMlxFetch(endpoint, post())).rejects.toThrow('paused');
    expect(fetch.mock.calls.filter(([,i]) => i?.method === 'POST')).toHaveLength(1);
  });
  it('allows field-rejection retries but quarantines 500', async () => {
    const fetch = residentFetch(async () => new Response('{}', { status: 400 })); vi.stubGlobal('fetch', fetch);
    expect((await guardedMlxFetch(endpoint, post())).status).toBe(400);
    expect((await guardedMlxFetch(endpoint, post())).status).toBe(400);
    vi.stubGlobal('fetch', residentFetch(async () => new Response('{}', {status: 500})));
    expect((await guardedMlxFetch(endpoint, post())).status).toBe(500);
    await expect(guardedMlxFetch(endpoint, post())).rejects.toThrow('paused');
  });
  it('catalog-only multi-model servers never receive an auto-selected model', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/health') ? new Response('', {status:404}) : Response.json({ data: [{id:'qwen'}, {id:'gemma'}] })));
    await expect(resolveSafeMlxModel(endpoint)).rejects.toThrow('unambiguous');
  });
});
