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
  CodexRolloutCache,
  type LocatedCodexRolloutSummary,
  type ObservedSession,
} from './passive-observer.js';
import { resolveProjectNameFromCwdCached } from './utils/project-name.js';
import { isCodexBackgroundCwd } from './codex-ambient-hooks.js';
import { locateCodexRolloutAsync } from './codex-rollout-response.js';

/** Reaped this long after the turn-ending hook — Swift's `codexPostTerminalTTL`. */
const POST_TERMINAL_TTL_MS = 60_000;
/**
 * Reaped this long after ANY hook when no terminal event arrived. A session
 * killed mid-turn (SIGKILL, closed laptop) fires no `codex_stop`, and without
 * this its creature would sit "processing" forever.
 */
const SILENT_TTL_MS = 30 * 60_000;
/** A broadcast never walks or rereads a rollout on every frame. Includes misses. */
const ROLLOUT_RECHECK_MS = 5_000;
type RolloutResolver = (sessionId: string) => LocatedCodexRolloutSummary | null
  | Promise<LocatedCodexRolloutSummary | null>;
interface RolloutRead {
  checkedAt: number;
  value: LocatedCodexRolloutSummary | null;
  pending: boolean;
}

/** Hook events that may create a row. */
const OPENING_EVENTS = new Set(['codex_session_start', 'codex_user_prompt_submit']);
/** Hook events that end a turn. `codex_turn_complete` is the notify-only
 *  fallback. Exported so the headless-child registry ends a child's run on
 *  exactly the events that end a hook row's turn. */
