import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callJudgeWithMeta, clearJudgeEndpointCachesForTests, MLX_JUDGE_REPETITION_PENALTY } from '../apme/runner.js';
import { DEFAULT_APME_CONFIG, loadApmeConfig } from '../apme/settings.js';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const answer = JSON.stringify({ overall: 0.8, summary: 'Did the thing.' });
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] }));

const mlxCfg = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_APME_CONFIG.judge, backend: 'mlx' as const, model: 'gemma-test',
  endpoint: 'http://127.0.0.1:8800/v1/chat/completions',
  fallbackToMlx: false, fallbackToFoundationModels: false, ...over,
});
const sentBody = (f: ReturnType<typeof vi.fn>) =>
  JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

// The endpoint memories are MODULE-level and survive between tests, and this
// file avoids collisions by giving each describe its own port — isolation by
// coincidence. Round 4 added this reset inside the FIRST describe only, which
// left the later blocks exactly as exposed: with a process-global penalty
// memory, `remembers the endpoint so the cost is one request` passed because
// an earlier test had already switched the penalty off, not because the
// scoping worked. Hoisted to file scope so every block starts clean.
beforeEach(() => { clearJudgeEndpointCachesForTests(); });

describe('MLX judge repetition penalty', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The default is not a taste knob — it is the measured cut rate: 4 of 6 tasks
  // → 1 of 6 (12/18 → 3/18 observations) under two designs, back-to-back and
  // interleaved. It is deliberately NOT claimed that the failure is permanent;
  // see MLX_JUDGE_REPETITION_PENALTY.
  it('sends the measured default when the user set nothing', async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal('fetch', f);
    await callJudgeWithMeta('judge', mlxCfg());
    // The LITERAL, not the constant compared with itself — that form stayed
    // green when the constant was changed to 1.4, leaving the one number this
    // whole change is about pinned by nothing. 1.05 is the measured value;
    // moving it should require re-measuring, which means editing this line.
    expect(sentBody(f).repetition_penalty).toBe(1.05);
    expect(MLX_JUDGE_REPETITION_PENALTY).toBe(1.05);
  });

  it('honours an explicit value', async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal('fetch', f);
    await callJudgeWithMeta('judge', mlxCfg({ repetitionPenalty: 1.2 }));
    expect(sentBody(f).repetition_penalty).toBe(1.2);
  });

  // 1 means OFF, and off omits the field. Sending `repetition_penalty: 1` is a
  // no-op for the model but still costs a user on a strict server the 400 and
  // the retry probe, so "disabling" it would have had a price.
  it('omits the field entirely when set to 1', async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal('fetch', f);
    await callJudgeWithMeta('judge', mlxCfg({ repetitionPenalty: 1 }));
    expect(sentBody(f)).not.toHaveProperty('repetition_penalty');
  });
});

describe('repetitionPenalty settings validation', () => {
  const withSettings = async (value: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-rp-'));
    const orig = process.env.AGENTDECK_DATA_DIR;
    process.env.AGENTDECK_DATA_DIR = dir;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'),
        JSON.stringify({ apme: { judge: { backend: 'mlx', repetitionPenalty: value } } }));
      vi.resetModules();
      const { loadApmeConfig: load } = await import('../apme/settings.js');
      return load().judge.repetitionPenalty;
    } finally {
      if (orig === undefined) delete process.env.AGENTDECK_DATA_DIR; else process.env.AGENTDECK_DATA_DIR = orig;
      rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  };

  // Out of range is not a choice — below 1 rewards repetition, which is the
  // opposite of the point, and an unusable value must not reach the server.
  // NaN is deliberately absent: `JSON.stringify({a: NaN})` is `{"a":null}`, so
  // a NaN case here would just be the null case again and would claim coverage
  // of the `Number.isFinite` guard that it does not have. That guard is in fact
  // unreachable through settings.json and is kept only as defence.
  it.each([0.5, 0, -1, 3, 'high', null])('drops %s', async (v) => {
    expect(await withSettings(v)).toBeUndefined();
  });

  it.each([1, 1.05, 1.5, 2])('keeps %s', async (v) => {
    expect(await withSettings(v)).toBe(v);
  });
});

describe('loadApmeConfig baseline', () => {
  it('leaves repetitionPenalty unset by default so the leg default applies', () => {
    expect(loadApmeConfig().judge.repetitionPenalty).toBeUndefined();
  });
});

