/**
 * Platform-dispatch facade for system control (volume, URL/app launch).
 *
 * Exports keep the exact names the action modules always imported from the old
 * `utility-modes/macos.ts`, so consumers are platform-blind: the only thing
 * that changed for them is this import path. Only this file reads
 * `process.platform`; tests inject a platform into `selectBackend` directly.
 */
import type { SystemBackend, VolumeSettings } from './types.js';
import { darwinBackend } from './darwin.js';
import { win32Backend } from './win32.js';

export type { SystemBackend, VolumeSettings } from './types.js';

/**
 * Only mac + windows ship (the manifest's OS entries). Anything else falls
 * back to the darwin backend, where osascript/open reject with ENOENT into the
 * plugin's existing catch paths — a dwarn per poll tick, same as pre-dispatch
 * behavior. Acceptable: no such host exists for the Stream Deck app.
 */
export function selectBackend(platform: NodeJS.Platform): SystemBackend {
  return platform === 'win32' ? win32Backend : darwinBackend;
}

const backend = selectBackend(process.platform);

/** False puts the E1 dial into its N/A face (e.g. Windows Add-Type blocked by WDAC). */
export function isVolumeSupported(): Promise<boolean> {
  return backend.isVolumeSupported();
}

export function getVolumeSettings(): Promise<VolumeSettings> {
  return backend.getVolumeSettings();
}

/**
 * Debounced per channel key: rapid dial rotation coalesces so only the final
 * value commits. Errors are swallowed here (exactly as the old macos.ts did) —
 * a failed tick surfaces as the 2s poll snapping the value back, and on win32
 * the coprocess's OK echo is deliberately discarded: the poll is the read path.
 */
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

function debounced(key: string, fn: () => void, delayMs = 100): void {
  const existing = debounceMap.get(key);
  if (existing) clearTimeout(existing);
  debounceMap.set(key, setTimeout(() => {
    debounceMap.delete(key);
    fn();
  }, delayMs));
}

export function setOutputVolume(vol: number): void {
  debounced('output-volume', () => {
    backend.setVolumeNow(vol).catch(() => {});
  });
}

/** Rejects on failure so the caller can surface it (showAlert) — see utility-dial. */
export function setOutputMuted(muted: boolean): Promise<void> {
  return backend.setOutputMuted(muted);
}

/**
 * Focus an existing browser tab matching urlPrefix (macOS nicety), or open a
 * new one. Non-mac platforms always open a fresh tab.
 */
export function openOrFocusBrowserTab(urlPrefix: string): Promise<void> {
  return backend.openUrl(urlPrefix);
}

export function openAgentDeckAppOrGitHub(): Promise<void> {
  return backend.openAgentDeckAppOrGitHub();
}

/**
 * Launch or focus a desktop app by name.
 * Rejects when the app is not installed, so the caller can walk its fallback chain.
 */
export function openApp(appName: string): Promise<void> {
  return backend.openApp(appName);
}
