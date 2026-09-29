/**
 * HTTP-only detection of locally-running, de-facto-standard inference servers
 * so onboarding + the REVIEW judge-setup guide can offer "use what you already
 * have" instead of asking the user to configure an endpoint by hand.
 *
 * App Store safety: this is pure network I/O against loopback ports — NO
 * subprocess, NO CLI probe (`ollama list` etc.). The macOS sandbox's
 * `com.apple.security.network.client` covers loopback HTTP, so this runs
 * unchanged in the signed App Store daemon. Mirror: apple ApmeJudgeDetect.swift.
 */

import { resolveSafeMlxModel } from '@agentdeck/shared';

export interface DetectedProvider {
  /** Stable key: 'ollama' | 'lmstudio' | 'mlx' | 'openai-generic'. */
  provider: string;
  label: string;
  /** OpenAI-compatible base to store as apme.judge.endpoint. */
  endpoint: string;
  /** Chat model ids advertised by the server (first is a sensible default). */
  models: string[];
}

interface Candidate {
  provider: string;
  label: string;
  base: string;        // host root, no path
  endpoint: string;    // OpenAI-compatible base to persist
  tags?: boolean;      // Ollama-style /api/tags model list
}

const CANDIDATES: Candidate[] = [
  { provider: 'ollama', label: 'Ollama', base: 'http://127.0.0.1:11434', endpoint: 'http://127.0.0.1:11434/v1', tags: true },
  { provider: 'lmstudio', label: 'LM Studio', base: 'http://127.0.0.1:1234', endpoint: 'http://127.0.0.1:1234/v1' },
  { provider: 'mlx', label: 'Local MLX server', base: 'http://127.0.0.1:8800', endpoint: 'http://127.0.0.1:8800/v1' },
  { provider: 'mlx', label: 'Local MLX server', base: 'http://127.0.0.1:8080', endpoint: 'http://127.0.0.1:8080/v1' },
];

const NANO = 'nanollava';

/**
 * True when an Ollama catalog entry can actually answer a chat completion.
 *
 * Ollama advertises `capabilities` per model (`["completion","tools",…]` for
 * chat models, `["embedding"]` for embedders like `bge-m3`). Offering an
 * embedding-only model as a judge candidate is a trap: the picker looks fine
 * and the first real judge call fails with a 400 from the server.
 *
 * Absence of the field is "no information", NOT "unusable" — older Ollama
 * builds omit `capabilities` entirely, and dropping those would empty the
 * catalog on exactly the servers we can least afford to mis-report.
 */
function ollamaChatCapable(m: { capabilities?: unknown }): boolean {
  if (!Array.isArray(m.capabilities)) return true;
  return m.capabilities.some((c) => typeof c === 'string' && c.toLowerCase() === 'completion');
}

async function modelsFor(c: Candidate, timeoutMs: number): Promise<string[] | null> {
  if (c.provider === 'mlx') {
    try { return [await resolveSafeMlxModel(c.base)]; } catch { return null; }
  }
  // Ollama's canonical list is /api/tags; every OpenAI-compatible server
  // (LM Studio, MLX, vLLM, Ollama's compat shim) exposes /v1/models.
  if (c.tags) {
    try {
      const r = await fetch(`${c.base}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
      if (r?.ok) {
        const j = await r.json() as { models?: Array<{ name?: string; capabilities?: unknown }> };
        const catalog = j.models ?? [];
        const names = catalog
          .filter(ollamaChatCapable)
          .map((m) => m.name)
          .filter((n): n is string => !!n);
        // Once /api/tags answered, its verdict is final: falling through to
        // /v1/models would re-add the embedding-only models we just filtered
        // out, since the OpenAI-compatible shim reports no capabilities.
        if (catalog.length) return names;
      }
    } catch { /* fall through to /v1/models */ }
  }
  try {
    const r = await fetch(`${c.base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    if (r?.ok) {
      const j = await r.json() as { data?: Array<{ id?: string }> };
      const ids = (j.data ?? []).map((m) => m.id).filter((id): id is string => !!id && !id.toLowerCase().includes(NANO));
      return ids; // empty array = reachable but no usable model
    }
  } catch { /* unreachable */ }
  return null;
}

/**
 * Probe the standard local endpoints concurrently. Returns only servers that
 * are reachable AND advertise at least one usable chat model. De-duplicated by
 * (provider, endpoint) so the two MLX ports don't both show when one answers.
 */
export async function detectLocalJudgeProviders(timeoutMs = 1200): Promise<DetectedProvider[]> {
  const results = await Promise.all(CANDIDATES.map(async (c) => {
    const models = await modelsFor(c, timeoutMs);
    if (!models || models.length === 0) return null;
    return { provider: c.provider, label: c.label, endpoint: c.endpoint, models: models.slice(0, 12) } as DetectedProvider;
  }));
  const seen = new Set<string>();
  const out: DetectedProvider[] = [];
  for (const r of results) {
    if (!r) continue;
    const key = `${r.provider}:${r.endpoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
