/**
 * Bridge-side timeline store — minimal server-side event buffer.
 * Stores recent timeline entries for relay to Android/plugin clients.
 * No scroll/grouping logic (that's client-side).
 */

import type { TimelineEntry } from './types.js';
import { deduplicateEntry, normalizeTimelineEntryForStorage } from '@agentdeck/shared';

type EntryListener = (entry: TimelineEntry, upsert?: boolean) => void;
/** Attribute an entry with session-scoped metadata (sessionId, projectName,
 *  taskId, runId, ...) before it lands in the buffer. Run once at storage
 *  time so history replay carries the same attribution as the live broadcast.
 *  Must be idempotent: caller already-set fields take precedence. */
type EntryAttributor = (entry: TimelineEntry) => TimelineEntry;

const MAX_ENTRIES = 200;

/** Chat/tool entry types that, in projection mode, come from the SessionSample
 *  projection instead of the adapters' direct emitters. Locally-emitted entries
 *  of these types are suppressed when projection mode is on so the timeline has
 *  exactly one source. Task hierarchy + error/scheduled rows are never affected. */
const PROJECTED_TYPES: ReadonlySet<string> = new Set([
  'chat_start', 'chat_response', 'chat_end', 'tool_request', 'tool_resolved', 'tool_exec',
]);

export class BridgeTimelineStore {
  private entries: TimelineEntry[] = [];
  private listeners: EntryListener[] = [];
  private attributor: EntryAttributor | null = null;
  /** Phase 6 cutover (default OFF). When true, locally-emitted chat/tool rows
   *  are dropped — the SessionSample projection (added via `bypassSuppression`)
   *  becomes the single source. Relayed + projected entries bypass this. */
  private suppressLocalChatTool = false;

  setSuppressLocalChatTool(v: boolean): void {
    this.suppressLocalChatTool = v;
  }

  /** Install (or replace) the attributor invoked on every addEntry / upsertEntry
   *  before dedup. Wired by `BridgeCore.wireTimeline` so the store and the
   *  live broadcast see identical, fully-attributed entries — critical for
   *  history replay (`timeline_history`). */
  setAttributor(fn: EntryAttributor | null): void {
    this.attributor = fn;
  }

