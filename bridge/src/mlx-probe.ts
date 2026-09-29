import { loadMlxSettings, resolveSafeMlxModel, mlxBaseUrl, type ModelResidency } from '@agentdeck/shared';

/** This is a resident-model probe, never a downloaded-model picker. */
export async function fetchMlxModels(pin?: string | null): Promise<string[] | null> {
  const settings = loadMlxSettings();
  try { return [await resolveSafeMlxModel(settings.endpoint, pin ?? settings.model)]; }
  catch { return null; }
}

/** /models is a catalog on VLM; only explicit health metadata proves residency. */
export async function fetchMlxResidency(): Promise<ModelResidency> {
  try {
    const response = await fetch(mlxBaseUrl(loadMlxSettings().endpoint) + '/health', { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { known: false, models: [] };
    const body = await response.json() as { loaded_model?: unknown };
    if (body.loaded_model === null) return { known: true, models: [] };
    if (typeof body.loaded_model === 'string' && body.loaded_model.trim()) return { known: true, models: [body.loaded_model] };
  } catch { /* no observation */ }
  return { known: false, models: [] };
}
