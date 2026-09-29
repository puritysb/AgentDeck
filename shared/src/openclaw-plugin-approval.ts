/**
 * openclaw-plugin-approval.ts — SSOT for OpenClaw plugin-approval prompts
 * (`plugin.approval.*`).
 *
 * WHY THIS FILE EXISTS. AgentDeck answers `exec.approval.*` (the Gateway
 * blocking a tool-execution call) but has never rendered `plugin.approval.*` —
 * the parallel surface a plugin (or a trusted in-process agent runtime) uses to
 * ask a human something that is not a shell command: "send this message",
 * "post externally", "grant standing access". `openclaw approvals pending`
 * lists exec, plugin AND system-agent approvals in one queue; AgentDeck only
 * ever drained the first. A pending plugin approval therefore sat on the
 * Gateway with no PERM on any surface — the exact thing PERM exists to show.
 *
 * Every shape below is read from the installed `openclaw` package's OWN
 * TypeScript declarations, not inferred — the exec module's header explains
 * why that discipline exists (a guessed shape shipped broken for months).
 * Sources, all under `openclaw/dist/`:
 *
 *  - `approval-types-CQ_BKP9V.d.ts` (`src/infra/plugin-approvals.d.ts` region):
 *    `PluginApprovalRequestPayload`, `PluginApprovalRequest`,
 *    `PluginApprovalResolved`, `DEFAULT_PLUGIN_APPROVAL_DECISIONS`. This is the
 *    exact shape `manager.create(request, timeoutMs, \`plugin:${uuid}\`)` builds
 *    in the real RPC handler (`plugin-approval-_zEt9gGf.mjs`).
 *  - `approvals-CiGTrkJW.d.ts` (`packages/gateway-protocol/src/schema/
 *    approvals.d.ts`): the wire-protocol `ApprovalPresentationSchema`'s
 *    `kind: "plugin"` variant — same field set, confirms `title` / `description`
 *    / `detail` / `severity` / `scope` / `allowedDecisions` /
 *    `externalResolution` as the reviewer-safe presentation.
 *  - `plugin-approval-_zEt9gGf.mjs`: the actual `plugin.approval.list` /
 *    `.request` / `.resolve` RPC handlers — confirms `plugin.approval.list`
 *    answers a bare array of `{id, request, createdAtMs, expiresAtMs,
 *    approvalKind}` (`listVisiblePendingApprovalRequests`), and that `resolve`
 *    validates `decision` against `resolveCanonicalPluginApprovalRequestAllowed
 *    Decisions(snapshot.request)` — the same fail-closed-deny rule exec uses.
 *  - `approval-shared-1gFEjucV.mjs` (`buildRequestedApprovalEvent`): confirms
 *    the broadcast payload is `{approvalKind: 'plugin', id, request,
 *    createdAtMs, expiresAtMs}` — nested under `request`, exactly like exec.
 *  - `plugin-approvals-4DQM9m9q.mjs` (`buildPluginApprovalRequestMessage`):
 *    confirms field ORDER for the human-facing message — title, description,
 *    scope, tool, plugin, agent — and that an absent `severity` defaults to
 *    `"warning"` (not `"info"`).
 *  - `agent-tools.before-tool-call-CHXgDzUI.mjs` (the embedded/TUI-local
 *    broker, a DIFFERENT runtime from the persisted Gateway approval manager):
 *    the only place `plugin.approval.removed` is actually emitted on the wire,
 *    payload `{id}`. The persisted-manager RPC path we connect to (same one
 *    exec approvals use) drops an expired/cancelled record with NO event at
 *    all, exactly like exec — so `removed` is handled defensively (a real,
 *    typed frame OpenClaw's own runtime emits in at least one execution mode)
 *    without being relied on as the only close signal; reconcile-via-list and
 *    the record's own expiry remain the primary path, mirroring exec.
 *
 * One deliberate difference from exec, confirmed by the same sources: a plugin
 * request has no `unavailableDecisions` field — only `allowedDecisions`
 * (`resolvePluginApprovalRequestAllowedDecisions`, no subtraction step).
 * Do not port exec's `unavailableDecisions` handling here; it would silently
 * accept a field the Gateway never sends and never filter on it.
 *
 * The decision vocabulary and error classification are IDENTICAL to exec's
 * (the Gateway's `isApprovalDecision` and `isApprovalStaleError` are shared
 * across `approval-shared-1gFEjucV.mjs`, used by both `exec.approval.resolve`
 * and `plugin.approval.resolve`), so this module re-exports rather than
 * re-derives `isApprovalGoneError` — a second regex pair here would be a
 * second place for it to drift from the Gateway's own classifier.
 */
