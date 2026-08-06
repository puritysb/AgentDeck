/**
 * Caches the latest daemon broadcasts and produces the merged `stateEvt` the
 * shared layout engine (`buildLayoutMap`) consumes. Focused-session selection
 * follows the AgentDeck rule: focusedSessionId ?? sessionId.
 */
import type { BridgeEvent, SessionInfo } from '@agentdeck/shared';

export class StateStore {
  /** Last raw state_update event (carries focused session's project/model/etc). */
  private lastState: Record<string, unknown> = { state: 'IDLE' };
  /** Full focused snapshots, isolated by session identity. */
  private sessionStates = new Map<string, Record<string, unknown>>();
  private sessions: SessionInfo[] = [];
  private usage: Record<string, unknown> = {};
  /** Host push-to-talk state (daemon voice_state) for the detail VOICE tile. */
  voiceState: 'idle' | 'recording' | 'transcribing' | 'error' = 'idle';
  /** Daemon link state — false until connected, false again on disconnect. */
  private connected = false;
  /**
   * Optimistic REVIEWING flip: sessionId → expiry. Set on the local REVIEW
   * press so the tile acknowledges instantly; superseded as soon as the
   * daemon's own reviewStatus lands on the row, cleared on a review_status
   * error (refusal) or the TTL (daemon dead / message lost).
   */
  private pendingReviewUntil = new Map<string, number>();

  /** Local press-ack for REVIEW — show REVIEWING before the daemon round trip. */
  markReviewPending(sessionId: string): void {
    this.pendingReviewUntil.set(sessionId, Date.now() + StateStore.PENDING_REVIEW_TTL_MS);
  }

  private static readonly PENDING_REVIEW_TTL_MS = 20_000;

