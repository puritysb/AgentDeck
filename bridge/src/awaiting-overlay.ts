import type { PromptOption } from '@agentdeck/shared';
import { rawSessionId } from '@agentdeck/shared';

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

export type AwaitingKind = 'permission' | 'option';

/** One question group of an AskUserQuestion call, already sanitized and
 *  re-indexed. A single call carries up to four; the overlay presents them one
 *  at a time (see `AwaitingEntry.groups`). */
export interface AskGroup {
  question: string;
  options: PromptOption[];
  promptType?: 'multi_select';
}

export interface AwaitingEntry {
  kind: AwaitingKind;
  state: 'awaiting_permission' | 'awaiting_option';
  question: string;
  /** Structured AskUserQuestion choices for the ACTIVE group. Pressable only
   *  when the daemon can deliver the answer (terminal injection or a held
   *  ask-gate) — otherwise devices direct the user back to the terminal. */
  options?: PromptOption[];
  promptType?: 'multi_select';
  /** Every valid question group from one AskUserQuestion call. Claude allows up
   *  to four, but SessionInfo carries a single question/options pair, so they
   *  are presented sequentially rather than flattened into one index space
   *  (which would let a press against group 1 select an option in group 2).
   *  `question`/`options`/`promptType` above always mirror `groups[activeGroup]`. */
  groups?: AskGroup[];
  activeGroup?: number;
  /** How many question groups the tool call actually contained, INCLUDING any
   *  `groups` dropped as malformed. The terminal's own picker renders a form
   *  for all of them, so this — not `groups.length` — decides whether that form
   *  ends on a "Submit answers" confirmation someone has to press. */
  rawGroupCount?: number;
  /** Answers collected so far, one per resolved group. The held ask-gate turns
   *  these into the hook's decision reason when the last group is answered. */
  answers?: Array<{ question: string; label: string }>;
  /** Claude's stable tool call id. Option overlays resolve only when the
   *  matching PostToolUse/PostToolUseFailure arrives (or a terminal lifecycle
   *  event ends/supersedes the turn). Never expose this as requestId: that
   *  would make devices fabricate actionable Allow/Deny controls. */
  toolUseId?: string;
  /** Set when the awaiting state is an actionable, device-approvable PreToolUse
   *  gate (vs. a display-only Notification prompt). Devices render Allow/Deny
   *  and reply with permission_decision keyed by this id. */
  requestId?: string;
  updatedAt: number;
}

/** A permission prompt is a genuine wait that can sit unanswered for hours (the
 *  user stepped away) — so the overlay must NOT self-clear on a short clock, or
 *  the observed session's PERMIT state vanishes from the dashboard while it is
 *  still legitimately pending. Clear-on-next-hook is the primary signal (fires
 *  the instant the user answers), and a dead `claude` process is reaped by the
 *  passive observer / liveness — so this TTL is only a last-resort backstop for
 *  a truly orphaned entry and is deliberately generous. */
const OVERLAY_TTL_MS = 6 * 60 * 60_000; // 6 hours

/** A display-only permission Notification (no requestId) is cleared the instant
 *  the user answers via a subsequent hook — but pressing ESC to dismiss the
 *  prompt fires NO hook, so that path had nothing to clear it short of the 6h
 *  TTL (the reported "attention stuck after ESC" bug). The transcript is the
 *  only observable signal: it stays frozen for the entire genuine wait (no
 *  records are written between an assistant tool_use and its resolution), so
 *  any transcript write dated after the overlay was set means the prompt is
 *  over — the tool was answered OR the user ESC'd. This margin guards the
 *  comparison against the sub-second jitter between the tool_use write and the
 *  Notification that follows it. */
const RESOLVED_ACTIVITY_MARGIN_MS = 1_000;

/** Cap question length at the source so every sessions_list broadcast stays small. */
const MAX_QUESTION_LEN = 120;

const overlay = new Map<string, AwaitingEntry>();

export function setAwaitingOverlay(sessionId: string, question: string, requestId?: string): void {
  const trimmed = (question || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_LEN);
  overlay.set(sessionId, {
    kind: 'permission',
    state: 'awaiting_permission',
    question: trimmed,
    requestId,
    updatedAt: Date.now(),
  });
}

