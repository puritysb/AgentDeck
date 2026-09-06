import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { callJudge, clearJudgeJsonModeCacheForTests } from '../apme/runner.js';
import type { ApmeJudgeConfig } from '../apme/settings.js';

// The judge prompt asks for strict JSON and the runner parses the reply as
// JSON, but the request never ASKED the server to constrain its output. A model
// that wraps the object in prose produces an unparseable verdict, the task
// retries, fails again and parks for 30 minutes — measured on the author's
// store, one task parked six times in three hours and 17 times since
// 2026-09-03, never judged. These cases pin both halves of the fix: the field
// is sent, and a server that refuses the FIELD still gets a judge.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_DATA_DIR = process.env.AGENTDECK_DATA_DIR;
let tmpDir: string;

interface Call { url: string; body: Record<string, unknown> }

/** Records every judge POST and answers from a queue of responses. */
function mockFetch(responses: Array<{ status: number; body?: unknown; text?: string }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    // Model discovery (`/models`) is not a judge call — answer it and move on.
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200 });
    }
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(next.text ?? JSON.stringify(next.body ?? {}), { status: next.status });
  }) as unknown as typeof fetch;
  return calls;
}

const verdict = { choices: [{ message: { content: '{"overall":0.7}' } }] };
const mlxCfg: ApmeJudgeConfig = {
  backend: 'mlx', model: 'test-model',
  endpoint: 'http://127.0.0.1:8800/v1/chat/completions',
  sampleRate: 1, onlyWhenDisagreement: false,
};
const openAiCfg: ApmeJudgeConfig = {
  backend: 'openai', model: 'test-model',
  endpoint: 'http://127.0.0.1:11434/v1',
  sampleRate: 1, onlyWhenDisagreement: false,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'apme-json-mode-'));
  process.env.AGENTDECK_DATA_DIR = tmpDir;
  clearJudgeJsonModeCacheForTests();
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGENTDECK_DATA_DIR;
  else process.env.AGENTDECK_DATA_DIR = ORIGINAL_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('judge JSON mode', () => {
  it('asks the MLX server for a JSON object instead of hoping for one', async () => {
    const calls = mockFetch([{ status: 200, body: verdict }]);
    expect(await callJudge('p', mlxCfg)).toContain('overall');
    expect(calls).toHaveLength(1);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
  });

  it('asks an OpenAI-compatible server too, alongside the existing fields', async () => {
    const calls = mockFetch([{ status: 200, body: verdict }]);
    await callJudge('p', { ...openAiCfg, reasoningEffort: 'none' });
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].body.reasoning_effort).toBe('none');
    expect(calls[0].body.max_tokens).toBe(1024);
  });

  it('keeps judging a server that refuses the field, and stops asking it', async () => {
    // 400 first (the field), then a normal verdict for the retry and for every
    // later call. A server without JSON mode must not lose its judge.
    const calls = mockFetch([
      { status: 400, text: 'unknown field response_format' },
      { status: 200, body: verdict },
    ]);
    expect(await callJudge('p', mlxCfg)).toContain('overall');
    expect(calls).toHaveLength(2);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1].body.response_format).toBeUndefined();

    // The probe costs ONE request per endpoint per process, not one per verdict.
    await callJudge('p', mlxCfg);
    expect(calls).toHaveLength(3);
    expect(calls[2].body.response_format).toBeUndefined();
  });

  it('remembers per endpoint, so one refusing server does not disable the others', async () => {
    const calls = mockFetch([
      { status: 400, text: 'unknown field response_format' },
      { status: 200, body: verdict },
    ]);
    await callJudge('p', mlxCfg);
    await callJudge('p', openAiCfg);
    expect(calls.at(-1)?.url).toContain('11434');
    expect(calls.at(-1)?.body.response_format).toEqual({ type: 'json_object' });
  });

  it('still compacts a context-overflow 400 and keeps JSON mode on', async () => {
    // The MLX overflow reply is also a 400. Reading it as a field rejection
    // would drop the one retry that actually fixes it.
    const calls = mockFetch([
      { status: 400, text: 'Request needs 9000 context tokens (8000 prompt + 800 max generation), but MAX_KV_SIZE is 4096' },
      { status: 200, body: verdict },
    ]);
    const longPrompt = 'x'.repeat(20_000);
    expect(await callJudge(longPrompt, mlxCfg)).toContain('overall');
    expect(calls).toHaveLength(2);
    expect(calls[1].body.response_format).toEqual({ type: 'json_object' });
    expect(String((calls[1].body.messages as Array<{ content: string }>)[1].content).length)
      .toBeLessThan(longPrompt.length);
  });

  it('does not read an auth or rate-limit failure as a rejected field', async () => {
    // Retrying a 401 without the field would hide it behind a second identical
    // failure and permanently switch JSON mode off for a healthy endpoint.
    const calls = mockFetch([{ status: 401, text: 'unauthorized' }]);
    await expect(callJudge('p', openAiCfg)).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);

    const later = mockFetch([{ status: 200, body: verdict }]);
    await callJudge('p', openAiCfg);
    expect(later[0].body.response_format).toEqual({ type: 'json_object' });
  });
});
