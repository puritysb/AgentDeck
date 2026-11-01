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

import { OPENCODE_PERMISSION_CHOICES, OPENCODE_PENDING_REQUEST_LIMIT, OPENCODE_QUESTION_RULES, openCodeQuestionPrompt, type OpenCodeQuestionPrompt, type PromptOption } from '@agentdeck/shared';
import { askEchoMatches } from './ask-gate.js';
import type { ObservedSession } from './passive-observer.js';
import { resolveProjectNameFromCwdCached } from './utils/project-name.js';

/** A row with no hook at all for this long is gone (the plugin posts on every
 *  turn edge and tool, so an attended session refreshes constantly). */
const SILENT_TTL_MS = 30 * 60_000;

export type HookOpenCodeState = 'idle' | 'processing' | 'awaiting_permission' | 'awaiting_option';

export interface HookOpenCodeSession {
  sessionId: string;
  projectName: string;
  cwd?: string;
  state: HookOpenCodeState;
  currentTool?: string;
  /** Permission prompt text while `awaiting_permission`. */
  question?: string;
  options?: PromptOption[];
  liveAnswerable?: boolean;
  questionDetail?: string;
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
  questionId?: string;
  title?: string;
  questions?: unknown;
  questionAnswerable?: boolean;
  replyFailed?: boolean;
}

const OPENING_EVENTS = new Set([
  'opencode_session_start', 'opencode_user_prompt_submit', 'opencode_tool_start',
  'opencode_permission_asked', 'opencode_question_asked',
]);

export function openCodePermissionRequestId(sessionId: string, permissionId: string): string {
  return `ocperm:${sessionId}:${permissionId}`;
}

export class HookOpenCodeSessions {
  private readonly waits = new Map<string, Map<string, { kind: string; id: string; title: string; prompt?: OpenCodeQuestionPrompt; answerable?: boolean; sending?: boolean; replyError?: boolean }>>();
  private readonly sessions = new Map<string, HookOpenCodeSession>();

  /** Fired when a hook changed something worth broadcasting. */
  onChanged: (() => void) | undefined;

  note(event: string, payload: HookOpenCodePayload, now = Date.now()): boolean {
    const sessionId = payload.sessionId?.trim();
    if (!sessionId || !event.startsWith('opencode_')) return false;

    if (event === 'opencode_session_end') {
      this.waits.delete(sessionId);
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
        this.waits.delete(sessionId);
        this.clearPermission(session);
        break;
      case 'opencode_tool_start':
        session.state = 'processing';
        session.currentTool = payload.toolName || undefined;
        break;
      case 'opencode_tool_end':
        session.state = 'processing';
        session.currentTool = undefined;
        break;
      case 'opencode_stop':
        this.waits.delete(sessionId);
        session.state = 'idle';
        session.currentTool = undefined;
        this.clearPermission(session);
        break;
      case 'opencode_permission_asked':
      case 'opencode_question_asked': {
        const kind = event === 'opencode_permission_asked' ? 'permission' : 'question';
        const id = (kind === 'permission' ? payload.permissionId : payload.questionId)?.trim();
        if (!id) break;
        const waits = this.waits.get(sessionId) ?? new Map();
        const key = `${kind}:${id}`;
        if (waits.size < OPENCODE_PENDING_REQUEST_LIMIT || waits.has(key)) {
          const old = waits.get(key);
          waits.set(key, { kind, id, prompt: kind === 'question' ? openCodeQuestionPrompt(payload.questions) : undefined,
            answerable: payload.questionAnswerable === true, sending: payload.replyFailed ? false : old?.sending,
            replyError: payload.replyFailed || old?.replyError, title: (payload.title ?? '').replace(/\s+/g, ' ').trim().slice(0, OPENCODE_QUESTION_RULES.maxText) || (kind === 'permission' ? 'Permission requested' : 'Answer in OpenCode') });
        }
        this.waits.set(sessionId, waits);
        break;
      }
      case 'opencode_permission_replied':
      case 'opencode_question_replied':
      case 'opencode_question_rejected':
      case 'opencode_question_unavailable': {
        const kind = event === 'opencode_permission_replied' ? 'permission' : 'question';
        const id = kind === 'permission' ? payload.permissionId : payload.questionId;
        if (id && this.waits.get(sessionId)?.delete(`${kind}:${id}`)) {
          session.state = 'processing';
          this.clearPermission(session);
        }
        break;
      }
      default:
        break;
    }

    const pending = this.waits.get(sessionId)?.values().next().value;
    if (pending) {
      session.state = pending.kind === 'permission' ? 'awaiting_permission' : 'awaiting_option';
      session.question = pending.prompt?.question ?? pending.title;
      session.options = pending.kind === 'permission' ? OPENCODE_PERMISSION_CHOICES.map(({ index, label }) => ({ index, label })) : pending.prompt?.options;
      session.questionDetail = pending.sending ? OPENCODE_QUESTION_RULES.sendingText
        : pending.replyError ? OPENCODE_QUESTION_RULES.unconfirmedText : undefined;
      session.liveAnswerable = pending.kind === 'permission' || (pending.answerable === true
        && pending.prompt?.replyable === true && pending.sending !== true);
      session.requestId = pending.kind === 'permission' ? openCodePermissionRequestId(sessionId, pending.id) : undefined;
    }
    this.sessions.set(sessionId, session);
    this.reap(now);
    const changed = JSON.stringify(session) !== before || !existing;
    if (changed) this.onChanged?.();
    return changed;
  }