/** Notification permission prompts arrive several seconds after
 * AskUserQuestion's structured PreToolUse. Preserve an existing option
 * interaction instead of downgrading it to generic permission copy. */
export function setPermissionNotificationOverlay(sessionId: string, question: string): boolean {
  if (overlay.get(sessionId)?.kind === 'option') return false;
  setAwaitingOverlay(sessionId, question);
  return true;
}

/** Sanitize one raw AskUserQuestion group. Returns undefined when the group has
 *  no usable question text or no labelled options. */
function parseAskGroup(raw: unknown): AskGroup | undefined {
  if (!isRecord(raw) || typeof raw.question !== 'string') return undefined;
  const question = raw.question.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_LEN);
  if (!question) return undefined;

  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const options: PromptOption[] = rawOptions.flatMap((value) => {
    if (!isRecord(value) || typeof value.label !== 'string') return [];
    const label = value.label.replace(/\s+/g, ' ').trim();
    if (!label) return [];
    return [{
      index: 0, // re-indexed below after invalid/empty labels are removed
      label: label.slice(0, MAX_QUESTION_LEN),
    }];
  }).map((option, index) => ({ ...option, index }));
  if (options.length === 0) return undefined;

  return {
    question,
    options,
    ...(raw.multiSelect === true ? { promptType: 'multi_select' as const } : {}),
  };
}

/** Copy a group's fields into the flat wire projection every surface renders. */
function projectGroup(entry: AwaitingEntry, group: AskGroup): void {
  entry.question = group.question;
  entry.options = group.options;
  if (group.promptType) entry.promptType = group.promptType;
  else delete entry.promptType;
}

/**
 * Lift a direct-Claude AskUserQuestion PreToolUse payload into a structured
 * option overlay. Claude supports one to four grouped questions while
 * SessionInfo carries a single question/options pair, so ALL valid groups are
 * kept here and presented one at a time (`advanceAskUserQuestionOverlay`)
 * rather than flattened into one index space — flattening would let a press
 * aimed at group 1 land on an option of group 2.
 * Returns false for malformed payloads so callers can preserve normal tool
 * processing instead of surfacing a dead prompt.
 */
export function setAskUserQuestionOverlay(
  sessionId: string,
  toolUseId: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): boolean {
  if (typeof toolUseId !== 'string' || !toolUseId) return false;
  const rawQuestions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const groups = rawQuestions
    .map((raw) => parseAskGroup(raw))
    .filter((group): group is AskGroup => group !== undefined);
  if (groups.length === 0) return false;

  const entry: AwaitingEntry = {
    kind: 'option',
    state: 'awaiting_option',
    question: '',
    groups,
    activeGroup: 0,
    rawGroupCount: rawQuestions.length,
    answers: [],
    toolUseId,
    updatedAt: Date.now(),
  };
  projectGroup(entry, groups[0]);
  overlay.set(sessionId, entry);
  return true;
}

/**
 * Record the answer to the active question group and present the next one.
 *
 * Returns `'advanced'` when a further group is now showing (the caller must
 * re-broadcast so devices swap to it), `'complete'` when that was the last
 * group (the caller resolves the held ask-gate / waits for PostToolUse), or
 * `'ignored'` when there is no active option overlay.
 *
 * `label` is the option text the user chose; it is kept so a held ask-gate can
 * report every Q→A pair back to the agent.
 */
export function advanceAskUserQuestionOverlay(
  sessionId: string,
  label?: string,
): 'advanced' | 'complete' | 'ignored' {
  const entry = overlay.get(sessionId);
  if (!entry || entry.kind !== 'option' || !entry.groups?.length) return 'ignored';
  const active = entry.activeGroup ?? 0;
  // Already past the last group: report completion again but record nothing.
  // A repeat press (a device that did not see the prompt close, a duplicate
  // frame) would otherwise append another answer every time, growing the list
  // without bound and reporting phantom answers back to the agent.
  if (active >= entry.groups.length) return 'complete';
  entry.answers = [
    ...(entry.answers ?? []),
    { question: entry.groups[active]?.question ?? entry.question, label: label ?? '' },
  ];
  const next = active + 1;
  if (next >= entry.groups.length) {
    entry.activeGroup = next;
    entry.updatedAt = Date.now();
    return 'complete';
  }
  entry.activeGroup = next;
  projectGroup(entry, entry.groups[next]);
  entry.updatedAt = Date.now();
  return 'advanced';
}

