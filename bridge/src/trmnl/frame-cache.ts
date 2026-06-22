/**
 * TRMNL frame cache — the rendered 1-bit PNG dashboards the BYOS HTTP routes
 * serve. The device module keeps them fresh by re-rendering on state change; the
 * daemon's /api/display + /trmnl/image routes read them. Unlike push devices
 * (Pixoo/D200H), TRMNL pulls on its own schedule, so we only hold the latest
 * frame per resolution and let each device fetch it when it polls.
 *
 * Frames are keyed by `"<W>x<H>"` rather than a single global frame: different
 * BYOS panels report different resolutions, and each must get a correctly-sized
 * image. The map is bounded (typically one resolution is in use) to cap memory.
 */
import { renderTrmnlFrame, type TrmnlFrame } from './image-renderer.js';
import { TRMNL_WIDTH, TRMNL_HEIGHT } from '@agentdeck/shared';

const DEFAULT_KEY = `${TRMNL_WIDTH}x${TRMNL_HEIGHT}`;
/** Bound on distinct resolutions held at once (insertion-order LRU eviction). */
const MAX_FRAMES = 8;

/** Resolution-keyed cache. Insertion order doubles as LRU recency. */
const frames = new Map<string, TrmnlFrame>();
const lastHashByKey = new Map<string, string>();

let lastStateEvt: any = {
  state: 'IDLE',
  projectName: '',
  modelName: '',
  mode: 'default',
  agentType: 'daemon',
  fiveHourPercent: 0,
  sevenDayPercent: 0,
  totalTokens: 0,
  totalCost: 0,
  options: [],
  currentTool: '',
  allSessions: [],
};

function sizeKey(width?: number, height?: number): string {
  const w = width && width > 0 ? Math.round(width) : TRMNL_WIDTH;
  const h = height && height > 0 ? Math.round(height) : TRMNL_HEIGHT;
  return `${w}x${h}`;
}

function parseKey(key: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(key);
  if (!m) return { width: TRMNL_WIDTH, height: TRMNL_HEIGHT };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Visual-state fingerprint (excludes the wall clock so it doesn't churn). */
export function trmnlStateHash(evt: any): string {
  const sessions = Array.isArray(evt?.allSessions) ? evt.allSessions : [];
  const sessKey = sessions
    .map((s: any) => `${s?.id}:${s?.agentType}:${s?.state}:${s?.projectName}:${s?.modelName}`)
    .join('|');
  // No wall-clock / freshness component: a real TRMNL caches by `filename` and
  // skips the (battery + flaky-WiFi) re-download when it's unchanged. So the hash
  // must change ONLY on real visual change — never churn it for a ticking clock.
  return [
    evt?.state,
    evt?.projectName,
    evt?.modelName,
    evt?.usageKnown ? Math.round(evt?.fiveHourPercent ?? 0) : 'na',
    evt?.usageKnown ? Math.round(evt?.sevenDayPercent ?? 0) : 'na',
    // Reset windows roll over rarely — include them so a rollover re-renders the
    // countdown, but they don't churn minute-to-minute.
    evt?.fiveHourResetsAt ?? '',
    evt?.sevenDayResetsAt ?? '',
    sessKey,
  ].join('~');
}

/** AWAITING/WORKING counts from the last known state — drives adaptive cadence. */
export function getTrmnlActivity(): { awaiting: number; working: number } {
  const sessions = Array.isArray(lastStateEvt?.allSessions) ? lastStateEvt.allSessions : [];
  let awaiting = 0;
  let working = 0;
  for (const s of sessions) {
    const st = String(s?.state ?? '').toLowerCase();
    if (st.startsWith('awaiting')) awaiting++;
    else if (st === 'processing') working++;
  }
  return { awaiting, working };
}

/** Store the latest broadcast state for lazy rendering, without rendering now. */
export function setTrmnlState(evt: any): void {
  lastStateEvt = evt;
}

/** Render (and cache) the current state for one resolution key, with LRU eviction. */
function renderForKey(key: string): TrmnlFrame {
  const { width, height } = parseKey(key);
  const frame = renderTrmnlFrame(lastStateEvt, undefined, { width, height });
  frames.delete(key); // re-insert to mark most-recently-used
  frames.set(key, frame);
  lastHashByKey.set(key, trmnlStateHash(lastStateEvt));
  while (frames.size > MAX_FRAMES) {
    const oldest = frames.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    frames.delete(oldest);
    lastHashByKey.delete(oldest);
  }
  return frame;
}

/**
 * Re-render every cached resolution whose visual state changed. Returns true if
 * any new frame was produced. Called by the device module on each broadcast. If
 * no device has polled yet, primes the default resolution so a first poll is
 * instant.
 */
export function refreshTrmnlFrame(evt: any): boolean {
  lastStateEvt = evt;
  const hash = trmnlStateHash(evt);
  if (frames.size === 0) {
    renderForKey(DEFAULT_KEY);
    return true;
  }
  let rendered = false;
  for (const key of [...frames.keys()]) {
    if (lastHashByKey.get(key) === hash) continue;
    renderForKey(key);
    rendered = true;
  }
  return rendered;
}

/** Force a render from the last known state for a resolution (e.g. after setup). */
export function forceRenderTrmnlFrame(width?: number, height?: number): TrmnlFrame {
  return renderForKey(sizeKey(width, height));
}

/** Frame for a resolution, lazily rendered from the last known state if absent. */
export function getTrmnlFrame(width?: number, height?: number): TrmnlFrame {
  const key = sizeKey(width, height);
  return frames.get(key) ?? renderForKey(key);
}

/** Frame for an exact `"<W>x<H>"` key, or undefined if not cached. */
export function getTrmnlFrameByKey(key: string): TrmnlFrame | undefined {
  return frames.get(key);
}

/** Active resolution keys currently held in the cache. */
export function getTrmnlFrameKeys(): string[] {
  return [...frames.keys()];
}
