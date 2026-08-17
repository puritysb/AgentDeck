/**
 * openclaw-approval.ts — SSOT for OpenClaw exec-approval prompts.
 *
 * WHY THIS FILE EXISTS. The approval surface was originally typed from an
 * assumption rather than from OpenClaw's own SDK, and every part of that guess
 * was wrong in a way that failed silently:
 *
 *  - The `exec.approval.requested` event was read as a FLAT payload
 *    (`payload.command` / `payload.ask`). The Gateway actually nests the whole
 *    thing under `request` (`buildRequestedApprovalEvent` →
 *    `{ id, request, createdAtMs, expiresAtMs }`), so every field read as
 *    `undefined` and the prompt collapsed to the literal fallback string
 *    "Approve tool execution?" — the user could see that something wanted
 *    approval but never WHAT.
 *  - `ask` is the approval POLICY ("on-miss" / "always"), not a question. It
 *    was being rendered as if it were the human-readable ask.
 *  - The decision vocabulary was typed as `'allow' | 'deny'`. The Gateway
 *    accepts only `'allow-once' | 'allow-always' | 'deny'` (its
 *    `isApprovalDecision`), and validates the decision BEFORE it looks the
 *    approval id up — so every "allow" AgentDeck ever sent came back
 *    INVALID_REQUEST and the approval stayed pending. The wrong vocabulary was
 *    baked into the shared TypeScript type, so the compiler actively enforced
 *    the unusable value.
 *
 * The lesson that keeps this file honest: the requested format lives in THEIR
 * SDK. Everything below is derived from the OpenClaw gateway bundle
 * (`approval-shared`, `exec-approval`, `exec-approvals`), not from inference.
 *
 * Parsing is pure and lives here so the Node adapter, the Swift daemon mirror,
 * and the tests all agree on one normalization.
 */

/**
 * The decisions the Gateway will accept for an exec approval.
 * Mirror of OpenClaw's `isApprovalDecision` / `DEFAULT_EXEC_APPROVAL_DECISIONS`.
 * `'allow'` is NOT a member — sending it is rejected as an invalid decision.
 */
export type ExecApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

/** Full decision set, in the order the Gateway lists them. */
export const EXEC_APPROVAL_DECISIONS: readonly ExecApprovalDecision[] = [
  'allow-once',
  'allow-always',
  'deny',
];

export function isExecApprovalDecision(value: unknown): value is ExecApprovalDecision {
  return value === 'allow-once' || value === 'allow-always' || value === 'deny';
}

/** `true` for the decisions that let the command run. */
export function execApprovalAllows(decision: string | null | undefined): boolean {
  return decision === 'allow-once' || decision === 'allow-always';
}

/**
 * Device-facing labels. Kept short because they land on 72×72 Stream Deck keys
 * and D200H cells; `shortcut` is what a non-navigable `respond` press carries.
 */
const DECISION_DISPLAY: Record<ExecApprovalDecision, { label: string; shortcut: string }> = {
  'allow-once': { label: 'Allow once', shortcut: 'y' },
  'allow-always': { label: 'Always allow', shortcut: 'a' },
  deny: { label: 'Deny', shortcut: 'n' },
};

export function execApprovalDecisionLabel(decision: ExecApprovalDecision): string {
  return DECISION_DISPLAY[decision].label;
}

/** The `request` body OpenClaw nests inside the requested event. */
export interface ExecApprovalRequestBody {
  /** Sanitized command display text — the thing the user is approving. */
  command?: string;
  /** Non-node hosts send a preview instead of the full command. */
  commandPreview?: string;
  commandArgv?: string[];
  cwd?: string | null;
  host?: string | null;
  /** Approval POLICY ("on-miss" | "always" | …), never a question. */
  ask?: string | null;
  security?: string | null;
  /** Human-readable risk note, when the Gateway produced one. */
  warningText?: string | null;
  /** Gateway-side static analysis summary of the command. */
  commandAnalysis?: string | null;
  /** Decisions this specific request permits (policy may drop allow-always). */
  allowedDecisions?: string[];
  unavailableDecisions?: string[];
  agentId?: string | null;
  sessionKey?: string | null;
  resolvedPath?: string | null;
}

/**
 * `exec.approval.requested` payload. The nested `request` is the real shape;
 * the flat fields are tolerated so a future/legacy Gateway that inlines them
 * still parses instead of silently producing an empty prompt.
 */
export interface ExecApprovalRequestedPayload extends Partial<ExecApprovalRequestBody> {
  id: string;
  request?: ExecApprovalRequestBody;
  createdAtMs?: number;
  expiresAtMs?: number;
}

/** `exec.approval.resolved` payload (`buildResolvedEvent` in exec-approval). */
export interface ExecApprovalResolvedPayload {
  id: string;
  decision: ExecApprovalDecision | string;
  resolvedBy?: string | null;
  ts?: number;
  request?: ExecApprovalRequestBody;
}

/** One renderable choice on a deck surface. */
export interface ExecApprovalOption {
  index: number;
  label: string;
  shortcut: string;
  decision: ExecApprovalDecision;
}

/**
 * Normalized prompt — what every surface renders and what an answer maps back
 * through. Deliberately carries the decision on each option so an index press
 * can never be re-derived (and mis-derived) at the answer site.
 */
