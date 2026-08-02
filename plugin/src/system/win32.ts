/**
 * Windows system control.
 *
 * URL opening uses `rundll32 url.dll,FileProtocolHandler`, NOT `cmd /c start`:
 * launcher `url:` targets are user-overridable, and cmd's parser turns `&`,
 * `^` and `%` into an injection vector, while rundll32 receives the URL as a
 * single argv with zero shell interpretation. App launch resolves an exact
 * Start-menu display name through Get-StartApps. The user-controlled name is
 * passed in an environment variable, never interpolated into PowerShell code.
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

const POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
] as const;

const OPEN_START_APP_SCRIPT =
  '$app = Get-StartApps | Where-Object { $_.Name -eq $env:AGENTDECK_LAUNCH_TARGET } | Select-Object -First 1; ' +
  'if (-not $app) { exit 2 }; ' +
  'Start-Process -FilePath ("shell:AppsFolder\\" + $app.AppID)';

function openApp(appName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [...POWERSHELL_ARGS, OPEN_START_APP_SCRIPT],
      {
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env, AGENTDECK_LAUNCH_TARGET: appName },
      },
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
