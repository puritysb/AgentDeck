/**
 * Shared icon-key system for timeline entries.
 *
 * Each platform maps the abstract key to its native form:
 *   - Apple: SF Symbols (`checkmark.circle.fill`, etc.)
 *   - Android tablet: Material Icons (`Icons.Filled.CheckCircle`)
 *   - Android e-ink: ASCII bracket markers (`[OK]`, `[T ]`) — high black coverage,
 *     no thin glyph strokes that ghost on partial refresh.
 *
 * This is the single source of truth. If you add a new key, add the platform
 * mapping in the same commit (apple TimelineStripView.swift,
 * android TimelineStrip.kt + EinkTimelinePanel.kt).
 */

import type { TimelineEntry, TimelineEntryType } from './timeline.js';

export type TimelineIconKey =
  | 'success'   // chat completed, tool resolved
  | 'error'     // any error
  | 'running'   // active turn / chat in progress
  | 'awaiting'  // waiting on user (pending tool, chat_start without completion)
  | 'tool'      // tool execution
  | 'model'     // model call/response
  | 'user'      // user action / prompt
  | 'task'      // task hierarchy header
  | 'scheduled' // scheduled work
  | 'memory';   // memory recall

/**
 * Map a timeline entry to its semantic icon key.
 * Looks at both the entry type and (for tool_request) the approval status.
 */
export function timelineIconKey(entry: Pick<TimelineEntry, 'type' | 'status'>): TimelineIconKey {
  switch (entry.type) {
    case 'task_start':
    case 'task_end':
      return 'task';
    case 'task_milestone':
      return 'success';
    case 'chat_start':
      return 'running';
    case 'chat_end':
    case 'chat_response':
    case 'model_response':
      return 'success';
    case 'model_call':
      return 'model';
    case 'tool_request':
      if (entry.status === 'approved') return 'success';
      if (entry.status === 'denied') return 'error';
      // `abandoned` and `pending` share the amber "no decision was made" icon.
      // They are the same fact at two points in time — one still open, one
      // closed without an answer — and neither is a refusal.
      return 'awaiting';
    case 'tool_resolved':
      // The resolution row carries the SAME status as the request it closes, so
      // it must branch on it. Returning 'success' unconditionally (as this did)
      // drew a green check on a denial and on an abandonment alike — the one
      // row whose entire job is to say how the approval ended was the one row
      // that could not say it.
      if (entry.status === 'denied') return 'error';
      if (entry.status === 'abandoned') return 'awaiting';
      return 'success';
    case 'tool_exec':
      return 'tool';
    case 'error':
      return 'error';
    case 'user_action':
      return 'user';
    case 'scheduled':
      return 'scheduled';
    case 'memory_recall':
      return 'memory';
    case 'eval_result':
      return entry.status === 'denied' ? 'error' : 'success';
    default:
      return 'running';
  }
}

/** All known icon keys, in stable order (used for tests/registries). */
export const TIMELINE_ICON_KEYS: readonly TimelineIconKey[] = [
  'success', 'error', 'running', 'awaiting',
  'tool', 'model', 'user', 'task',
  'scheduled', 'memory',
] as const;

/**
 * Staleness cap for the in-flight task spinner: a `task_start` older than
 * this without a matching `task_end` is treated as resolved-but-orphaned
 * (daemon killed mid-task / hook delivery race / session_end early-return).
 * The daemon-side orphan reaper eventually upserts a synthetic task_end, but
 * this UI guard is independent so a stale row reads as completed even before
 * the reaper runs. Value matches Apple's `inFlightTaskMaxAgeSec`.
 */
export const IN_FLIGHT_TASK_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * True when `entry` is a `task_start` whose matching `task_end` (same `taskId`)
 * has not yet appeared among `siblings` and the row is younger than
 * `IN_FLIGHT_TASK_MAX_AGE_MS`. Lets clients render in-flight task hierarchy
 * markers with the rotating "running" treatment instead of the static `task`
 * icon. Mirrored in Apple `timelineIsInFlightTask` and Android
 * `isInFlightTask` — update all three in the same commit.
 */
