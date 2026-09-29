import { clearMlxSafetyForTests, clearMlxSettingsCache } from '@agentdeck/shared';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeJudgeBackend, sanitizeForMlx, callJudgeWithMeta, clearFoundationModelsAutoCacheForTests } from '../apme/runner.js';
import { DEFAULT_APME_CONFIG, type ApmeJudgeConfig } from '../apme/settings.js';
import { clearFoundationModelsHelperForTests } from '../foundation-models-helper.js';

// Codex stop-time review (2026-04-30) caught that the original probe
// reported `status: 'ready'` for setups that would actually fail at first
// eval — MLX server with no chat model loaded, OpenClaw with /health up but
// /chat unrouted, Foundation Models endpoint reachable but Apple Intelligence
// not downloaded, ANTHROPIC_API_KEY set but @anthropic-ai/sdk missing. These
// tests pin the corrected behaviour: any setup that callJudge() would throw
// on must report `unavailable`, never `ready`.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_DATA_DIR = process.env.AGENTDECK_DATA_DIR;
const ORIGINAL_FM_HELPER = process.env.AGENTDECK_FM_HELPER;
let dataDir: string;

function makeFetchMock(routes: Record<string, { ok: boolean; status?: number; body?: unknown } | (() => Response)>): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (u.includes(pattern)) {
        if (typeof handler === 'function') return handler();
        const r = handler;
        return new Response(
          r.body !== undefined ? JSON.stringify(r.body) : null,
          { status: r.status ?? (r.ok ? 200 : 500), headers: { 'Content-Type': 'application/json' } },
        );
      }
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearMlxSafetyForTests();
  clearMlxSettingsCache();
  dataDir = mkdtempSync(join(tmpdir(), 'apme-judge-probe-'));
  process.env.AGENTDECK_DATA_DIR = dataDir;
  process.env.AGENTDECK_FM_HELPER = join(dataDir, 'missing-fm-helper');
  delete process.env.ANTHROPIC_API_KEY;
  clearFoundationModelsHelperForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGENTDECK_DATA_DIR;
  else process.env.AGENTDECK_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_FM_HELPER === undefined) delete process.env.AGENTDECK_FM_HELPER;
  else process.env.AGENTDECK_FM_HELPER = ORIGINAL_FM_HELPER;
  if (ORIGINAL_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
  clearFoundationModelsAutoCacheForTests();
  clearFoundationModelsHelperForTests();
  vi.restoreAllMocks();
});

const MLX_CFG: ApmeJudgeConfig = {
  backend: 'mlx', model: 'qwen3-30b', sampleRate: 1.0, onlyWhenDisagreement: false,
  endpoint: 'http://127.0.0.1:8800/v1/chat/completions',
};
const OPENCLAW_CFG: ApmeJudgeConfig = {
  backend: 'openclaw', model: 'claude-sonnet-4-6', sampleRate: 1.0, onlyWhenDisagreement: false,
  endpoint: 'http://127.0.0.1:18789/chat',
};
const API_CFG: ApmeJudgeConfig = {
  backend: 'api', model: 'claude-opus-4-7', sampleRate: 1.0, onlyWhenDisagreement: false,
};