export const CODEX_TERMINAL_EVENTS: ReadonlySet<string> = new Set(['codex_stop', 'codex_session_end', 'codex_turn_complete', 'codex_interrupt']);
const TERMINAL_EVENTS = CODEX_TERMINAL_EVENTS;
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
  /** Latest opening/tool-start evidence; a delayed tool-end is not new work. */
  workEvidenceAt: number;
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

  private readonly resolveRollout: RolloutResolver;
  private readonly rolloutCache = new CodexRolloutCache();
  private readonly rolloutPaths = new Map<string, string>();
  private readonly rolloutReads = new Map<string, RolloutRead>();

  constructor(resolveRollout?: RolloutResolver) {
    // Hooks can outlive process/fd observation on every OS, including a CLI
    // failure with no Stop hook. Async exact-id lookup and the observer's
    // mtime/size summary cache keep reconciliation off the broadcast executor.
    this.resolveRollout = resolveRollout ?? (async (sessionId) => {
      const session = this.sessions.get(sessionId);
      if (!session) return null;
      const path = this.rolloutPaths.get(sessionId) ?? await locateCodexRolloutAsync(sessionId);
      if (!path || this.sessions.get(sessionId) !== session) return null;
      this.rolloutPaths.set(sessionId, path);
      const entry = await this.rolloutCache.get(path);
      if (this.sessions.get(sessionId) !== session) {
        this.pruneRolloutCache();
        return null;
      }
      if (!entry || entry.summary.sessionId !== sessionId) {
        this.rolloutPaths.delete(sessionId);
        return null;
      }
      return { path, mtimeMs: entry.mtimeMs, summary: entry.summary };
    });
  }

  private rolloutFor(session: HookCodexSession, now: number): LocatedCodexRolloutSummary | null {
    const previous = this.rolloutReads.get(session.sessionId);
    if (previous && (previous.pending || now - previous.checkedAt < ROLLOUT_RECHECK_MS)) return previous.value;
    // Keep known metadata while refreshing; opening/forget already invalidates it.
    const read: RolloutRead = { checkedAt: now, value: previous?.value ?? null, pending: false };
    this.rolloutReads.set(session.sessionId, read);
    const accept = (value: LocatedCodexRolloutSummary | null): void => {
      // A new prompt invalidates this read, even within the same millisecond.
      // A forgotten/recreated identity must not inherit an old async result.
      if (this.sessions.get(session.sessionId) !== session || this.rolloutReads.get(session.sessionId) !== read) return;
      read.value = value?.summary.sessionId === session.sessionId ? value : null;
      read.pending = false;
    };
    try {
      const result = this.resolveRollout(session.sessionId);
      if (result instanceof Promise) {
        read.pending = true;
        void result.then(value => {
          accept(value);
          if (read.value) this.onChanged?.();
        }, () => accept(null));
      } else {
        accept(result);
      }
    } catch { accept(null); }
    return read.value;
  }

  /**
   * Record a `codex_*` lifecycle hook. Returns true when the sessions list
   * should be rebroadcast.
   */
  note(event: string, payload: HookCodexPayload, now = Date.now()): boolean {
    const sessionId = payload.sessionId?.trim();
    if (!sessionId || !event.startsWith('codex_')) return false;

    if (OPENING_EVENTS.has(event)) {
      this.terminated.delete(sessionId);
      this.rolloutReads.delete(sessionId);
    } else if (this.terminated.has(sessionId) && !TERMINAL_EVENTS.has(event)) {
      // A trailing callback cannot reopen a turn, even before its row is reaped.
      return false;
    }

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
      workEvidenceAt: now,
    };
    const before = JSON.stringify(session);
    session.lastHookAt = now;
    if (event === 'codex_user_prompt_submit' || event === 'codex_tool_start'
      || event === 'codex_permission_request') session.workEvidenceAt = now;

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
    } else if (event === 'codex_session_start') {
      // Registration proves existence, not work. A duplicate/resume must
      // not erase work already established by a prompt or tool event.
      if (!existing) session.state = 'idle';
      session.terminalAt = undefined;
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

  /** Whether hooks own this session: a live hook row, or a terminal tombstone. */
  knows(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.terminated.has(sessionId);
  }

  /** Drop a session immediately (explicit end, not a timeout). */
  forget(sessionId: string): void {
    this.rolloutReads.delete(sessionId);
    this.rolloutPaths.delete(sessionId);
    this.pruneRolloutCache();
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
    for (const sessionId of this.rolloutReads.keys()) {
      if (!this.sessions.has(sessionId)) {
        this.rolloutReads.delete(sessionId);
        this.rolloutPaths.delete(sessionId);
      }
    }
    this.pruneRolloutCache();
    for (const [sessionId, at] of this.terminated) {
      if (now - at > TOMBSTONE_TTL_MS) this.terminated.delete(sessionId);
    }
  }

  private pruneRolloutCache(): void {
    for (const sessionId of this.rolloutPaths.keys()) {
      if (!this.sessions.has(sessionId)) this.rolloutPaths.delete(sessionId);
    }
    this.rolloutCache.retain(new Set(this.rolloutPaths.values()));
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
      const located = this.rolloutFor(session, now);
      if (located?.summary.isSubagent) continue;
      const rollout = located?.summary;
      const terminal = rollout?.terminalEvent;
      // Idle/default state, file mtime and pid=0 prove no terminal boundary.
      // Require a dated, current-turn end newer than actual work openings.
      // A delayed tool-end callback may arrive after the producer terminal.
      if (session.state === 'processing' && rollout?.state === 'idle' && terminal
        && Number.isFinite(terminal.at) && terminal.at >= session.workEvidenceAt && terminal.at <= now) {
        session.state = 'idle';
        session.currentTool = undefined;
        session.terminalAt = terminal.at;
        this.terminated.set(session.sessionId, terminal.at);
      }
      // A terminal discovered late must not buy another minute on every poll.
      if (session.terminalAt !== undefined && now - session.terminalAt > POST_TERMINAL_TTL_MS) {
        this.sessions.delete(session.sessionId);
        this.rolloutReads.delete(session.sessionId);
        this.rolloutPaths.delete(session.sessionId);
        this.pruneRolloutCache();
        continue;
      }
      const desktop = rollout?.originator?.toLowerCase().includes('desktop') === true;
      const cwd = rollout?.cwd ?? session.cwd;
      // Belt and braces for the daemon-level gate: Codex's memory agent never becomes a row.
      if (isCodexBackgroundCwd(cwd)) continue;
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
        ...(rollout?.effort ? { effortLevel: rollout.effort } : {}),
        ...(rollout?.permissionMode ? { permissionMode: rollout.permissionMode } : {}),
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
