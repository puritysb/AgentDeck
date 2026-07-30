/**
 * Windows system control.
 *
 * URL opening uses `rundll32 url.dll,FileProtocolHandler`, NOT `cmd /c start`:
 * launcher `url:` targets are user-overridable, and cmd's parser turns `&`,
 * `^` and `%` into an injection vector, while rundll32 receives the URL as a
 * single argv with zero shell interpretation. App launch has no such escape
 * hatch — `start` (which resolves App Paths registry names, the closest analog
 * of macOS `open -a`) only exists inside cmd — so app names are gated by a
 * strict allowlist instead; anything exotic rejects into the `|url:` fallback
 * chain, which is the Launcher's designed safety net.
 */
import { execFile } from 'child_process';
import * as path from 'path';
import type { SystemBackend, VolumeSettings } from './types.js';
import { WinVolumeCoprocess } from './win32-volume.js';

function system32(exe: string): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);
}

function openUrl(urlPrefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      system32('rundll32.exe'),
      ['url.dll,FileProtocolHandler', urlPrefix],
      { timeout: 5000, windowsHide: true },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/** `start` runs inside cmd, so app names must never reach the cmd parser raw. */
const APP_NAME_RE = /^[\w .+-]+$/;

function openApp(appName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!APP_NAME_RE.test(appName)) {
      reject(new Error(`Cannot open "${appName}": name not allowed on Windows`));
      return;
    }
    execFile(
      system32('cmd.exe'),
      ['/d', '/s', '/c', 'start', '', appName],
      { timeout: 5000, windowsHide: true },
      (err) => (err ? reject(new Error(`Cannot open "${appName}": ${err.message}`)) : resolve()),
    );
  });
}

async function openAgentDeckAppOrGitHub(): Promise<void> {
  // No AgentDeck desktop app exists on Windows (the daemon is the CLI /
  // Scheduled Task), so the project page is the offline destination.
  await openUrl('https://puritysb.github.io/AgentDeck/');
}

// Lazy singleton: constructing it is cheap (no spawn until the first request).
let coprocess: WinVolumeCoprocess | null = null;
function volume(): WinVolumeCoprocess {
  if (!coprocess) coprocess = new WinVolumeCoprocess();
  return coprocess;
}

async function getVolumeSettings(): Promise<VolumeSettings> {
  return volume().get();
}

async function setVolumeNow(vol: number): Promise<void> {
  await volume().set(vol);
}

async function setOutputMuted(muted: boolean): Promise<void> {
  await volume().mute(muted);
}

export const win32Backend: SystemBackend = {
  isVolumeSupported: () => Promise.resolve(volume().isSupported()),
  getVolumeSettings,
  setVolumeNow,
  setOutputMuted,
  openUrl,
  openApp,
  openAgentDeckAppOrGitHub,
};