  addEntry(entry: TimelineEntry, opts?: { bypassSuppression?: boolean }): void {
    // Phase 6: in projection mode, drop locally-emitted chat/tool rows — they
    // now come from the SessionSample projection (which bypasses) or are
    // relayed from another bridge (which bypasses). No-op when mode is off.
    if (this.suppressLocalChatTool && !opts?.bypassSuppression && PROJECTED_TYPES.has(entry.type)) {
      return;
    }
    const enriched = this.attributor ? this.attributor(entry) : entry;
    const normalized = normalizeTimelineEntryForStorage(enriched);
    if (!normalized) return;

    if (this.tryMergeTaskEndByTaskId(normalized)) {
      return;
    }

    const result = deduplicateEntry(normalized, this.entries);

    if (result.action === 'skip') return;

    if (result.action === 'merge') {
      // Merge path is an *update* — the existing entry was attributed at its
      // own creation time and that attribution is the truth. Do NOT pull
      // session/task/run/project from `enriched` (the attributor on this call
      // reflects the *current* active task, which may have rotated since the
      // original entry was stored). Use the raw caller `entry` so explicit
      // caller-set fields still win, and otherwise keep `existing.*`.
      const existing = this.entries[result.index];
      existing.repeatCount = (existing.repeatCount || 1) + 1;
      existing.ts = normalized.ts;
      existing.raw = normalized.raw;
      existing.detail = normalized.detail ?? existing.detail;
      existing.agentType = entry.agentType ?? existing.agentType;
      existing.projectName = entry.projectName ?? existing.projectName;
      existing.sessionId = entry.sessionId ?? existing.sessionId;
      existing.runId = entry.runId ?? existing.runId;
      existing.taskId = entry.taskId ?? existing.taskId;
      existing.startedAt = normalized.startedAt ?? existing.startedAt;
      existing.endedAt = normalized.endedAt ?? existing.endedAt;
      existing.automated = normalized.automated ?? existing.automated;
      existing.summaryKind = normalized.summaryKind ?? existing.summaryKind;
      existing.boundarySignal = normalized.boundarySignal ?? existing.boundarySignal;
      existing.taskScore = normalized.taskScore ?? existing.taskScore;
      existing.taskOutcome = normalized.taskOutcome ?? existing.taskOutcome;
      existing.taskCategory = normalized.taskCategory ?? existing.taskCategory;
      existing.taskSummary = normalized.taskSummary ?? existing.taskSummary;
      if (result.removeChatStartIndex != null) {
        this.entries.splice(result.removeChatStartIndex, 1);
      }
      for (const cb of this.listeners) cb(existing, true);
      return;
    }

    // action === 'add' — fresh entry. Push the enriched form so storage and
    // history replay carry attribution from the time of creation.
    this.entries.push(result.entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    for (const cb of this.listeners) cb(result.entry);
  }

  getHistory(since?: number): TimelineEntry[] {
    if (since) {
      return this.entries.filter((e) => e.ts > since);
    }
    return [...this.entries];
  }

  updateEntryStatus(approvalId: string, status: 'approved' | 'denied'): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].approvalId === approvalId) {
        this.entries[i] = { ...this.entries[i], status };
        return;
      }
    }
  }

  /** Update existing entry with same ts+type (1s tolerance), or add new.
   *
   *  Update path: the existing entry's session/task/run/project attribution
   *  was set at *its* creation time and is authoritative. We do NOT re-run
   *  the attributor on update — by the time a late upsert lands (e.g. async
   *  LLM summary on a chat_end), the active task may have rotated, and
   *  re-attributing would silently move the entry to the wrong task. The
   *  raw caller `entry` only overrides existing fields when the caller
   *  explicitly set them.
   *
   *  Insert path (no match): falls through to `addEntry`, which runs the
   *  attributor as usual to capture creation-time attribution. */
  upsertEntry(entry: TimelineEntry, opts?: { bypassSuppression?: boolean }): void {
    // An upsert that finds no match falls through to addEntry; honor the same
    // suppression bypass on that insert path (relayed task_end upserts, etc.).
    const normalized = normalizeTimelineEntryForStorage(entry);
    if (!normalized) return;

    if (this.tryMergeTaskEndByTaskId(normalized)) {
      return;
    }

    const tolerance = 1000;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.type === normalized.type && Math.abs(e.ts - normalized.ts) < tolerance) {
        this.entries[i] = {
          ...e,
          raw: normalized.raw,
          ...(normalized.detail ? { detail: normalized.detail } : {}),
          ...(normalized.agentType ? { agentType: normalized.agentType } : {}),
          ...(normalized.projectName ? { projectName: normalized.projectName } : {}),
          ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
          ...(normalized.runId ? { runId: normalized.runId } : {}),
          ...(normalized.taskId ? { taskId: normalized.taskId } : {}),
          ...(normalized.boundarySignal ? { boundarySignal: normalized.boundarySignal } : {}),
          ...(normalized.startedAt != null ? { startedAt: normalized.startedAt } : {}),
          ...(normalized.endedAt != null ? { endedAt: normalized.endedAt } : {}),
          ...(normalized.automated ? { automated: normalized.automated } : {}),
          // summaryKind progresses heuristic/none → llm when the async LLM
          // summary lands. Without this propagation, the dashboard never
          // sees the kind upgrade and (for `summaryKind: 'none'` rows) the
          // detail pane stays suppressed even after the LLM rescues it.
          ...(normalized.summaryKind ? { summaryKind: normalized.summaryKind } : {}),
          ...(normalized.taskScore != null ? { taskScore: normalized.taskScore } : {}),
          ...(normalized.taskOutcome ? { taskOutcome: normalized.taskOutcome } : {}),
          ...(normalized.taskCategory ? { taskCategory: normalized.taskCategory } : {}),
          ...(normalized.taskSummary ? { taskSummary: normalized.taskSummary } : {}),
        };
        for (const cb of this.listeners) cb(this.entries[i], true);
        return;
      }
    }
    this.addEntry(normalized, opts);
  }

  /** Get the most recent entry of a given type */
  getLastEntry(type: string): TimelineEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === type) return this.entries[i];
    }
    return null;
  }

  onEntry(cb: EntryListener): void {
    this.listeners.push(cb);
  }

  removeListener(cb: EntryListener): void {
    const idx = this.listeners.indexOf(cb);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }

  private tryMergeTaskEndByTaskId(entry: TimelineEntry): boolean {
    if (entry.type !== 'task_end' || !entry.taskId) return false;
    let idx = -1;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.type === 'task_end' && e.taskId === entry.taskId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return false;

    const existing = this.entries[idx];
    this.entries[idx] = {
      ...existing,
      raw: entry.raw,
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.agentType ? { agentType: entry.agentType } : {}),
      ...(entry.projectName ? { projectName: entry.projectName } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.startedAt != null ? { startedAt: entry.startedAt } : {}),
      ...(entry.endedAt != null ? { endedAt: entry.endedAt } : {}),
      ...(entry.boundarySignal ? { boundarySignal: entry.boundarySignal } : {}),
      ...(entry.summaryKind ? { summaryKind: entry.summaryKind } : {}),
      ...(entry.taskScore != null ? { taskScore: entry.taskScore } : {}),
      ...(entry.taskOutcome ? { taskOutcome: entry.taskOutcome } : {}),
      ...(entry.taskCategory ? { taskCategory: entry.taskCategory } : {}),
      ...(entry.taskSummary ? { taskSummary: entry.taskSummary } : {}),
    };
    for (const cb of this.listeners) cb(this.entries[idx], true);
    return true;
  }
}