export interface OpenClawApprovalPrompt {
  id: string;
  /** Headline: the command itself, so the user knows what they are approving. */
  question: string;
  /** Supporting lines (cwd, warning, analysis) for surfaces with room. */
  detail?: string;
  /** Raw command text, unprefixed — for the timeline row. */
  command: string;
  cwd?: string;
  options: ExecApprovalOption[];
  /** Wall-clock expiry, when the Gateway set one. */
  expiresAtMs?: number;
  requestedAtMs: number;
  sessionKey?: string;
}

function firstNonEmpty(...values: Array<unknown>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * Which decisions this request permits. The Gateway computes `allowedDecisions`
 * per-request (an `ask: "always"` policy drops `allow-always`), so honor what it
 * sent and fall back to the full set only when it sent nothing — never invent a
 * decision the request forbids, which comes back as
 * "allow-always is unavailable because the effective policy requires approval
 * every time".
 */
function resolveDecisions(body: ExecApprovalRequestBody): ExecApprovalDecision[] {
  const allowed = Array.isArray(body.allowedDecisions)
    ? body.allowedDecisions.filter(isExecApprovalDecision)
    : [];
  const base = allowed.length > 0 ? allowed : [...EXEC_APPROVAL_DECISIONS];
  const unavailable = new Set(
    Array.isArray(body.unavailableDecisions) ? body.unavailableDecisions : [],
  );
  const kept = base.filter((d) => !unavailable.has(d));
  // Deny must always be offered: a prompt the user can only accept is not a
  // prompt. If the policy filtering emptied the set, fall back to deny alone.
  return kept.length > 0 ? kept : ['deny'];
}

/**
 * Normalize a raw `exec.approval.requested` payload. Returns `null` only when
 * the payload carries no usable id — a request with no command text still
 * produces a prompt (labeled as unknown) so the user keeps the ability to deny.
 */
export function parseExecApprovalRequest(
  payload: ExecApprovalRequestedPayload | Record<string, unknown> | null | undefined,
  nowMs: number,
): OpenClawApprovalPrompt | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as ExecApprovalRequestedPayload;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;

  // Nested `request` is authoritative; the flat spread is the compatibility
  // path only. Merging (rather than picking one) means a Gateway that moves a
  // field between the two levels degrades instead of blanking the prompt.
  const body: ExecApprovalRequestBody = { ...raw, ...(raw.request ?? {}) };

  const command = firstNonEmpty(
    body.command,
    body.commandPreview,
    Array.isArray(body.commandArgv) ? body.commandArgv.join(' ') : undefined,
  ) ?? '';

  const cwd = firstNonEmpty(body.cwd ?? undefined);
  const detailParts: string[] = [];
  if (cwd) detailParts.push(`cwd: ${cwd}`);
  const warning = firstNonEmpty(body.warningText ?? undefined);
  if (warning) detailParts.push(warning);
  const analysis = firstNonEmpty(body.commandAnalysis ?? undefined);
  if (analysis && analysis !== warning) detailParts.push(analysis);

  const options: ExecApprovalOption[] = resolveDecisions(body).map((decision, index) => ({
    index,
    label: DECISION_DISPLAY[decision].label,
    shortcut: DECISION_DISPLAY[decision].shortcut,
    decision,
  }));

  return {
    id,
    // No command text is a degraded prompt, not a broken one — say so plainly
    // rather than falling back to a string that reads like a normal ask.
    question: command || 'Approve tool execution (command not reported)',
    ...(detailParts.length > 0 ? { detail: detailParts.join('\n') } : {}),
    command,
    ...(cwd ? { cwd } : {}),
    options,
    ...(typeof raw.expiresAtMs === 'number' ? { expiresAtMs: raw.expiresAtMs } : {}),
    requestedAtMs: typeof raw.createdAtMs === 'number' ? raw.createdAtMs : nowMs,
    ...(firstNonEmpty(body.sessionKey ?? undefined)
      ? { sessionKey: firstNonEmpty(body.sessionKey ?? undefined) }
      : {}),
  };
}

/** Map a `select_option` index onto the decision that option represents. */
export function decisionForOptionIndex(
  prompt: OpenClawApprovalPrompt,
  index: number,
): ExecApprovalDecision | null {
  const byIndex = prompt.options.find((o) => o.index === index);
  return byIndex ? byIndex.decision : null;
}

/**
 * Map a `respond` value onto a decision. Accepts the option shortcut, the
 * decision name itself, and the y/n/a spellings a hardware key or the wake-word
 * assistant sends. Anything unrecognized returns `null` — an ambiguous press
 * must never be guessed into an approval.
 */
export function decisionForRespondValue(
  prompt: OpenClawApprovalPrompt,
  value: string,
): ExecApprovalDecision | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const byDecision = prompt.options.find((o) => o.decision === v);
  if (byDecision) return byDecision.decision;
  const byShortcut = prompt.options.find((o) => o.shortcut === v);
  if (byShortcut) return byShortcut.decision;
  const byLabel = prompt.options.find((o) => o.label.toLowerCase() === v);
  if (byLabel) return byLabel.decision;
  const alias: Record<string, ExecApprovalDecision> = {
    y: 'allow-once',
    yes: 'allow-once',
    allow: 'allow-once',
    once: 'allow-once',
    a: 'allow-always',
    always: 'allow-always',
    n: 'deny',
    no: 'deny',
    reject: 'deny',
  };
  const mapped = alias[v];
  if (!mapped) return null;
  // Honor the request's own policy: if it forbids allow-always, a spoken
  // "always" must not silently become a one-shot allow either — refuse.
  return prompt.options.some((o) => o.decision === mapped) ? mapped : null;
}
