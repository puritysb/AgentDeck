/**
 * OpenClaw model catalog from the Gateway's own `models.list` RPC.
 *
 * The Node adapter used to learn the catalog only by spawning
 * `openclaw models list --json` once at connect (5 s subprocess timeout, one
 * retry ten seconds later, then nothing until the next reconnect). On
 * 2026-09-11 a daemon restart landed while an Xcode build and a Gradle build
 * were starting (load 13–15); both attempts timed out and every surface ran
 * without a catalog or a Gateway model name until the daemon was restarted
 * again. The Gateway answers `models.list` over the socket the adapter already
 * holds — no subprocess, no PATH, no load sensitivity — and the Swift adapter
 * has read it that way since the catalog row shipped (`OpenClawAdapter.
 * fetchModelCatalog`). This module is the Node mirror of that mapping; the Node
 * suite replays `tests/parity/gateway-frames/models-list-response.json` through
 * it (the Swift parity suite's `models.list` case is still the fixtures
 * README's Phase 4-B follow-up).
 */
import type { ModelCatalogEntry, ModelsListResult, OpenClawModel } from '@agentdeck/shared';

export interface ResolvedModelCatalog {
  entries: ModelCatalogEntry[];
  /** Display name of the configured default model, when the payload names one. */
  defaultModel: string | null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** `default` → default, `fallback#N` → fallback-N, else configured (Swift `parseModelRole`). */
export function parseModelRole(tags: readonly string[]): ModelCatalogEntry['role'] {
  if (tags.includes('default')) return 'default';
  for (const tag of tags) {
    const match = /^fallback#(\d+)$/.exec(tag);
    if (match) return `fallback-${match[1]}` as `fallback-${number}`;
  }
  return 'configured';
}

function entryFromModel(model: OpenClawModel): ModelCatalogEntry | null {
  const provider = nonEmpty(model.provider);
  const bareName = nonEmpty(model.name);
  const id = nonEmpty(model.id);
  // The live Gateway (openclaw 2026.9.3) sends a bare `id` plus `provider`
  // (`glm-5.3` + `zai`), while the CLI the daemon used to read sent the joined
  // `key` (`zai/glm-5.3`, and `local-mlx/mlx-community/…` — the provider is
  // prefixed even when the id already carries a slash). Keep the CLI form so
  // nothing keyed on it shifts across the transport change.
  const key = nonEmpty(model.key)
    ?? (id && provider ? `${provider}/${id}` : id)
    ?? [provider, bareName].filter((s): s is string => !!s).join('/');
  const name = bareName ?? nonEmpty(model.title) ?? nonEmpty(model.id) ?? key;
  if (!key || !name) return null;
  const tags = Array.isArray(model.tags) ? model.tags.filter((t): t is string => typeof t === 'string') : [];
  const available = (model.available !== false) && model.missing !== true;
  return { key, name, role: parseModelRole(tags), available };
}

/**
 * Never infer the configured model from catalog ORDER: `models.list` may omit
 * the CLI-only `default` tag, and local models commonly sort before the real
 * remote primary. An explicit `defaultModel` / `primaryModel` / `default` key
 * on the payload wins; a `default` tag is the only other evidence; otherwise
 * the answer is "unknown", not the first row.
 */
export function explicitDefaultModelName(
  payload: Record<string, unknown>,
  entries: readonly ModelCatalogEntry[],
): string | null {
  const explicitKey = nonEmpty(payload.defaultModel) ?? nonEmpty(payload.primaryModel) ?? nonEmpty(payload.default);
  if (explicitKey) return entries.find((e) => e.key === explicitKey)?.name ?? explicitKey;
  return entries.find((e) => e.role === 'default')?.name ?? null;
}

/** Read a `models.list` result payload. `null` when it carries no usable list. */
export function catalogFromModelsList(payload: unknown): ResolvedModelCatalog | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Partial<ModelsListResult> & Record<string, unknown>;
  if (!Array.isArray(p.models)) return null;
  const entries = p.models
    .map((m) => (m && typeof m === 'object' ? entryFromModel(m as OpenClawModel) : null))
    .filter((e): e is ModelCatalogEntry => e !== null);
  if (entries.length === 0) return null;
  return { entries, defaultModel: explicitDefaultModelName(p, entries) };
}

/**
 * Retry ladder for a catalog that could not be fetched: quick at first (the
 * Gateway is usually just busy right after connect), then every five minutes
 * for as long as the adapter is alive — a catalog is never abandoned for the
 * connection's lifetime.
 */
export const CATALOG_RETRY_LADDER_MS: readonly number[] = [10_000, 30_000, 60_000, 120_000, 300_000];

export function catalogRetryDelayMs(attempt: number): number {
  const i = Math.max(0, Math.min(attempt, CATALOG_RETRY_LADDER_MS.length - 1));
  return CATALOG_RETRY_LADDER_MS[i];
}
