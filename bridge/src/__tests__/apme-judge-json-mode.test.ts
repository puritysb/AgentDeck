import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { callJudge, clearJudgeEndpointCachesForTests } from '../apme/runner.js';
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
  clearJudgeEndpointCachesForTests();
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

  it('converges on a server that refuses JSON mode, without ever writing off a field it did not refuse permanently', async () => {
    // Two non-standard-ish fields ride this request, so a 400 is ambiguous and
    // the ladder gives them up in order of likelihood: `repetition_penalty`
    // first (not an OpenAI field at all, and losing it only raises the cut
    // rate), then `response_format` (losing it costs the strict-JSON request).
    //
    // When BOTH came off before the request succeeded, the evidence does not
    // say which one mattered — so the rule is not "guess right", it is "make
    // the CHEAP mistake". Blaming the penalty costs the cut-rate improvement
    // and self-corrects on the next call; blaming JSON mode is permanent and
    // never re-probed. This test is that convergence, call by call.
    const calls = mockFetch([
      { status: 400, text: 'unknown field response_format' },
      { status: 400, text: 'unknown field response_format' },
      { status: 200, body: verdict },
      { status: 400, text: 'unknown field response_format' },
      { status: 200, body: verdict },
      { status: 200, body: verdict },
    ]);

    // Call 1 — three requests: both fields, then without the penalty, then
    // without either.
    expect(await callJudge('p', mlxCfg)).toContain('overall');
    expect(calls).toHaveLength(3);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].body.repetition_penalty).toBeDefined();
    expect(calls[1].body.repetition_penalty).toBeUndefined();
    expect(calls[1].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[2].body.response_format).toBeUndefined();

    // Call 2 — the penalty was blamed, so it is gone; JSON mode was NOT
    // written off on ambiguous evidence, so it is asked for again. This time
    // the 400 is unambiguous (only one field left to give up), and THAT is
    // what earns the json-mode memory.
    expect(await callJudge('p', mlxCfg)).toContain('overall');
    expect(calls).toHaveLength(5);
    expect(calls[3].body.repetition_penalty).toBeUndefined();
    expect(calls[3].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[4].body.response_format).toBeUndefined();

    // Call 3 — converged: one request, neither field.
    expect(await callJudge('p', mlxCfg)).toContain('overall');
    expect(calls).toHaveLength(6);
    expect(calls[5].body.response_format).toBeUndefined();
    expect(calls[5].body.repetition_penalty).toBeUndefined();
  });

  it('writes off neither field when giving them up did not help', async () => {
    // A 400 that has nothing to do with either field — a wrong model id, an
    // auth proxy, any rejected request. The ladder walks the whole way down
    // and still fails, which PROVES both guesses were wrong. Before the
    // evidence rule, that single call marked the endpoint for both fields for
    // the life of the process: the server recovers and never gets JSON mode
    // again.
    const calls = mockFetch([
      { status: 400, text: "the model 'nope' does not exist" },
      { status: 400, text: "the model 'nope' does not exist" },
      { status: 400, text: "the model 'nope' does not exist" },
      { status: 200, body: verdict },
    ]);
    await expect(callJudge('p', { ...mlxCfg, endpoint: 'http://127.0.0.1:8801' }))
      .rejects.toThrow(/MLX judge HTTP 400/);
    expect(calls).toHaveLength(3);

    // The server is healthy now. Both fields must come back.
    expect(await callJudge('p', { ...mlxCfg, endpoint: 'http://127.0.0.1:8801' })).toContain('overall');
    expect(calls[3].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[3].body.repetition_penalty).toBeDefined();
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
    // …and the penalty survives too: an overflow says nothing about the field,
    // so giving it up here would spend the endpoint's penalty memory on a
    // diagnosis that was never made.
    expect(calls[1].body.repetition_penalty).toBeDefined();
    expect(String((calls[1].body.messages as Array<{ content: string }>)[1].content).length)
      .toBeLessThan(longPrompt.length);
  });

  // The ladder must re-diagnose after every retry. Nesting it made this
  // unreachable: a server that refuses the penalty AND then reports an
  // overflow lost the compaction retry, and the verdict with it.
  it('recovers when a penalty refusal is followed by a context overflow', async () => {
    const calls = mockFetch([
      { status: 400, text: 'unknown field repetition_penalty' },
      { status: 400, text: 'Request needs 9000 context tokens (8000 prompt + 800 max generation), but MAX_KV_SIZE is 4096' },
      { status: 200, body: verdict },
    ]);
    const longPrompt = 'y'.repeat(20_000);
    expect(await callJudge(longPrompt, mlxCfg)).toContain('overall');
    expect(calls).toHaveLength(3);
    expect(calls[1].body.repetition_penalty).toBeUndefined();   // penalty given up
    expect(calls[2].body.response_format).toEqual({ type: 'json_object' });  // JSON mode kept
    expect(String((calls[2].body.messages as Array<{ content: string }>)[1].content).length)
      .toBeLessThan(longPrompt.length);                          // and compacted
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
