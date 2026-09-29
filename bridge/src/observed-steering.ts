/**
 * Steering state for observed (direct `claude`, no PTY) sessions.
 *
 * The daemon cannot type into an observed session's terminal, but Claude Code
 * hooks form a synchronous RPC channel that supports three steering
 * primitives, all resolved here:
 *
 *   1. Device approval — a held PreToolUse response (permission-resolver.ts)
 *      answers a genuine permission prompt with allow/deny. Gate eligibility
 *      is decided by `shouldHoldPreToolUse` below (precision-first: every
 *      uncertainty resolves to "don't hold" — see claude-permission-rules.ts).
 *   2. Soft STOP — a stop flag consumed by the next PreToolUse, which returns
 *      `deny` with an instruction to halt. Not an instant Ctrl+C (pure text
 *      generation runs to the next tool call), but a real stop at the next
 *      tool boundary.
 *   3. Turn-end directives — prompts queued while the session is processing,
 *      delivered by the Stop hook as `{decision:'block', reason}` so Claude
 *      continues with the queued instruction instead of ending the turn.
 *      Bounded by design: each Stop drains at most one directive, the queue
 *      is hard-capped, and an empty queue always lets the turn end (no
 *      stop_hook_active loop).
 *
 * Keyed by the Claude session UUID (same key as awaiting-overlay.ts). Lives
 * outside the state machine for the same reason: per-session attribution.
 */

import { randomUUID } from 'crypto';
import {
  GATE_LEARN_WINDOW_MS,
  gateSignature,
  predictPreToolUseHold,
} from '@agentdeck/shared';
import { loadMergedPermissionRules } from './claude-permission-rules.js';
import { debug } from './logger.js';

export { gateSignature };

const STOP_FLAG_TTL_MS = 10 * 60_000;      // stale STOP must not deny a tool an hour later
const DIRECTIVE_TTL_MS = 60 * 60_000;
const DIRECTIVE_QUEUE_CAP = 3;
/** After a hold releases undecided, how long we correlate PostToolUse-without-
 *  Notification to learn "this signature was auto-approved" (session
 *  "always allow" answers live only in Claude's memory — this is the only way
 *  to see them). SSOT in @agentdeck/shared: a `permission_prompt`
 *  Notification clears the pending release, so this bounds only how slow the
 *  TOOL may be — and 8 s was shorter than a routine `curl`. */
const ASK_RELEASE_LEARN_WINDOW_MS = GATE_LEARN_WINDOW_MS;

interface DirectiveEntry { text: string; ts: number; }
interface AskRelease { tool: string; signature: string; ts: number; toolUseId?: string; }

interface SteeringSession {
  stopRequestedAt?: number;
  directives: DirectiveEntry[];
  /** Signatures learned to be auto-approved — never hold these again. */
  suppressed: Set<string>;
  /** At most one held gate per session (parallel tool calls pass through). */
  heldRequestId?: string;
  recentAskReleases: AskRelease[];
}

const sessions = new Map<string, SteeringSession>();

function ses(sid: string): SteeringSession {
  let s = sessions.get(sid);
  if (!s) {
    s = { directives: [], suppressed: new Set(), recentAskReleases: [] };
    sessions.set(sid, s);
  }
  return s;
}

/** Human-readable question for the gate's awaiting overlay — device-native
 *  semantics ("Allow Bash: git push …?"), never a fabricated mirror of the
 *  TUI prompt's option labels. Overlay caps length at 120 chars. */
export function buildGateQuestion(tool: string, toolInput?: Record<string, unknown>): string {
  const preview = tool === 'Bash' && typeof toolInput?.command === 'string' ? toolInput.command
    : typeof toolInput?.file_path === 'string' ? toolInput.file_path
      : typeof toolInput?.url === 'string' ? toolInput.url : '';
  return preview ? `Allow ${tool}: ${preview}` : `Allow ${tool}?`;
}

// ─── Soft STOP ───

export function requestStop(sid: string): void {
  ses(sid).stopRequestedAt = Date.now();
  debug('steering', `stop requested for ${sid}`);
}

export function clearStop(sid: string): boolean {
  const s = sessions.get(sid);
  if (!s || s.stopRequestedAt === undefined) return false;
  s.stopRequestedAt = undefined;
  return true;
}

export function isStopRequested(sid: string): boolean {
  const s = sessions.get(sid);
  if (!s || s.stopRequestedAt === undefined) return false;
  if (Date.now() - s.stopRequestedAt > STOP_FLAG_TTL_MS) {
    s.stopRequestedAt = undefined;
    return false;
  }
  return true;
}

/** One-shot consume by the PreToolUse deny path. */
export function consumeStop(sid: string): boolean {
  if (!isStopRequested(sid)) return false;
  ses(sid).stopRequestedAt = undefined;
  debug('steering', `stop consumed by PreToolUse deny for ${sid}`);
  return true;
}

export const STOP_DENY_REASON =
  'AgentDeck: the user pressed STOP on their AgentDeck controller. '
  + 'Halt the current work now, briefly summarize where you left off, and wait '
  + 'for the user\'s next instruction. Do not start new tool calls.';