// The penalty is NOT an OpenAI-standard field, and `apme.judge.endpoint` may
// point at any OpenAI-shaped server. A strict one answers 400 — which
// `isJsonModeRejection` reads as "response_format refused", so without its own
// escape hatch the endpoint lost JSON mode for the life of the process AND the
// retry still carried the penalty and failed identically.
// The openai-compatible adapter's own doc lists OpenRouter and "any other
// OpenAI-compatible endpoint" among its targets, and several hosted providers
// DO honour `repetition_penalty` — so sending it there would silently change
// sampling for a judge the user pays per call, on evidence measured only
// against a local gemma-4-26b. The scope is stated, not silently discarded.
// The cap must allow all THREE diagnoses in one call. At 2 a server that
// refuses both fields and is then handed an oversized prompt loses its verdict
// again — the exact failure the re-diagnosing rewrite exists to prevent.
describe('the retry ladder allows every diagnosis', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('recovers from penalty refusal, then JSON-mode refusal, then overflow', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const f = vi.fn(async (_u: string, o: RequestInit) => {
      const body = JSON.parse(o.body as string);
      seen.push(body);
      if ('repetition_penalty' in body) return new Response('no such field', { status: 400 });
      if (body.response_format) return new Response('no such field', { status: 400 });
      const content = (body.messages as Array<{ content: string }>)[1].content;
      if (content.length > 15_000) {
        return new Response('Request needs 9000 context tokens (8000 prompt + 800 max generation), but MAX_KV_SIZE is 4096', { status: 400 });
      }
      return ok();
    });
    vi.stubGlobal('fetch', f);
    // A prompt long enough to trip the stub's overflow branch — with a short
    // one the third diagnosis is never reached and the test passes vacuously.
    const longPrompt = 'z'.repeat(20_000);
    const { text } = await callJudgeWithMeta(longPrompt, mlxCfg({
      endpoint: 'http://127.0.0.1:9997/v1/chat/completions',
    }));
    expect(text).toContain('overall');
    expect(seen).toHaveLength(4);
    expect(seen[1]).not.toHaveProperty('repetition_penalty');
    expect(seen[2]).not.toHaveProperty('response_format');
    expect(String((seen[3].messages as Array<{ content: string }>)[1].content).length).toBeLessThan(20_000);
  });
});

describe('openai-compatible leg is deliberately excluded', () => {
  afterEach(() => vi.unstubAllGlobals());
  const openAiCfg = (over: Record<string, unknown> = {}) => ({
    ...DEFAULT_APME_CONFIG.judge, backend: 'openai' as const, model: 'local-model',
    endpoint: 'http://127.0.0.1:11434/v1', fallbackToMlx: false,
    fallbackToFoundationModels: false, ...over,
  });

  it('never sends the penalty, not even the default', async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal('fetch', f);
    await callJudgeWithMeta('judge', openAiCfg());
    expect(sentBody(f)).not.toHaveProperty('repetition_penalty');
  });

  it('does not send it even when the user set one explicitly', async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal('fetch', f);
    await callJudgeWithMeta('judge', openAiCfg({ repetitionPenalty: 1.3 }));
    expect(sentBody(f)).not.toHaveProperty('repetition_penalty');
    // …and the rest of the request is untouched by that decision.
    expect(sentBody(f).response_format).toEqual({ type: 'json_object' });
  });
});

describe('a server that refuses repetition_penalty', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('drops the penalty first and keeps JSON mode', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const f = vi.fn(async (_u: string, o: RequestInit) => {
      const body = JSON.parse(o.body as string);
      seen.push(body);
      if ('repetition_penalty' in body) return new Response('unknown field', { status: 400 });
      return ok();
    });
    vi.stubGlobal('fetch', f);
    const { text } = await callJudgeWithMeta('judge', mlxCfg({ endpoint: 'http://127.0.0.1:9999/v1/chat/completions' }));
    expect(text).toContain('overall');
    expect(seen).toHaveLength(2);
    // The retry gave up the non-standard field, not the one the prompt depends on.
    expect(seen[1]).not.toHaveProperty('repetition_penalty');
    expect(seen[1]).toHaveProperty('response_format');
  });

  it('remembers the endpoint so the cost is one request, not one per call', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = vi.fn(async (u: string, o: RequestInit) => {
      const body = JSON.parse(o.body as string);
      seen.push({ url: u, body });
      if ('repetition_penalty' in body) return new Response('unknown field', { status: 400 });
      return ok();
    });
    vi.stubGlobal('fetch', f);
    const cfg = mlxCfg({ endpoint: 'http://127.0.0.1:9998/v1/chat/completions' });
    await callJudgeWithMeta('judge', cfg);
    const afterFirst = seen.length;
    await callJudgeWithMeta('judge', cfg);
    // Second call must not re-probe: one extra request, not two.
    expect(seen.length - afterFirst).toBe(1);
    // Assert the SHAPES, not only the count — a count alone passes just as
    // happily when the penalty was switched off globally by an earlier test,
    // which is how a process-global memory hid behind this assertion.
    expect(seen[0].body).toHaveProperty('repetition_penalty');
    expect(seen[1].body).not.toHaveProperty('repetition_penalty');
    expect(seen[2].body).not.toHaveProperty('repetition_penalty');
  });

  it('scopes that memory to the endpoint, so one strict server does not disarm the rest', async () => {
    // The penalty memory had no scoping test at all: making it process-global
    // left the whole suite green, while the same mutation on the json-mode
    // memory went red in two places. A one-sided gate is how an asymmetry
    // survives a green suite.
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = vi.fn(async (u: string, o: RequestInit) => {
      const body = JSON.parse(o.body as string);
      seen.push({ url: u, body });
      // ONLY the strict endpoint refuses the field.
      if (u.includes(':9994') && 'repetition_penalty' in body) {
        return new Response('unknown field', { status: 400 });
      }
      return ok();
    });
    vi.stubGlobal('fetch', f);
    await callJudgeWithMeta('judge', mlxCfg({ endpoint: 'http://127.0.0.1:9994/v1/chat/completions' }));
    expect(seen.filter((c) => c.url.includes(':9994'))).toHaveLength(2);

    // A DIFFERENT endpoint must still be offered the penalty.
    await callJudgeWithMeta('judge', mlxCfg({ endpoint: 'http://127.0.0.1:9993/v1/chat/completions' }));
    const other = seen.filter((c) => c.url.includes(':9993'));
    expect(other).toHaveLength(1);
    expect(other[0].body).toHaveProperty('repetition_penalty');
  });
});
