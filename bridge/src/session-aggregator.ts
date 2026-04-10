import { listActive as listActiveSessions, type SessionEntry } from './session-registry.js';
import type { AgentType } from './types.js';
import { sortSessions } from '@agentdeck/shared';

export interface EnrichedSession {
  id: string;
  port: number;
  projectName: string;
  agentType?: AgentType;
  alive: boolean;
  state?: string;
  modelName?: string;
  startedAt?: string;
}

/**
 * Enrich sibling sessions with state from their /health endpoint.
 * For the own session (matched by ownSessionId), uses ownState directly.
 */
export async function enrichSessionsWithState(
  sessions: SessionEntry[],
  ownSessionId: string,
  ownState: string,
): Promise<EnrichedSession[]> {
  return Promise.all(sessions.map(async (s) => {
    const base: EnrichedSession = {
      id: s.id,
      port: s.port,
      projectName: s.projectName,
      agentType: s.agentType as AgentType | undefined,
      alive: true,
      startedAt: s.startedAt,
    };
    if (s.id === ownSessionId) return { ...base, state: ownState };
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
      const data = await res.json() as { state?: string; modelName?: string };
      return { ...base, state: data.state, modelName: data.modelName };
    } catch {
      return base;
    }
  }));
}

/**
 * Build an enriched sessions list for multi-session display.
 * Always includes the own session so single-session mode (agentdeck claude) shows the active session.
 */
export async function buildEnrichedSessionsList(
  ownSessionId: string,
  ownState: string,
): Promise<EnrichedSession[]> {
  const all = listActiveSessions().filter(s => s.agentType !== 'daemon');
  const enriched = await enrichSessionsWithState(all, ownSessionId, ownState);
  return sortSessions(enriched);
}
