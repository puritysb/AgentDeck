/**
 * Shared spawn helper for the daemon-managed Python BLE sync clients
 * (iDotMatrix `sync.py`, Timebox `sync_ble.py`).
 *
 * Both clients were previously spawned with `stdio: 'ignore'`, which keeps the
 * child's verbose stdout from flooding the daemon log — but also discards the
 * crash traceback on stderr. A missing `bleak`/`idotmatrix` dependency, a stale
 * venv, or a bad BLE address then looks identical to a clean exit: the panel
 * goes dark and the daemon logs only "respawning in Ns" with no cause. This
 * helper pipes stdout/stderr into small ring buffers so the manager can log
 * *why* the sync died without flooding the daemon log while it is running.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { BleStatusLine } from './ble-sync-status.js';

export interface ManagedSyncChild {
  proc: ChildProcess;
  /** Last captured stderr lines, newest-last, joined with ' | ' (empty if none). */
  stderrTail: () => string;
  /** Last captured stdout/stderr lines, newest-last, joined with ' | ' (empty if none). */
  outputTail: () => string;
}

/**
 * Machine-readable status lines the sync clients print on every BLE link state
 * change. Emitted by `StatusReporter` in `pysync/matrix_sync_common.py` — the
 * two must agree on this prefix.
 */
export const BLE_STATUS_LINE_PREFIX = 'AGENTDECK_STATUS ';

export interface SpawnPythonSyncOptions {
  /** Ring size for the diagnostic stdout/stderr tails. */
  maxTailLines?: number;
  /**
   * Called for each `AGENTDECK_STATUS` line the child prints. These lines are
   * the *only* window Node has into the BLE link (the clients reconnect inside
   * their own loop, so the child staying alive proves nothing).
   */
  onStatus?: (payload: BleStatusLine) => void;
}

/**
 * Spawn a Python sync child with stdout/stderr captured into bounded tail
 * buffers. Output is not streamed live; callers read it only if the child exits
 * — except `AGENTDECK_STATUS` lines, which are parsed and dispatched live to
 * `onStatus` and kept *out* of the tails (they are state, not diagnostics, and
 * letting them into the tail would make every reconnect look like a new exit
 * cycle to `createSyncCycleSquelch`).
 */
export function spawnPythonSync(
  venvPython: string,
  args: string[],
  options: SpawnPythonSyncOptions | number = {},
): ManagedSyncChild {
  const opts: SpawnPythonSyncOptions =
    typeof options === 'number' ? { maxTailLines: options } : options;
  const maxTailLines = opts.maxTailLines ?? 8;
  const onStatus = opts.onStatus;
  // [stdin ignored, stdout/stderr piped into small rings for diagnostics]
  const proc = spawn(venvPython, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const stderrTail: string[] = [];
  const outputTail: string[] = [];
  let stderrPartial = '';
  let stdoutPartial = '';

  const capture = (label: 'stdout' | 'stderr', chunk: Buffer): void => {
    let partial = label === 'stderr' ? stderrPartial : stdoutPartial;
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      if (onStatus && trimmed.startsWith(BLE_STATUS_LINE_PREFIX)) {
        const parsed = parseStatusLine(trimmed);
        // A malformed line is a client bug, not link state — drop it into the
        // diagnostic tail rather than silently swallowing it.
        if (parsed) {
          onStatus(parsed);
          continue;
        }
      }
      const tagged = `${label}: ${trimmed}`;
      outputTail.push(tagged);
      if (outputTail.length > maxTailLines) outputTail.shift();
      if (label === 'stderr') {
        stderrTail.push(trimmed);
        if (stderrTail.length > maxTailLines) stderrTail.shift();
      }
    }
    if (label === 'stderr') stderrPartial = partial;
    else stdoutPartial = partial;
  };

  proc.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
  proc.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));

  return {
    proc,
    stderrTail: () => {
      const lines = stderrPartial.trim() ? [...stderrTail, stderrPartial.trim()] : stderrTail;
      return lines.slice(-maxTailLines).join(' | ');
    },
    outputTail: () => {
      const lines = [...outputTail];
      if (stdoutPartial.trim()) lines.push(`stdout: ${stdoutPartial.trim()}`);
      if (stderrPartial.trim()) lines.push(`stderr: ${stderrPartial.trim()}`);
      return lines.slice(-maxTailLines).join(' | ');
    },
  };
}

