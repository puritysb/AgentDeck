// hook-codex-sessions.ts — Codex sessions derived from lifecycle hooks alone.
//
// The Node daemon has always let the ps/lsof passive observer own observed
// Codex session identity and state, with `codex_*` hooks feeding only the
// timeline (see the dispatch comment in daemon-server.ts). That works right up
// until the process scan can't answer: `lsof` is a 2 s-timeout subprocess, and
// when it times out — or a Codex holds no rollout open — the row disappears
// from every deck even though hooks are still arriving. The Swift daemon never
// had this failure mode because it has no process visibility at all and
// synthesizes a session from `codex_session_start` directly
// (`DaemonServer.handleHookEvent`). This is that path, ported.
//
// Ownership rules, so the two sources can't fight:
//   • The observer wins whenever it sees the session. A hook row is emitted only
//     for a session id no observed row carries — never a second row for one
//     conversation.
//   • Hook rows are deliberately thin (id, project, state, tool). Model, token
//     counts, context %, and goal come from the rollout and stay the observer's
//     job; a hook row that guessed them would flicker against the real values
//     the moment the scan recovered.

import type { ObservedSession } from './passive-observer.js';
import { resolveProjectNameFromCwdCached } from './utils/project-name.js';

/** Reaped this long after the turn-ending hook — Swift's `codexPostTerminalTTL`. */
const POST_TERMINAL_TTL_MS = 60_000;
/**
 * Reaped this long after ANY hook when no terminal event arrived. A session
 * killed mid-turn (SIGKILL, closed laptop) fires no `codex_stop`, and without
 * this its creature would sit "processing" forever.
 */
const SILENT_TTL_MS = 30 * 60_000;

/** Hook events that may create a row. */
const OPENING_EVENTS = new Set(['codex_session_start', 'codex_user_prompt_submit']);
/** Hook events that end a turn. `codex_turn_complete` is the notify-only fallback. */
const TERMINAL_EVENTS = new Set(['codex_stop', 'codex_session_end', 'codex_turn_complete']);
/**
 * A finished session stays un-resurrectable this long — longer than its row
 * lives, so a trailing tool callback can't revive a creature 90 s after the turn
 * ended. Only an explicit opening event clears it.
 */
const TOMBSTONE_TTL_MS = 30 * 60_000;

export interface HookCodexSession {
  sessionId: string;
  projectName: string;
  cwd?: string;
  state: 'idle' | 'processing';
  currentTool?: string;
  startedAt: number;
  lastHookAt: number;
  terminalAt?: number;
}

export interface HookCodexPayload {
  sessionId?: string;
  cwd?: string;
  projectName?: string;
  toolName?: string;
}

export class HookCodexSessions {
  private readonly sessions = new Map<string, HookCodexSession>();
  /** sessionId → epoch ms of its last terminal hook, outliving the row. */
  private readonly terminated = new Map<string, number>();

  /** Fired when a hook changed something worth broadcasting. */
  onChanged: (() => void) | undefined;

  /**
   * Record a `codex_*` lifecycle hook. Returns true when the sessions list
   * should be rebroadcast.
   */
  note(event: string, payload: HookCodexPayload, now = Date.now()): boolean {
    const sessionId = payload.sessionId?.trim();
    if (!sessionId || !event.startsWith('codex_')) return false;

    if (OPENING_EVENTS.has(event)) this.terminated.delete(sessionId);

    const existing = this.sessions.get(sessionId);
    if (!existing) {
      // A mid-turn event may open a row too — that's how a session whose start
      // hook predates this daemon (restart, or hooks installed mid-session)
      // becomes visible at all. But only when the session has no tombstone: a
      // trailing tool callback from a finished companion task must not
      // resurrect a creature. Swift layers the same tombstone-gated bypass over
      // `shouldSynthesizeUnknownHookSession`.
      if (!OPENING_EVENTS.has(event) && !isProgressEvent(event)) return false;
      if (this.terminated.has(sessionId)) return false;
    }

    const session: HookCodexSession = existing ?? {
      sessionId,
      projectName: '',
      state: 'idle',
      startedAt: now,
      lastHookAt: now,
    };
    const before = JSON.stringify(session);
    session.lastHookAt = now;

    // cwd/project upgrade once, empty→set: later hooks on the same session can
    // carry a subcommand's directory, and overwriting would relabel the row.
    if (!session.cwd && payload.cwd) {
      session.cwd = payload.cwd;
      session.projectName = resolveProjectNameFromCwdCached(payload.cwd);
    }
    if (!session.projectName && payload.projectName) session.projectName = payload.projectName;

    if (TERMINAL_EVENTS.has(event)) {
      session.state = 'idle';
      session.currentTool = undefined;
      session.terminalAt = now;
      this.terminated.set(sessionId, now);
    } else {
      // Any non-terminal hook means the turn is live again — including a
      // follow-up prompt on a session whose previous turn ended.
      session.terminalAt = undefined;
      session.state = 'processing';
      if (event === 'codex_tool_start') session.currentTool = payload.toolName || undefined;
      else if (event === 'codex_tool_end') session.currentTool = undefined;
      else if (event === 'codex_user_prompt_submit') session.currentTool = undefined;
    }

    this.sessions.set(sessionId, session);
    this.reap(now);
    const changed = JSON.stringify(session) !== before || !existing;
    if (changed) this.onChanged?.();
    return changed;
  }

  /** Drop a session immediately (explicit end, not a timeout). */
  forget(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.onChanged?.();
  }

  snapshot(): HookCodexSession[] {
    return [...this.sessions.values()];
  }

  private reap(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      const finished = session.terminalAt !== undefined
        && now - session.terminalAt > POST_TERMINAL_TTL_MS;
      if (finished || now - session.lastHookAt > SILENT_TTL_MS) this.sessions.delete(sessionId);
    }
    for (const [sessionId, at] of this.terminated) {
      if (now - at > TOMBSTONE_TTL_MS) this.terminated.delete(sessionId);
    }
  }

  /**
   * Append a row for every hook-known Codex the process scan didn't produce.
   * Sessions the observer already found are left entirely alone — its row is
   * strictly richer.
   */
  applyTo(observed: ObservedSession[], now = Date.now()): ObservedSession[] {
    this.reap(now);
    if (this.sessions.size === 0) return observed;

    const seen = new Set<string>();
    for (const session of observed) {
      // `observed:codex:<uuid>` / `observed:codex-app:<uuid>` → the bare uuid
      // hooks use. Both id forms name the same conversation.
      const match = /^observed:codex(?:-app)?:(.+)$/.exec(session.id);
      if (match?.[1]) seen.add(match[1]);
    }

    const extra: ObservedSession[] = [];
    for (const session of this.sessions.values()) {
      if (seen.has(session.sessionId)) continue;
      extra.push({
        id: `observed:codex:${session.sessionId}`,
        port: 0,
        pid: 0,
        projectName: session.projectName || 'Codex',
        agentType: 'codex-cli',
        alive: true,
        state: session.state,
        controlMode: 'observed',
        cwd: session.cwd,
        currentTask: session.currentTool,
        startedAt: new Date(session.startedAt).toISOString(),
        lastActivityAt: session.lastHookAt,
      });
    }
    return extra.length > 0 ? [...observed, ...extra] : observed;
  }
}

/** Mid-turn hooks: progress on a session that must already be known. */
function isProgressEvent(event: string): boolean {
  return event === 'codex_tool_start' || event === 'codex_tool_end';
}
