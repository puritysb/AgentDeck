/**
 * Hook-driven awaiting overlay for observed (non-PTY) sessions.
 *
 * When the user runs `claude` directly (not `agentdeck claude`), there is no
 * PTY for the OutputParser to read, so permission prompts ("Do you want to
 * proceed?") never reach the state machine. Instead Claude Code fires a
 * `Notification` hook, which the daemon receives with a `session_id` and a
 * free-text `message`. We stash that here, keyed by the Claude session UUID,
 * and the daemon's session enricher overlays it onto the matching observed
 * session so devices flip to the awaiting (attention) tier and show the
 * question text.
 *
 * This intentionally lives OUTSIDE the passive observer (which recomputes
 * idle/processing from the transcript every 5s and would clobber an inline
 * flag) and outside the single aggregate state machine (whose hardcoded
 * `daemon-hook` id can't attribute awaiting to a specific session). Mirrors
 * the `pushStateCache` TTL-map pattern in session-aggregator.ts.
 */

interface AwaitingEntry {
  question: string;
  /** Set when the awaiting state is an actionable, device-approvable PreToolUse
   *  gate (vs. a display-only Notification prompt). Devices render Allow/Deny
   *  and reply with permission_decision keyed by this id. */
  requestId?: string;
  updatedAt: number;
}

/** Permission prompts can sit unanswered for a long time, but a stale overlay
 *  must self-clear so a session never gets stuck showing PERMIT forever (e.g.
 *  the user answered in the terminal and no follow-up hook fired, or claude
 *  crashed). Clear-on-next-hook is the primary signal; this TTL is the backstop. */
const OVERLAY_TTL_MS = 5 * 60_000;

/** Cap question length at the source so every sessions_list broadcast stays small. */
const MAX_QUESTION_LEN = 120;

const overlay = new Map<string, AwaitingEntry>();

export function setAwaitingOverlay(sessionId: string, question: string, requestId?: string): void {
  const trimmed = (question || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_LEN);
  overlay.set(sessionId, { question: trimmed, requestId, updatedAt: Date.now() });
}

/** Returns the overlay entry if it exists and is still fresh (< TTL). Stale
 *  entries are pruned on read. */
export function getAwaitingOverlay(sessionId: string): { question: string; requestId?: string } | undefined {
  const entry = overlay.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > OVERLAY_TTL_MS) {
    overlay.delete(sessionId);
    return undefined;
  }
  return { question: entry.question, requestId: entry.requestId };
}

/** Called on any subsequent hook for a session (tool_start/tool_end/
 *  user_prompt_submit/stop/session_end) — ANY later event means the prompt
 *  was answered, so the awaiting overlay should drop. Order-independent.
 *  Returns true if an entry was actually removed, so callers can skip a
 *  needless broadcast on the common (no-overlay) path. */
export function clearAwaitingOverlay(sessionId: string): boolean {
  return overlay.delete(sessionId);
}

/** Test/diagnostic helper. */
export function _resetAwaitingOverlay(): void {
  overlay.clear();
}

/**
 * Overlay any fresh awaiting state onto a list of observed (`observed:claude:…`
 * / `observed:codex:…`) sessions, keyed by the embedded Claude session UUID.
 * Returns a new array; unaffected sessions are passed through unchanged.
 * Pure (reads the module overlay map but mutates nothing), so the daemon
 * enricher can call it on every broadcast and tests can assert it directly.
 */
export function applyAwaitingOverlayToObserved<
  T extends { id: string; state?: string; question?: string; requestId?: string },
>(sessions: T[]): T[] {
  return sessions.map((s) => {
    const uuid = s.id.replace(/^observed:(?:claude|codex):/, '');
    const ov = getAwaitingOverlay(uuid);
    if (ov) return { ...s, state: 'awaiting_permission', question: ov.question, requestId: ov.requestId };
    return s;
  });
}

/**
 * Heuristic: does a Notification `message` look like a permission/input
 * prompt rather than an idle-timeout reminder? Claude's Notification hook
 * fires for both, so this filter prevents idle pings from flipping a session
 * to awaiting. Kept conservative.
 */
export function looksLikePermissionMessage(message: string): boolean {
  if (!message) return false;
  return /needs? your permission|waiting for your|wants to|approve|permission to use|confirm|to proceed/i.test(
    message,
  );
}