/** Q→A pairs recorded so far for a pending AskUserQuestion (held ask-gate). */
export function getAskUserQuestionAnswers(
  sessionId: string,
): Array<{ question: string; label: string }> {
  const entry = overlay.get(sessionId);
  if (!entry || entry.kind !== 'option') return [];
  return (entry.answers ?? []).map((a) => ({ ...a }));
}

/** Returns the overlay entry if it exists and is still fresh (< TTL). Stale
 *  entries are pruned on read. `updatedAt` is exposed so the observed-session
 *  overlay can compare it against the session's transcript recency. */
export function getAwaitingOverlay(
  sessionId: string,
): AwaitingEntry | undefined {
  const entry = overlay.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > OVERLAY_TTL_MS) {
    overlay.delete(sessionId);
    return undefined;
  }
  return {
    ...entry,
    options: entry.options?.map((option) => ({ ...option })),
    groups: entry.groups?.map((group) => ({ ...group })),
    answers: entry.answers?.map((answer) => ({ ...answer })),
  };
}

/** Unconditionally clear an overlay at an authoritative lifecycle boundary.
 *  Ordinary permission prompts may also use this after a subsequent tool hook;
 *  structured AskUserQuestion callers must instead match tool_use_id through
 *  clearAskUserQuestionOverlay. Returns true when an entry was removed. */
export function clearAwaitingOverlay(sessionId: string): boolean {
  return overlay.delete(sessionId);
}

/** Clear only the structured option interaction identified by Claude's
 *  tool_use_id. An unrelated parallel tool hook must not dismiss the prompt. */
