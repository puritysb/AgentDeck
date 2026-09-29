import { withMlxResident } from './mlx-test-server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callJudgeWithMeta, MLX_JUDGE_REPETITION_PENALTY } from '../apme/runner.js';
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

describe('MLX judge repetition penalty', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The default is not a taste knob — it is the measured cut rate: 4 of 6 tasks
  // → 1 of 6 (12/18 → 3/18 observations) under two designs, back-to-back and
  // interleaved. It is deliberately NOT claimed that the failure is permanent;
  // see MLX_JUDGE_REPETITION_PENALTY.
  it('sends the measured default when the user set nothing', async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
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
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
    await callJudgeWithMeta('judge', mlxCfg({ repetitionPenalty: 1.2 }));
    expect(sentBody(f).repetition_penalty).toBe(1.2);
  });

  // 1 means OFF, and off omits the field. Sending `repetition_penalty: 1` is a
  // no-op for the model but still costs a user on a strict server the 400 and
  // the retry probe, so "disabling" it would have had a price.
  it('omits the field entirely when set to 1', async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
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
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
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

  it('stops when the prompt is already at the compaction target instead of resending it', async () => {
    // `compacted === body` means another pass would post byte-identical bytes.
    // Without the break the loop spends its remaining attempts on a request
    // that cannot change, and the caller waits out every one of them.
    const bodies: string[] = [];
    const f = vi.fn(async (_u: string, o: RequestInit) => {
      const body = JSON.parse(o.body as string);
      bodies.push((body.messages as Array<{ content: string }>)[1].content);
      // Always claims overflow, and always with numbers that resolve to a
      // target ABOVE this prompt's length — so compaction is a no-op.
      return new Response('Request needs 9000 context tokens (8000 prompt + 800 max generation), but MAX_KV_SIZE is 40960', { status: 400 });
    });
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
    await expect(callJudgeWithMeta('short', mlxCfg({
      endpoint: 'http://127.0.0.1:9990/v1/chat/completions',
      repetitionPenalty: 1,
    }))).rejects.toThrow(/MLX judge HTTP 400/);
    expect(bodies).toHaveLength(1);
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
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
    await callJudgeWithMeta('judge', openAiCfg());
    expect(sentBody(f)).not.toHaveProperty('repetition_penalty');
  });

  it('does not send it even when the user set one explicitly', async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
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
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
    const { text } = await callJudgeWithMeta('judge', mlxCfg({ endpoint: 'http://127.0.0.1:9999/v1/chat/completions' }));
    expect(text).toContain('overall');
    expect(seen).toHaveLength(2);
    // The retry gave up the non-standard field, not the one the prompt depends on.
    expect(seen[1]).not.toHaveProperty('repetition_penalty');
    expect(seen[1]).toHaveProperty('response_format');
  });

  // Owner decision (#299 item 1, 2026-09-10): the per-endpoint "unsupported
  // field" memory is DELETED. A strict server costs one extra request on
  // EVERY call, forever — never remembered, never amortized across calls or
  // scoped per endpoint, because there is no memory left to scope.
  it('costs one extra request on every call — nothing is remembered between calls', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = vi.fn(async (u: string, o: RequestInit) => {
      const body = JSON.parse(o.body as string);
      seen.push({ url: u, body });
      if ('repetition_penalty' in body) return new Response('unknown field', { status: 400 });
      return ok();
    });
    vi.stubGlobal('fetch', withMlxResident(f as typeof fetch, 'gemma-test'));
    const cfg = mlxCfg({ endpoint: 'http://127.0.0.1:9998/v1/chat/completions' });
    await callJudgeWithMeta('judge', cfg);
    // First call: two requests (probe, then the field dropped).
    expect(seen).toHaveLength(2);
    expect(seen[0].body).toHaveProperty('repetition_penalty');
    expect(seen[1].body).not.toHaveProperty('repetition_penalty');

    await callJudgeWithMeta('judge', cfg);
    // Second call to the SAME strict endpoint must probe again — two more
    // requests, not one. A memory would have made this one.
    expect(seen).toHaveLength(4);
    expect(seen[2].body).toHaveProperty('repetition_penalty');
    expect(seen[3].body).not.toHaveProperty('repetition_penalty');
  });
});
