/**
 * Harness identity at a managed session bridge's hook door (#490 follow-up).
 *
 * `agentdeck claude|codex|monitor` exports `AGENTDECK_PORT` into its PTY, and
 * every AgentDeck hook script — Claude's and Codex's alike — posts to that
 * port before it looks for the daemon. So a Codex started inside a managed
 * Claude terminal (or `codex exec` run by Claude as a tool) delivers its
 * `codex_*` hooks to the Claude bridge, whose state machine drives the one
 * Claude session from them: the nested Codex turn's Stop closed the Claude
 * turn, and its prompt re-opened it. The same holds the other way round, and a
 * Codex that imported Claude's hooks posts unprefixed `Stop`/`PreToolUse`
 * carrying a Codex payload.
 *
 * The rule mirrors the daemons (`routeHookHarness`, `CodexHookReplayGuard`):
 * a hook's harness is read from its payload and prefix, never from the port it
 * reached. A hook of the bridge's own harness drives the session; any other
 * harness's hook is someone else's session and is handed to the local daemon
 * unchanged, as if `AGENTDECK_PORT` had not been set.
 */
import { HOOK_HARNESS_PREFIXES, routeHookHarness } from '@agentdeck/shared';
import { CodexHookReplayGuard } from './codex-hook-replay.js';

/** The harness whose hooks a managed bridge owns — fixed by its adapter class
 *  before the hook port opens (monitor mode is a Claude hook receiver). An
 *  OpenCode bridge owns no HTTP hooks in practice: its observer plugin stays
 *  silent inside a managed PTY, so whatever reaches it is a nested agent's. */
export type ManagedHarness = 'claude-code' | 'codex' | 'opencode';

export type ManagedHookVerdict =
  /** This session's own hook: emit it under `eventName`. `quiet` answers the
   *  hook script with an empty body (a Codex payload on a Claude-shaped
   *  command, whose output Codex would read back). */
  | { kind: 'own'; eventName: string; quiet: boolean }
  /** Another harness's session: forward to the daemon, never emit here. */
  | { kind: 'foreign' }
  /** A Codex twin already ingested, or a Codex payload with no Codex route. */
  | { kind: 'drop' };

export class ManagedHookGate {
  private readonly replay = new CodexHookReplayGuard();

  constructor(private readonly own: () => ManagedHarness) {}

  /** May set `payload.session_id` from a Codex thread key, as the daemon does. */
  classify(eventName: string, payload: Record<string, unknown>, now = Date.now()): ManagedHookVerdict {
    const route = routeHookHarness(eventName, payload);
    if (route.kind === 'drop') return { kind: 'drop' };
    const codex = route.kind === 'codex' || eventName.startsWith('codex_');
    const prefix = HOOK_HARNESS_PREFIXES.find((p) => eventName.startsWith(p));
    const harness = codex ? 'codex' : prefix ? prefix.slice(0, -1) : 'claude-code';
    if (harness !== this.own()) return { kind: 'foreign' };
    if (harness !== 'codex') return { kind: 'own', eventName, quiet: false };
    const verdict = this.replay.admit(eventName, payload, now);
    if (verdict.kind === 'drop') return { kind: 'drop' };
    return { kind: 'own', eventName: verdict.eventName, quiet: verdict.rerouted };
  }
}

/** The reply a hook script gets when nothing better is known. Claude's
 *  steering hooks echo their body, so they get nothing (normal flow); so does
 *  any unprefixed hook carrying a Codex payload (`quiet`), because Codex reads
 *  a Claude-shaped command's output back. Everything else gets the ack. */
export function neutralHookReply(eventName: string, quiet = false): string {
  const prefixed = HOOK_HARNESS_PREFIXES.some((p) => eventName.startsWith(p));
  if (eventName === 'PreToolUse' || eventName === 'Stop' || (quiet && !prefixed)) return '';
  return JSON.stringify({ received: true });
}

export interface ForwardedHookReply { status: number; contentType: string; body: string }

export type ForeignHookForwarder = (
  eventName: string,
  body: string,
  headers: Record<string, string>,
) => Promise<ForwardedHookReply | null>;

/** How long a forwarded hook may wait on the daemon — just under the hook
 *  script's own `--max-time`, so a held PreToolUse decision still arrives. */
export function forwardTimeoutMs(eventName: string): number {
  if (eventName === 'PreToolUse') return 58_000;
  if (eventName === 'Stop') return 9_000;
  return 2_000;
}

/** How long a resolved daemon port is reused, so a burst of foreign hooks
 *  does not rescan the port range once per hook. */
const DAEMON_PORT_CACHE_MS = 5_000;

/** Forward a foreign hook to the local daemon. Null when there is no daemon to
 *  take it (or the only one found is this bridge), or it did not answer in
 *  time. The lookup counts against the hook's budget. */
export function createDaemonHookForwarder(deps: {
  ownPort: () => number;
  findDaemonPort: () => Promise<number | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): ForeignHookForwarder {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let cached: { port: number; at: number } | null = null;
  let lookup: Promise<number | null> | null = null;
  const daemonPort = async (): Promise<number | null> => {
    if (cached && now() - cached.at < DAEMON_PORT_CACHE_MS) return cached.port;
    lookup ??= deps.findDaemonPort().catch(() => null).then((port) => {
      // Only a found daemon is reused: one starting up must be reachable at once.
      cached = port ? { port, at: now() } : null;
      lookup = null;
      return port;
    });
    return lookup;
  };
  return async (eventName, body, headers) => {
    const startedAt = now();
    const port = await daemonPort();
    if (!port || port === deps.ownPort()) return null;
    const budget = forwardTimeoutMs(eventName) - (now() - startedAt);
    if (budget <= 0) return null;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/hooks/${encodeURIComponent(eventName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(budget),
      });
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/json',
        body: await response.text(),
      };
    } catch {
      cached = null;
      return null;
    }
  };
}
