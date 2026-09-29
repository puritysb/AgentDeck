import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadMlxSettings,
  resolveMlxModel,
  pickMlxModel,
  clearMlxSettingsCache,
  mlxChatUrl,
  MLX_FALLBACK_MODEL,
} from '../llm-settings.js';

const originalDataDir = process.env.AGENTDECK_DATA_DIR;

function writeSettings(dir: string, obj: unknown): void {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(obj, null, 2));
  clearMlxSettingsCache();
}

describe('llm-settings', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-llm-'));
    process.env.AGENTDECK_DATA_DIR = dir;
    clearMlxSettingsCache();
  });

  afterAll(() => {
    if (originalDataDir === undefined) {
      delete process.env.AGENTDECK_DATA_DIR;
    } else {
      process.env.AGENTDECK_DATA_DIR = originalDataDir;
    }
  });

  it('returns defaults when settings.json is missing', () => {
    rmSync(dir, { recursive: true, force: true });
    const s = loadMlxSettings();
    expect(s.endpoint).toBe('http://127.0.0.1:8800');
    expect(s.model).toBeNull();
  });

  it('reads llm.mlx pin from settings.json', () => {
    writeSettings(dir, {
      llm: { mlx: { endpoint: 'http://127.0.0.1:9999', model: 'mlx-community/Qwen3-1.7B-4bit' } },
    });
    const s = loadMlxSettings();
    expect(s.endpoint).toBe('http://127.0.0.1:9999');
    expect(s.model).toBe('mlx-community/Qwen3-1.7B-4bit');
  });

  it('treats "qwen3-30b" and "default" as placeholders (unpinned)', () => {
    writeSettings(dir, { llm: { mlx: { model: 'qwen3-30b' } } });
    expect(loadMlxSettings().model).toBeNull();

    writeSettings(dir, { llm: { mlx: { model: 'default' } } });
    expect(loadMlxSettings().model).toBeNull();

    writeSettings(dir, { llm: { mlx: { model: '' } } });
    expect(loadMlxSettings().model).toBeNull();
  });

  it('falls back to apme.judge.model when llm.mlx is absent', () => {
    writeSettings(dir, {
      apme: { judge: { model: 'mlx-community/Qwen3-1.7B-4bit' } },
    });
    expect(loadMlxSettings().model).toBe('mlx-community/Qwen3-1.7B-4bit');
  });

  it('strips /chat/completions suffix from legacy endpoints', () => {
    writeSettings(dir, {
      apme: { judge: { endpoint: 'http://127.0.0.1:8800/v1/chat/completions', model: 'foo' } },
    });
    expect(loadMlxSettings().endpoint).toBe('http://127.0.0.1:8800');
  });

  it('prefers llm.mlx over apme.judge when both set', () => {
    writeSettings(dir, {
      llm: { mlx: { model: 'A' } },
      apme: { judge: { model: 'B' } },
    });
    expect(loadMlxSettings().model).toBe('A');
  });

  it('resolveMlxModel: refuses to invent a model', () => {
    writeSettings(dir, { llm: { mlx: { model: 'pinned' } } });
    expect(resolveMlxModel('probed')).toBe('pinned');

    writeSettings(dir, {});
    expect(resolveMlxModel('probed')).toBe('probed');

    writeSettings(dir, {});
    expect(() => resolveMlxModel()).toThrow(/not configured or verified/);
    expect(() => resolveMlxModel(null)).toThrow(/not configured or verified/);
    expect(() => resolveMlxModel('')).toThrow(/not configured or verified/);
  });

  it('pickMlxModel requires a singleton catalog and matching pin', () => {
    expect(pickMlxModel(null)).toBeNull();
    expect(pickMlxModel([])).toBeNull();
    expect(pickMlxModel(['a', 'b'], 'a')).toBeNull();
    expect(pickMlxModel(['a', 'b'])).toBeNull();
    expect(pickMlxModel(['a'], 'b')).toBeNull();
    expect(pickMlxModel(['a'], 'a')).toBe('a');
    expect(pickMlxModel(['a', 'a'])).toBe('a');
  });

  it.each(['openai', 'api', 'foundationModels', 'openclaw'])('never inherits %s credentials routing into MLX', (backend) => {
    writeSettings(dir, { apme: { judge: { backend, model: 'other', endpoint: 'https://other.invalid/v1' } } });
    expect(loadMlxSettings()).toEqual({ endpoint: 'http://127.0.0.1:8800', model: null });
  });

  it('an explicit default MLX endpoint is not overridden by a legacy custom endpoint', () => {
    writeSettings(dir, { llm: { mlx: { endpoint: 'http://127.0.0.1:8800' } },
      apme: { judge: { backend: 'mlx', endpoint: 'http://other.invalid:8800' } } });
    expect(loadMlxSettings().endpoint).toBe('http://127.0.0.1:8800');
  });

  it('does not redirect an invalid explicit endpoint to a running loopback server', () => {
    writeSettings(dir, { llm: { mlx: { endpoint: 'not-a-url', model: 'chosen' } } });
    expect(loadMlxSettings()).toEqual({ endpoint: 'not-a-url', model: 'chosen' });
  });

  it('mlxChatUrl reflects endpoint setting', () => {
    writeSettings(dir, { llm: { mlx: { endpoint: 'http://10.0.0.5:4242' } } });
    expect(mlxChatUrl()).toBe('http://10.0.0.5:4242/chat/completions');
  });

  it('caches result for TTL window', () => {
    writeSettings(dir, { llm: { mlx: { model: 'first' } } });
    expect(loadMlxSettings().model).toBe('first');

    // Rewrite without clearing cache — still returns first.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ llm: { mlx: { model: 'second' } } }));
    expect(loadMlxSettings().model).toBe('first');

    clearMlxSettingsCache();
    expect(loadMlxSettings().model).toBe('second');
  });
});
