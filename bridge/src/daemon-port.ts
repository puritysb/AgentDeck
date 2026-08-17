/**
 * The CLI daemon's **preferred port** — the port it intends to serve, as
 * opposed to the port it ended up on.
 *
 * Roadmap item 11 (docs/ENTERPRISE-ROADMAP.md §1.5) asks for a persistent
 * `daemonPort` for the CLI to match the macOS app's `AppPreferences.daemonPort`.
 * The reason it matters is not configurability for its own sake — it is that
 * without a recorded intent, a daemon that landed on a fallback port has no way
 * to know it is on the wrong one.
 *
 * ## Intent is persisted; the outcome never is
 *
 * This is the rule the whole module exists to enforce. `daemon.json` records
 * where the daemon *is*, and every client resolves through it. This setting
 * records where the daemon *wants to be*. Persisting the outcome instead would
 * be self-reinforcing: a daemon bumped to 9121 by a transient hold would write
 * 9121 down and start there forever, turning a 14-second kernel reservation
 * into a permanent move. So nothing in the daemon's startup path ever writes
 * this value — only the user does, via `agentdeck daemon port <n>`.
 *
 * ## Sources
 *
 * `-p/--port` › `AGENTDECK_DAEMON_PORT` › `settings.json` `daemonPort` › 9120.
 * All four are statements of intent; they differ only in precedence and in how
 * long they last. The resolved `source` is carried alongside the number because
 * one caller needs it: `daemon start` treats a port the user typed on THIS
 * invocation differently from one it merely defaulted to (an explicit choice
 * fails loudly rather than quietly binding a different port).
 */

import { loadDaemonSettings } from './daemon-settings.js';
import { DAEMON_DEFAULT_PORT } from './session-registry.js';

/** `settings.json` key. Same name as the macOS app's `prefs.daemonPort`. */
export const DAEMON_PORT_SETTING_KEY = 'daemonPort';

/** Environment override, for a shell or MDM profile that cannot edit files. */
export const DAEMON_PORT_ENV_VAR = 'AGENTDECK_DAEMON_PORT';

/**
 * Accepted range, mirroring `AppPreferences.clampPort` (1024–65535). Below 1024
 * needs root on every platform we support, which the daemon never has.
 */
export const DAEMON_PORT_MIN = 1024;
export const DAEMON_PORT_MAX = 65535;

/**
 * How long the daemon waits for its preferred port to come free before
 * conceding to a fallback, when nothing answers `/health` on it.
 *
 * Sized from a measurement, not a guess: cancelling a listener on macOS leaves
 * a NECP reservation on the port for ~14s (bindable at ~17s, measured
 * 2026-08-06 — `lsof` shows zero sockets for the whole interval and `bind()`
 * still returns EADDRINUSE). 20s clears that with margin.
 *
 * The wait polls, so it costs only as long as the port is actually held. The
 * full budget is paid only when something outside AgentDeck really is
 * listening there — once per daemon start, with a log line saying so.
 */
export const PREFERRED_PORT_RECLAIM_MS = 20_000;

export type DaemonPortSource = 'flag' | 'env' | 'settings' | 'default';

export interface ResolvedDaemonPort {
  port: number;
  source: DaemonPortSource;
}

/** True when `value` is a port this daemon may be asked to bind. */
export function isValidDaemonPort(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= DAEMON_PORT_MIN
    && value <= DAEMON_PORT_MAX;
}

/**
 * Parse a port written as text (a flag value, an env var). Returns null for
 * anything that is not a valid port — including `"9120abc"`, which `parseInt`
 * would happily read as 9120.
 */
export function parseDaemonPort(raw: string | undefined | null): number | null {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return isValidDaemonPort(value) ? value : null;
}

/**
 * The persisted preference, or null when absent or unusable.
 *
 * Lenient on purpose: a malformed `daemonPort` must fall through to the
 * default rather than stop the daemon from starting. The *setter* is the strict
 * half — it rejects out-of-range input with a message, so a typo is caught
 * where the user can see it instead of silently reverting six weeks later.
 */
export function preferredDaemonPortFrom(settings: Record<string, unknown>): number | null {
  const value = settings[DAEMON_PORT_SETTING_KEY];
  if (isValidDaemonPort(value)) return value;
  // A port stored as a string is a plausible hand-edit of settings.json.
  if (typeof value === 'string') return parseDaemonPort(value);
  return null;
}

export interface ResolveDaemonPortInput {
  /** `-p/--port` as typed on THIS invocation, or undefined when defaulted. */
  flag?: string | number | null;
  env?: NodeJS.ProcessEnv;
  settings?: Record<string, unknown>;
}

/**
 * Resolve the preferred port and where it came from. Pure — every input is
 * injectable so the precedence order can be pinned without touching the real
 * environment or the real settings file.
 */
export function resolveDaemonPort(input: ResolveDaemonPortInput = {}): ResolvedDaemonPort {
  const flag = typeof input.flag === 'number' ? input.flag : parseDaemonPort(input.flag ?? undefined);
  if (isValidDaemonPort(flag)) return { port: flag, source: 'flag' };

  const env = input.env ?? process.env;
  const fromEnv = parseDaemonPort(env[DAEMON_PORT_ENV_VAR]);
  if (fromEnv !== null) return { port: fromEnv, source: 'env' };

  const fromSettings = preferredDaemonPortFrom(input.settings ?? loadDaemonSettings());
  if (fromSettings !== null) return { port: fromSettings, source: 'settings' };

  return { port: DAEMON_DEFAULT_PORT, source: 'default' };
}

/** Human-readable provenance, for `daemon port` and the startup log. */
export function describeDaemonPortSource(source: DaemonPortSource): string {
  switch (source) {
    case 'flag': return '--port';
    case 'env': return DAEMON_PORT_ENV_VAR;
    case 'settings': return `settings.json ${DAEMON_PORT_SETTING_KEY}`;
    case 'default': return 'built-in default';
  }
}
