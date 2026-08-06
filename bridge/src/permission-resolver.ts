import type { ServerResponse } from 'http';
import { debug } from './logger.js';

/**
 * Holds open PreToolUse hook HTTP responses for observed (`claude` direct)
 * sessions until a device approves/denies, then resolves them into a Claude
 * Code permission decision.
 *
 * Flow: the daemon's `/hooks/PreToolUse` handler classifies a gated tool call,
 * registers the still-open `res` here keyed by a fresh `requestId`, and waits.
 * A device sends `permission_decision { requestId, decision }` over WS, which
 * calls `resolvePending` → the held response ends with
 * `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision } }`
 * and Claude proceeds. If no device answers within the timeout, the response
 * falls back to `pass` — an EMPTY body, which Claude treats as "no hook
 * decision" and runs its normal permission evaluation untouched. (The earlier
 * gate returned an explicit `ask` here; `pass` is strictly safer because an
 * `ask` decision can force a prompt for a call the allowlist would have
 * auto-approved — the false-attention failure mode this gate must never
 * reintroduce.)
 *
 * Lives outside the state machine (which can't attribute per-session) — same
 * rationale as awaiting-overlay.ts.
 */

export type PermissionDecision = 'allow' | 'deny' | 'pass';

interface PendingEntry {
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
  tool?: string;
  createdAt: number;
  /** Fired exactly once when the entry resolves by any path (device decision,
   *  timeout, sweep, drain) so the caller can clear awaiting UI consistently. */
  onResolved?: (decision: PermissionDecision) => void;
}

const pending = new Map<string, PendingEntry>();

function buildDecisionBody(decision: PermissionDecision, reason?: string): string {
  // `pass` = empty body: the hook's `printf '%s' "$RESP"` emits nothing and
  // Claude's normal permission flow runs as if the gate never existed.
  if (decision === 'pass') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  });
}

/** End a held response with a decision and drop the entry. Safe if the socket
 *  is already gone. */
function endWith(
  key: string,
  entry: PendingEntry,
  decision: PermissionDecision,
  reason?: string,
): void {
  clearTimeout(entry.timer);
  pending.delete(key);
  try {
    entry.res.writeHead(200, { 'Content-Type': 'application/json' });
    entry.res.end(buildDecisionBody(decision, reason));
  } catch {
    /* client disconnected */
  }
  try { entry.onResolved?.(decision); } catch { /* callback must never throw the resolver */ }
}

/**
 * Register a held hook response. Auto-resolves to `pass` after `timeoutMs` so a
 * never-answered prompt falls back to Claude's own terminal prompt. The hook's
 * curl `--max-time` must exceed `timeoutMs` so this fallback reaches Claude
 * before curl gives up.
 */
export function registerPending(
  requestId: string,
  res: ServerResponse,
  opts: { sessionId?: string; tool?: string; timeoutMs: number; onResolved?: (decision: PermissionDecision) => void },
): void {
  // Defensive: if a stale entry exists under this id, resolve it to pass first.
  const existing = pending.get(requestId);
  if (existing) endWith(requestId, existing, 'pass');

  const timer = setTimeout(() => {
    const entry = pending.get(requestId);
    if (entry) {
      debug('permission', `pending ${requestId} timed out → pass`);
      endWith(requestId, entry, 'pass');
    }
  }, opts.timeoutMs);

  pending.set(requestId, {
    res,
    timer,
    sessionId: opts.sessionId,
    tool: opts.tool,
    createdAt: Date.now(),
    onResolved: opts.onResolved,
  });
  debug('permission', `registered pending ${requestId} (tool=${opts.tool ?? '?'} session=${opts.sessionId ?? '?'})`);
}

/**
 * Resolve a pending request from a device decision. Returns the affected
 * sessionId (so the caller can clear the awaiting overlay + rebroadcast), or
 * null if no such pending request exists (already resolved / unknown id).
 */
export function resolvePending(requestId: string, decision: 'allow' | 'deny'): string | null {
  const entry = pending.get(requestId);
  if (!entry) return null;
  const sessionId = entry.sessionId ?? null;
  endWith(requestId, entry, decision);
  debug('permission', `resolved pending ${requestId} → ${decision}`);
  return sessionId;
}

/**
 * Resolve a pending request with an explanation Claude receives as the tool
 * call's feedback (`permissionDecisionReason`).
 *
 * This is the delivery channel for a device-answered AskUserQuestion: the hook
 * contract has no field for supplying a chosen option, but a denied tool call's
 * reason text IS handed to the model — so the daemon denies the question and
 * reports the answer the user already gave on their device. Same mechanism the
 * soft-STOP deny and the Stop-hook directive queue already use.
 */
export function resolvePendingWithReason(
  requestId: string,
  decision: 'allow' | 'deny',
  reason: string,
): string | null {
  const entry = pending.get(requestId);
  if (!entry) return null;
  const sessionId = entry.sessionId ?? null;
  endWith(requestId, entry, decision, reason);
  debug('permission', `resolved pending ${requestId} → ${decision} (with reason)`);
  return sessionId;
}

/** Drop a pending entry without sending a decision (e.g. the hook's socket
 *  closed because Claude moved on). The held response is already dead. */
export function abandonPending(requestId: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
}

/** Sweep entries older than maxAgeMs (backstop for any timer that didn't fire),
 *  resolving them to `pass`. Returns the number swept. */
export function sweepStalePending(maxAgeMs: number, now: number = Date.now()): number {
  let swept = 0;
  for (const [key, entry] of Array.from(pending.entries())) {
    if (now - entry.createdAt > maxAgeMs) {
      endWith(key, entry, 'pass');
      swept++;
    }
  }
  if (swept > 0) debug('permission', `swept ${swept} stale pending requests`);
  return swept;
}

/** Resolve all pending to `pass` and clear — used on daemon shutdown. */
export function drainAllPending(): void {
  for (const [key, entry] of Array.from(pending.entries())) {
    endWith(key, entry, 'pass');
  }
}

/** Is this requestId still an open held gate? Used by the hook handler to
 *  avoid clearing a gate's awaiting overlay on unrelated parallel-tool hooks. */
export function isPendingRequest(requestId: string): boolean {
  return pending.has(requestId);
}

/** Test/diagnostic helper. */
export function _pendingCount(): number {
  return pending.size;
}
