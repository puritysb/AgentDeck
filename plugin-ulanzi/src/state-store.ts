/**
 * Caches the latest daemon broadcasts and produces the merged `stateEvt` the
 * shared layout engine (`buildLayoutMap`) consumes. Focused-session selection
 * follows the AgentDeck rule: focusedSessionId ?? sessionId.
 */
import type { BridgeEvent, SessionInfo } from '@agentdeck/shared';

export class StateStore {
  /** Last raw state_update event (carries focused session's project/model/etc). */
  private lastState: Record<string, unknown> = { state: 'IDLE' };
  private sessions: SessionInfo[] = [];
  private usage: Record<string, unknown> = {};
  /** Daemon link state — false until connected, false again on disconnect. */
  private connected = false;

  /** Reflect daemon connect/disconnect so the deck shows OFFLINE when down. */
  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  /** Apply a daemon event. Returns true if the visible state likely changed. */
  apply(ev: BridgeEvent): boolean {
    const e = ev as unknown as Record<string, unknown>;
    switch (ev.type) {
      case 'sessions_list':
        this.sessions = (e.sessions as SessionInfo[]) ?? [];
        return true;
      case 'state_update':
        this.lastState = e;
        return true;
      case 'prompt_options':
        this.lastState = { ...this.lastState, options: e.options, promptType: e.promptType, question: e.question };
        return true;
      case 'usage_update':
        this.usage = e;
        return true;
      default:
        return false;
    }
  }

  /** Merged event for the shared layout engine. `allSessions` is the live list. */
  toLayoutInput(): Record<string, unknown> {
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
    return {
      ...this.lastState,
      allSessions: this.sessions,
      totalTokens,
      totalCost: (this.usage.totalCost as number) ?? (this.lastState.totalCost as number) ?? 0,
      fiveHourPercent: (this.usage.fiveHourPercent as number) ?? (this.lastState.fiveHourPercent as number) ?? 0,
      sevenDayPercent: (this.usage.sevenDayPercent as number) ?? (this.lastState.sevenDayPercent as number) ?? 0,
      fiveHourResetsAt: this.usage.fiveHourResetsAt as string | undefined,
      sevenDayResetsAt: this.usage.sevenDayResetsAt as string | undefined,
      usageKnown,
    };
  }
}
