/**
 * Local judge auto-detection.
 *
 * The trap this guards: Ollama's catalog mixes chat models with embedders
 * (`bge-m3` and friends). Listing an embedder as a judge candidate is worse
 * than listing nothing — the picker looks healthy and the failure only shows
 * up on the first real judge call, after the user has already chosen it.
 *
 * `capabilities` is the authoritative signal; its ABSENCE is "no information"
 * (older Ollama builds omit it), so entries without the field stay.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectLocalJudgeProviders } from '../apme/judge-detect.js';

type Handler = (url: string) => { status: number; body: unknown } | null;

function mockFetch(handler: Handler): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const hit = handler(url);
    if (!hit) throw new Error(`connection refused: ${url}`);
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: async () => hit.body,
    } as unknown as Response;
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectLocalJudgeProviders', () => {
  it('drops embedding-only Ollama models', async () => {
    mockFetch((url) => {
      if (url.includes('11434/api/tags')) {
        return {
          status: 200,
          body: {
            models: [
              { name: 'bge-m3:latest', capabilities: ['embedding'] },
              { name: 'qwen2.5:7b', capabilities: ['completion', 'tools'] },
            ],
          },
        };
      }
      return null;
    });

    const found = await detectLocalJudgeProviders(50);
    expect(found).toHaveLength(1);
    expect(found[0].provider).toBe('ollama');
    expect(found[0].models).toEqual(['qwen2.5:7b']);
  });

  it('reports no provider when every Ollama model is an embedder', async () => {
    mockFetch((url) => {
      if (url.includes('11434/api/tags')) {
        return { status: 200, body: { models: [{ name: 'bge-m3:latest', capabilities: ['embedding'] }] } };
      }
      // The OpenAI-compatible shim lists the same embedder with no capability
      // info — detection must NOT fall through to it and re-add the model.
      if (url.includes('11434/v1/models')) {
        return { status: 200, body: { data: [{ id: 'bge-m3:latest' }] } };
      }
      return null;
    });

    const found = await detectLocalJudgeProviders(50);
    expect(found).toEqual([]);
  });

  it('keeps models from servers that report no capabilities at all', async () => {
    mockFetch((url) => {
      if (url.includes('11434/api/tags')) {
        return { status: 200, body: { models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }] } };
      }
      return null;
    });

    const found = await detectLocalJudgeProviders(50);
    expect(found[0].models).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
  });

  it('still detects OpenAI-compatible servers via /v1/models', async () => {
    mockFetch((url) => {
      if (url.includes('1234/v1/models')) {
        return { status: 200, body: { data: [{ id: 'gemma-3-12b' }, { id: 'nanollava-1.5' }] } };
      }
      return null;
    });

    const found = await detectLocalJudgeProviders(50);
    expect(found).toHaveLength(1);
    expect(found[0].provider).toBe('lmstudio');
    // nanollava loads for vision work and judges badly — filtered as before.
    expect(found[0].models).toEqual(['gemma-3-12b']);
  });

  it('returns nothing when no local server answers', async () => {
    mockFetch(() => null);
    expect(await detectLocalJudgeProviders(50)).toEqual([]);
  });
});

describe('MLX discovery uses residency rather than downloads', () => {
  it('offers only the resident model when another download appears first', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.includes(':8800/')) throw new Error('offline');
      if (url.endsWith('/health')) return Response.json({ loaded_model: 'gemma' });
      if (url.endsWith('/metrics')) return Response.json({ summary: { in_flight: 0 } });
      return Response.json({ data: [{ id: 'qwen' }, { id: 'gemma' }] });
    }));
    const found = await detectLocalJudgeProviders();
    expect(found).toEqual([{ provider: 'mlx', label: 'Local MLX server', endpoint: 'http://127.0.0.1:8800/v1', models: ['gemma'] }]);
  });

  it('does not offer an ambiguous catalog-only MLX server', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.includes(':8800/')) throw new Error('offline');
      if (url.endsWith('/health')) return new Response(null, { status: 404 });
      return Response.json({ data: [{ id: 'qwen' }, { id: 'gemma' }] });
    }));
    expect(await detectLocalJudgeProviders()).toEqual([]);
  });
});
