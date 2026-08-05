import {
  State,
  type PromptOption,
  type PromptOptionsEvent,
  type SessionInfo,
  type StateUpdateEvent,
} from '@agentdeck/shared';

/** Session-owned state used exclusively by the keypad detail view. */
export interface FocusedDetailSnapshot {
  sessionId: string;
  state: State;
  options: PromptOption[];
  tool?: string;
  toolInput?: string;
  question?: string;
  modelName?: string;
  mode?: string;
  effortLevel?: string;
  suggestedPrompt?: string;
}

/** Exported so the slot manager seeds its own detail cache identically. */
export function stateFromSession(session: SessionInfo): State {
  const state = session.state;
  if (
    state === State.IDLE
    || state === State.PROCESSING
    || state === State.AWAITING_PERMISSION
    || state === State.AWAITING_OPTION
    || state === State.AWAITING_DIFF
    || state === State.DISCONNECTED
  ) {
    return state;
  }
  return session.alive ? State.IDLE : State.DISCONNECTED;
}

/**
 * Prefer an explicit user focus, then the event's source session.
 *
 * `focusedSessionId` is load-bearing, not a hint: `buildStateEvent` sets no
 * `sessionId` at all, so a hook-observed session's AWAITING_PERMISSION options
 * reach the deck attributed only by this field. Narrowing it to `sessionId`
 * silently drops Allow/Deny routing (bridge/src/__tests__/session-deck-awaiting).
 */
function eventSessionId(ev: { sessionId?: string; focusedSessionId?: string }): string | undefined {
  return ev.focusedSessionId || ev.sessionId || undefined;
}

/**
 * Keeps detail rendering isolated from plugin-global state. A state_update is a
 * replacement snapshot, not a partial merge: an omitted model/tool/question is
 * unknown for this session and must never inherit another agent's value.
 */
export class FocusedDetailState {
  private current: FocusedDetailSnapshot | null = null;

  get snapshot(): FocusedDetailSnapshot | null {
    return this.current;
  }

  clear(): void {
    this.current = null;
  }

  prime(session: SessionInfo): FocusedDetailSnapshot {
    this.current = {
      sessionId: session.id,
      state: stateFromSession(session),
      options: session.options ?? [],
      tool: session.currentTool ?? session.currentTask,
      question: session.question,
      modelName: session.modelName,
      effortLevel: session.effortLevel,
    };
    return this.current;
  }

  applyState(ev: StateUpdateEvent, focused: SessionInfo): FocusedDetailSnapshot | null {
    const sourceId = eventSessionId(ev);
    const legacyOpenClawMatch = !sourceId
      && focused.agentType === 'openclaw'
      && ev.agentType === 'openclaw';
    if (sourceId !== focused.id && !legacyOpenClawMatch) return null;

    this.current = {
      sessionId: focused.id,
      state: ev.state,
      options: ev.options ?? [],
      tool: ev.currentTool,
      toolInput: ev.toolInput,
      question: ev.question,
      // SessionInfo is the only safe fallback. Never retain the preceding
      // global model (the GLM→Claude contamination reproduced in device logs).
      modelName: ev.modelName ?? focused.modelName,
      mode: ev.permissionMode,
      effortLevel: ev.effortLevel ?? focused.effortLevel,
      suggestedPrompt: ev.state === State.IDLE ? ev.suggestedPrompt : undefined,
    };
    return this.current;
  }

  applyOptions(ev: PromptOptionsEvent, focused: SessionInfo): FocusedDetailSnapshot | null {
    // prompt_options is backward compatibility only. It is actionable in a
    // detail view solely when the daemon correlated it to the selected session.
    if (eventSessionId(ev) !== focused.id) return null;
    const base = this.current?.sessionId === focused.id
      ? this.current
      : this.prime(focused);
    this.current = {
      ...base,
      options: ev.options,
      question: ev.question,
    };
    return this.current;
  }
}
