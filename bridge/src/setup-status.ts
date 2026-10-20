/**
 * `GET /setup-status` — the ONE route a browser page may read cross-origin, and
 * therefore the one route that must carry no secret (Swift mirror:
 * `DaemonServer.setupStatusPayload`). The shape is pinned for both daemons by
 * `shared/setup-status-contract.json`.
 *
 * The Ulanzi Studio Property Inspector reads it to mark its setup steps. It used
 * to decide "step 2 is done" from `state !== 'disconnected'`, but the daemon
 * reports `disconnected` whenever no MANAGED session is focused — the normal case
 * for observed `claude`/`codex` sessions — so the panel said "No agent session
 * yet" over a deck full of sessions (Ulanzi QA, 2026-10-19). `sessions` is the
 * count the deck shows; `claudeHooks` says whether Claude Code will report to
 * this daemon at all.
 *
 * Both are counts and flags, never content: no ids, names, paths, prompts or
 * token. `null` / `'unknown'` mean "could not look", which the panel treats as
 * no information rather than as zero or missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAgentDeckHookCommand } from '@agentdeck/hooks';

export type HookPresence = 'installed' | 'missing' | 'unknown';

export interface SetupStatusInput {
  port: number;
  state: string;
  /** Rows the deck shows; null when the roster could not be built in time. */
  sessions: number | null;
  claudeHooks: HookPresence;
}

export function buildSetupStatusPayload(input: SetupStatusInput): Record<string, unknown> {
  return {
    status: 'ok',
    mode: 'daemon',
    port: input.port,
    state: input.state,
    isSwift: false,
    sessions: input.sessions,
    claudeHooks: input.claudeHooks,
  };
}

/**
 * Whether `~/.claude/settings.json` carries AgentDeck's Claude Code hooks.
 * A missing file is `missing` (Claude Code reads no hooks from it either); a
 * file that cannot be read or parsed is `unknown`, never `missing`.
 */
export function claudeHookPresence(home: string = homedir()): HookPresence {
  const path = join(home, '.claude', 'settings.json');
  if (!existsSync(path)) return 'missing';
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'unknown';
  }
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object') return 'missing';
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (isAgentDeckHookCommand((group as { command?: unknown })?.command)) return 'installed';
      const handlers = (group as { hooks?: unknown })?.hooks;
      if (Array.isArray(handlers) && handlers.some((h) => isAgentDeckHookCommand((h as { command?: unknown })?.command))) {
        return 'installed';
      }
    }
  }
  return 'missing';
}

/** Resolve within `ms`, else null — the panel must not wait on a slow roster. */
export async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
