// Static application pixel code only. No host callbacks, I/O or downloaded code.
import type { PixooBakeInput } from './pixoo-baked.js';
import { deriveSubagentActivity } from '@agentdeck/shared';
import { formatResetDetailed, renderFrame, renderPixooLoop } from './pixoo-renderer.js';
import { PIXOO_LOOP_POLICY as P } from './pixoo-loop-policy.generated.js';

// JavaScriptCore has the ECMAScript core, not browser TextEncoder. Keep UTF-8
// identical in both runtimes, including replacement of unpaired surrogates.
(globalThis as any).TextEncoder = class {
  encode(text: string): Uint8Array {
    const out: number[] = [];
    for (const scalar of text) {
      let c = scalar.codePointAt(0)!;
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | c >> 6, 128 | c & 63);
      else if (c < 65536) out.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
      else out.push(240 | c >> 18, 128 | c >> 12 & 63, 128 | c >> 6 & 63, 128 | c & 63);
    }
    return Uint8Array.from(out);
  }
};

function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += alphabet[n >>> 18 & 63] + alphabet[n >>> 12 & 63]
      + (i + 1 < bytes.length ? alphabet[n >>> 6 & 63] : '=')
      + (i + 2 < bytes.length ? alphabet[n & 63] : '=');
  }
  return out;
}

(globalThis as any).agentdeckPixooActive = (json: string): boolean => {
  const i = JSON.parse(json), state = i.state?.state ?? 'disconnected';
  const activity = i.subagents ?? deriveSubagentActivity(i.timeline ?? [], { now: i.nowMs });
  return state === 'processing' || state.startsWith('awaiting')
    || Object.values(activity).some((a: any) => a.activeCount > 0)
    || (i.sessions ?? []).some((s: any) => s.alive && (s.state === 'processing' || s.state?.startsWith('awaiting')));
};
// The existing Node visible-state signature, shared with Swift scheduling.
(globalThis as any).agentdeckPixooSignature = (json: string): string => {
  const input = JSON.parse(json) as PixooBakeInput;
  Date.now = () => input.nowMs;
  const lastStateEvent = input.state, lastUsageEvent = input.usage, lastSessions = input.sessions;
  const displayDimmed = input.dimmed ?? false;
  const activity = input.subagents ?? deriveSubagentActivity(input.timeline ?? [], { now: input.nowMs });
  const stateStr = lastStateEvent?.state ?? 'disconnected';
  const gatewayConnected = lastStateEvent?.gatewayConnected ?? false;
  const gatewayHasError = lastStateEvent?.gatewayHasError ?? false;

  const r5 = lastUsageEvent ? formatResetDetailed(lastUsageEvent.fiveHourResetsAt) : '';
  const r7 = lastUsageEvent ? formatResetDetailed(lastUsageEvent.sevenDayResetsAt) : '';
  const u5 = lastUsageEvent?.fiveHourPercent != null ? Math.floor(lastUsageEvent.fiveHourPercent) : -1;
  const u7 = lastUsageEvent?.sevenDayPercent != null ? Math.floor(lastUsageEvent.sevenDayPercent) : -1;
  const cx1 = lastUsageEvent?.codexRateLimits?.primary?.usedPercent != null
    ? Math.floor(lastUsageEvent.codexRateLimits.primary.usedPercent) : -1;
  const cx2 = lastUsageEvent?.codexRateLimits?.secondary?.usedPercent != null
    ? Math.floor(lastUsageEvent.codexRateLimits.secondary.usedPercent) : -1;
  const cxStale = `${lastUsageEvent?.codexRateLimits?.primary?.stale === true}|${lastUsageEvent?.codexRateLimits?.secondary?.stale === true}`;
  const uStale = lastUsageEvent?.usageStale ?? false;

  const sessionInfo = lastSessions
    ? lastSessions.map(s => `${s.id}:${s.agentType}:${s.state}:${s.backgroundTaskCount ?? "?"}`).join(',')
    : '';
  const subagentInfo = Object.entries(activity)
    .map(([sessionId, activity]) =>
      `${sessionId}:${activity.activeCount}:${activity.lastCompletedAt ?? 0}`)
    .sort()
    .join(',');

  return `${stateStr}|${gatewayConnected}|${gatewayHasError}|${r5}|${r7}|${u5}|${u7}|${cx1}|${cx2}|${cxStale}|${uStale}|${sessionInfo}|${subagentInfo}|${displayDimmed}`;
};
let seeded = false;
(globalThis as any).agentdeckPixooBake = (json: string): string => {
  const input = JSON.parse(json);
  if (!Number.isFinite(input.nowMs)) throw new Error('invalid clock');
  // One isolated context per driver keeps the canonical simulation between
  // uploads without preview calls advancing its fish, bubbles or camera.
  if (!seeded) {
    let seed = P.randomSeed;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    seeded = true;
  }
  Date.now = () => input.nowMs;
  const activity = input.subagents ?? deriveSubagentActivity(input.timeline ?? [], { now: input.nowMs });
  const frames = input.loop === false
    ? [renderFrame(input.state ?? null, input.usage ?? null, input.sessions ?? null, input.nowMs, 64, 'standard', activity)]
    : renderPixooLoop(input.state ?? null, input.usage ?? null, input.sessions ?? null, input.nowMs, activity);
  return JSON.stringify(frames.map(base64));
};