describe('probeJudgeBackend — MLX', () => {
  it('returns unavailable when /v1/models is unreachable', async () => {
    globalThis.fetch = makeFetchMock({
      '/v1/models': () => { throw new Error('ECONNREFUSED'); },
      '/models': () => { throw new Error('ECONNREFUSED'); },
    });
    const r = await probeJudgeBackend(MLX_CFG);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/ECONNREFUSED/i);
  });

  it('returns unavailable when /v1/models advertises no chat-capable model', async () => {
    globalThis.fetch = makeFetchMock({
      '/v1/models': { ok: true, body: { data: [{ id: 'nanollava-tiny' }, { id: 'mlx-community/nanollava-2' }] } },
    });
    const r = await probeJudgeBackend({ ...MLX_CFG, model: '' as string });
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/no unambiguous resident chat model/i);
  });

  it('returns unavailable when chat ping fails (model not loaded)', async () => {
    globalThis.fetch = makeFetchMock({
      '/v1/models': { ok: true, body: { data: [{ id: 'qwen3-30b' }] } },
      '/chat/completions': { ok: false, status: 400, body: { error: 'model not loaded' } },
    });
    const r = await probeJudgeBackend(MLX_CFG);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/inference failed/i);
  });

  it('returns ready when catalog AND chat ping both succeed', async () => {
    globalThis.fetch = makeFetchMock({
      '/v1/models': { ok: true, body: { data: [{ id: 'qwen3-30b' }] } },
      '/chat/completions': { ok: true, body: { choices: [{ message: { content: 'ok' } }] } },
    });
    const r = await probeJudgeBackend(MLX_CFG);
    expect(r.status).toBe('ready');
    expect(r.model).toBeTruthy();
  });
});

describe('probeJudgeBackend — OpenClaw', () => {
  it('returns unavailable when /health is unreachable', async () => {
    globalThis.fetch = makeFetchMock({
      '/health': () => { throw new Error('ECONNREFUSED'); },
    });
    const r = await probeJudgeBackend(OPENCLAW_CFG);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/health unreachable/i);
  });

  it('returns unavailable when /health is up but /models is not (gateway not initialised)', async () => {
    globalThis.fetch = makeFetchMock({
      '/health': { ok: true, body: { ok: true } },
      '/models': { ok: false, status: 404 },
    });
    const r = await probeJudgeBackend(OPENCLAW_CFG);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/not fully initialised|/);
  });

  it('returns unavailable when configured model is not in /models catalog', async () => {
    globalThis.fetch = makeFetchMock({
      '/health': { ok: true, body: { ok: true } },
      '/models': { ok: true, body: { data: [{ id: 'gpt-4' }, { id: 'gemini-pro' }] } },
    });
    const r = await probeJudgeBackend(OPENCLAW_CFG);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/not advertised/i);
  });

  it('returns ready when /health + /models both up and model matches', async () => {
    globalThis.fetch = makeFetchMock({
      '/health': { ok: true, body: { ok: true } },
      '/models': { ok: true, body: { data: [{ id: 'claude-sonnet-4-6' }] } },
    });
    const r = await probeJudgeBackend(OPENCLAW_CFG);
    expect(r.status).toBe('ready');
  });
});

describe('probeJudgeBackend — Anthropic API (opt-in backend)', () => {
  // The API backend is now implemented via @anthropic-ai/sdk, but stays
  // strictly OPT-IN: with no credential the probe must report 'unavailable'
  // with actionable setup guidance (never a false 'ready'). A credential
  // present drives a real Models-endpoint check — not asserted here to keep
  // the unit test offline.
  it('returns unavailable with setup guidance when no credential is present', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const r = await probeJudgeBackend(API_CFG);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/no Anthropic API credential/i);
    expect(r.reason).toMatch(/ANTHROPIC_API_KEY|ant auth login|apiKey/i);
  });
});

