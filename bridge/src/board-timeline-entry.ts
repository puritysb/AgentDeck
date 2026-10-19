import { truncateUtf8Bytes } from '@agentdeck/shared';

/** Rows a board's firmware ring holds (TIMELINE_MAX_ENTRIES); older rows are shifted straight out. */
export const BOARD_TIMELINE_ROWS = 64;

/**
 * Claude's per-tool hook rows are opt-in: only a client that offers
 * `timeline.tool-events.read` receives them (docs/surface-protocol.md), and a
 * board never offers it. Over WiFi the daemon's event transformer drops them;
 * serial has no negotiation, so its shaping drops them with this predicate, as
 * does the Pixoo bridge, which reads the raw broadcast.
 */
export function isToolEventRow(entry: unknown): boolean {
  return (entry as { toolEvent?: unknown } | null | undefined)?.toolEvent === true;
}

/**
 * The newest `rows` entries a board may show, for the serial connect seed.
 * Tool rows go before the count: the last few rows of a busy turn can all be
 * tool rows, and a seed filtered after the slice would arrive empty.
 */
export function boardTimelineSeed<T>(history: readonly T[], rows: number): T[] {
  return history.filter((entry) => !isToolEventRow(entry)).slice(-rows);
}

/**
 * A timeline entry at board size: bound to the firmware's TimelineEntry
 * buffers (raw[120] / detail[200] / projectName[40], UTF-8 safe). The one
 * definition for both the connect burst (bridge-core) and serial/WS shaping
 * (esp32-serial) — trimming before the byte budget is what lets a board's
 * first frame carry several rows instead of the one full-length reply that
 * used to fill it. Mirrors the Swift daemon, which shrinks before budgeting.
 */
export function shrinkTimelineEntryForBoard<T extends { raw?: unknown; detail?: unknown; projectName?: unknown }>(entry: T): T {
  if (!entry || typeof entry !== 'object') return entry;
  const limit = (value: unknown, maxBytes: number) =>
    typeof value === 'string' ? truncateUtf8Bytes(value, maxBytes) : undefined;
  return {
    ...entry,
    raw: limit(entry.raw, 119) ?? '',
    detail: limit(entry.detail, 199),
    ...(typeof entry.projectName === 'string' ? { projectName: limit(entry.projectName, 39) } : {}),
  };
}