/**
 * Deliver a device-answered AskUserQuestion back to Claude.
 *
 * The hook contract has no field for supplying a chosen option — a PreToolUse
 * hook may only allow, deny or defer. But a denial's reason text IS handed to
 * the model as the tool call's feedback, which is the same reason-as-message
 * channel `STOP_DENY_REASON` and the Stop-hook directive queue already ride.
 * So the daemon denies the question and states the answer the user gave on
 * their device. The wording has to be unambiguous that these ARE the user's
 * answers and that re-asking is wrong: read as a bare refusal, a model treats
 * the denial as an obstacle and calls AskUserQuestion again.
 */
export function buildAskAnswerReason(
  answers: Array<{ question: string; label: string }>,
): string {
  const pairs = answers
    .filter((a) => a.label)
    .map((a) => `Q: ${a.question}\nA: ${a.label}`)
    .join('\n');
  return 'AgentDeck: the user already answered this question on their connected '
    + 'AgentDeck device, so the question picker was not shown in their terminal.\n'
    + `${pairs}\n`
    + 'These are the user\'s own answers. Treat them exactly as if the tool had '
    + 'returned them and continue — do not call AskUserQuestion again for these '
    + 'questions, and do not ask the user to repeat themselves.';
}

// ─── Turn-end directive queue ───

export function queueDirective(sid: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const s = ses(sid);
  const now = Date.now();
  s.directives = s.directives.filter((d) => now - d.ts < DIRECTIVE_TTL_MS);
  if (s.directives.length >= DIRECTIVE_QUEUE_CAP) return false;
  s.directives.push({ text: trimmed, ts: now });
  debug('steering', `directive queued for ${sid}: "${trimmed.slice(0, 60)}" (${s.directives.length} queued)`);
  return true;
}

/** Pop exactly one directive (Stop hook drains one per turn end). A pending
 *  STOP outranks directives: stopping wins, the queue is discarded. */
export function takeDirective(sid: string): string | undefined {
  const s = sessions.get(sid);
  if (!s) return undefined;
  if (isStopRequested(sid)) {
    s.directives = [];
    return undefined;
  }
  const now = Date.now();
  s.directives = s.directives.filter((d) => now - d.ts < DIRECTIVE_TTL_MS);
  return s.directives.shift()?.text;
}

/** Take a directive for a Stop hook, given that hook's payload.
 *
 *  Delivery works by BLOCKING a hook Claude is waiting on and handing back the
 *  directive as the continuation reason, so it is only deliverable when
 *  something is actually listening. A synthetic Stop — the missed-Stop
 *  watchdog posting to the daemon's own `/hooks/Stop` to close a turn whose
 *  real hook dropped — has no listener: the daemon discards that response. So
 *  taking here would pop the user's queued follow-up and drop it on the floor,
 *  with no error and no trace. Leaving it queued costs one turn of latency and
 *  the next real Stop delivers it.
 *
 *  This lives next to the queue rather than at the call site because the rule
 *  belongs to the queue: any future caller draining it owes the same check. */
export function takeDirectiveForStop(
  sid: string,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (payload?.synthetic_stop === true) return undefined;
  return takeDirective(sid);
}

export function queuedDirectiveCount(sid: string): number {
  const s = sessions.get(sid);
  if (!s) return 0;
  const now = Date.now();
  s.directives = s.directives.filter((d) => now - d.ts < DIRECTIVE_TTL_MS);
  return s.directives.length;
}

/** User re-engaged in the terminal — their own prompt supersedes anything the
 *  deck queued, and a pending STOP is moot. */
export function clearOnUserPrompt(sid: string): boolean {
  const s = sessions.get(sid);
  if (!s) return false;
  const had = s.directives.length > 0 || s.stopRequestedAt !== undefined;
  s.directives = [];
  s.stopRequestedAt = undefined;
  return had;
}

export function clearSession(sid: string): void {
  sessions.delete(sid);
}

// ─── PreToolUse gate decision ───

export interface HoldDecision {
  hold: boolean;
  requestId?: string;
  reason: string;
}

export interface HoldContext {
  sessionId: string;
  tool: string;
  toolInput: Record<string, unknown> | undefined;
  permissionMode: string | undefined;
  cwd: string | undefined;
  /** Connected dashboard clients that could answer — no client, no hold. */
  clientCount: number;
  enabled: boolean;
}

/**
 * Should this PreToolUse be held for device approval? Precision-first: hold
 * ONLY when every check says Claude would genuinely prompt the user. Any
 * uncertainty → pass through untouched (Claude's normal flow, zero latency).
 */
