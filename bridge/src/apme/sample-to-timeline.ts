/**
 * Sample → Timeline projection.
 *
 * The collector is the single normalizer: it turns raw agent events into typed
 * trajectory events (sample_events). This module projects ONE trajectory event
 * into ONE TimelineEntry, so the device-facing timeline is a *projection* of the
 * canonical sample rather than a parallel emitter. Grouping/dedup already
 * happened upstream (one assistant_message per turn, tool pending→resolved
 * collapsed into one row), so the timeline no longer needs display-time merging
 * or a race-sensitive dedup window for these entries.
 *
 * Pure + synchronous + unit-testable. Returns null for event kinds that should
 * not surface as their own timeline row (e.g. ModelEvent — cost is shown on the
 * task header, not as a standalone row).
 */

import type { TimelineEntry, ApmeSampleEventRow, AgentType } from '@agentdeck/shared';
import { isPrunedPayload } from './payload-prune.js';

export interface SampleTimelineHeader {
  sessionId: string;
  runId: string;
  taskId: string;
  agentType: AgentType | null;
  projectName: string | null;
}

function parsePayload(row: ApmeSampleEventRow): Record<string, unknown> {
  if (!row.payload) return {};
  try { return JSON.parse(row.payload) as Record<string, unknown>; } catch { return {}; }
}

/** Short one-line summary of a tool input for the timeline `raw` field. */
function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 80);
  try {
    const obj = input as Record<string, unknown>;
    const first = obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.query ?? obj.cmd;
    if (typeof first === 'string') return first.slice(0, 80);
    return JSON.stringify(input).slice(0, 80);
  } catch { return ''; }
}

/** Project a stored sample event into a timeline entry, or null to skip. */
export function sampleEventToTimeline(
  row: ApmeSampleEventRow,
  header: SampleTimelineHeader,
): TimelineEntry | null {
  const base = {
    ts: row.ts,
    agentType: header.agentType ?? undefined,
    projectName: header.projectName ?? undefined,
    sessionId: header.sessionId,
    runId: header.runId,
    taskId: header.taskId,
  };
  const p = parsePayload(row);

  switch (row.kind) {
    case 'user_message': {
      const text = (p.text as string) ?? '';
      if (!text.trim()) return null;
      return { ...base, type: 'chat_start', raw: text.slice(0, 120), detail: text.slice(0, 4000) };
    }
    case 'assistant_message': {
      const text = (p.text as string) ?? '';
      const kind = (p.responseKind as string) ?? 'text';
      if (kind !== 'text' || !text.trim()) return null; // tool-only/empty turns aren't chat rows
      return { ...base, type: 'chat_response', raw: text.slice(0, 120), detail: text.slice(0, 8000) };
    }
    case 'tool': {
      const name = row.toolName ?? 'tool';
      // A pruned row's payload (#302) already parses to `{pruned, prunedAt,
      // bytes}`, so `p.input` is naturally undefined here — this call is
      // called out explicitly so a reused/replayed sample never reads the
      // marker's own keys as tool input by accident.
      const inputSummary = isPrunedPayload(row.payload) ? '' : summarizeToolInput(p.input);
      const raw = inputSummary ? `${name} · ${inputSummary}` : name;
      const status = row.toolStatus === 'error' ? 'denied'
        : row.toolStatus === 'success' ? 'approved'
        : 'pending';
      return {
        ...base,
        type: 'tool_resolved',
        raw,
        status: status as TimelineEntry['status'],
        ...(row.toolError ? { detail: String(row.toolError).slice(0, 1000) } : {}),
      };
    }
    case 'subagent':
      // SubagentTimelineTracker already emits the folded dispatch/completion
      // rows directly. The sample copy is evaluation/graph evidence; projecting
      // it again would duplicate the visible lifecycle.
      return null;
    case 'state':
      return null; // state transitions are not standalone timeline rows
    case 'info': {
      const label = (p.label as string) ?? 'info';
      return { ...base, type: 'error', raw: label.slice(0, 120), ...(p.detail ? { detail: String(p.detail).slice(0, 1000) } : {}) };
    }
    case 'model':
      return null; // cost lives on the task header, not a row
    default:
      return null;
  }
}
