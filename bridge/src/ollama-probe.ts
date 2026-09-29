import type { OllamaStatus } from '@agentdeck/shared';
export type { OllamaStatus, OllamaModel } from '@agentdeck/shared';
const BASE = 'http://127.0.0.1:11434';
type Row = { name?: string; size?: number; size_vram?: number };
async function probe(path: string): Promise<Row[] | null> {
  try {
    const response = await fetch(BASE + path, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = await response.json() as { models?: Row[] };
    if (!Array.isArray(body.models) || body.models.some(m => !m || typeof m.name !== 'string' || !m.name)) return null;
    return body.models;
  } catch { return null; }
}
export class OllamaProbe {
  async getStatus(): Promise<OllamaStatus> {
    const [installed, running] = await Promise.all([probe('/api/tags'), probe('/api/ps')]);
    const vram = new Map((running ?? []).map(m => [m.name, m.size_vram ?? 0]));
    return {
      available: installed !== null || running !== null,
      // Retain the installed-list and byte-count contract for released clients.
      models: (installed ?? running ?? []).map(m => ({ name: m.name!, size: m.size ?? 0, sizeVram: vram.get(m.name) ?? 0 })),
      installedModelsKnown: installed !== null,
      residency: { known: running !== null, models: (running ?? []).map(m => m.name!) },
    };
  }
}