export function clearAskUserQuestionOverlay(
  sessionId: string,
  toolUseId: string | undefined,
): boolean {
  const entry = overlay.get(sessionId);
  if (!entry || entry.kind !== 'option') return false;
  if (entry.toolUseId) {
    if (!toolUseId || toolUseId !== entry.toolUseId) return false;
  }
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
 *
 * Not pure: like `getAwaitingOverlay`'s TTL prune-on-read, it drops a
 * display-only entry the moment the session's transcript proves the prompt was
 * resolved off-hook (ESC/cancel writes a record but fires no hook — see
 * `RESOLVED_ACTIVITY_MARGIN_MS`). Held device-approval gates (requestId set)
 * are never dropped this way: their tool stays blocked so the transcript can't
 * advance, and they resolve through their own `onResolved` path.
 */
export function applyAwaitingOverlayToObserved<
  T extends {
    id: string;
    state?: string;
    question?: string;
    requestId?: string;
    options?: PromptOption[];
    promptType?: string;
    askGroupIndex?: number;
    askGroupCount?: number;
    lastActivityAt?: number;
  },
>(sessions: T[]): T[] {
  return sessions.map((s) => {
    const uuid = rawSessionId(s.id);
    const ov = getAwaitingOverlay(uuid);
    if (!ov) return s;
    // Display-only Notification prompt whose transcript has moved on since the
    // overlay was set → answered or ESC-dismissed. Drop it (no hook will).
    if (
      ov.kind === 'permission' &&
      !ov.requestId &&
      typeof s.lastActivityAt === 'number' &&
      s.lastActivityAt > ov.updatedAt + RESOLVED_ACTIVITY_MARGIN_MS
    ) {
      clearAwaitingOverlay(uuid);
      return s;
    }
    // Multi-group prompts advance one question at a time, so surfaces can show
    // "Q 2/3". Single-group prompts omit the fields entirely (absent ⇒ one).
    const multiGroup = (ov.groups?.length ?? 0) > 1;
    return {
      ...s,
      state: ov.state,
      question: ov.question,
      requestId: ov.requestId,
      ...(ov.options ? { options: ov.options } : {}),
      ...(ov.promptType ? { promptType: ov.promptType } : {}),
      ...(multiGroup
        ? {
          // Clamped: once the last group is answered the cursor sits one past
          // the end, and "Q 4/3" is not a thing.
          askGroupIndex: Math.min(ov.activeGroup ?? 0, ov.groups!.length - 1),
          askGroupCount: ov.groups!.length,
        }
        : {}),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * FALLBACK heuristic (see `isPermissionNotification` for the primary path):
 * does a Notification `message` look like an actual permission prompt rather
 * than an idle-timeout reminder? Claude's Notification hook fires for BOTH
 * "Claude needs your permission to use Bash" (a real decision) and "Claude is
 * waiting for your input" (a 60s idle ping). Only the former is an awaiting
 * state — the latter must NOT flip a session to attention, or every idle
 * session falsely shows a permission popup with no answerable choice.
 *
 * So this matches genuine permission phrasing ONLY. Earlier alternatives like
 * `waiting for your` / `wants to` / `confirm` / `to proceed` were too broad and
 * caught the idle ping (and arbitrary status text), which was the root cause of
 * false "Attention" popups. Biased toward precision: a missed permission
 * Notification just means no attention badge (the user still sees the prompt in
 * their terminal), whereas a false positive nags with a dead popup.
 *
 * Used only when Claude omits the structured `notification_type` (older
 * versions); current Claude is classified by `isPermissionNotification`.
 */
export function looksLikePermissionMessage(message: string): boolean {
  if (!message) return false;
  return /needs? your permission|permission to use|requesting permission/i.test(message);
}

/**
 * Is a Notification hook an actual permission prompt (awaiting decision)?
 *
 * Current Claude Code carries an authoritative `notification_type`
 * (`permission_prompt` | `idle_prompt` | `auth_success` | `elicitation_*`).
 * Prefer it — only `permission_prompt` is an awaiting state; everything else
 * (idle pings, auth toasts, elicitation) must never flip a session to
 * attention. Fall back to the brittle free-text `message` regex only when the
 * field is absent (older Claude). Mirrors the Swift
 * `DaemonServer.isPermissionNotification`.
 */
export function isPermissionNotification(
  notificationType: string | undefined,
  message: string,
): boolean {
  if (typeof notificationType === 'string' && notificationType.length > 0) {
    return notificationType === 'permission_prompt';
  }
  return looksLikePermissionMessage(message);
}

/** Edit-family tools that Claude auto-approves in `acceptEdits` mode. */
const EDIT_FAMILY_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Should the daemon HOLD a gated PreToolUse for device approval, given the
 * session's `permission_mode`?
 *
 * Claude's PreToolUse hook fires for EVERY tool call regardless of mode or
 * allowlist — even when Claude will auto-approve and never prompt the user.
 * `permission_mode` is the session's global decision posture, so gate only in
 * modes where Claude could still surface its own prompt; otherwise the device
 * nags for a decision the agent never asked for (the reported false-attention
 * bug). Mirrors the Swift `DaemonServer.shouldGate(permissionMode:tool:)`.
 *
 *  - `bypassPermissions` / `dontAsk` → never prompts            → don't gate
 *  - `auto`                          → policy engine auto-approves; its
 *    decisions live outside the settings allowlist files, so the rule
 *    predictor can't see them and every unlisted call would false-hold.
 *    The rare genuine prompt still surfaces via the Notification
 *    `permission_prompt` overlay                                 → don't gate
 *  - `plan`                          → tools don't execute       → don't gate
 *  - `acceptEdits`                   → edits auto-approved, Bash still prompts
 *  - `default` / unknown             → Claude may prompt         → gate
 *
 * Unknown/absent mode is treated as `default` (gate) to preserve behavior on
 * older Claude versions that don't send the field.
 */
export function shouldGatePreToolUse(permissionMode: string | undefined, tool: string): boolean {
  switch ((permissionMode || 'default').trim()) {
    case 'bypassPermissions':
    case 'dontAsk':
    case 'auto':
    case 'plan':
      return false;
    case 'acceptEdits':
      return !EDIT_FAMILY_TOOLS.has(tool);
    default:
      return true;
  }
}
