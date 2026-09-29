import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_RETRY_LADDER_MS,
  catalogFromModelsList,
  catalogRetryDelayMs,
  explicitDefaultModelName,
  parseModelRole,
} from '../openclaw-model-catalog.js';

// The same frame the Swift adapter's parity suite decodes.
const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../tests/parity/gateway-frames/models-list-response.json', import.meta.url)), 'utf8'));

describe('catalogFromModelsList', () => {
  it('reads the parity fixture the way the Swift adapter does', () => {
    const catalog = catalogFromModelsList(FIXTURE.payload);
    expect(catalog).toEqual({
      entries: [
        { key: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', role: 'default', available: true },
        { key: 'openai/gpt-5.4', name: 'GPT-5.4', role: 'fallback-1', available: true },
      ],
      defaultModel: 'Claude Sonnet 4.5',
    });
  });

  it('joins provider/id into the CLI key form, then falls back through id and provider/name; title/id for the name', () => {
    // Live shape (openclaw 2026.9.3 `models.list`): bare `id` + `provider`.
    const catalog = catalogFromModelsList({ models: [
      { id: 'glm-5.3', name: 'GLM-5.3 (1M)', provider: 'zai', tags: ['default'] },
      { id: 'mlx-community/gemma-4-26b-a4b-it-4bit', name: 'Gemma 4 (Local MLX)', provider: 'local-mlx' },
      { id: 'local/gemma', title: 'Gemma (MLX)' },
      { provider: 'zai', name: 'glm-5.2' },
      { key: 'x/y' },
    ] });
    expect(catalog?.entries).toEqual([
      { key: 'zai/glm-5.3', name: 'GLM-5.3 (1M)', role: 'default', available: true },
      { key: 'local-mlx/mlx-community/gemma-4-26b-a4b-it-4bit', name: 'Gemma 4 (Local MLX)', role: 'configured', available: true },
      { key: 'local/gemma', name: 'Gemma (MLX)', role: 'configured', available: true },
      { key: 'zai/glm-5.2', name: 'glm-5.2', role: 'configured', available: true },
      { key: 'x/y', name: 'x/y', role: 'configured', available: true },
    ]);
    expect(catalog?.defaultModel).toBe('GLM-5.3 (1M)');
  });

  it('a missing or unavailable model is not available; non-string tags are ignored', () => {
    const catalog = catalogFromModelsList({ models: [
      { key: 'a', name: 'A', missing: true },
      { key: 'b', name: 'B', available: false },
      { key: 'c', name: 'C', tags: ['fallback#2', 7, null] },
    ] });
    expect(catalog?.entries.map((e) => [e.key, e.available, e.role])).toEqual([
      ['a', false, 'configured'], ['b', false, 'configured'], ['c', true, 'fallback-2'],
    ]);
  });

  it('answers null for a payload without a usable list — not an empty catalog', () => {
    expect(catalogFromModelsList(null)).toBeNull();
    expect(catalogFromModelsList({})).toBeNull();
    expect(catalogFromModelsList({ models: 'nope' })).toBeNull();
    expect(catalogFromModelsList({ models: [] })).toBeNull();
    expect(catalogFromModelsList({ models: [{ provider: '', name: '' }, 42] })).toBeNull();
  });
});

describe('explicitDefaultModelName', () => {
  const entries = [
    { key: 'local/first', name: 'Local First', role: 'configured' as const, available: true },
    { key: 'zai/glm-5.3', name: 'GLM-5.3 (1M)', role: 'default' as const, available: true },
  ];
  it('an explicit payload key wins and resolves to the display name', () => {
    expect(explicitDefaultModelName({ defaultModel: 'local/first' }, entries)).toBe('Local First');
    expect(explicitDefaultModelName({ primaryModel: 'zai/glm-5.3' }, entries)).toBe('GLM-5.3 (1M)');
    expect(explicitDefaultModelName({ default: 'not/listed' }, entries)).toBe('not/listed');
  });
  it('otherwise only a default tag counts — never catalog order', () => {
    expect(explicitDefaultModelName({}, entries)).toBe('GLM-5.3 (1M)');
    expect(explicitDefaultModelName({}, [entries[0]])).toBeNull();
    expect(explicitDefaultModelName({ defaultModel: '   ' }, [entries[0]])).toBeNull();
  });
});

describe('parseModelRole', () => {
  it('maps tags like the CLI parser and the Swift adapter', () => {
    expect(parseModelRole(['default'])).toBe('default');
    expect(parseModelRole(['fallback#3'])).toBe('fallback-3');
    expect(parseModelRole(['local'])).toBe('configured');
    expect(parseModelRole([])).toBe('configured');
  });
});

describe('catalogRetryDelayMs', () => {
  it('climbs the ladder and then holds at the last rung forever', () => {
    expect(CATALOG_RETRY_LADDER_MS.map((_, i) => catalogRetryDelayMs(i))).toEqual([...CATALOG_RETRY_LADDER_MS]);
    expect(catalogRetryDelayMs(CATALOG_RETRY_LADDER_MS.length + 40)).toBe(300_000);
    expect(catalogRetryDelayMs(-1)).toBe(10_000);
  });
});
