/** Pending asynchronous reads are invalidated by later session activity.
 * Only pending reads are retained; parallel notification/hold twins coexist. */
export class CodexApprovalProbes {
  private pending = new Map<string, Map<object, () => boolean>>();

  begin(sessionId: string, liveHold: () => boolean = () => false): { current: () => boolean; dispose: () => void } {
    const token = {};
    const tokens = this.pending.get(sessionId) ?? new Map<object, () => boolean>();
    tokens.set(token, liveHold);
    this.pending.set(sessionId, tokens);
    return {
      current: () => this.pending.get(sessionId)?.has(token) === true,
      dispose: () => {
        tokens.delete(token);
        if (tokens.size === 0 && this.pending.get(sessionId) === tokens) this.pending.delete(sessionId);
      },
    };
  }

  invalidate(sessionId: string, terminal = true): void {
    // Parallel tool progress cannot release a hook that Codex is still
    // waiting for. Terminal activity always invalidates both twins.
    if (!terminal && [...(this.pending.get(sessionId)?.values() ?? [])].some(live => live())) return;
    this.pending.delete(sessionId);
  }
}