export function shouldHoldPreToolUse(ctx: HoldContext): HoldDecision {
  if (!ctx.enabled) return { hold: false, reason: 'disabled' };
  if (ctx.clientCount < 1) return { hold: false, reason: 'no clients' };
  if (!ctx.tool) return { hold: false, reason: 'no tool name' };
  const s = ses(ctx.sessionId);
  const signature = gateSignature(ctx.tool, ctx.toolInput);
  if (s.suppressed.has(signature)) return { hold: false, reason: 'signature learned auto-approved' };
  if (s.heldRequestId) return { hold: false, reason: 'another gate already held' };
  // The stateless prediction (tool sets, mode gate, allow/deny/ask rules,
  // built-in read-only and acceptEdits auto-approvals) is the shared SSOT the
  // Swift daemon runs as generated code — one decision, two daemons.
  const prediction = predictPreToolUseHold({
    tool: ctx.tool,
    toolInput: ctx.toolInput,
    permissionMode: ctx.permissionMode,
    rules: loadMergedPermissionRules(ctx.cwd),
  });
  if (!prediction.hold) return { hold: false, reason: prediction.reason };
  const requestId = randomUUID();
  s.heldRequestId = requestId;
  return { hold: true, requestId, reason: prediction.reason };
}

/**
 * Register a hold for an AskUserQuestion PreToolUse so a device can answer it.
 *
 * Shares only the one-gate-per-session invariant with `shouldHoldPreToolUse`
 * and NONE of its precision guards — deliberately. Those guards exist because
 * PreToolUse fires for tool calls Claude will auto-approve without ever asking
 * the user, so holding one invents a decision nobody was asked for.
 * AskUserQuestion is the opposite: its entire purpose is to prompt, it always
 * does, and no allowlist entry suppresses it. There is no false-hold to guard
 * against, so the permission-rule predictor is skipped — which is also what
 * lets this rung work in the sandboxed App Store daemon, where the predictor
 * can't read `~/.claude` and therefore disables the permission gate entirely.
 *
 * Release it through `gateReleased` with `undecided: false`: an unanswered ask
 * says nothing about whether Claude auto-approves anything, so it must never
 * feed the auto-approval learner.
 */
export function beginAskGate(ctx: {
  sessionId: string;
  clientCount: number;
  enabled: boolean;
}): HoldDecision {
  if (!ctx.enabled) return { hold: false, reason: 'disabled' };
  if (ctx.clientCount < 1) return { hold: false, reason: 'no clients' };
  const s = ses(ctx.sessionId);
  if (s.heldRequestId) return { hold: false, reason: 'another gate already held' };
  const requestId = randomUUID();
  s.heldRequestId = requestId;
  return { hold: true, requestId, reason: 'AskUserQuestion always prompts' };
}

/** The held gate resolved (device decision, timeout, sweep). `undecided` marks
 *  a pass-through release, which arms the auto-approval learner below. */
export function gateReleased(
  sid: string,
  requestId: string,
  opts: { undecided: boolean; tool: string; toolInput?: Record<string, unknown>; toolUseId?: string },
): void {
  const s = sessions.get(sid);
  if (!s) return;
  if (s.heldRequestId === requestId) s.heldRequestId = undefined;
  if (opts.undecided) {
    s.recentAskReleases.push({
      tool: opts.tool,
      signature: gateSignature(opts.tool, opts.toolInput),
      ts: Date.now(),
      toolUseId: opts.toolUseId,
    });
    if (s.recentAskReleases.length > 8) s.recentAskReleases.shift();
  }
}

/** A permission_prompt Notification arrived — every recent undecided release
 *  was a GENUINE prompt, so nothing should be learned as auto-approved. */
export function notePermissionPromptShown(sid: string): void {
  const s = sessions.get(sid);
  if (s) s.recentAskReleases = [];
}

/**
 * PostToolUse arrived. If a recent undecided release matches this tool and no
 * permission_prompt Notification came in between, Claude auto-approved it
 * (session-scoped "always allow" we cannot read) — suppress the signature so
 * it is never held again this session.
 */
export function noteToolEnd(sid: string, tool: string | undefined, toolUseId?: string): void {
  const s = sessions.get(sid);
  if (!s || !tool || s.recentAskReleases.length === 0) return;
  const now = Date.now();
  const kept: AskRelease[] = [];
  for (const r of s.recentAskReleases) {
    if (now - r.ts > ASK_RELEASE_LEARN_WINDOW_MS) continue; // expired
    // The held call and its PostToolUse share a `tool_use_id`, so a release
    // that recorded one learns ONLY from its own completion — a parallel
    // allowlisted Bash finishing inside the window must not teach the held
    // signature (the window is 15 min now, wide enough for that to happen).
    // Releases without an id (older Claude) fall back to the tool name.
    const matches = r.toolUseId ? r.toolUseId === toolUseId : r.tool === tool;
    if (matches) {
      s.suppressed.add(r.signature);
      debug('steering', `learned auto-approved signature for ${sid}: ${r.signature}`);
    } else {
      kept.push(r);
    }
  }
  s.recentAskReleases = kept;
}

/** Enrichment snapshot for sessions_list (devices render STOPPING / queue badges). */
export function steeringSnapshot(sid: string): { stopRequested: boolean; queuedDirectives: number } {
  return {
    stopRequested: isStopRequested(sid),
    queuedDirectives: queuedDirectiveCount(sid),
  };
}

/** Test helper. */
export function _resetSteering(): void {
  sessions.clear();
}