/** Parse one `AGENTDECK_STATUS {...}` line; null when it isn't valid JSON. */
export function parseStatusLine(line: string): BleStatusLine | null {
  if (!line.startsWith(BLE_STATUS_LINE_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(line.slice(BLE_STATUS_LINE_PREFIX.length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as BleStatusLine;
  } catch {
    return null;
  }
}

/** Emit a repeated-cycle summary at most this often while suppressing. */
const SQUELCH_SUMMARY_INTERVAL_MS = 60 * 60_000;
/** A run this long means the previous respawn loop ended; the next exit logs fresh. */
const SQUELCH_RESET_UPTIME_MS = 5 * 60_000;

/**
 * Collapse variable parts so consecutive exits from the same failure loop
 * compare equal: timestamps/addresses/hashes are masked, and the ` | `-joined
 * output tail is reduced to its set of distinct lines — the ring buffer
 * captures 1 or 2 copies of the same retry error depending on timing, which
 * must not read as a different cycle.
 */
function cycleSignature(code: number | null, signal: NodeJS.Signals | null, tail: string): string {
  const masked = tail.replace(/[0-9A-Fa-f]{4,}/g, '#').replace(/\d+/g, '#');
  const segments = [...new Set(masked.split(' | ').map((s) => s.trim()))].sort();
  return `${code}|${signal}|${segments.join(' | ')}`;
}

export interface SyncCycleSquelch {
  /** Log a spawn line, unless we're inside a suppressed repeating cycle. */
  logStart(line: string): void;
  /**
   * Log an exit line, or absorb it into the repeating-cycle summary.
   * `tail` is the captured child output alone (no prefix/backoff suffix) —
   * it is what identifies the cycle.
   */
  logExit(code: number | null, signal: NodeJS.Signals | null, uptimeMs: number, tail: string, line: string): void;
}

/**
 * Log gate for the respawn loop of a managed BLE sync child.
 *
 * A powered-off or out-of-range panel makes the sync child exit the same way
 * every backoff period, all night — thousands of identical start/exit pairs in
 * the daemon log. The gate logs the first two occurrences of an exit cycle in
 * full, then suppresses identical repeats (including their respawn start
 * lines), emitting an hourly count summary instead. Any *different* exit —
 * new error text, non-zero code, a crash after a long healthy run — flushes
 * the summary and logs immediately, so novel failures are never hidden.
 */
export function createSyncCycleSquelch(log: (msg: string) => void): SyncCycleSquelch {
  let lastSignature: string | null = null;
  let repeats = 0; // suppressed repeats of lastSignature (beyond the logged first occurrence)
  let suppressedSinceSummary = 0;
  let suppressedSince = 0;
  let lastSummaryAt = 0;
  let lastLine = '';

  const flush = (): void => {
    if (suppressedSinceSummary > 0) {
      log(
        `suppressed ${suppressedSinceSummary} repeats of the same sync cycle since ` +
          `${new Date(suppressedSince).toISOString()}; latest: ${lastLine}`,
      );
    }
    lastSignature = null;
    repeats = 0;
    suppressedSinceSummary = 0;
  };

  return {
    logStart(line: string): void {
      if (repeats > 0) return; // inside a suppressed repeating cycle
      log(line);
    },
    logExit(code, signal, uptimeMs, tail, line): void {
      // A long healthy run means the old loop ended; whatever exits next is a
      // fresh incident even if the text matches the old one.
      if (uptimeMs >= SQUELCH_RESET_UPTIME_MS) flush();
      const signature = cycleSignature(code, signal, tail);
      if (signature !== lastSignature) {
        flush();
        lastSignature = signature;
        log(line);
        return;
      }
      repeats += 1;
      suppressedSinceSummary += 1;
      lastLine = line;
      const now = Date.now();
      if (repeats === 1) {
        // Second identical cycle: log it once more, then go quiet.
        suppressedSinceSummary = 0;
        suppressedSince = now;
        lastSummaryAt = now;
        log(`${line} — repeating cycle; suppressing identical start/exit logs (hourly summary, a different exit logs immediately)`);
        return;
      }
      if (now - lastSummaryAt >= SQUELCH_SUMMARY_INTERVAL_MS) {
        log(
          `suppressed ${suppressedSinceSummary} repeats of the same sync cycle in the last ` +
            `${Math.round((now - lastSummaryAt) / 60_000)}m; latest: ${lastLine}`,
        );
        lastSummaryAt = now;
        suppressedSinceSummary = 0;
      }
    },
  };
}

/**
 * SIGTERM a managed sync child and wait (bounded) for it to exit, so the child's
 * OFFLINE / blank farewell frame finishes painting before the daemon process
 * exits.
 *
 * The Python sync clients trap SIGTERM, break their loop, push a final OFFLINE
 * (iDotMatrix) or black (Timebox) frame over BLE, then disconnect. That push
 * takes ~1s. If we only fire SIGTERM and return immediately (the old behaviour),
 * the daemon exits right away; when the daemon is a launchd job, launchd then
 * tears the job down and SIGKILLs the orphaned child mid-farewell — leaving the
 * stateful BLE panel frozen on its last dashboard frame instead of OFFLINE.
 * Awaiting the child's exit here keeps the daemon alive just long enough for the
 * farewell to land. Escalates to SIGKILL if the child overruns `timeoutMs`.
 */
export function terminateSyncChild(proc: ChildProcess, timeoutMs = 3_000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish();
    }, timeoutMs);
    timer.unref?.();
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}