describe('callJudgeWithMeta — effective backend labelling across fallback', () => {
  // Codex stop-time finding: FM→MLX fallback caller still wrote
  // `evals.judge_model = 'foundationModels:apple-intelligence'` even though
  // MLX produced the response. callJudgeWithMeta must report the effective
  // backend so the DB row is honest.

  it('FM happy path labels eval as foundationModels', async () => {
    globalThis.fetch = makeFetchMock({
      '/apme/judge/foundation-models': { ok: true, body: { text: '{"overall":0.7}' } },
    });
    const result = await callJudgeWithMeta('p', {
      backend: 'foundationModels', model: 'apple-intelligence',
      endpoint: 'http://127.0.0.1:9120/apme/judge/foundation-models',
      sampleRate: 1, onlyWhenDisagreement: false,
    });
    expect(result.effectiveBackend).toBe('foundationModels');
    expect(result.effectiveLabel).toBe('foundationModels:apple-intelligence');
    expect(result.text).toContain('overall');
  });

  it('FM→MLX fallback (fallbackToMlx=true) labels eval as mlx, not foundationModels', async () => {
    // Use loose substrings — mlxChatUrl() may emit /v1/chat/completions or
    // /chat/completions depending on user pinning, and the mock must catch
    // either form. /apme/judge/foundation-models is checked first so it doesn't
    // accidentally match the looser substrings.
    globalThis.fetch = makeFetchMock({
      '/apme/judge/foundation-models': () => { throw new Error('FM down'); },
      'models': { ok: true, body: { data: [{ id: 'qwen3-30b' }] } },
      'completions': { ok: true, body: { choices: [{ message: { content: '{"overall":0.5}' } }] } },
    });
    const result = await callJudgeWithMeta('p', {
      backend: 'foundationModels', model: 'apple-intelligence',
      endpoint: 'http://127.0.0.1:9120/apme/judge/foundation-models',
      sampleRate: 1, onlyWhenDisagreement: false,
      fallbackToMlx: true,
    });
    expect(result.effectiveBackend).toBe('mlx');
    expect(result.effectiveLabel).toMatch(/^mlx:/);
    expect(result.effectiveLabel).not.toMatch(/foundationModels|apple-intelligence/);
    expect(result.text).toContain('overall');
  });

  it('FM failure without fallbackToMlx propagates the error (no silent label drift)', async () => {
    globalThis.fetch = makeFetchMock({
      '/apme/judge/foundation-models': () => { throw new Error('FM down'); },
    });
    await expect(callJudgeWithMeta('p', {
      backend: 'foundationModels', model: 'apple-intelligence',
      endpoint: 'http://127.0.0.1:9120/apme/judge/foundation-models',
      sampleRate: 1, onlyWhenDisagreement: false,
      fallbackToMlx: false,
    })).rejects.toThrow();
  });
});

describe('sanitizeForMlx — runtime fallback hygiene', () => {
  // Codex stop-time finding: callJudge's foundationModels→mlx fallback path
  // used to forward the FM cfg unchanged. callMlx then POSTed to the FM
  // endpoint and asked MLX for `apple-intelligence`. This helper is the
  // companion to loadApmeConfig's resetBackendCoupledFields — same invariant,
  // applied at runtime instead of settings load.

  it('strips FM endpoint and model when forcing to MLX', () => {
    const fm: ApmeJudgeConfig = {
      backend: 'foundationModels',
      model: 'apple-intelligence',
      endpoint: 'http://127.0.0.1:9120/apme/judge/foundation-models',
      sampleRate: 1.0,
      onlyWhenDisagreement: false,
      fallbackToMlx: true,
    };
    const out = sanitizeForMlx(fm);
    expect(out.backend).toBe('mlx');
    expect(out.endpoint).toBeUndefined();
    expect(out.model).toBe(DEFAULT_APME_CONFIG.judge.model);
    // Other knobs survive — sampleRate / onlyWhenDisagreement aren't backend-coupled.
    expect(out.sampleRate).toBe(1.0);
    expect(out.fallbackToMlx).toBe(true);
  });

  it('strips OpenClaw endpoint and model when forcing to MLX', () => {
    const oc: ApmeJudgeConfig = {
      backend: 'openclaw',
      model: 'claude-sonnet-4-6',
      endpoint: 'http://127.0.0.1:18789/chat',
      sampleRate: 1.0,
      onlyWhenDisagreement: false,
    };
    const out = sanitizeForMlx(oc);
    expect(out.backend).toBe('mlx');
    expect(out.endpoint).toBeUndefined();
    expect(out.model).toBe(DEFAULT_APME_CONFIG.judge.model);
  });

  it('returns the same cfg shape when already-clean MLX is passed', () => {
    const mlx: ApmeJudgeConfig = {
      backend: 'mlx',
      model: DEFAULT_APME_CONFIG.judge.model,
      sampleRate: 1.0,
      onlyWhenDisagreement: false,
    };
    const out = sanitizeForMlx(mlx);
    expect(out.backend).toBe('mlx');
    expect(out.endpoint).toBeUndefined();
    expect(out.model).toBe(DEFAULT_APME_CONFIG.judge.model);
  });

  it('clears a custom MLX endpoint when source backend is MLX but model is overridden', () => {
    // Edge case: cfg.backend === 'mlx' AND cfg.model is non-default; the user
    // configured a specific local model. We don't want to wipe their override
    // here because they're already on MLX. Caller (callJudge) only ever calls
    // sanitizeForMlx on the FALLBACK path, not the happy path, so this case
    // shouldn't arise in practice — but we still preserve the override
    // because the cfg is already mlx-typed.
    const mlxOverride: ApmeJudgeConfig = {
      backend: 'mlx',
      model: 'qwen3-72b-custom',
      endpoint: 'http://192.0.2.1:9999/v1/chat/completions',
      sampleRate: 1.0,
      onlyWhenDisagreement: false,
    };
    const out = sanitizeForMlx(mlxOverride);
    expect(out.backend).toBe('mlx');
    // backend was already mlx — sanitization wipes anyway because the helper
    // can't distinguish "intentional override" from "leaked fields". Document
    // this in the assertion: the contract is "MLX-clean output", not preservation.
    expect(out.endpoint).toBeUndefined();
    expect(out.model).toBe(DEFAULT_APME_CONFIG.judge.model);
  });
});