export function isInFlightTask(
  entry: Pick<TimelineEntry, 'type' | 'taskId'> & Partial<Pick<TimelineEntry, 'ts'>>,
  siblings: ReadonlyArray<Pick<TimelineEntry, 'type' | 'taskId'>>,
  nowMs?: number,
): boolean {
  if (entry.type !== 'task_start') return false;
  if (!entry.taskId) return false;
  for (const s of siblings) {
    if (s.type === 'task_end' && s.taskId === entry.taskId) return false;
  }
  if (entry.ts != null && (nowMs ?? Date.now()) - entry.ts > IN_FLIGHT_TASK_MAX_AGE_MS) {
    return false;
  }
  return true;
}

/**
 * Age cap for the rotating "running" treatment on turn rows. Turn-completion
 * signals are best-effort (Stop hook, transcript tail, PTY marker) and can be
 * lost across daemon handoffs — a chat_start older than this stops spinning
 * even without an explicit completion so dead turns don't animate forever.
 * Matches Apple's `chatStartMaxAgeSec` (TimelineStripView.swift). Task
 * hierarchy markers are handled by the daemon-side orphan reaper plus Apple's
 * own in-flight cap.
 */
export const ROTATING_ENTRY_MAX_AGE_MS = 10 * 60 * 1000;

type RotatingSibling = Pick<TimelineEntry, 'type' | 'taskId'> &
  Partial<Pick<TimelineEntry, 'sessionId' | 'ts'>>;

/** Same-session test mirroring the turn-merge rule: both ids equal, or both
 *  absent (legacy single-session emitters). */
function sameRotatingSession(a?: string, b?: string): boolean {
  if (!a && !b) return true;
  return !!a && !!b && a === b;
}

/**
 * True when a turn row should rotate its leading icon. Combines the static
 * `running` icon-key (chat_start, unknown types) with the in-flight
 * task-hierarchy signal so an open `task_start` also spins until its
 * `task_end` arrives. `siblings` should be the entries the row sees in its
 * group/list — passing `[]` falls back to icon-key only.
 *
 * A chat_start only spins while its turn is plausibly still open:
 *   - no later same-session completion (chat_response / chat_end / model_response),
 *   - no later same-session chat_start (a new prompt supersedes the turn even
 *     when its completion signal was lost — Stop hooks are best-effort),
 *   - younger than ROTATING_ENTRY_MAX_AGE_MS.
 * Mirrored in Apple TimelineStripView.swift and Android TimelineIcons.kt —
 * update all three in the same commit.
 */
export function isRotatingEntry(
  entry: Pick<TimelineEntry, 'type' | 'status' | 'taskId'> &
    Partial<Pick<TimelineEntry, 'sessionId' | 'ts'>>,
  siblings: ReadonlyArray<RotatingSibling>,
  nowMs?: number,
): boolean {
  if (timelineIconKey(entry) === 'running') {
    if (entry.type !== 'chat_start') return true;
    const ts = entry.ts;
    if (ts != null) {
      const now = nowMs ?? Date.now();
      if (now - ts > ROTATING_ENTRY_MAX_AGE_MS) return false;
      for (const s of siblings) {
        if (s.ts == null || s.ts < ts) continue;
        if (!sameRotatingSession(entry.sessionId, s.sessionId)) continue;
        // `error` closes a turn as surely as a response does — a failed Codex
        // request emits one instead of a reply, and leaving it off this list
        // kept the spinner turning next to the error that explained it.
        if (s.type === 'chat_response' || s.type === 'chat_end'
            || s.type === 'model_response' || s.type === 'error') return false;
        if (s.type === 'chat_start' && s.ts > ts) return false;
      }
    }
    return true;
  }
  return isInFlightTask(entry, siblings, nowMs);
}

/**
 * E-ink ASCII glyphs — bracket-padded so total width is constant (4 chars)
 * for column alignment on monospace bitmap fonts.
 */
export const EINK_ICON_GLYPHS: Record<TimelineIconKey, string> = {
  success:   '[OK]',
  error:     '[!!]',
  running:   '[..]',
  awaiting:  '[??]',
  tool:      '[T ]',
  model:     '[M ]',
  user:      '[U ]',
  task:      '[==]',
  scheduled: '[S ]',
  memory:    '[~ ]',
};

/**
 * Whether a timeline entry type carries a content body worth showing in the
 * detail pane. task_start/task_end/task_milestone are hierarchy markers —
 * their `raw` is the summary, no extra detail expected.
 */
export function entryHasDetailBody(type: TimelineEntryType): boolean {
  return type !== 'task_start' && type !== 'task_end' && type !== 'task_milestone';
}
