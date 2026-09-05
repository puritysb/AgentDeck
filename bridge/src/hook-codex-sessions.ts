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

import {
  codexRolloutSummaryForSession,
  type LocatedCodexRolloutSummary,
  type ObservedSession,
} from './passive-observer.js';
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
const TERMINAL_EVENTS = new Set(['codex_stop', 'codex_session_end', 'codex_turn_complete', 'codex_interrupt']);
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

  private readonly resolveRollout: (sessionId: string) => LocatedCodexRolloutSummary | null;

  constructor(resolveRollout?: (sessionId: string) => LocatedCodexRolloutSummary | null) {
    // macOS/Linux already get richer rows from pid→open-fd observation. The
    // id-keyed fallback is specifically the Windows bridge over that missing
    // primitive; keeping it platform-scoped also avoids duplicate disk scans.
    this.resolveRollout = resolveRollout
      ?? (process.platform === 'win32' ? codexRolloutSummaryForSession : () => null);
  }

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
      const located = this.resolveRollout(session.sessionId);
      if (located?.summary.isSubagent) continue;
      const rollout = located?.summary;
      const desktop = rollout?.originator?.toLowerCase().includes('desktop') === true;
      const cwd = rollout?.cwd ?? session.cwd;
      extra.push({
        id: `observed:${desktop ? 'codex-app' : 'codex'}:${session.sessionId}`,
        port: 0,
        pid: 0,
        projectName: cwd ? resolveProjectNameFromCwdCached(cwd) : (session.projectName || 'Codex'),
        agentType: desktop ? 'codex-app' : 'codex-cli',
        alive: true,
        state: session.state,
        controlMode: 'observed',
        cwd,
        appName: desktop ? 'ChatGPT' : undefined,
        modelName: rollout?.modelName,
        currentTask: rollout?.currentTask ?? session.currentTool,
        goal: rollout?.goal,
        contextPercent: rollout?.contextPercent,
        totalTokens: rollout?.totalTokens,
        startedAt: new Date(rollout?.startedAt ?? session.startedAt).toISOString(),
        lastActivityAt: Math.max(session.lastHookAt, located?.mtimeMs ?? 0),
      });
    }
    return extra.length > 0 ? [...observed, ...extra] : observed;
  }
}

/** Mid-turn hooks: progress on a session that must already be known. */
function isProgressEvent(event: string): boolean {
  return event === 'codex_tool_start' || event === 'codex_tool_end'
    || event === 'codex_permission_request';
}

/**
 * Device-native question for a Codex `PermissionRequest` — "Approve Bash:
 * <command>" when the payload names a command, the tool name otherwise. The
 * hook's `tool_input` is a free JSON value: the shell tool carries `command`
 * as a string or an argv array, patch tools carry a `patch`, network approvals
 * carry a `host`/`url`. Never quote the whole input: a 4 KB patch would land
 * on a 120-character device line.
 */
export function buildCodexPermissionQuestion(json: Record<string, unknown>): string {
  const tool = typeof json.tool_name === 'string' && json.tool_name.trim() ? json.tool_name.trim() : 'tool';
  const input = json.tool_input;
  let preview = '';
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    const command = rec.command ?? rec.cmd;
    if (typeof command === 'string') preview = command;
    else if (Array.isArray(command)) preview = command.filter((c): c is string => typeof c === 'string').join(' ');
    else if (typeof rec.url === 'string') preview = rec.url;
    else if (typeof rec.host === 'string') preview = rec.host;
    else if (typeof rec.path === 'string') preview = rec.path;
  } else if (typeof input === 'string') {
    preview = input;
  }
  preview = preview.replace(/\s+/g, ' ').trim();
  return preview ? `Approve ${tool}: ${preview}` : `Approve ${tool}?`;
}
