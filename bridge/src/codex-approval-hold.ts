/**
 * Open Codex device-approval holds — the Node daemon's half of the opt-in
 * `PermissionRequest` hold. What a hold request means, when one is held, how
 * long, what the hook prints and which events end it are shared rules in
 * shared/src/codex-approval-hold.ts (Swift: the generated
 * `CodexApprovalHoldRules` plus the `.codexApproval` gate in
 * `ObservedSteering`). This registry only remembers, per Codex session, the
 * hold a device can answer and whether its turn ended under it.
 */
import { randomUUID } from 'crypto';
import { codexHoldPressDecision, type CodexApprovalOutcome } from '@agentdeck/shared';
import { askEchoMatches } from './ask-gate.js';
import type { PermissionDecision } from './permission-resolver.js';

interface OpenHold {
  requestId: string;
  ended: boolean;
}

/** What an option press on a session does to its open hold. */
export type CodexApprovalPress =
  /** Resolve the hold as a `permission_decision` for `requestId` would. */
  | { kind: 'answer'; requestId: string; decision: 'allow' | 'deny' }
  /** Neither an Allow nor a Deny: nothing is resolved. */
  | { kind: 'not-an-answer' }
  /** Echoes a prompt this hold does not show: nothing is resolved, and the
   *  caller re-sends the row so the device redraws the live one. */
  | { kind: 'stale' };

/** Open holds by Codex session id. */
export class CodexApprovalHolds {
  private readonly bySession = new Map<string, OpenHold>();

  begin(sessionId: string): string {
    const requestId = randomUUID();
    this.bySession.set(sessionId, { requestId, ended: false });
    return requestId;
  }

  requestIdFor(sessionId: string): string | undefined {
    return this.bySession.get(sessionId)?.requestId;
  }

  /** The session's turn ended under the hold. Returns the hold to release. */
  end(sessionId: string): string | undefined {
    const open = this.bySession.get(sessionId);
    if (!open) return undefined;
    open.ended = true;
    return open.requestId;
  }

  /** A deck's Allow / Deny keys answer a hold with an option press on the
   *  session, never with `permission_decision`. Null = no hold is open, or the
   *  command is not an option press: the caller routes it as before. `shown`
   *  is the prompt on the session's row. */
  press(
    sessionId: string,
    command: Record<string, unknown>,
    shown: { question?: string; requestId?: string } | undefined,
  ): CodexApprovalPress | null {
    if (command.type !== 'select_option' && command.type !== 'respond') return null;
    const requestId = this.requestIdFor(sessionId);
    if (!requestId) return null;
    const decision = codexHoldPressDecision(command);
    if (!decision) return { kind: 'not-an-answer' };
    // A press that echoes its question must name the prompt this hold shows:
    // the session may already be on its next approval, and an Allow aimed at
    // the previous one would approve a command nobody saw.
    const echo = typeof command.question === 'string' ? command.question : undefined;
    if (echo !== undefined
      && !(shown?.requestId === requestId && shown.question && askEchoMatches(echo, shown.question))) {
      return { kind: 'stale' };
    }
    return { kind: 'answer', requestId, decision };
  }

  /** Drop the hold once released; reports how it ended. */
  finish(sessionId: string, requestId: string, decision: PermissionDecision): CodexApprovalOutcome {
    const open = this.bySession.get(sessionId);
    if (open?.requestId !== requestId) return decision;
    this.bySession.delete(sessionId);
    return open.ended ? 'ended' : decision;
  }
}
