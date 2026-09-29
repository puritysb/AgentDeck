/**
 * How an OpenClaw Gateway `health` frame becomes the `gatewayHasError` flag.
 *
 * That flag has exactly one visible consumer shape and it is a loud one: the
 * OpenClaw creature turns SICK (Android `TerrariumState.kt`, Swift parity) and
 * the topology LED turns red. So the rule that sets it has to answer THREE
 * questions, not two — healthy, unhealthy, and "this frame did not say".
 *
 * Both daemons used to collapse the third into the second:
 *
 *   Node:   `const hasError = !(evt.data?.ok as boolean);`   // undefined -> true
 *   Swift:  `!((payload?["ok"] as? Bool) ?? false)`          // nil       -> true
 *
 * A frame that carries no usable `ok` therefore read as a failure, and the
 * creature went sick until the next frame happened to carry one — OpenClaw's
 * health monitor runs on a 300 s interval, so that window is up to five
 * minutes. Same trap as the flash-id and `lsof` probes, tilted the alarming
 * way: "I could not tell" is not "it is broken".
 *
 * The two daemons also disagreed about what a health payload may look like.
 * The Swift ADAPTER already knew the frame can express health as a `checks`
 * array or a top-level `status` string; the Node adapter read only `ok` and
 * dropped the rest. One payload, two verdicts. This module is the single
 * source both now consult, replayed by both suites through
 * `shared/gateway-health-vectors.json`.
 */

/** A status word that means "not healthy" wherever a health payload uses one. */
const UNHEALTHY_STATUS = new Set(['error', 'warn', 'degraded', 'unhealthy', 'fail', 'failed', 'down']);

export interface GatewayHealthVerdict {
  /** False when the frame said nothing usable — the caller RETAINS its previous
   *  value rather than inventing one. */
  known: boolean;
  /** Only meaningful when `known`. */
  hasError: boolean;
  /** Which part of the payload decided it — for the transition log, so the next
   *  sick creature leaves a trace instead of a guess. */
  reason: 'ok_field' | 'checks' | 'status_field' | 'unreadable';
  /** The failing check/status name, when there was one. */
  detail?: string;
}

function statusOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Read a Gateway health payload.
 *
 * Order matters and mirrors the Swift adapter's existing ladder: an explicit
 * `ok` boolean wins, then a `checks` array, then a top-level `status` string.
 * Anything else is `known: false`.
 */
export function resolveGatewayHealth(payload: unknown): GatewayHealthVerdict {
  if (!payload || typeof payload !== 'object') {
    return { known: false, hasError: false, reason: 'unreadable' };
  }
  const p = payload as Record<string, unknown>;

  if (typeof p.ok === 'boolean') {
    return { known: true, hasError: !p.ok, reason: 'ok_field' };
  }

  if (Array.isArray(p.checks)) {
    for (const check of p.checks) {
      if (!check || typeof check !== 'object') continue;
      const c = check as Record<string, unknown>;
      const status = statusOf(c.status);
      if (status && UNHEALTHY_STATUS.has(status)) {
        const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : status;
        return { known: true, hasError: true, reason: 'checks', detail: name };
      }
    }
    // An empty `checks` array is a frame that ran no checks, not a pass.
    if (p.checks.length === 0) {
      return { known: false, hasError: false, reason: 'unreadable' };
    }
    return { known: true, hasError: false, reason: 'checks' };
  }

  const status = statusOf(p.status);
  if (status) {
    return {
      known: true,
      hasError: UNHEALTHY_STATUS.has(status),
      reason: 'status_field',
      detail: status,
    };
  }

  return { known: false, hasError: false, reason: 'unreadable' };
}
