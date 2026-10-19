import { buildCappedTimelineHistory, ESP32_INITIAL_TIMELINE_HISTORY_MAX_BYTES } from './bridge-core.js';
import { BOARD_TIMELINE_ROWS, isToolEventRow, shrinkTimelineEntryForBoard } from './board-timeline-entry.js';
import { setSerialTimelineQueryHandler } from './esp32-serial.js';
import type { BridgeEvent, TimelineEntry } from './types.js';

export interface SessionTimelineQuery {
  sessionId?: unknown;
  since?: unknown;
}

export interface SessionTimelineReplyOptions {
  /** The requester negotiated `timeline.tool-events.read`. A board never does. */
  toolEvents: boolean;
  /** The requester is a board: the ≤4096 B frame rule and firmware-size rows apply. */
  board: boolean;
}

export interface SessionTimelineSource {
  /** The full session id a device's (possibly truncated) id names; '' for none. */
  resolveSessionId(raw: unknown): string;
  /** The session's recent rows, Claude's tool rows included only when asked for. */
  entriesFor(sessionId: string, sinceMs: number | undefined, toolEvents: boolean): TimelineEntry[];
}

/**
 * The reply to a `query_session_timeline`, for whichever transport asked.
 *
 * A board gets back the id it SENT. It matches the reply against that id
 * (the T-Embed knob keeps it in `scrubSessionId[32]` and `strcmp`s), and
 * board ids are cut to 31 bytes on the way out, so echoing the resolved
 * 36-char UUID or 52-char observed id meant the board discarded every reply.
 * Its rows are trimmed to firmware size BEFORE the byte budget, as the
 * connect burst does: one long reply (up to 3,000 characters of detail) as
 * the newest row used to exhaust the budget on its own and the board got no
 * answer at all.
 */
export function buildSessionTimelineReply(
  query: SessionTimelineQuery,
  opts: SessionTimelineReplyOptions,
  source: SessionTimelineSource,
): BridgeEvent | null {
  const sessionId = source.resolveSessionId(query.sessionId);
  if (!sessionId) return null;
  const sinceMs = typeof query.since === 'number' ? query.since : undefined;
  let entries = source.entriesFor(sessionId, sinceMs, opts.toolEvents);
  if (!opts.toolEvents) entries = entries.filter((entry) => !isToolEventRow(entry));
  if (!opts.board) return buildCappedTimelineHistory(entries, undefined, { sessionId });
  const requested = typeof query.sessionId === 'string' ? query.sessionId : sessionId;
  return buildCappedTimelineHistory(entries.slice(-BOARD_TIMELINE_ROWS).map(shrinkTimelineEntryForBoard),
    ESP32_INITIAL_TIMELINE_HISTORY_MAX_BYTES, { sessionId: requested });
}

/**
 * Wires the one reply to both transports: the serial handler is registered
 * here and the WebSocket replier returned, so a daemon cannot answer a board
 * over one transport and forget the other — which is how USB went unanswered
 * while WiFi worked. Call it before the serial module opens a port.
 */
export function wireSessionTimelineReplies(
  source: SessionTimelineSource,
): (query: SessionTimelineQuery, opts: SessionTimelineReplyOptions) => BridgeEvent | null {
  const reply = (query: SessionTimelineQuery, opts: SessionTimelineReplyOptions) =>
    buildSessionTimelineReply(query, opts, source);
  // A board never opts in to tool rows, over either transport.
  setSerialTimelineQueryHandler((query) => reply(query, { toolEvents: false, board: true }));
  return reply;
}
