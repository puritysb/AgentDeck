import { listActive as listActiveSessions, type SessionEntry } from './session-registry.js';
import type { AgentType } from './types.js';
import { sortSessions } from '@agentdeck/shared';

export interface EnrichedSession {
  id: string;
  port: number;
  pid?: number;
  projectName: string;
  agentType?: AgentType;
  alive: boolean;
  state?: string;
  modelName?: string;
  effortLevel?: string;
  startedAt?: string;
  controlMode?: 'managed' | 'observed';
  cwd?: string;
  currentTask?: string;
  contextPercent?: number;
  totalTokens?: number;
}

/** Cache last-known sibling state to avoid propagating undefined on transient fetch failures */
const siblingStateCache = new Map<string, { state: string; modelName?: string; effortLevel?: string }>();

/** Push-channel state cache — populated by DaemonWsClient session_push_state messages */
const pushStateCache = new Map<string, { state: string; modelName?: string; effortLevel?: string; updatedAt: number }>();

/** Update push-channel cache (called from daemon-server when session_push_state arrives) */
export function updatePushState(sessionId: string, state: string, modelName?: string, effortLevel?: string): void {
  pushStateCache.set(sessionId, { state, modelName, effortLevel, updatedAt: Date.now() });
  // Also update sibling cache so it stays consistent
  siblingStateCache.set(sessionId, { state, modelName, effortLevel });
}

/** Check if push-channel has fresh state (< 30s old) */
export function getPushState(sessionId: string): { state: string; modelName?: string; effortLevel?: string } | undefined {
  const entry = pushStateCache.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > 30_000) return undefined; // stale
  return { state: entry.state, modelName: entry.modelName, effortLevel: entry.effortLevel };
}

/** Clear cache entry when a session is removed (call from session-registry cleanup) */
export function clearSiblingStateCache(sessionId: string): void {
  siblingStateCache.delete(sessionId);
  pushStateCache.delete(sessionId);
}

/**
 * Enrich sibling sessions with state from their /health endpoint.
 * For the own session (matched by ownSessionId), uses ownState directly.
 * On fetch failure, falls back to last-known cached state to prevent
 * transient undefined propagation to all clients.
 */
export async function enrichSessionsWithState(
  sessions: SessionEntry[],
  ownSessionId: string,
  ownState: string,
  ownModelName?: string,
  ownEffortLevel?: string,
): Promise<EnrichedSession[]> {
  return Promise.all(sessions.map(async (s) => {
    const base: EnrichedSession = {
      id: s.id,
      port: s.port,
      pid: s.pid,
      projectName: s.projectName,
      agentType: s.agentType as AgentType | undefined,
      alive: true,
      startedAt: s.startedAt,
      controlMode: 'managed',
    };
    if (s.id === ownSessionId) return { ...base, state: ownState, modelName: ownModelName, effortLevel: ownEffortLevel };
    // 1. Use fresh push-channel state if available (< 30s old)
    const pushed = getPushState(s.id);
    if (pushed) return { ...base, state: pushed.state, modelName: pushed.modelName, effortLevel: pushed.effortLevel };
    // 2. Fall back to HTTP polling
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
      const data = await res.json() as { state?: string; modelName?: string; effortLevel?: string };
      if (data.state) {
        siblingStateCache.set(s.id, { state: data.state, modelName: data.modelName, effortLevel: data.effortLevel });
      }
      return { ...base, state: data.state, modelName: data.modelName, effortLevel: data.effortLevel };
    } catch {
      const cached = siblingStateCache.get(s.id);
      if (cached) return { ...base, state: cached.state, modelName: cached.modelName, effortLevel: cached.effortLevel };
      return base;
    }
  }));
}

/**
 * Build an enriched sessions list for multi-session display.
 *
 * Includes the own session so single-session mode (`agentdeck claude` without a daemon)
 * still surfaces the active session. The daemon-server enricher overrides this list in
 * multi-session setups, so per-session bridges keeping their own entry is safe.
 */
export async function buildEnrichedSessionsList(
  ownSessionId: string,
  ownState: string,
  ownModelName?: string,
  ownEffortLevel?: string,
): Promise<EnrichedSession[]> {
  const all = listActiveSessions().filter(s => s.agentType !== 'daemon');
  const enriched = await enrichSessionsWithState(all, ownSessionId, ownState, ownModelName, ownEffortLevel);
  return sortSessions(enriched);
}
