import type { TimelineEntry } from './timeline.js';

export interface SubagentVisualActivity {
  activeCount: number;
  lastCompletedAt?: number;
}

export type SubagentActivityBySession = Record<string, SubagentVisualActivity>;

export interface SubagentActivityOptions {
  now?: number;
  activeTtlMs?: number;
}

const DEFAULT_ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;

interface ActiveBurst {
  ts: number;
  count: number;
}

/** `Subagent ×8 dispatched · researcher` → 8; anything else → 1. */
export function subagentBurstCount(raw: string): number {
  const match = /^Subagent\s+×(\d+)\b/.exec(raw);
  if (!match) return 1;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Derive parent/child activity from timeline rows.
 *
 * **This is the fallback path.** `SessionInfo.subagents` carries the daemon's
 * own census and is authoritative wherever it is present; prefer it. This
 * function exists for the case the wire field cannot cover — a client reading a
 * rehydrated `timeline.json` from an older daemon, or one that predates the
 * field — and it is inherently approximate, because the rows it reads are
 * bounded and lossy by design (dispatch bursts fold into one row, and the
 * 200-entry buffer evicts).
 */
export function deriveSubagentActivity(
  entries: readonly TimelineEntry[],
  options: SubagentActivityOptions = {},
): SubagentActivityBySession {
  const now = options.now ?? Date.now();
  const activeTtlMs = options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS;
  const burstsBySession = new Map<string, ActiveBurst[]>();
  const completedBySession = new Map<string, number>();
  const drainedBySession = new Map<string, number>();

  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.ts - b.entry.ts || a.index - b.index);

  for (const { entry } of ordered) {
    const sessionId = entry.sessionId?.trim();
    if (!sessionId) continue;

    const isSubagent = entry.raw.startsWith('Subagent ');
    const isTeamCompletion = entry.raw.startsWith('Team ');

    if (entry.type === 'tool_exec' && isSubagent) {
      const bursts = burstsBySession.get(sessionId) ?? [];
      // A dispatch row is upserted as its burst grows, so the same
      // `subagentId` must replace rather than accumulate.
      const existing = entry.subagentId
        ? bursts.findIndex((b) => b.ts === (entry.startedAt ?? entry.ts))
        : -1;
      const burst = { ts: entry.startedAt ?? entry.ts, count: subagentBurstCount(entry.raw) };
      if (existing >= 0) bursts[existing] = burst;
      else bursts.push(burst);
      burstsBySession.set(sessionId, bursts);
      continue;
    }

    if (entry.type !== 'tool_resolved' || (!isSubagent && !isTeamCompletion)) {
      continue;
    }

    completedBySession.set(
      sessionId,
      Math.max(completedBySession.get(sessionId) ?? 0, entry.endedAt ?? entry.ts),
    );

    if (!isSubagent) continue;
    drainedBySession.set(sessionId, (drainedBySession.get(sessionId) ?? 0) + 1);
  }

  const result: SubagentActivityBySession = {};
  const sessionIds = new Set([
    ...burstsBySession.keys(),
    ...completedBySession.keys(),
  ]);

  for (const sessionId of sessionIds) {
    const dispatched = (burstsBySession.get(sessionId) ?? [])
      .filter((burst) => now - burst.ts <= activeTtlMs)
      .reduce((sum, burst) => sum + burst.count, 0);
    const activeCount = Math.max(0, dispatched - (drainedBySession.get(sessionId) ?? 0));
    const lastCompletedAt = completedBySession.get(sessionId);
    if (activeCount === 0 && lastCompletedAt == null) continue;
    result[sessionId] = {
      activeCount,
      ...(lastCompletedAt == null ? {} : { lastCompletedAt }),
    };
  }

  return result;
}
