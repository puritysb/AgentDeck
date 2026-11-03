/**
 * Content-minimized, rebuildable activity history shared across daemon owners.
 *
 * The App Store daemon and CLI daemon intentionally keep separate SQLite
 * databases. They exchange this projection over authenticated loopback HTTP;
 * neither process opens or mutates the other's source DB. The cache may be
 * deleted at any time and rebuilt from the source rows on the next handover.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { request } from 'http';
import { getDataDir } from '../session-registry.js';
import { atomicWritePrivateFile } from '../private-files.js';
import type { ApmeStore } from './store.js';

export const APME_ACTIVITY_SCHEMA = 'agentdeck-activity/v1' as const;
const CACHE_FILE = 'apme-peer-activity.json';
const MAX_ROWS = 500;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const FUZZY_HANDOVER_GAP_MS = 5 * 60 * 1000;

export interface ApmeActivityRow {
  originKey: string;
  agentType: string;
  sessionId: string;
  taskIndex: number;
  projectName: string | null;
  modelId: string | null;
  task: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  turnCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  overallScore: number | null;
  provenance: Array<'node' | 'swift'>;
}

export interface ApmeAgentActivitySummary {
  agentType: string;
  taskCount: number;
  durationMs: number;
  firstAt: number;
  lastAt: number;
}

export interface ApmeActivitySnapshot {
  schema: typeof APME_ACTIVITY_SCHEMA;
  capturedAt: number;
  rows: ApmeActivityRow[];
  agents: ApmeAgentActivitySummary[];
}

function canonicalAgent(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === 'codex' || v === 'codex-app') return 'codex-cli';
  if (v === 'open-code') return 'opencode';
  return v || 'unknown';
}

function canonicalSession(agentType: string, value: string): string {
  let v = value.trim();
  const prefixes = agentType === 'codex-cli' ? ['codex:']
    : agentType === 'opencode' ? ['opencode:'] : [];
  for (const prefix of prefixes) {
    if (v.toLowerCase().startsWith(prefix)) v = v.slice(prefix.length);
  }
  return v || 'unknown';
}

function normalizedTask(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 2_000);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function activityOriginKey(input: {
  agentType: string;
  sessionId: string;
  taskIndex: number;
  firstPrompt: string;
}): string {
  const agent = canonicalAgent(input.agentType);
  const session = canonicalSession(agent, input.sessionId);
  return `activity:v1:${digest(`${agent}\0${session}\0${input.taskIndex}\0${normalizedTask(input.firstPrompt)}`)}`;
}

export function localActivityRows(store: ApmeStore, limit = MAX_ROWS): ApmeActivityRow[] {
  const page = store.listTaskPage({ limit: Math.min(Math.max(limit, 1), MAX_ROWS) });
  return page.tasks.map((task) => {
    const turns = store.listTurnsForTask(task.id);
    const now = Date.now();
    // "Time used" means agent-working time, not wall time between the first
    // and last prompt. Summing closed turn intervals keeps a lunch break or an
    // overnight user think-time out of the number; only the currently-open
    // turn accrues up to now.
    const activeDurationMs = turns.reduce((total, turn) => {
      const started = typeof turn.started_at === 'number' ? turn.started_at : null;
      if (started == null) return total;
      const ended = typeof turn.ended_at === 'number' ? turn.ended_at : now;
      return total + Math.max(0, ended - started);
    }, 0);
    const agentType = canonicalAgent(String(task.agentType));
    const sessionId = canonicalSession(agentType, task.sessionId);
    const firstPrompt = normalizedTask(task.firstPrompt ?? '');
    const label = normalizedTask(task.summary ?? firstPrompt) || '(task details unavailable)';
    const endedAt = task.endedAt ?? null;
    return {
      originKey: activityOriginKey({ agentType, sessionId, taskIndex: task.taskIndex, firstPrompt }),
      agentType,
      sessionId,
      taskIndex: task.taskIndex,
      projectName: task.projectName ?? null,
      modelId: task.modelId ?? null,
      task: label.slice(0, 500),
      startedAt: task.startedAt,
      endedAt,
      durationMs: activeDurationMs,
      turnCount: task.turnCount,
      inputTokens: task.inputTokens ?? null,
      outputTokens: task.outputTokens ?? null,
      costUsd: task.costUsd ?? null,
      overallScore: task.overallScore ?? task.compositeScore ?? null,
      provenance: ['node'],
    };
  });
}

function intervalsTouch(a: ApmeActivityRow, b: ApmeActivityRow): boolean {
  const aEnd = a.endedAt ?? a.startedAt;
  const bEnd = b.endedAt ?? b.startedAt;
  return a.startedAt <= bEnd + FUZZY_HANDOVER_GAP_MS
    && b.startedAt <= aEnd + FUZZY_HANDOVER_GAP_MS;
}

function isSameActivity(a: ApmeActivityRow, b: ApmeActivityRow): boolean {
  // Even a deterministic key is not a native task id: task_index can reset
  // after a daemon restart and a user can repeat the same first prompt later.
  // Time agreement is therefore mandatory on every merge path.
  if (a.originKey === b.originKey) return intervalsTouch(a, b);
  // Conservative legacy/handover fallback: never match on text alone. Native
  // session + agent + task index must all agree, and the time intervals must
  // overlap or nearly touch. A resumed same-session task hours later remains
  // separate even when it repeats the same prompt.
  return a.agentType === b.agentType
    && a.sessionId === b.sessionId
    && a.taskIndex === b.taskIndex
    && intervalsTouch(a, b);
}

function quality(row: ApmeActivityRow): number {
  return (row.task && row.task !== '(task details unavailable)' ? 4 : 0)
    + (row.endedAt != null ? 2 : 0)
    + (row.modelId ? 1 : 0)
    + (row.overallScore != null ? 1 : 0)
    + (row.inputTokens != null || row.outputTokens != null || row.costUsd != null ? 1 : 0);
}

function mergePair(a: ApmeActivityRow, b: ApmeActivityRow): ApmeActivityRow {
  const rich = quality(b) > quality(a) ? b : a;
  const other = rich === a ? b : a;
  const ended = [a.endedAt, b.endedAt].filter((v): v is number => typeof v === 'number');
  const startedAt = Math.min(a.startedAt, b.startedAt);
  const endedAt = ended.length ? Math.max(...ended) : null;
  return {
    ...rich,
    originKey: [a.originKey, b.originKey].sort()[0],
    projectName: rich.projectName ?? other.projectName,
    modelId: rich.modelId ?? other.modelId,
    task: rich.task || other.task,
    startedAt,
    endedAt,
    // Durations already represent summed turn-working intervals. Rebuilding
    // from the merged wall-clock bounds would put user think time back in.
    durationMs: Math.max(a.durationMs, b.durationMs),
    turnCount: Math.max(a.turnCount, b.turnCount),
    inputTokens: maxNullable(a.inputTokens, b.inputTokens),
    outputTokens: maxNullable(a.outputTokens, b.outputTokens),
    costUsd: maxNullable(a.costUsd, b.costUsd),
    overallScore: maxNullable(a.overallScore, b.overallScore),
    provenance: Array.from(new Set([...a.provenance, ...b.provenance])).sort() as Array<'node' | 'swift'>,
  };
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

export function mergeActivityRows(rows: ApmeActivityRow[], limit = MAX_ROWS): ApmeActivityRow[] {
  const merged: ApmeActivityRow[] = [];
  for (const row of [...rows].sort((a, b) => a.startedAt - b.startedAt || a.originKey.localeCompare(b.originKey))) {
    const index = merged.findIndex((candidate) => isSameActivity(candidate, row));
    if (index >= 0) merged[index] = mergePair(merged[index], row);
    else merged.push(row);
  }
  return merged.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export function summarizeActivity(rows: ApmeActivityRow[]): ApmeAgentActivitySummary[] {
  const groups = new Map<string, ApmeAgentActivitySummary>();
  for (const row of rows) {
    const existing = groups.get(row.agentType);
    const lastAt = row.endedAt ?? row.startedAt;
    if (!existing) {
      groups.set(row.agentType, {
        agentType: row.agentType, taskCount: 1, durationMs: row.durationMs,
        firstAt: row.startedAt, lastAt,
      });
    } else {
      existing.taskCount += 1;
      existing.durationMs += row.durationMs;
      existing.firstAt = Math.min(existing.firstAt, row.startedAt);
      existing.lastAt = Math.max(existing.lastAt, lastAt);
    }
  }
  return [...groups.values()].sort((a, b) => b.durationMs - a.durationMs || a.agentType.localeCompare(b.agentType));
}

function cachePath(): string { return join(getDataDir(), CACHE_FILE); }

export function loadPeerActivityRows(): ApmeActivityRow[] {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<ApmeActivitySnapshot>;
    if (parsed.schema !== APME_ACTIVITY_SCHEMA || !Array.isArray(parsed.rows)) return [];
    return parsed.rows.filter(isActivityRow).slice(0, MAX_ROWS);
  } catch {
    return [];
  }
}

export function savePeerActivityRows(rows: ApmeActivityRow[]): void {
  const merged = mergeActivityRows([...loadPeerActivityRows(), ...rows]);
  const snapshot = makeActivitySnapshot(merged);
  const path = cachePath();
  mkdirSync(getDataDir(), { recursive: true });
  atomicWritePrivateFile(path, JSON.stringify(snapshot));
}

export function makeActivitySnapshot(rows: ApmeActivityRow[]): ApmeActivitySnapshot {
  const merged = mergeActivityRows(rows);
  return { schema: APME_ACTIVITY_SCHEMA, capturedAt: Date.now(), rows: merged, agents: summarizeActivity(merged) };
}

export function activitySnapshotForStore(store: ApmeStore, limit = MAX_ROWS): ApmeActivitySnapshot {
  return makeActivitySnapshot([...localActivityRows(store, limit), ...loadPeerActivityRows()]);
}

function isActivityRow(value: unknown): value is ApmeActivityRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.originKey === 'string'
    && typeof row.agentType === 'string'
    && typeof row.sessionId === 'string'
    && typeof row.taskIndex === 'number'
    && typeof row.task === 'string'
    && typeof row.startedAt === 'number'
    && typeof row.durationMs === 'number'
    && Array.isArray(row.provenance);
}

/** Capture a same-user Swift daemon's projection before asking it to yield.
 * Failure is deliberately non-blocking: activity sync must never prevent the
 * CLI daemon from taking over the port. */
export function capturePeerActivity(port: number, token: unknown): Promise<boolean> {
  const query = typeof token === 'string' && token ? `?token=${encodeURIComponent(token)}` : '';
  return new Promise((resolve) => {
    const req = request({
      hostname: '127.0.0.1', port, path: `/apme/activity${query}`, method: 'GET', timeout: 2500,
    }, (res) => {
      if ((res.statusCode ?? 500) >= 300) { res.resume(); resolve(false); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) { req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<ApmeActivitySnapshot>;
          if (parsed.schema !== APME_ACTIVITY_SCHEMA || !Array.isArray(parsed.rows)) { resolve(false); return; }
          savePeerActivityRows(parsed.rows.filter(isActivityRow));
          resolve(true);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
