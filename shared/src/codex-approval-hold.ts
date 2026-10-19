/**
 * Codex device approvals — the opt-in `PermissionRequest` hold. The rules both
 * daemons apply to a hold request; the open holds themselves are per daemon
 * (Node `CodexApprovalHolds` in bridge/src/codex-approval-hold.ts, Swift the
 * `.codexApproval` gate in `ObservedSteering`).
 *
 * `PermissionRequest` fires only when Codex is about to ask the user, so unlike
 * Claude's PreToolUse hold nothing here is predicted: every held request is a
 * prompt the terminal would have drawn anyway. Codex waits for the hook before
 * drawing it (measured on codex-cli 0.160.1: the prompt appears ~120 ms after
 * the hook answers), which is what lets a device answer it — and is also the
 * whole cost: while a hold waits, the person at the terminal sees "Running
 * hook" instead of the prompt. Hence opt-in, installed as a second handler
 * next to the notification (hooks/src/codex-install.ts and
 * `CodexConfigInstaller.swift`, which emit the same command).
 *
 * The hold request posts the notification's own payload to the notification's
 * own endpoint, marked by `X-AgentDeck-Hold: <seconds the command waits>`. Its
 * payload is the notification's twin and carries no `tool_use_id`, so the
 * replay guard cannot pair them: a daemon never ingests a hold request — the
 * notification handler already did — and only puts the prompt (with its
 * button) on the row.
 *
 * Swift mirror: generated `CodexApprovalHoldRules.generated.swift`
 * (`pnpm generate-codex-approval-hold`); behaviour pinned by
 * shared/codex-approval-hold-vectors.json, which both suites replay.
 */

/** Lower-case: how both daemons' HTTP servers key request headers. */
export const CODEX_APPROVAL_HOLD_HEADER = 'x-agentdeck-hold';
export const CODEX_APPROVAL_DENY_MESSAGE = "Denied from the user's AgentDeck controller.";
/** Release this long before the command's own curl budget runs out, so a
 *  pass always reaches the hook before curl gives up on it. */
export const CODEX_APPROVAL_HOLD_MARGIN_MS = 3_000;
/** Shorter than this, a hold is a stall that no one can answer in time. */
export const CODEX_APPROVAL_HOLD_MIN_MS = 5_000;
/** The end of the turn a hold waits in releases it early (`ended`): the hook
 *  is most likely gone with the turn. Codex's terminal events plus a new
 *  prompt. A parallel call's tool hooks and notification leave it alone. */
export const CODEX_APPROVAL_RELEASING_EVENTS: readonly string[] = [
  'codex_stop', 'codex_session_end', 'codex_turn_complete', 'codex_interrupt', 'codex_user_prompt_submit',
];

/** `ended` = the turn the hold waited in is over (interrupt, stop, a new
 *  prompt): released like a pass, but its prompt is cleared, not kept. */
export type CodexApprovalOutcome = 'allow' | 'deny' | 'pass' | 'ended';

/** What the hold handler prints for an outcome. Empty prints nothing, which
 *  Codex reads as no decision: its own prompt appears as if the hook were
 *  absent. Deny carries a message because Codex hands it to the model. */
export function codexApprovalDecisionBody(outcome: CodexApprovalOutcome): string {
  if (outcome !== 'allow' && outcome !== 'deny') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: outcome === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: CODEX_APPROVAL_DENY_MESSAGE },
    },
  });
}

/** How long to hold a request whose command waits `header` seconds, given the
 *  daemon's configured hold. `null` = do not hold: a header this daemon cannot
 *  read is not a budget it may spend. */
export function codexApprovalHoldMs(header: string | undefined, defaultMs: number): number | null {
  if (header === undefined) return null;
  const value = header.trim();
  if (!/^[0-9]{1,4}$/.test(value)) return null;
  const holdMs = Math.min(defaultMs, Number(value) * 1000 - CODEX_APPROVAL_HOLD_MARGIN_MS);
  return holdMs >= CODEX_APPROVAL_HOLD_MIN_MS ? holdMs : null;
}

export function codexHoldReleasedBy(event: string): boolean {
  return CODEX_APPROVAL_RELEASING_EVENTS.includes(event);
}

/** A deck's Allow / Deny keys answer a held approval with an option press on
 *  the session (the Stream Deck's observed detail view sends `select_option`,
 *  wrapped in `session_command`), not with `permission_decision`. The index
 *  order is the deck's: Allow first. */
export const CODEX_APPROVAL_ALLOW_INDEX = 0;
export const CODEX_APPROVAL_DENY_INDEX = 1;
/** `respond` carries the option's shortcut. */
export const CODEX_APPROVAL_ALLOW_WORDS: readonly string[] = ['y', 'yes'];
export const CODEX_APPROVAL_DENY_WORDS: readonly string[] = ['n', 'no'];

export interface CodexHoldPress {
  type?: unknown;
  index?: unknown;
  value?: unknown;
}

/** The decision an option press makes on a held approval. `null` = the press
 *  is not an Allow or a Deny (another index, an unknown word), and nothing is
 *  resolved — a press is never guessed into a decision. */
export function codexHoldPressDecision(press: CodexHoldPress): 'allow' | 'deny' | null {
  if (press.type === 'select_option') {
    if (press.index === CODEX_APPROVAL_ALLOW_INDEX) return 'allow';
    if (press.index === CODEX_APPROVAL_DENY_INDEX) return 'deny';
    return null;
  }
  if (press.type === 'respond' && typeof press.value === 'string') {
    const word = press.value.trim().toLowerCase();
    if (CODEX_APPROVAL_ALLOW_WORDS.includes(word)) return 'allow';
    if (CODEX_APPROVAL_DENY_WORDS.includes(word)) return 'deny';
  }
  return null;
}

export interface CodexHoldEligibility {
  /** `AGENTDECK_OBSERVED_APPROVAL` kill switch, shared with Claude's hold. */
  enabled: boolean;
  clientCount: number;
  sessionId: string;
  /** A Codex background thread (ambient suggestions, memory consolidation). */
  background: boolean;
  /** A headless `codex exec` folded under the session that launched it. */
  execChild: boolean;
  /** A row shows the session; otherwise no device can show the prompt. */
  visible: boolean;
  alreadyHeld: boolean;
}

export function codexHoldDecision(e: CodexHoldEligibility): { hold: boolean; reason: string } {
  if (!e.enabled) return { hold: false, reason: 'disabled' };
  if (!e.sessionId) return { hold: false, reason: 'no-session' };
  if (e.background) return { hold: false, reason: 'background-thread' };
  if (e.execChild) return { hold: false, reason: 'exec-child' };
  if (e.clientCount <= 0) return { hold: false, reason: 'no-client' };
  if (!e.visible) return { hold: false, reason: 'not-visible' };
  // One per session. A second approval (a parallel call) passes straight to
  // its terminal prompt rather than swapping the question under a button
  // that would then answer a different command.
  if (e.alreadyHeld) return { hold: false, reason: 'already-held' };
  return { hold: true, reason: 'device-approval' };
}
