import {
  extractTopicHintWithKind,
  formatDurationSec,
  promptSnippetFallback,
  stripUnsafeText,
  type SubagentSummary,
  type TimelineEntry,
} from '@agentdeck/shared';

export interface SubagentTimelineHook {
  eventName: string;
  payload: Record<string, unknown>;
  sessionId: string;
  agentType: string;
  projectName?: string;
}

export interface SubagentTimelineResult {
  /**
   * The hook belongs to a child agent/team lifecycle and must not enter the
   * parent session's state, approval, steering, or APME pipelines.
   */
  childOnly: boolean;
  /**
   * The parent session whose child census changed, if it did. The caller
   * rebroadcasts `sessions_list` for it — a child starting or stopping is the
   * only signal that a parent's `subagents` block moved, and nothing else in
   * the hook path would notice.
   */
  censusChangedFor?: string;
  /** Lifecycle evidence for the parent task's SessionSample. Child hooks are
   *  consumed before the normal APME path, so this explicit handoff is the
   *  only honest producer for SampleModelConfig.subagents and graph nodes. */
  sampleEvent?: SubagentSampleEvent;
}

export interface SubagentSampleEvent {
  id: string;
  name: string;
  phase: 'started' | 'completed';
  ts: number;
  startedAt?: number;
  summary?: string;
}

type TimelineEmitter = (entry: TimelineEntry, upsert?: boolean) => void;

interface ActiveSubagent {
  startedAt: number;
  label: string;
  /** The dispatch burst this child was launched in — its siblings share it. */
  burstId: string;
}

/** Per-parent census. Mirrors the `SubagentSummary` wire shape plus the
 *  bookkeeping needed to keep `peak` meaningful across waves. */
interface SessionCensus {
  active: Map<string, ActiveSubagent>;
  peak: number;
  completed: number;
  lastCompletedAt?: number;
  /** Open dispatch burst: children starting within BURST_WINDOW_MS of each
   *  other fold into one timeline row. */
  burstId: string | null;
  burstStartedAt: number;
  burstCount: number;
  burstLabels: string[];
}

const ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a dispatch stays "the same fan-out" for row-folding purposes.
 *
 * One row per child would be honest and unreadable: a 200-entry buffer shared
 * by every session cannot absorb 8 starts + 8 stops per wave without evicting
 * the turns they belong to. So starts fold into a single upserted row carrying
 * the count (the `task_start` one-row-per-task pattern), while stops stay
 * individual — a completion carries a summary and a duration, which is the part
 * a reader actually reads.
 */
const BURST_WINDOW_MS = 10_000;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = stripUnsafeText(value)
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

function normalizedEventName(eventName: string): string {
  switch (eventName) {
    case 'SubagentStart':
    case 'codex_subagent_start':
      return 'subagent_start';
    case 'SubagentStop':
    case 'codex_subagent_stop':
      return 'subagent_stop';
    case 'TaskCompleted':
      return 'task_completed';
    case 'TeammateIdle':
      return 'teammate_idle';
    default:
      return eventName;
  }
}

export function isSubagentOnlyHook(
  eventName: string,
  payload: Record<string, unknown>,
): boolean {
  const event = normalizedEventName(eventName);
  if (
    event === 'subagent_start' || event === 'subagent_stop'
    || event === 'task_completed' || event === 'teammate_idle'
  ) {
    return true;
  }
  // Claude/Codex reserve agent_id for child-agent context. Consume every
  // such hook, including future Notification/Stop variants, so child
  // lifecycle can never drift into parent steering or turn state.
  return nonEmptyString(payload.agent_id) !== null;
}

function agentLabel(payload: Record<string, unknown>): string {
  const raw = nonEmptyString(payload.agent_type)
    ?? nonEmptyString(payload.teammate_name)
    ?? 'Subagent';
  return cap(raw.replace(/^general-purpose$/i, 'General'), 28);
}

/**
 * A short, stable handle for one child.
 *
 * Twelve children of one workflow all report `agent_type: "workflow-subagent"`,
 * so the type alone names none of them — every row read as the same row, and a
 * reader had no way to tell "one of twelve finished" from "the work finished".
 * The suffix is the child's own `agent_id`, which is the only thing that
 * differs.
 */
function childHandle(label: string, agentId: string | null): string {
  if (!agentId) return label;
  const short = agentId.replace(/[^A-Za-z0-9]/g, '').slice(-4).toLowerCase();
  return short ? `${label}#${short}` : label;
}