import {
  isExecApprovalDecision,
  type ExecApprovalDecision,
} from './openclaw-approval.js';
export { isApprovalGoneError } from './openclaw-approval.js';

/**
 * The decisions the Gateway will accept for a plugin approval. Same union as
 * exec (`ApprovalDecisionSchema` in `approvals-CiGTrkJW.d.ts` is shared by
 * every approval kind) — re-typed under this module's own name so callers
 * that only touch plugin approvals do not have to import the exec module for
 * a type alias.
 */
export type PluginApprovalDecision = ExecApprovalDecision;

/** Full decision set, in the order `DEFAULT_PLUGIN_APPROVAL_DECISIONS` lists them. */
export const PLUGIN_APPROVAL_DECISIONS: readonly PluginApprovalDecision[] = [
  'allow-once',
  'allow-always',
  'deny',
];

export function isPluginApprovalDecision(value: unknown): value is PluginApprovalDecision {
  return isExecApprovalDecision(value);
}

/** `true` for the decisions that let the plugin action proceed. */
export function pluginApprovalAllows(decision: string | null | undefined): boolean {
  return decision === 'allow-once' || decision === 'allow-always';
}

const DECISION_DISPLAY: Record<PluginApprovalDecision, { label: string; shortcut: string }> = {
  'allow-once': { label: 'Allow once', shortcut: 'y' },
  'allow-always': { label: 'Always allow', shortcut: 'a' },
  deny: { label: 'Deny', shortcut: 'n' },
};

export function pluginApprovalDecisionLabel(decision: PluginApprovalDecision): string {
  return DECISION_DISPLAY[decision].label;
}

/**
 * `severity?: "info" | "warning" | "critical" | null` (`PluginApprovalRequestPayload`).
 * Absent → `"warning"`, matching OpenClaw's own `buildPluginApprovalRequestMessage`
 * fallback (`request.request.severity ?? "warning"`) — NOT `"info"`, which would
 * understate a request the Gateway itself treats as needing the 🛡️ icon.
 */
export type PluginApprovalSeverity = 'info' | 'warning' | 'critical';
export const PLUGIN_APPROVAL_DEFAULT_SEVERITY: PluginApprovalSeverity = 'warning';

function isPluginApprovalSeverity(value: unknown): value is PluginApprovalSeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

/**
 * Loosely-typed mirror of `ApprovalScopeSchema` (`approvals-CiGTrkJW.d.ts`) —
 * a discriminated union of owner-declared blast-radius facts. Display-only,
 * never authorization; AgentDeck only needs enough of it to summarize one
 * supporting line, so this is intentionally not the full 4-variant union.
 */
export interface PluginApprovalScopeLike {
  kind?: string;
  target?: string;
  command?: string;
  automation?: string;
  amount?: string;
  currency?: string;
  [key: string]: unknown;
}

/** The `request` body OpenClaw nests inside the requested/resolved event —
 *  `PluginApprovalRequestPayload` in `approval-types-CQ_BKP9V.d.ts`. */
export interface PluginApprovalRequestBody {
  pluginId?: string | null;
  title: string;
  description: string;
  detail?: string | null;
  severity?: PluginApprovalSeverity | null;
  scope?: PluginApprovalScopeLike | null;
  toolName?: string | null;
  toolCallId?: string | null;
  mcpTool?: { server: string; tool: string };
  /** Explicit decisions this request permits. No `unavailableDecisions`
   *  counterpart exists on the plugin surface — unlike exec, there is no
   *  subtraction step. */
  allowedDecisions?: readonly string[] | null;
  externalResolution?: { label: string; decisions?: readonly string[] } | null;
  agentId?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
}

/**
 * `plugin.approval.requested` payload (`PluginApprovalRequest` in
 * `approval-types-CQ_BKP9V.d.ts`, confirmed on the wire by
 * `buildRequestedApprovalEvent(record, 'plugin')` in `approval-shared-
 * 1gFEjucV.mjs`): `{approvalKind?: 'plugin', id, request, createdAtMs,
 * expiresAtMs}`. Unlike exec's compatibility fallback, the Gateway's OWN
 * `PluginApprovalRequest` type declares `request` as required, never optional
 * or flattened — but the flat-field merge below is kept anyway, at zero cost,
 * so a future Gateway that inlines a field degrades instead of blanking the
 * prompt (the same defensive posture the exec module documents its own
 * reasoning for).
 */
