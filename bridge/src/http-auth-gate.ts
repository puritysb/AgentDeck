/**
 * LAN-facing HTTP access policy for the daemon hub (GitHub issue #145).
 *
 * The daemon deliberately listens on all interfaces — companion apps, ESP32
 * boards, and pull-sync e-ink clients all live on the LAN — so the security
 * boundary is authentication, not the bind address. The rules here are the
 * single chokepoint the request handler consults before dispatching routes:
 *
 * - Same-machine connections (loopback or any of this host's own addresses)
 *   are fully trusted, matching the WS server's long-standing policy.
 * - A remote request is authorized only by pairing token (`?token=` query or
 *   `Authorization: Bearer`).
 * - Unauthorized remote requests reach exactly one always-on route: a minimal
 *   `GET /health` that carries **no pairing token, no module/device
 *   inventory, and no session state** — just enough for a companion app to
 *   recognize a daemon and know that pairing is required. Everything else
 *   is 401.
 * - `POST /pair` exists only while the **operator has a pairing window open**
 *   on the host (`agentdeck pair`). It is the credential path for a device that
 *   can neither scan a QR nor be reached over USB serial — an e-ink reader. With
 *   no window it is refused by the same default-deny branch as any unknown path,
 *   so it is not a standing pre-auth route and cannot be probed to learn whether
 *   someone is pairing. See `pairing-window.ts` and shared `pairing-code.ts`.
 *
 * Kept as pure functions (no server state) so the deny matrix and the
 * secret-free public payload are unit-testable without booting a daemon. The
 * one piece of state the gate needs — is a window open — is passed in.
 */
import type { IncomingMessage } from 'http';
import { isLocalConnection, validateToken } from './auth.js';

export type HttpGateDecision = 'allow' | 'public-health' | 'pair-redeem' | 'deny';

/** True when the request is same-machine or carries a valid pairing token. */
export function isAuthorizedHttpRequest(
  req: Pick<IncomingMessage, 'url' | 'headers'> & { socket: { remoteAddress?: string } },
): boolean {
  const ip = req.socket.remoteAddress ?? '';
  if (isLocalConnection(ip)) return true;

  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken && validateToken(queryToken)) return true;
  } catch {
    // Unparseable URL — fall through to header check.
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && validateToken(auth.slice(7))) {
    return true;
  }
  return false;
}

/** The redemption route. Only a route while an operator window is open. */
export const PAIR_REDEEM_PATH = '/pair';

/**
 * Route an (un)authorized request: full dispatch, public health, code
 * redemption, or 401.
 *
 * @param pairingWindowOpen whether the operator has a pairing window open right
 *   now. False must be indistinguishable from "no such route" — the caller
 *   answers 'deny' identically for `/pair` and for `/nonsense`, so a peer cannot
 *   use the endpoint to detect that someone is pairing.
 */
export function gateHttpRequest(
  method: string,
  pathname: string,
  authorized: boolean,
  pairingWindowOpen = false,
): HttpGateDecision {
  if (authorized) return 'allow';
  if (method === 'GET' && pathname === '/health') return 'public-health';
  if (method === 'POST' && pathname === PAIR_REDEEM_PATH && pairingWindowOpen) return 'pair-redeem';
  return 'deny';
}

/**
 * The `/health` payload served to unauthenticated LAN peers. Discovery-grade
 * only: enough for a companion app to identify a daemon (`mode`) and for a
 * remote worker to see the attach capability bit — never credentials,
 * device inventory, or session state. `authRequired` tells clients to open
 * their pairing flow instead of retrying.
 */
export function buildPublicHealth(port: number): Record<string, unknown> {
  return {
    status: 'ok',
    mode: 'daemon',
    port,
    sameSocketControl: true,
    authRequired: true,
  };
}