  answerPermission(sessionId: string, requestId: string, decision: unknown,
    enqueue: (permissionId: string, decision: 'allow' | 'deny') => boolean): boolean {
    const wait = this.waits.get(sessionId)?.values().next().value;
    if (!wait || wait.kind !== 'permission' || requestId !== openCodePermissionRequestId(sessionId, wait.id)
      || (decision !== 'allow' && decision !== 'deny')) return false;
    return enqueue(wait.id, decision);
  }

  answerOption(sessionId: string, index: unknown, echo: unknown,
    question: (questionId: string, answers: string[][]) => boolean,
    permission: (permissionId: string, decision: 'allow' | 'deny') => boolean): boolean {
    const wait = this.waits.get(sessionId)?.values().next().value;
    if (wait?.kind !== 'permission') return this.answerQuestion(sessionId, index, echo, question);
    const choice = OPENCODE_PERMISSION_CHOICES.find(c => c.index === index);
    if (!choice || typeof echo !== 'string' || !askEchoMatches(echo, wait.title)) return false;
    return this.answerPermission(sessionId, openCodePermissionRequestId(sessionId, wait.id), choice.decision, permission);
  }

  answerQuestion(sessionId: string, index: unknown, echo: unknown,
    enqueue: (questionId: string, answers: string[][]) => boolean): boolean {
    const session = this.sessions.get(sessionId);
    const wait = this.waits.get(sessionId)?.values().next().value;
    if (!session || !wait || wait.kind !== 'question' || !wait.prompt?.replyable
      || !wait.answerable || wait.sending || !Number.isInteger(index) || typeof echo !== 'string'
      || !askEchoMatches(echo, wait.prompt.question)) return false;
    const option = wait.prompt.options.find(o => o.index === index);
    if (!option || !enqueue(wait.id, [[option.label]])) return false;
    wait.sending = true;
    wait.replyError = false;
    session.questionDetail = OPENCODE_QUESTION_RULES.sendingText;
    session.liveAnswerable = false;
    this.onChanged?.();
    return true;
  }

  snapshot(): HookOpenCodeSession[] {
    return [...this.sessions.values()];
  }

  private clearPermission(session: HookOpenCodeSession): void {
    session.question = undefined;
    session.questionDetail = undefined;
    session.options = undefined;
    session.liveAnswerable = false;
    session.requestId = undefined;
  }

  private reap(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastHookAt > SILENT_TTL_MS) {
        this.sessions.delete(sessionId);
        this.waits.delete(sessionId);
      }
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
        questionDetail: session.questionDetail ?? '',
        ...(session.requestId ? { requestId: session.requestId } : {}),
        options: session.options ?? [],
        liveAnswerable: session.liveAnswerable === true,
      } as ObservedSession);
    }
    return kept;
  }
}