  /** Reflect daemon connect/disconnect so the deck shows OFFLINE when down. */
  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  /** Start a focus handshake from the selected sessions_list row, not stale detail. */
  prepareFocus(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  private eventSessionId(e: Record<string, unknown>): string | undefined {
    const focused = typeof e.focusedSessionId === 'string' ? e.focusedSessionId : '';
    if (focused) return focused;
    return typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : undefined;
  }

  /** Is this session hook-observed? Its roster row is then the only source of
   *  its state/prompt — no state_update ever describes it. */
  private isObserved(sessionId: string): boolean {
    return this.sessions.find((s) => s.id === sessionId)?.controlMode === 'observed';
  }

  private sessionBase(sessionId: string): Record<string, unknown> | undefined {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return undefined;
    return {
      state: session.state ?? (session.alive ? 'IDLE' : 'DISCONNECTED'),
      sessionId,
      focusedSessionId: '',
      projectName: session.projectName,
      agentType: session.agentType,
      modelName: session.modelName,
      currentTool: session.currentTool,
      question: session.question,
      promptType: session.promptType,
      options: session.options ?? [],
    };
  }

  /** Apply a daemon event. Returns true if the visible state likely changed. */
  apply(ev: BridgeEvent): boolean {
    const e = ev as unknown as Record<string, unknown>;
    switch (ev.type) {
      case 'sessions_list':
        this.sessions = (e.sessions as SessionInfo[]) ?? [];
        for (const id of this.sessionStates.keys()) {
          if (!this.sessions.some((session) => session.id === id)) this.sessionStates.delete(id);
        }
        return true;
      case 'state_update': {
        this.lastState = e;
        const sessionId = this.eventSessionId(e);
        // An observed session has no live state channel of its own: its state,
        // question and options only ever arrive on its sessions_list row. But
        // opening one sends `focus_session`, and the daemon answers with its
        // GLOBAL state snapshot stamped with that session's focusedSessionId.
        // Stored as this session's snapshot it would shadow the roster row —
        // blanking the real options and freezing the render signature, so the
        // deck showed "answer in terminal" over a live question.
        if (sessionId && !this.isObserved(sessionId)) {
          // Replacement, not merge: absent fields must not survive from a
          // previous agent or an earlier state of this session.
          this.sessionStates.set(sessionId, { ...e, sessionId });
        }
        return true;
      }
      case 'prompt_options': {
        const sessionId = this.eventSessionId(e);
        // Source-less legacy events are display-only noise on a multi-session
        // daemon and must never become actionable D200H keys.
        if (!sessionId) return false;
        const base = this.sessionStates.get(sessionId) ?? this.sessionBase(sessionId) ?? { sessionId };
        this.sessionStates.set(sessionId, {
          ...base,
          options: e.options,
          promptType: e.promptType,
          question: e.question,
        });
        return true;
      }
      case 'usage_update':
        this.usage = e;
        return true;
      case 'voice_state': {
        // Host push-to-talk progress — restyles the detail-view VOICE tile.
        const state = typeof e.state === 'string' ? e.state : 'idle';
        if (state === this.voiceState) return false;
        this.voiceState = state as typeof this.voiceState;
        return true;
      }
      case 'review_status': {
        // Refusal / failure ends the optimistic REVIEWING flip immediately;
        // success lands as reviewStatus on the sessions_list row instead.
        const sessionId = typeof e.sessionId === 'string' ? e.sessionId : '';
        if (sessionId && e.status !== 'running' && this.pendingReviewUntil.delete(sessionId)) return true;
        return false;
      }
      default:
        return false;
    }
  }

  /** Sessions with the optimistic REVIEWING flip applied (daemon rows win). */
  private sessionsWithPendingReview(): SessionInfo[] {
    if (this.pendingReviewUntil.size === 0) return this.sessions;
    const now = Date.now();
    return this.sessions.map((s) => {
      const until = this.pendingReviewUntil.get(s.id);
      if (until == null) return s;
      if (s.reviewStatus != null || now > until) {
        this.pendingReviewUntil.delete(s.id);
        return s;
      }
      return { ...s, reviewStatus: 'running' as const };
    });
  }

  /** Merged event for the shared layout engine. `allSessions` is the live list. */
  toLayoutInput(selectedSessionId?: string): Record<string, unknown> {
    // Daemon down → force DISCONNECTED so the deck shows OFFLINE, not a stale list.
    if (!this.connected) {
      return { state: 'DISCONNECTED', allSessions: [] };
    }
    let totalTokens = this.usage.totalTokens as number | undefined;
    if (totalTokens == null && (this.usage.inputTokens != null || this.usage.outputTokens != null)) {
      totalTokens = ((this.usage.inputTokens as number) ?? 0) + ((this.usage.outputTokens as number) ?? 0);
    }
    totalTokens ??= (this.lastState.totalTokens as number) ?? 0;
    // Subscription quota rides usage_update. Distinguish "0% used" from "no data"
    // so the deck draws a "—" instead of a confident 0% when the hub has no
    // OAuth source or the cache went stale. The numeric is still coerced to 0
    // (the gauge bar needs a number); display is gated by usageKnown.
    const stale = this.usage.usageStale === true;
    const usageKnown = !stale && (this.usage.fiveHourPercent != null || this.usage.sevenDayPercent != null);
    // In detail mode, use only the selected session's row/snapshot. Never fall
    // back to lastState, which may belong to OpenClaw or another PTY.
    // For an observed session the roster row wins outright — a snapshot stored
    // before its row arrived (so `isObserved` could not yet reject it) must not
    // shadow the live prompt. Managed sessions keep snapshot-over-row, which is
    // where their live PTY options come from.
    const base = selectedSessionId ? (this.sessionBase(selectedSessionId) ?? {}) : {};
    const snapshot = selectedSessionId ? (this.sessionStates.get(selectedSessionId) ?? {}) : {};
    const selected = selectedSessionId
      ? (this.isObserved(selectedSessionId)
          ? { ...snapshot, ...base }
          : { ...base, ...snapshot })
      : this.lastState;
    return {
      ...selected,
      allSessions: this.sessionsWithPendingReview(),
      totalTokens,
      totalCost: (this.usage.totalCost as number) ?? (selected.totalCost as number) ?? 0,
      fiveHourPercent: (this.usage.fiveHourPercent as number) ?? (selected.fiveHourPercent as number) ?? 0,
      sevenDayPercent: (this.usage.sevenDayPercent as number) ?? (selected.sevenDayPercent as number) ?? 0,
      fiveHourResetsAt: this.usage.fiveHourResetsAt as string | undefined,
      sevenDayResetsAt: this.usage.sevenDayResetsAt as string | undefined,
      // Codex (ChatGPT) rolling-window quota rides the same usage_update event.
      // Pass it straight through so the layout engine can draw CX 5H/7D tiles
      // alongside Claude's, mirroring how fiveHourPercent is surfaced.
      codexRateLimits: this.usage.codexRateLimits,
      usageKnown,
    };
  }
}
