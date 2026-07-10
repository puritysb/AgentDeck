import { createWriteStream, type WriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let debugStream: WriteStream | null = null;
let debugEnabled = false;
let ptyMode = false;

/**
 * Enable debug logging to a file. This avoids interfering with PTY terminal.
 * Defaults to the OS temp dir (portable — `/tmp` on macOS/Linux, `%TEMP%` on
 * Windows, where a hardcoded `/tmp/...` resolves to a bogus `<drive>:\tmp\...`
 * and silently writes nothing). `tail -f "$(node -e 'console.log(require("os").tmpdir())')/agentdeck-debug.log"`.
 */
export function enableDebugLog(path = join(tmpdir(), 'agentdeck-debug.log')): void {
  debugStream = createWriteStream(path, { flags: 'w' });
  debugEnabled = true;
  debugStream.write(`[agentdeck] Debug log started at ${new Date().toISOString()}\n`);
}

/**
 * Suppress stderr logging after PTY is active (bridge shares terminal with PTY).
 * When enabled, log() redirects to debug file only (if --debug). Daemon/CLI never call this.
 */
export function setPtyMode(enabled: boolean): void {
  ptyMode = enabled;
}

/**
 * Wall-clock stamp for stderr lines. Daemon/CLI stderr goes to long-lived log
 * files (~/.agentdeck/daemon-stderr.log); without a timestamp a restart or a
 * device incident can't be placed in time, which repeatedly blocked root-cause
 * work on intermittent device (TRMNL/D200H) outages.
 */
function stamp(): string {
  return new Date().toISOString();
}

/** Standard logging to stderr (suppressed in PTY mode to avoid terminal noise) */
export function log(...args: unknown[]): void {
  if (ptyMode) {
    if (debugEnabled && debugStream) {
      const ts = new Date().toISOString().slice(11, 23);
      debugStream.write(`${ts} [log] ${args.map(String).join(' ')}\n`);
    }
    return;
  }
  process.stderr.write(`${stamp()} [agentdeck] ${args.map(String).join(' ')}\n`);
}

export function logTagged(tag: string, ...args: unknown[]): void {
  if (ptyMode) {
    if (debugEnabled && debugStream) {
      const ts = new Date().toISOString().slice(11, 23);
      debugStream.write(`${ts} [${tag}] ${args.map(String).join(' ')}\n`);
    }
    return;
  }
  process.stderr.write(`${stamp()} [${tag}] ${args.map(String).join(' ')}\n`);
}

/** Critical errors — always shown even in PTY mode (user action required) */
export function logError(...args: unknown[]): void {
  const msg = `${stamp()} [agentdeck] ERROR: ${args.map(String).join(' ')}\n`;
  process.stderr.write(msg);
  if (debugEnabled && debugStream) {
    const ts = new Date().toISOString().slice(11, 23);
    debugStream.write(`${ts} [ERROR] ${args.map(String).join(' ')}\n`);
  }
}

/** Debug logging — only goes to file when --debug is enabled */
export function debug(tag: string, ...args: unknown[]): void {
  if (!debugEnabled || !debugStream) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  debugStream.write(`${ts} [${tag}] ${args.map(String).join(' ')}\n`);
}
