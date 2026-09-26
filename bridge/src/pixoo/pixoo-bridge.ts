/**
 * Pixoo64 Bridge — safe adaptive HTTP animation driver.
 *
 * Active states advance through moving single frames every 2.5s. Multi-frame
 * GIF uploads are intentionally disabled: the supported LAN API accepts them,
 * but tested Pixoo64 firmware loses both HTTP and ICMP after such requests.
 * State latency is controlled separately from the motion cadence.
 */

import { renderDeskAwareness } from './desk-awareness.js';
import { State } from '../types.js';
import type { BridgeEvent, StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo, SessionsListEvent } from '@agentdeck/shared/protocol';
import { DISPLAY_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import {
  deriveSubagentActivity,
  type SubagentActivityBySession,
  type TimelineEntry,
} from '@agentdeck/shared';
import { pushFrame, pushFrames, setBrightness, clearText, getDeviceBackoffStatus, switchToCustomChannel, onDeviceStatusChange, stopProbeTimer } from './pixoo-client.js';
import { renderFrame, renderDisconnectedFrame, formatResetDetailed } from './pixoo-renderer.js';
import { debug } from '../logger.js';

const TAG = 'Pixoo';

// ===== Configuration =====

export interface PixooDevice {
  ip: string;
  name?: string;
  brightness?: number; // 0-100, default 100
}

// ===== Internal State =====

let devices: PixooDevice[] = [];
let streamTimer: ReturnType<typeof setInterval> | null = null;
let lastPushTime = 0;
let pushing = false; // guard against overlapping pushes
let lastStateHash = '';
const deviceLastPushTime = new Map<string, number>();

// Cached latest events
let lastStateEvent: StateUpdateEvent | null = null;
let lastUsageEvent: UsageEvent | null = null;
let lastSessions: SessionInfo[] | null = null;
let lastTimelineEntries: TimelineEntry[] = [];

// Display sleep state — when Mac display is off, dim Pixoo and pause stream
let displayDimmed = false;
let lastDisplayDimSignature = '';

// Frame listeners for SSE streaming
let frameListeners: Array<(frame: Uint8Array) => void> = [];
let previewTimer: ReturnType<typeof setInterval> | null = null;
let previewFps = 10; // Adjustable 1–10 FPS for /pixoo live preview

const STATE_CHECK_INTERVAL_MS = 500;
export const PIXOO_PUSH_POLICY = {
  stateChangeFloorMs: 1_000,
  idleRefreshMs: 10_000,
  activeFrameRefreshMs: 2_500,
} as const;
export type PixooPushMode = 'single-frame' | 'idle';

export function resolvePixooPushMode(active: boolean): PixooPushMode {
  return active ? 'single-frame' : 'idle';
}

export function pixooPushIntervalMs(stateChanged: boolean, mode: PixooPushMode): number {
  if (stateChanged) return PIXOO_PUSH_POLICY.stateChangeFloorMs;
  if (mode === 'single-frame') return PIXOO_PUSH_POLICY.activeFrameRefreshMs;
  return PIXOO_PUSH_POLICY.idleRefreshMs;
}
const CHANNEL_REASSERT_MS = 30_000;     // Re-assert custom channel every 30s (fast recovery after reboots)
const DEFAULT_BRIGHTNESS = 100;

const FORWARDED_EVENTS = new Set([
  ...DISPLAY_FORWARDED_EVENTS,
  'timeline_event',
  'timeline_history',
]);

// Broadcast function injected by module for sending status notifications
let broadcastFn: ((event: BridgeEvent) => void) | null = null;

// ===== Public API =====

/** Set broadcast function for pushing Pixoo status events to WS clients. */
export function setPixooBroadcast(fn: (event: BridgeEvent) => void): void {
  broadcastFn = fn;
}

export function startPixooBridge(pixooDevices?: PixooDevice[]): void {
  if (!pixooDevices || pixooDevices.length === 0) {
    debug(TAG, 'No Pixoo devices configured, skipping');
    return;
  }

  devices = pixooDevices;
  debug(TAG, `Starting with ${devices.length} device(s): ${devices.map(d => d.name || d.ip).join(', ')}`);

  // Switch to custom channel + set brightness (fire-and-forget, one-time only)
  // Do NOT repeat this call — it resets the HTTP GIF buffer, clearing the display.
  for (const dev of devices) {
    switchToCustomChannel(dev.ip).catch(() => {});
    setBrightness(dev.ip, dev.brightness ?? DEFAULT_BRIGHTNESS).catch(() => {});
  }

  // Wire device status change → WS notification
  onDeviceStatusChange((ip, online) => {
    const dev = devices.find(d => d.ip === ip);
    const name = dev?.name || 'Pixoo64';
    if (broadcastFn) {
      broadcastFn({
        type: 'device_status',
        device: 'pixoo',
        name,
        ip,
        online,
        message: online
          ? `${name} reconnected`
          : `${name} offline — power cycle may be needed`,
      } as any);
    }
    debug(TAG, online ? `${name} (${ip}) back online` : `${name} (${ip}) went offline`);
  });

  // Start state checking timer
  if (streamTimer) clearInterval(streamTimer);
  streamTimer = setInterval(doStateCheckAndPush, STATE_CHECK_INTERVAL_MS);

  debug(TAG, 'Bridge started (safe 2.5s active single-frame motion)');
}

export function broadcastPixoo(event: BridgeEvent): void {
  if (!FORWARDED_EVENTS.has(event.type)) return;

  // Always cache state for live preview (even without Pixoo devices)
  switch (event.type) {
    case 'state_update':
      lastStateEvent = event as StateUpdateEvent;
      break;
    case 'usage_update':
      lastUsageEvent = event as UsageEvent;
      break;
    case 'sessions_list':
      lastSessions = (event as SessionsListEvent).sessions;
      break;
    case 'timeline_event': {
      const entry = (event as { entry?: TimelineEntry }).entry;
      if (entry) {
        const upsert = (event as { upsert?: boolean }).upsert === true;
        const index = upsert
          ? lastTimelineEntries.findIndex((item) =>
            item.ts === entry.ts && item.type === entry.type)
          : -1;
        if (index >= 0) lastTimelineEntries[index] = entry;
        else lastTimelineEntries.push(entry);
        lastTimelineEntries.sort((a, b) => a.ts - b.ts);
        if (lastTimelineEntries.length > 96) {
          lastTimelineEntries.splice(0, lastTimelineEntries.length - 96);
        }
      }
      break;
    }
    case 'timeline_history':
      lastTimelineEntries = [
        ...((event as { entries?: TimelineEntry[] }).entries ?? []),
      ].sort((a, b) => a.ts - b.ts).slice(-96);
      break;
    case 'connection':
      if ((event as any).status === 'disconnected') {
        lastStateEvent = null;
        lastSessions = null;
        lastUsageEvent = null;
        lastTimelineEntries = [];
      }
      break;
    case 'display_state': {
      const displayOn = (event as any).displayOn as boolean;
      const dim = (event as any).dim as Record<string, unknown> | undefined;
      const rawEnabled = dim?.enabled;
      const dimEnabled = typeof rawEnabled === 'boolean' ? rawEnabled : true;
      const dimMode = dim?.mode === 'min' ? 'min' : 'off';
      const rawLevel = dim?.level;
      const dimLevel = Math.max(1, Math.min(100, Math.round(typeof rawLevel === 'number' ? rawLevel : 10)));
      const signature = `${dimEnabled}|${dimMode}|${dimLevel}`;

      if (!displayOn && !dimEnabled) {
        if (displayDimmed) {
          displayDimmed = false;
          for (const dev of devices) {
            setBrightness(dev.ip, dev.brightness ?? DEFAULT_BRIGHTNESS).catch(() => {});
          }
          lastStateHash = '';
          if (!streamTimer && devices.length > 0) {
            streamTimer = setInterval(doStateCheckAndPush, STATE_CHECK_INTERVAL_MS);
            doStateCheckAndPush();
          }
        }
        debug(TAG, 'Display sleep — dim disabled, leaving Pixoo lit');
      } else if (!displayOn && (!displayDimmed || signature !== lastDisplayDimSignature)) {
        // Mac display off → dim Pixoo and pause stream
        const target = dimMode === 'min' ? dimLevel : 0;
        displayDimmed = true;
        for (const dev of devices) {
          setBrightness(dev.ip, target).catch(() => {});
        }
        if (streamTimer) {
          clearInterval(streamTimer);
          streamTimer = null;
        }
        debug(TAG, `Display sleep — brightness ${target}, stream paused`);
      } else if (displayOn && displayDimmed) {
        // Mac display on → restore brightness and resume stream
        displayDimmed = false;
        for (const dev of devices) {
          setBrightness(dev.ip, dev.brightness ?? DEFAULT_BRIGHTNESS).catch(() => {});
        }
        // Resume stream after brief delay (let brightness restore first)
        setTimeout(() => {
          if (!displayDimmed && !streamTimer && devices.length > 0) {
            streamTimer = setInterval(doStateCheckAndPush, STATE_CHECK_INTERVAL_MS);
            lastStateHash = ''; // Force refresh
            doStateCheckAndPush(); // Immediate first sequence
          }
        }, 100);
        debug(TAG, 'Display wake — brightness restored, stream resumed');
      }
      lastDisplayDimSignature = signature;
      break;
    }
  }

  // Immediate push on major disconnections to feel snappy
  if (event.type === 'connection' && devices.length > 0) {
    if (!pushing) {
      lastStateHash = ''; // Force refresh
      doStateCheckAndPush();
    }
  }
}

export async function stopPixooBridge(): Promise<void> {
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }
  stopProbeTimer();

  // Push disconnected frame to all devices (best-effort, 2s cap)
  if (devices.length > 0) {
    const frame = renderDisconnectedFrame();
    await Promise.race([
      Promise.all(devices.map(dev => pushFrame(dev.ip, frame).catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
  }

  for (const dev of devices) {
    clearText(dev.ip).catch(() => {});
  }

  stopPreviewTimer();
  devices = [];
  lastStateEvent = null;
  lastUsageEvent = null;
  lastSessions = null;
  lastTimelineEntries = [];
  displayDimmed = false;
  lastDisplayDimSignature = '';
  broadcastFn = null;
  frameListeners = [];
  deviceLastPushTime.clear();
  debug(TAG, 'Bridge stopped');
}

/** Register a listener called whenever a new frame is rendered. */
export function onFrameRendered(listener: (frame: Uint8Array) => void): void {
  frameListeners.push(listener);
  startPreviewTimer();
}

/** Remove a frame listener. */
export function offFrameRendered(listener: (frame: Uint8Array) => void): void {
  frameListeners = frameListeners.filter(l => l !== listener);
  if (frameListeners.length === 0) stopPreviewTimer();
}

/**
 * Set the live preview frame rate (1–10 FPS).
 * Takes effect immediately by restarting the preview timer.
 */
export function setPreviewFps(fps: number): void {
  previewFps = Math.max(1, Math.min(10, Math.round(fps)));
  if (frameListeners.length > 0) {
    stopPreviewTimer();
    startPreviewTimer();
  }
  debug(TAG, `Preview FPS set to ${previewFps}`);
}

/** Get current preview FPS setting. */
export function getPreviewFps(): number {
  return previewFps;
}

export function pixooDeviceCount(): number {
  return devices.length;
}

export function getPixooDeviceDetails(): Array<{
  ip: string;
  name: string;
  backedOff: boolean;
  failures: number;
  nextProbeMs: number;
  lastPushAgo: number;
  animationMode: PixooPushMode;
}> {
  return devices.map(dev => {
    const backoff = getDeviceBackoffStatus(dev.ip);
    return {
      ip: dev.ip,
      name: dev.name || 'Pixoo64',
      backedOff: backoff.backedOff,
      failures: backoff.failures,
      nextProbeMs: backoff.nextProbeMs,
      lastPushAgo: lastPushTime > 0 ? Date.now() - lastPushTime : -1,
      animationMode: resolvePixooPushMode(isAnimationActive()),
    };
  });
}

// ===== Internal =====

/**
 * Compute a hash string representing the variables influencing the visual state of the aquarium.
 */
function calculateStateHash(): string {
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
    ? lastSessions.map(s => `${s.id}:${s.agentType}:${s.state}`).join(',')
    : '';
  const subagentInfo = Object.entries(currentSubagentActivity())
    .map(([sessionId, activity]) =>
      `${sessionId}:${activity.activeCount}:${activity.lastCompletedAt ?? 0}`)
    .sort()
    .join(',');

  return `${stateStr}|${gatewayConnected}|${gatewayHasError}|${r5}|${r7}|${u5}|${u7}|${cx1}|${cx2}|${cxStale}|${uStale}|${sessionInfo}|${subagentInfo}|${displayDimmed}`;
}

function isAnimationActive(): boolean {
  const state = lastStateEvent?.state ?? 'disconnected';
  if (state === 'processing' || state.startsWith('awaiting')) return true;
  if (Object.values(currentSubagentActivity()).some((activity) => activity.activeCount > 0)) {
    return true;
  }
  return lastSessions?.some(s => s.alive && (s.state === 'processing' || s.state?.startsWith('awaiting'))) ?? false;
}

function currentSubagentActivity(now = Date.now()): SubagentActivityBySession {
  return deriveSubagentActivity(lastTimelineEntries, { now });
}

/**
 * State Check and Push tick using per-device adaptive modes.
 */
function doStateCheckAndPush(): void {
  if (devices.length === 0) return;
  if (pushing) return;
  if (displayDimmed) return;

  const currentHash = calculateStateHash();
  const stateChanged = currentHash !== lastStateHash;
  const now = Date.now();
  const active = isAnimationActive();
  const due = devices.flatMap(dev => {
    const mode = resolvePixooPushMode(active);
    const elapsed = now - (deviceLastPushTime.get(dev.ip) ?? 0);
    return elapsed >= pixooPushIntervalMs(stateChanged, mode) ? [{ dev, mode }] : [];
  });
  if (due.length === 0) return;

  pushing = true;
  lastStateHash = currentHash;

  try {
    const ts = new Date().toISOString().slice(11, 19);
    debug('Pixoo', `${ts} pushing to ${due.length} dev(s) (changed=${stateChanged}, active=${active})`);

    const promises = due.map(({ dev, mode }) => {
      const count = 1;
      const frames = Array.from({ length: count }, (_, i) =>
        renderFrame(
          lastStateEvent,
          lastUsageEvent,
          lastSessions,
          now + i * 180,
          64,
          'standard',
          currentSubagentActivity(now + i * 180),
        ));
      // Rate-limit attempts as well as successes. This prevents a failed
      // endpoint from being retried on every 500 ms scheduler tick.
      deviceLastPushTime.set(dev.ip, Date.now());
      return pushFrames(dev.ip, frames, count > 1 ? 180 : 1000).then(ok => {
        if (ok) {
          deviceLastPushTime.set(dev.ip, Date.now());
          lastPushTime = Date.now();
        }
        debug('Pixoo', `${ts}   → ${dev.ip}: ${ok ? 'OK' : 'FAIL'} (${mode}, ${count} frame)`);
      }).catch((err: any) => {
        debug('Pixoo', `${ts}   → ${dev.ip}: ERROR ${err?.message}`);
      });
    });

    Promise.all(promises).finally(() => { pushing = false; });
  } catch (err: any) {
    pushing = false;
    debug('Pixoo', `renderFrame error: ${err?.message}`);
  }
}

/**
 * Render a fresh frame using current cached state.
 * Used by the live preview endpoint when no Pixoo device is connected.
 */
export function renderPreviewFrame(size?: 11 | 32 | 64, layout: 'standard' | 'micro' = 'standard'): Uint8Array {
  if (size === 11 || size === 32) return renderDeskAwareness(size, lastSessions, lastTimelineEntries, Date.now());
  return renderFrame(
    lastStateEvent,
    lastUsageEvent,
    lastSessions,
    undefined,
    size,
    layout,
    currentSubagentActivity(),
  );
}

/**
 * Get the last calculated frame.
 */
export function getLastFrame(size?: 11 | 32 | 64, layout: 'standard' | 'micro' = 'standard'): Uint8Array | null {
  if (size === 11 || size === 32) return renderDeskAwareness(size, lastSessions, lastTimelineEntries, Date.now());
  return renderFrame(
    lastStateEvent,
    lastUsageEvent,
    lastSessions,
    undefined,
    size,
    layout,
    currentSubagentActivity(),
  );
}

/** Notify all SSE frame listeners. */
function notifyFrameListeners(frame: Uint8Array): void {
  for (const listener of frameListeners) {
    try { listener(frame); } catch { /* best-effort */ }
  }
}

/** Preview timer: Generates frames at previewFps for the Web UI stream. */
function startPreviewTimer(): void {
  if (previewTimer) return;
  const intervalMs = Math.round(1000 / previewFps);
  previewTimer = setInterval(() => {
    if (frameListeners.length === 0) { stopPreviewTimer(); return; }
    const frame = renderFrame(
      lastStateEvent,
      lastUsageEvent,
      lastSessions,
      undefined,
      64,
      'standard',
      currentSubagentActivity(),
    );
    notifyFrameListeners(frame);
  }, intervalMs);
}

function stopPreviewTimer(): void {
  if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
}