export interface PluginApprovalRequestedPayload extends Partial<PluginApprovalRequestBody> {
  approvalKind?: 'plugin';
  id: string;
  request?: PluginApprovalRequestBody;
  createdAtMs?: number;
  expiresAtMs?: number;
}

/** `plugin.approval.resolved` payload (`PluginApprovalResolved`). */
export interface PluginApprovalResolvedPayload {
  id: string;
  decision: PluginApprovalDecision | string;
  resolvedBy?: string | null;
  ts?: number;
  request?: PluginApprovalRequestBody;
}

/**
 * `plugin.approval.removed` payload. NOT declared in any `.d.ts` shipped with
 * the installed package — it is real wire protocol (confirmed at the string
 * literal `event: "plugin.approval.removed"` in `agent-tools.before-tool-
 * call-CHXgDzUI.mjs`, the embedded/TUI-local approval broker) but has no
 * typed declaration because that broker is a runtime helper, not part of the
 * generated `packages/gateway-protocol` schema surface the persisted-manager
 * RPC path (the one AgentDeck's Gateway connection actually uses) ships types
 * for. The payload shape read directly from that emitter is `{id}` — no
 * decision, no reason. Documented here as best-effort/lightly-typed rather
 * than SDK-confirmed for the persisted-manager path specifically.
 */
export interface PluginApprovalRemovedPayload {
  id: string;
}

/** One renderable choice on a deck surface. */
export interface PluginApprovalOption {
  index: number;
  label: string;
  shortcut: string;
  decision: PluginApprovalDecision;
}

/**
 * Normalized prompt — the plugin-approval counterpart of
 * `OpenClawApprovalPrompt`. `question` is the request's `title` (the
 * headline: what is being asked), `detail` is the description plus whatever
 * scope/tool/plugin/agent context the request carried, most-decisive-first —
 * mirroring `buildPluginApprovalRequestMessage`'s own line order (title,
 * description, scope, tool, plugin, agent).
 */
export interface OpenClawPluginApprovalPrompt {
  id: string;
  question: string;
  detail?: string;
  title: string;
  description: string;
  severity: PluginApprovalSeverity;
  pluginId?: string;
  toolName?: string;
  options: PluginApprovalOption[];
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

/** Short summary of a scope variant's most distinguishing field — display
 *  only, never authorization. Kept intentionally light: the full 4-variant
 *  union (`ApprovalScopeSchema`) exists to describe blast radius to a human
 *  reviewer, and one line is what a deck surface has room for. */
function summarizeScope(scope: PluginApprovalScopeLike): string | undefined {
  const kind = firstNonEmpty(scope.kind);
  if (!kind) return undefined;
  if (kind === 'standing-grant') {
    const command = firstNonEmpty(scope.command);
    return command ? `scope: ${kind} (${command})` : `scope: ${kind}`;
  }
  if (kind === 'payment') {
    const amount = firstNonEmpty(scope.amount);
    const currency = firstNonEmpty(scope.currency);
    return amount ? `scope: payment ${amount}${currency ? ` ${currency}` : ''}` : 'scope: payment';
  }
  const target = firstNonEmpty(scope.target);
  return target ? `scope: ${kind} (${target})` : `scope: ${kind}`;
}

/**
 * Which decisions this request permits. Plugin requests have no
 * `unavailableDecisions` subtraction step — only `allowedDecisions`
 * (`resolvePluginApprovalRequestAllowedDecisions`: explicit list, filtered to
 * the known vocabulary, or the full default set when empty/absent) — plus the
 * canonical fail-closed-deny guarantee
 * (`resolveCanonicalPluginApprovalRequestAllowedDecisions`: deny is always
 * appended when the explicit set omitted it).
 */
function resolveDecisions(body: PluginApprovalRequestBody): PluginApprovalDecision[] {
  const explicit: PluginApprovalDecision[] = [];
  if (Array.isArray(body.allowedDecisions)) {
    for (const d of body.allowedDecisions) {
      if (isPluginApprovalDecision(d) && !explicit.includes(d)) explicit.push(d);
    }
  }
  const base = explicit.length > 0 ? explicit : [...PLUGIN_APPROVAL_DECISIONS];
  return base.includes('deny') ? base : [...base, 'deny'];
}

/**
 * Normalize a raw `plugin.approval.requested` payload. Returns `null` only
 * when the payload carries no usable id — mirroring exec, a request with no
 * title/description still produces a prompt (labeled as unknown) so the user
 * keeps the ability to deny.
 */
export function parsePluginApprovalRequest(
  payload: PluginApprovalRequestedPayload | Record<string, unknown> | null | undefined,
  nowMs: number,
): OpenClawPluginApprovalPrompt | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as PluginApprovalRequestedPayload;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;