describe('probeJudgeBackend — Foundation Models', () => {
  it('returns unavailable when Swift daemon FM endpoint cannot be resolved', async () => {
    // No Swift daemon → resolveFoundationModelsUrl() returns null. Inject a
    // fetch mock that fails everything so any incidental probe also fails.
    globalThis.fetch = makeFetchMock({});
    const fmCfg: ApmeJudgeConfig = {
      backend: 'foundationModels', model: 'apple-intelligence',
      sampleRate: 1.0, onlyWhenDisagreement: false,
      // No endpoint set → resolver tries findDaemonPortAsync which depends on
      // a running Swift daemon. In CI / Node-only test env this returns null.
    };
    const r = await probeJudgeBackend(fmCfg);
    // Either Swift daemon unreachable OR the FM endpoint ping fails — both
    // are valid `unavailable` outcomes. The contract is just: never `ready`.
    expect(r.status).toBe('unavailable');
  });

  it('returns unavailable when FM endpoint responds with error body', async () => {
    globalThis.fetch = makeFetchMock({
      '/apme/judge/foundation-models': {
        ok: true,
        body: { error: 'unavailable', reason: 'Apple Intelligence not downloaded' },
      },
    });
    const fmCfg: ApmeJudgeConfig = {
      backend: 'foundationModels', model: 'apple-intelligence',
      sampleRate: 1.0, onlyWhenDisagreement: false,
      endpoint: 'http://127.0.0.1:9120/apme/judge/foundation-models',
    };
    const r = await probeJudgeBackend(fmCfg);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toMatch(/Apple Intelligence|unavailable/i);
  });

  it('returns ready when FM endpoint responds with text', async () => {
    globalThis.fetch = makeFetchMock({
      '/apme/judge/foundation-models': { ok: true, body: { text: 'ok' } },
    });
    const fmCfg: ApmeJudgeConfig = {
      backend: 'foundationModels', model: 'apple-intelligence',
      sampleRate: 1.0, onlyWhenDisagreement: false,
      endpoint: 'http://127.0.0.1:9120/apme/judge/foundation-models',
    };
    const r = await probeJudgeBackend(fmCfg);
    expect(r.status).toBe('ready');
  });
});
