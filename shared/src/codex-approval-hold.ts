/**
 * Codex device approvals — the opt-in `PermissionRequest` hold. The rules both
 * daemons apply to a hold request; the open holds themselves are per daemon
 * (Node `CodexApprovalHolds` in bridge/src/codex-approval-hold.ts, Swift the
 * `.codexApproval` gate in `ObservedSteering`).
 *
 * `PermissionRequest` runs BEFORE reviewer routing: auto-review requests fire
 * it too. Only a user-reviewed request belongs on a device; the rollout
 * records `approvals_reviewer`, which the hook payload currently omits.
 * For human review, Codex waits for the hook before drawing the prompt
 * (measured on codex-cli 0.160.1: it appears ~120 ms after the hook answers), which is what lets a device answer it — and is also the
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
export function codexApprovalHoldMs(header: string | undefined, defaultMs: number, elapsedMs = 0): number | null {
  if (header === undefined) return null;
  const value = header.trim();
  if (!/^[0-9]{1,4}$/.test(value)) return null;
  const holdMs = Math.min(defaultMs, Number(value) * 1000 - CODEX_APPROVAL_HOLD_MARGIN_MS - Math.max(0, Math.ceil(elapsedMs)));
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

/** Scan block size, not a total rollout limit. Adjacent reads overlap by one
 * block so settings records crossing a block boundary remain whole. */
export const CODEX_APPROVAL_CONTEXT_BYTES = 8 * 1024 * 1024;
export const CODEX_APPROVAL_READ_TIMEOUT_MS = 5_000;
export const CODEX_APPROVAL_SCAN_WINDOW_BYTES = 2 * CODEX_APPROVAL_CONTEXT_BYTES;

/** A pre-routing hook is not proof of a human wait. Missing, unreadable or
 * invalid settings stay unknown; they must not create Attention or
 * intercept automatic review with a device hold. */
export const CODEX_APPROVAL_HUMAN_REVIEWER = 'user';
export function codexApprovalNeedsHuman(reviewer: string | undefined): boolean {
  return reviewer === CODEX_APPROVAL_HUMAN_REVIEWER;
}

/** Canonical JSONL header check, used only to extend a settings record that
 * crosses an I/O window. A quoted tool result is never a record header. */
export const CODEX_APPROVAL_SETTINGS_PAYLOAD_PREFIX = '^\\s*:\\s*\\{\\s*"type"\\s*:\\s*"thread_settings_applied"';
export function codexApprovalSettingsPrefix(line: string): boolean {
  const payloadAt = line.indexOf('"payload"');
  if (payloadAt < 0) return false;
  try {
    const header = JSON.parse(line.slice(0, payloadAt).trimEnd().replace(/,$/, '') + '}') as Record<string, unknown>;
    return header.type === 'turn_context' || (header.type === 'event_msg'
      && new RegExp(CODEX_APPROVAL_SETTINGS_PAYLOAD_PREFIX).test(line.slice(payloadAt + '"payload"'.length)));
  } catch { return false; }
}

export interface CodexApprovalReviewerRecord { reviewer?: string }

/** undefined means no authoritative record; { reviewer: undefined } is a
 * latest settings/turn barrier and must stop a backwards file scan. */
export function codexApprovalReviewerRecord(line: string, turnId?: string): CodexApprovalReviewerRecord | undefined {
  if (!line.includes('"turn_context"') && !line.includes('"thread_settings_applied"')) return undefined;
  let record: Record<string, unknown>;
  try { record = JSON.parse(line) as Record<string, unknown>; } catch { return codexApprovalSettingsPrefix(line) ? {} : undefined; }
  if (!record || typeof record !== 'object') return undefined;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return record.type === 'turn_context' ? {} : undefined;
  let settings: Record<string, unknown> | undefined;
  if (record.type === 'turn_context') {
    if (turnId && payload.turn_id !== turnId) return {};
    settings = payload;
  } else if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    settings = payload.thread_settings as Record<string, unknown> | undefined;
  } else return undefined;
  return { reviewer: typeof settings?.approvals_reviewer === 'string' ? settings.approvals_reviewer : undefined };
}

export function codexApprovalReviewerFromRollout(text: string, turnId?: string): string | undefined {
  return codexApprovalLatestReviewerRecord(text, turnId)?.reviewer;
}

/** Latest authoritative reviewer setting, never a quoted tool/message body.
 * A newer settings record without a reviewer is unknown: do not reuse an old
 * auto-review setting after a resume/turn change. Legacy/unreadable rollouts
 * remain unknown. Only explicit user reviewer evidence permits Attention
 * and the opt-in hold (codexApprovalNeedsHuman). */
export function codexApprovalLatestReviewerRecord(text: string, turnId?: string): CodexApprovalReviewerRecord | undefined {
  for (const line of text.split('\n').reverse()) {
    const record = codexApprovalReviewerRecord(line, turnId);
    if (record) return record;
  }
  return undefined;
}