function completionSummary(payload: Record<string, unknown>): {
  text: string;
  summaryKind: 'heuristic' | 'none';
} {
  const response = nonEmptyString(payload.last_assistant_message)
    ?? nonEmptyString(payload.task_subject)
    ?? nonEmptyString(payload.task_description);
  if (response) {
    const hint = extractTopicHintWithKind(response);
    if (hint.hint) {
      return {
        text: cap(hint.hint, 96),
        summaryKind: hint.kind === 'topic' ? 'heuristic' : 'none',
      };
    }
    const fallback = promptSnippetFallback(response, 96);
    if (fallback) return { text: fallback, summaryKind: 'none' };
  }
  // NOT "Completed". That string is what a child that reported nothing used to
  // look like, and next to a session whose other eleven children were still
  // running it read as "the work is done" — the single most misleading row on
  // the strip. Say what actually happened: it ended, and it said nothing.
  return { text: 'ended · no summary', summaryKind: 'none' };
}

/**
 * Lifecycle reducer for Claude Code/Codex child agents, and the source of
 * truth for the parent's `subagents` census.
 *
 * Two outputs, deliberately separate:
 *
 *   - **timeline rows**, which stay within the existing entry types so older
 *     macOS/iOS/Android/Node/ESP32 clients keep rendering them; and
 *   - **`summary()`**, the live count the daemon stamps onto `sessions_list`.
 *
 * The census is kept HERE rather than derived from the rows it emits, because
 * the rows are lossy on purpose — dedup folds a burst into one entry and the
 * 200-cap sheds tool rows first. A census read back out of them counts zero in
 * precisely the fan-out it exists to describe.
 */
export class SubagentTimelineTracker {
  private readonly sessions = new Map<string, SessionCensus>();
  private burstSeq = 0;

  constructor(
    private readonly emit: TimelineEmitter,
    private readonly now: () => number = Date.now,
  ) {}

  handle(hook: SubagentTimelineHook): SubagentTimelineResult {
    const event = normalizedEventName(hook.eventName);
    const agentId = nonEmptyString(hook.payload.agent_id);
    const childOnly = isSubagentOnlyHook(hook.eventName, hook.payload);

    this.sweep();

    if (event === 'subagent_start') {
      const id = agentId ?? nonEmptyString(hook.payload.task_id) ?? `anonymous:${this.now()}`;
      const startedAt = this.now();
      const label = agentLabel(hook.payload);
      const census = this.censusFor(hook.sessionId);

      // Open a burst, or join the one still open.
      if (census.burstId == null || startedAt - census.burstStartedAt > BURST_WINDOW_MS) {
        census.burstId = `burst:${hook.sessionId}:${++this.burstSeq}`;
        census.burstStartedAt = startedAt;
        census.burstCount = 0;
        census.burstLabels = [];
      }
      census.burstCount += 1;
      if (!census.burstLabels.includes(label)) census.burstLabels.push(label);

      census.active.set(id, { startedAt, label, burstId: census.burstId });
      census.peak = Math.max(census.peak, census.active.size);

      this.emit({
        // Anchor the row at the burst's first child so a growing fan-out
        // updates in place instead of walking down the strip.
        ts: census.burstStartedAt,
        type: 'tool_exec',
        raw: this.burstRaw(census),
        sessionId: hook.sessionId,
        agentType: hook.agentType,
        projectName: hook.projectName,
        startedAt: census.burstStartedAt,
        subagentId: census.burstId,
        summaryKind: 'progress',
      }, true);
      return {
        childOnly: true,
        censusChangedFor: hook.sessionId,
        sampleEvent: {
          id,
          name: childHandle(label, agentId),
          phase: 'started',
          ts: startedAt,
        },
      };
    }

    if (event === 'subagent_stop') {
      const id = agentId ?? nonEmptyString(hook.payload.task_id) ?? '';
      // Claude 2.1.261 also emits SubagentStop for internal fork queries
      // (prompt suggestions / agent summaries). Live captures carry an
      // explicitly empty agent_type and have no SubagentStart. They are not
      // dispatched workers. Keep missing legacy types, typed orphan stops,
      // and known children; never guess a start for a helper query.
      if (hook.agentType === 'claude-code'
        && hook.payload.agent_type === ''
        && !this.sessions.get(hook.sessionId)?.active.has(id)) {
        return { childOnly: true };
      }
      const census = this.censusFor(hook.sessionId);
      const active = census.active.get(id);
      if (active) census.active.delete(id);
      const endedAt = this.now();
      const label = active?.label ?? agentLabel(hook.payload);
      const summary = completionSummary(hook.payload);
      const elapsedSec = active ? Math.round((endedAt - active.startedAt) / 1000) : null;

      census.completed += 1;
      census.lastCompletedAt = endedAt;
      // A wave that has fully drained resets the wave-scoped counters, so the
      // next fan-out reports its own width rather than a running total.
      if (census.active.size === 0) {
        census.burstId = null;
        census.burstCount = 0;
        census.burstLabels = [];
      }

      const handle = childHandle(label, agentId);
      const duration = elapsedSec != null && elapsedSec > 0
        ? ` · ${formatDurationSec(elapsedSec)}`
        : '';
      this.emit({
        ts: endedAt,
        type: 'tool_resolved',
        raw: `Subagent ${handle}${duration} · ${summary.text}`,
        sessionId: hook.sessionId,
        agentType: hook.agentType,
        projectName: hook.projectName,
        ...(active ? { startedAt: active.startedAt } : {}),
        endedAt,
        subagentId: `child:${hook.sessionId}:${id}`,
        summaryKind: summary.summaryKind,
      });
      return {
        childOnly: true,
        censusChangedFor: hook.sessionId,
        sampleEvent: {
          id: id || `anonymous:${endedAt}`,
          name: handle,
          phase: 'completed',
          ts: endedAt,
          ...(active ? { startedAt: active.startedAt } : {}),
          summary: summary.text,
        },
      };
    }

    if (event === 'task_completed') {
      const endedAt = this.now();
      const label = agentLabel(hook.payload);
      const summary = completionSummary(hook.payload);
      this.emit({
        ts: endedAt,
        type: 'tool_resolved',
        raw: `Team ${label} · ${summary.text}`,
        sessionId: hook.sessionId,
        agentType: hook.agentType,
        projectName: hook.projectName,
        endedAt,
        summaryKind: summary.summaryKind,
      });
      return {
        childOnly: true,
        sampleEvent: {
          id: nonEmptyString(hook.payload.task_id) ?? `team:${label}:${endedAt}`,
          name: label,
          phase: 'completed',
          ts: endedAt,
          summary: summary.text,
        },
      };
    }

    // Idle is lifecycle metadata, not a useful Timeline row. Consume it so it
    // cannot alter the parent state while respecting the user's team setup.
    if (event === 'teammate_idle' || childOnly) {
      return { childOnly: true };
    }

    return { childOnly: false };
  }

