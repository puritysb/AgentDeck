/**
 * The z.ai key once the usage strip is crowded: its two windows (5H and the
 * MCP tool-call quota, or a token weekly window) share one key, and a press
 * cycles both → first → second like the Claude weekly key
 * (claude-weekly-view.ts). A missing window never invents a quota.
 */
export type ZaiPairMode = 'both' | 'first' | 'second';
export function isZaiPairMode(value: unknown): value is ZaiPairMode {
  return value === 'both' || value === 'first' || value === 'second';
}
export function nextZaiPairMode(mode: ZaiPairMode = 'both'): ZaiPairMode {
  return mode === 'both' ? 'first' : mode === 'first' ? 'second' : 'both';
}
export function zaiPairReadings<T>(first: T | undefined, second: T | undefined, mode: ZaiPairMode = 'both'): T[] {
  if (!first) return second ? [second] : [];
  if (!second) return [first];
  return mode === 'first' ? [first] : mode === 'second' ? [second] : [first, second];
}
