/**
 * Harness identity at the hook door (#490).
 *
 * Every `/hooks/<name>` POST is first given its real harness: an unprefixed
 * name carrying a Codex payload is ingested as the `codex_*` event it is
 * (`routeHookHarness`, shared SSOT), and one Codex event instance delivered
 * twice — AgentDeck's own `codex_*` hook plus a Claude-shaped command Codex
 * also runs — is ingested once. Without this, the generic copy was read as a
 * Claude Code hook: a second `chat_response` for the same turn under the Claude
 * icon, keyed by the Codex thread. Swift mirror: `CodexHookHarness` +
 * `codexHookReplay` in DaemonServer.swift.
 */
import {
  CODEX_HOOK_REPLAY_WINDOW_MS,
  codexHookFingerprint,
  codexThreadIdFromPayload,
  routeHookHarness,
} from '@agentdeck/shared';

export type IncomingHookVerdict =
  | { kind: 'ingest'; eventName: string; rerouted: boolean }
  /** A Codex payload with no Codex route — no row, no timeline, no run. */
  | { kind: 'drop'; reason: 'codex-unrouted' }
  /** The twin of a Codex event instance already ingested. */
  | { kind: 'drop'; reason: 'codex-replay' };

const MAX_FINGERPRINTS = 2048;

export class CodexHookReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs = CODEX_HOOK_REPLAY_WINDOW_MS) {}

  /** Decide how one incoming hook is ingested. Mutates `payload` only to give
   *  a Codex event its thread as `session_id` when it named the thread under a
   *  Codex key alone (notify's `thread-id`), so it lands on the Codex
   *  session instead of the anonymous `daemon-hook` bucket. */
  admit(eventName: string, payload: Record<string, unknown>, now = Date.now()): IncomingHookVerdict {
    const route = routeHookHarness(eventName, payload);
    if (route.kind === 'drop') return { kind: 'drop', reason: 'codex-unrouted' };
    const name = route.kind === 'codex' ? route.event : eventName;
    if (!name.startsWith('codex_')) return { kind: 'ingest', eventName: name, rerouted: false };
    if (typeof payload.session_id !== 'string' || !payload.session_id) {
      const thread = codexThreadIdFromPayload(payload);
      if (thread) payload.session_id = thread;
    }
    const fp = codexHookFingerprint(name, payload);
    if (fp) {
      const at = this.seen.get(fp);
      if (at !== undefined && now - at <= this.windowMs) return { kind: 'drop', reason: 'codex-replay' };
      this.seen.delete(fp);
      this.seen.set(fp, now);
      if (this.seen.size > MAX_FINGERPRINTS) this.prune(now);
    }
    return { kind: 'ingest', eventName: name, rerouted: route.kind === 'codex' };
  }

  private prune(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at > this.windowMs || this.seen.size > MAX_FINGERPRINTS) this.seen.delete(key);
      else break;
    }
  }
}