  const body: PluginApprovalRequestBody = { ...raw, ...(raw.request ?? {}) } as PluginApprovalRequestBody;

  const title = firstNonEmpty(body.title) ?? '';
  const description = firstNonEmpty(body.description) ?? '';
  const severity = isPluginApprovalSeverity(body.severity)
    ? body.severity
    : PLUGIN_APPROVAL_DEFAULT_SEVERITY;
  const pluginId = firstNonEmpty(body.pluginId ?? undefined);
  const toolName = firstNonEmpty(body.toolName ?? undefined);
  const agentId = firstNonEmpty(body.agentId ?? undefined);

  // Most-decisive-first, mirroring `buildPluginApprovalRequestMessage`'s own
  // order: description explains WHAT/WHY, then scope, tool, plugin, agent —
  // each supporting, none of them the headline.
  const detailParts: string[] = [];
  if (description) detailParts.push(description);
  const scopeLine = body.scope ? summarizeScope(body.scope) : undefined;
  if (scopeLine) detailParts.push(scopeLine);
  if (toolName) detailParts.push(`tool: ${toolName}`);
  if (pluginId) detailParts.push(`plugin: ${pluginId}`);
  if (agentId) detailParts.push(`agent: ${agentId}`);

  const options: PluginApprovalOption[] = resolveDecisions(body).map((decision, index) => ({
    index,
    label: DECISION_DISPLAY[decision].label,
    shortcut: DECISION_DISPLAY[decision].shortcut,
    decision,
  }));

  return {
    id,
    question: title || 'Approve plugin action (title not reported)',
    ...(detailParts.length > 0 ? { detail: detailParts.join('\n') } : {}),
    title,
    description,
    severity,
    ...(pluginId ? { pluginId } : {}),
    ...(toolName ? { toolName } : {}),
    options,
    ...(typeof raw.expiresAtMs === 'number' ? { expiresAtMs: raw.expiresAtMs } : {}),
    requestedAtMs: typeof raw.createdAtMs === 'number' ? raw.createdAtMs : nowMs,
    ...(firstNonEmpty(body.sessionKey ?? undefined)
      ? { sessionKey: firstNonEmpty(body.sessionKey ?? undefined) }
      : {}),
  };
}

/** Map a `select_option` index onto the decision that option represents. */
export function pluginDecisionForOptionIndex(
  prompt: OpenClawPluginApprovalPrompt,
  index: number,
): PluginApprovalDecision | null {
  const byIndex = prompt.options.find((o) => o.index === index);
  return byIndex ? byIndex.decision : null;
}

/**
 * Map a `respond` value onto a decision. Same accepted spellings as exec
 * (option shortcut, decision name, y/n/a aliases) — deliberately duplicated
 * rather than shared, because the two modules' `options` shape is structurally
 * identical but nominally distinct, and a generic helper over both would be
 * the one place a future divergence (e.g. plugin approvals someday growing a
 * fourth decision) could silently apply to the wrong vocabulary.
 */
export function pluginDecisionForRespondValue(
  prompt: OpenClawPluginApprovalPrompt,
  value: string,
): PluginApprovalDecision | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const byDecision = prompt.options.find((o) => o.decision === v);
  if (byDecision) return byDecision.decision;
  const byShortcut = prompt.options.find((o) => o.shortcut === v);
  if (byShortcut) return byShortcut.decision;
  const byLabel = prompt.options.find((o) => o.label.toLowerCase() === v);
  if (byLabel) return byLabel.decision;
  const alias: Record<string, PluginApprovalDecision> = {
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
  return prompt.options.some((o) => o.decision === mapped) ? mapped : null;
}

/**
 * Parse a `plugin.approval.removed` payload down to the id it names, or
 * `null` when unreadable. Unreadable is not "not removed" for the CALLER's
 * purposes (the adapter treats a parse failure as "ignore, no information"),
 * but this function itself makes no claim beyond what it could read.
 */
export function parsePluginApprovalRemoved(
  payload: PluginApprovalRemovedPayload | Record<string, unknown> | null | undefined,
): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const id = (payload as PluginApprovalRemovedPayload).id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}