  /**
   * The parent's live census, or `null` when this session has never had a
   * child. Never fold "no children ever" into `active: 0` here — the caller
   * omits the wire field for the former and emits an explicit zero for the
   * latter, which is what stops a drained fan-out from latching on clients
   * that merge retain-on-absent.
   */
  summary(sessionId: string): SubagentSummary | null {
    this.sweep();
    const census = this.sessions.get(sessionId);
    if (!census) return null;
    return {
      active: census.active.size,
      peak: census.peak,
      completed: census.completed,
      ...(census.lastCompletedAt == null ? {} : { lastCompletedAt: census.lastCompletedAt }),
    };
  }

  /** The session ended: every child it had is gone with it. Without this a
   *  child whose stop hook was lost kept its parent's census at "+1" for the
   *  whole ACTIVE_TTL after the parent itself had exited. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Every session with a census, keyed as the tracker saw it (bare uuid). */
  summaries(): Map<string, SubagentSummary> {
    this.sweep();
    const out = new Map<string, SubagentSummary>();
    for (const sessionId of this.sessions.keys()) {
      const summary = this.summary(sessionId);
      if (summary) out.set(sessionId, summary);
    }
    return out;
  }

  private burstRaw(census: SessionCensus): string {
    const names = census.burstLabels.slice(0, 2).join(', ')
      + (census.burstLabels.length > 2 ? ` +${census.burstLabels.length - 2}` : '');
    return census.burstCount > 1
      ? `Subagent ×${census.burstCount} dispatched · ${names}`
      : `Subagent ${names} · dispatched`;
  }

  private censusFor(sessionId: string): SessionCensus {
    let census = this.sessions.get(sessionId);
    if (!census) {
      census = {
        active: new Map(),
        peak: 0,
        completed: 0,
        burstId: null,
        burstStartedAt: 0,
        burstCount: 0,
        burstLabels: [],
      };
      this.sessions.set(sessionId, census);
    }
    return census;
  }

  /** Expire children whose stop never arrived, so a lost hook cannot pin a
   *  parent at "running" forever. The census row itself survives: a session
   *  that once had children keeps reporting an explicit zero. */
  private sweep(): void {
    const cutoff = this.now() - ACTIVE_TTL_MS;
    for (const census of this.sessions.values()) {
      for (const [key, value] of census.active) {
        if (value.startedAt < cutoff) census.active.delete(key);
      }
      if (census.active.size === 0 && census.burstId != null) {
        census.burstId = null;
        census.burstCount = 0;
        census.burstLabels = [];
      }
    }
  }
}
