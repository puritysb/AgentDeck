/**
 * Hook-derived OpenCode session rows for the Node daemon.
 *
 * The passive process scan lists a standalone `opencode` TUI as
 * `observed:opencode:<pid>` — alive, always `idle`, project from the process
 * cwd — because it can see nothing else. The AgentDeck observer plugin
 * (hooks/src/opencode-install.ts) POSTs `opencode_*` lifecycle hooks keyed by
 * OpenCode's own session id, and those carry everything the scan cannot: the
 * turn (prompt/stop), the running tool, and — the reason this module exists —
 * `permission.asked`, which OpenCode emits only when it is GENUINELY waiting
 * for the user. Until 2026-09-05 the Node daemon classified those hooks for
 * the timeline/APME and dropped them for session state, so an OpenCode
 * session blocked on a permission read `idle` on every surface while the
 * Swift daemon (which builds `opencode:<id>` rows from the same hooks)
 * showed PERM with an answerable requestId.
 *
 * Mirror of the Swift daemon's `opencode_*` cases in `DaemonServer.swift`,
 * shaped like `HookCodexSessions`: rows come and go with the hooks, and the
 * PID row for the same working directory yields to the hook row so one TUI is
 * never two creatures.
 */

import type { ObservedSession } from './passive-observer.js';
import { resolveProjectNameFromCwdCached } from './utils/project-name.js';

/** A row with no hook at all for this long is gone (the plugin posts on every
 *  turn edge and tool, so an attended session refreshes constantly). */
const SILENT_TTL_MS = 30 * 60_000;

export type HookOpenCodeState = 'idle' | 'processing' | 'awaiting_permission';

export interface HookOpenCodeSession {
  sessionId: string;
  projectName: string;
  cwd?: string;
  state: HookOpenCodeState;
  currentTool?: string;
  /** Permission prompt text while `awaiting_permission`. */
  question?: string;
  /** `ocperm:<sid>:<permissionId>` — the daemon's `permission_decision`
   *  route recognises this prefix and answers through the plugin queue. */
  requestId?: string;
  startedAt: number;
  lastHookAt: number;
}

export interface HookOpenCodePayload {
  sessionId?: string;
  cwd?: string;
  projectName?: string;
  toolName?: string;
  permissionId?: string;
  title?: string;
}

const OPENING_EVENTS = new Set([
  'opencode_session_start', 'opencode_user_prompt_submit', 'opencode_tool_start',
  'opencode_permission_asked',
]);

export function openCodePermissionRequestId(sessionId: string, permissionId: string): string {
  return `ocperm:${sessionId}:${permissionId}`;
}

export class HookOpenCodeSessions {
  private readonly sessions = new Map<string, HookOpenCodeSession>();

  /** Fired when a hook changed something worth broadcasting. */
  onChanged: (() => void) | undefined;

  note(event: string, payload: HookOpenCodePayload, now = Date.now()): boolean {
    const sessionId = payload.sessionId?.trim();
    if (!sessionId || !event.startsWith('opencode_')) return false;

    if (event === 'opencode_session_end') {
      const removed = this.sessions.delete(sessionId);
      if (removed) this.onChanged?.();
      return removed;
    }

    const existing = this.sessions.get(sessionId);
    if (!existing && !OPENING_EVENTS.has(event)) return false;

    const session: HookOpenCodeSession = existing ?? {
      sessionId,
      projectName: '',
      state: 'idle',
      startedAt: now,
      lastHookAt: now,
    };
    const before = JSON.stringify(session);
    session.lastHookAt = now;

    if (!session.cwd && payload.cwd) {
      session.cwd = payload.cwd;
      session.projectName = resolveProjectNameFromCwdCached(payload.cwd);
    }
    if (!session.projectName && payload.projectName) session.projectName = payload.projectName;

    switch (event) {
      case 'opencode_user_prompt_submit':
        session.state = 'processing';
        session.currentTool = undefined;
        this.clearPermission(session);
        break;
      case 'opencode_tool_start':
        session.state = 'processing';
        session.currentTool = payload.toolName || undefined;
        this.clearPermission(session);
        break;
      case 'opencode_tool_end':
        session.state = 'processing';
        session.currentTool = undefined;
        this.clearPermission(session);
        break;
      case 'opencode_stop':
        session.state = 'idle';
        session.currentTool = undefined;
        this.clearPermission(session);
        break;
      case 'opencode_permission_asked': {
        // OpenCode fires this only when it is genuinely asking — a
        // zero-false-positive gate signal, no prediction needed.
        const permissionId = payload.permissionId?.trim();
        if (permissionId) {
          const title = (payload.title ?? '').replace(/\s+/g, ' ').trim();
          session.state = 'awaiting_permission';
          session.question = (title || 'Permission requested').slice(0, 120);
          session.requestId = openCodePermissionRequestId(sessionId, permissionId);
        }
        break;
      }
      case 'opencode_permission_replied':
        // Answered in the TUI or from a device — the tool now runs (or the
        // turn ends); either way the wait is over.
        if (session.state === 'awaiting_permission') session.state = 'processing';
        this.clearPermission(session);
        break;
      default:
        break;
    }

    this.sessions.set(sessionId, session);
    this.reap(now);
    const changed = JSON.stringify(session) !== before || !existing;
    if (changed) this.onChanged?.();
    return changed;
  }

  snapshot(): HookOpenCodeSession[] {
    return [...this.sessions.values()];
  }

  private clearPermission(session: HookOpenCodeSession): void {
    session.question = undefined;
    session.requestId = undefined;
  }

  private reap(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastHookAt > SILENT_TTL_MS) this.sessions.delete(sessionId);
    }
  }

  /**
   * Merge hook rows into the observed list. A hook row wins over a PID row
   * for the same working directory: the scan cannot tell which TUI is which,
   * while the hook row knows its session, its turn and its prompt.
   */
  applyTo(observed: ObservedSession[], now = Date.now()): ObservedSession[] {
    this.reap(now);
    if (this.sessions.size === 0) return observed;

    const hookRows = [...this.sessions.values()];
    const hookCwds = new Set(hookRows.map((s) => s.cwd).filter((c): c is string => Boolean(c)));
    const seen = new Set<string>();
    const kept: ObservedSession[] = [];
    for (const session of observed) {
      const match = /^observed:opencode:(.+)$/.exec(session.id);
      if (!match?.[1]) {
        kept.push(session);
        continue;
      }
      if (this.sessions.has(match[1])) {
        seen.add(match[1]);
        kept.push(session);
        continue;
      }
      // A PID-keyed scan row in a directory a hook row already covers.
      const isPidRow = /^\d+$/.test(match[1]);
      if (isPidRow && session.cwd && hookCwds.has(session.cwd)) continue;
      kept.push(session);
    }

    for (const session of hookRows) {
      if (seen.has(session.sessionId)) continue;
      kept.push({
        id: `observed:opencode:${session.sessionId}`,
        port: 0,
        pid: 0,
        projectName: session.projectName || (session.cwd ? resolveProjectNameFromCwdCached(session.cwd) : 'OpenCode'),
        agentType: 'opencode',
        alive: true,
        state: session.state,
        controlMode: 'observed',
        cwd: session.cwd,
        startedAt: new Date(session.startedAt).toISOString(),
        currentTask: session.currentTool,
        ...(session.question ? { question: session.question } : {}),
        ...(session.requestId ? { requestId: session.requestId } : {}),
      } as ObservedSession);
    }
    return kept;
  }
}
