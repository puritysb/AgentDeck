/** One weekly key, regardless of strip capacity. Missing readings never invent a quota. */
export type ClaudeWeeklyMode = 'both' | '7d' | 'scoped';
export function isClaudeWeeklyMode(value: unknown): value is ClaudeWeeklyMode {
  return value === 'both' || value === '7d' || value === 'scoped';
}
export function nextClaudeWeeklyMode(mode: ClaudeWeeklyMode = 'both'): ClaudeWeeklyMode {
  return mode === 'both' ? '7d' : mode === '7d' ? 'scoped' : 'both';
}
export function claudeWeeklyReadings<T>(weekly: T | undefined, scoped: T | undefined, mode: ClaudeWeeklyMode = 'both'): T[] {
  if (!weekly) return scoped ? [scoped] : [];
  if (!scoped) return [weekly];
  return mode === '7d' ? [weekly] : mode === 'scoped' ? [scoped] : [weekly, scoped];
}
