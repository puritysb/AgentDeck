import { execFile } from 'child_process';
import { debug } from './logger.js';
import type { ModelCatalogEntry } from './types.js';
import { augmentedPath } from '@agentdeck/shared';

export interface OpenClawModel {
  key: string;
  name: string;
  input?: string;
  contextWindow?: number;
  local?: boolean;
  available?: boolean;
  tags?: string[];
  missing?: boolean;
}

interface ModelListResult {
  count: number;
  models: OpenClawModel[];
}

// Cache
let cachedEntries: ModelCatalogEntry[] | null = null;
let cachedRaw: OpenClawModel[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

let fetchPromise: Promise<{ entries: ModelCatalogEntry[]; raw: OpenClawModel[] } | null> | null = null;

/**
 * Parse role from model tags.
 * - "default" → "default"
 * - "fallback#N" → "fallback-N"
 * - otherwise → "configured"
 */
function parseRole(tags: string[]): ModelCatalogEntry['role'] {
  if (tags.includes('default')) return 'default';
  for (const tag of tags) {
    const match = tag.match(/^fallback#(\d+)$/);
    if (match) return `fallback-${match[1]}` as `fallback-${number}`;
  }
  return 'configured';
}

/**
 * Convert raw CLI models to catalog entries for the plugin.
 */
function toEntries(models: OpenClawModel[]): ModelCatalogEntry[] {
  return models.map((m) => ({
    key: m.key,
    name: m.name,
    role: parseRole(m.tags ?? []),
    available: m.available !== false,
  }));
}

/**
 * Fetch the model catalog from `openclaw models list --json`.
 * Returns cached entries if within TTL.
 * Returns null if openclaw is not installed or the command fails.
 */
export async function fetchModelCatalog(): Promise<{ entries: ModelCatalogEntry[]; raw: OpenClawModel[] } | null> {
  const now = Date.now();
  if (cachedEntries && cachedRaw && now - cacheTime < CACHE_TTL_MS) {
    return { entries: cachedEntries, raw: cachedRaw };
  }

  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = new Promise((resolve) => {
    execFile('openclaw', ['models', 'list', '--json'], {
      timeout: 5000,
      encoding: 'utf-8',
      env: { ...process.env, PATH: augmentedPath() },
      windowsHide: true,
    }, (err, stdout) => {
      fetchPromise = null;
      if (err) {
        debug('model-catalog', `CLI call failed: ${err}`);
        resolve(null);
        return;
      }

      try {
        const result = JSON.parse(stdout.trim()) as ModelListResult;
        if (!result.models || !Array.isArray(result.models)) {
          debug('model-catalog', 'Unexpected CLI output format');
          resolve(null);
          return;
        }

        cachedRaw = result.models;
        cachedEntries = toEntries(result.models);
        cacheTime = Date.now();

        debug('model-catalog', `Fetched ${cachedEntries.length} models (default: ${cachedEntries.find((e) => e.role === 'default')?.name ?? 'none'})`);
        resolve({ entries: cachedEntries, raw: cachedRaw });
      } catch (parseErr) {
        debug('model-catalog', `CLI output parse failed: ${parseErr}`);
        resolve(null);
      }
    });
  });

  return fetchPromise;
}

/**
 * Get the default model name from the catalog, or null.
 * Returns the display name (e.g., "Claude Haiku 4.5"), not the API key.
 * Returns null if no default is marked. Catalog ordering is not routing state.
 */
export async function getDefaultModelName(): Promise<string | null> {
  const catalog = await fetchModelCatalog();
  if (!catalog) return null;
  const defaultEntry = catalog.entries.find((e) => e.role === 'default');
  if (defaultEntry) return defaultEntry.name ?? null;
  return null;
}

/**
 * Invalidate the cache (e.g., on reconnect).
 */
export function invalidateModelCache(): void {
  cachedEntries = null;
  cachedRaw = null;
  cacheTime = 0;
}
