import type { DeviceScope } from './device-credentials.js';

/** The only state exported by the scoped TLS endpoint. No history or controls. */
export const DEVICE_SNAPSHOT = {
  version: 1, maxBytes: 32768, headerBytes: 8192, maxRows: 64, maxString: 256, timeoutMs: 5000, maxConnections: 16,
  sessionFields: ['id', 'agentType', 'projectName', 'displayName', 'state', 'alive'],
  usageFields: ['fiveHourPercent', 'sevenDayPercent', 'usageStale'],
  windowFields: ['usedPercent', 'windowMinutes', 'resetsAt', 'stale', 'regularResetsAt', 'available'],
  creditFields: ['hasCredits', 'unlimited', 'balance'],
} as const;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function pick(input: unknown, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!object(input)) return result;
  for (const key of fields) {
    const value = input[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
    else if (typeof value === 'string' && new TextEncoder().encode(value).length <= DEVICE_SNAPSHOT.maxString) result[key] = value;
  }
  return result;
}
export function buildDeviceSnapshot(scopes: readonly DeviceScope[], sessions: unknown, usage: unknown) {
  const events: Record<string, unknown>[] = [{type:'surface_welcome', protocol:1, profile:'display-only/v1', capabilities:[...scopes]}];
  if (scopes.includes('sessions.read')) {
    const rows = Array.isArray(sessions) ? sessions.slice(0, DEVICE_SNAPSHOT.maxRows).map(row => pick(row, DEVICE_SNAPSHOT.sessionFields))
      .filter(row => typeof row.id === 'string' && typeof row.state === 'string' && typeof row.alive === 'boolean') : [];
    events.push({type:'sessions_list', sessions:rows});
  }
  if (scopes.includes('usage.read')) {
    const event = {type:'usage_update', claudeUsageSnapshot:true, ...pick(usage, DEVICE_SNAPSHOT.usageFields)} as Record<string, unknown>;
    if (object(usage)) {
      event.scopedLimits = Array.isArray(usage.scopedLimits) ? usage.scopedLimits.slice(0, DEVICE_SNAPSHOT.maxRows).map(row => pick(row, ['label','percent'])) : [];
      const input = usage.codexRateLimits;
      if (object(input)) {
        const codex = pick(input, ['capturedAt']);
        for (const name of ['primary','secondary','lunaReserve']) if (object(input[name])) codex[name] = pick(input[name], DEVICE_SNAPSHOT.windowFields);
        if (object(input.credits)) codex.credits = pick(input.credits, DEVICE_SNAPSHOT.creditFields);
        event.codexRateLimits = codex;
      } else event.codexRateLimits = null;
    }
    events.push(event);
  }
  return {version:DEVICE_SNAPSHOT.version, events};
}
