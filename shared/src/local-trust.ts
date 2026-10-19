/**
 * Same-machine trust is for local programs, not for web pages.
 *
 * Both daemons admit a connection from this machine without the pairing token
 * (`isLocalConnection` in `bridge/src/auth.ts`, `AuthManager.isLocalConnection`
 * in Swift): the CLI, the macOS app, the deck plugins and the session bridges
 * all run here, and a socket carries no credential that would tell them apart.
 * A web page the user has open runs here too, and its browser connects from
 * 127.0.0.1 like any of them. Treated as one of them, a page could:
 *
 *  - open a WebSocket to the daemon (WebSockets have no CORS), receive the
 *    session roster and timeline, and send device commands;
 *  - send a cross-origin POST with a `text/plain` body, which needs no CORS
 *    preflight, and both daemons parse any body as JSON;
 *  - with a host name that re-resolves to 127.0.0.1 (DNS rebinding), read the
 *    daemon same-origin, `/health` and its pairing token included.
 *
 * A browser says where a request comes from, and a local program does not: it
 * sends `Host` as the name in the page's URL, and `Origin` on every WebSocket
 * handshake and every request other than GET and HEAD. So local trust also
 * requires both of these:
 *
 *  - `Host` names this machine without asking the network: an IP literal,
 *    `localhost` or a `.localhost` name (RFC 6761), or this machine's own mDNS
 *    name exactly as `gethostname` reports it (`<name>.local`). A rebinding
 *    page's `Host` is the page's own domain, and so is any name DNS answers:
 *    a bare host name (macOS resolves a single label through the DNS search
 *    domains), a fully qualified one, or another machine's `.local` name.
 *  - On a WebSocket upgrade or a method that changes state, `Origin` is absent,
 *    is the daemon's own origin (a page the daemon served itself, such as the
 *    APME dashboard), or is the literal `file://` some non-browser clients send.
 *    A browser serialises an opaque origin as `null`, never as `file://`. Its
 *    own origin is this machine at either the port the request was addressed
 *    to (its `Host`: a browser writes the page's host and port into both, and
 *    behind a port forward that is not the port this server listens on) or the
 *    port it listens on.
 *
 * A GET or HEAD keeps local trust whatever its `Origin`. A browser shows a page
 * the answer only from a route that opts in with `Access-Control-Allow-Origin`,
 * so that header goes only on routes that carry no secret (`/setup-status`,
 * `/display-state`, the Pixoo frames); the Ulanzi Studio Property Inspector
 * reads `/setup-status` exactly that way. A request that loses local trust is
 * judged as a LAN peer's would be: a pairing token still admits it. An
 * operator approval does not, since it names a device on the network, and
 * approving a loopback address would hand local trust to every page.
 *
 * Every test is on ASCII: whitespace is trimmed and case is folded only as
 * ASCII, and the rest is compared code unit for code unit, which is how the
 * Swift evaluator reads it too (a browser sends nothing else in these headers).
 * A Unicode case or space mapping would make the two daemons disagree.
 *
 * `pnpm generate-local-trust-rules` emits the Swift evaluator
 * (`LocalTrustRules.generated.swift`), drift gated by `local-trust-sync.test.ts`;
 * both suites replay `shared/local-trust-vectors.json`.
 */

export type LocalTrustVerdict = 'trusted' | 'foreign-host' | 'foreign-origin';

export interface LocalTrustRequest {
  /** The request method, in any case. */
  method: string;
  /** A WebSocket upgrade, whose `Origin` is checked even though it is a GET. */
  upgrade?: boolean;
  /** The request's `Origin` header, absent when it carried none. */
  origin?: string | null;
  /** The request's `Host` header, absent when it carried none. */
  host?: string | null;
}

export interface LocalTrustEnvironment {
  /** The port this server listens on, which its own pages' origin carries. */
  port: number;
  /**
   * Whether an IP literal (no brackets, no zone) is one of this machine's
   * addresses, loopback included: the daemon's `isLocalConnection`.
   */
  isLocalAddress: (ip: string) => boolean;
  /** This machine's host names (`gethostname`), in any case; only a `.local` one is trusted. */
  hostNames: readonly string[];
}

/** Methods that do not change state; a browser sends no `Origin` on a same-origin GET or HEAD. */
export const LOCAL_TRUST_SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

/** The port an origin names when it names none, per scheme a daemon page can have. */
export const LOCAL_TRUST_DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, ws: 80, https: 443, wss: 443 };

/** The literal `Origin` the ESP32 WebSocket library (links2004) sends; a browser never sends it. */
export const LOCAL_TRUST_FILE_ORIGIN = 'file://';

const SAFE_METHODS = new Set(LOCAL_TRUST_SAFE_METHODS);

/** Whether a same-machine request may skip the pairing token, and why not. */
export function localTrustVerdict(req: LocalTrustRequest, env: LocalTrustEnvironment): LocalTrustVerdict {
  const hostHeader = trimAscii(req.host ?? '');
  let host: Authority | null = null;
  if (hostHeader !== '') {
    host = splitAuthority(hostHeader);
    // A browser reaches an IP literal without DNS, so rebinding cannot produce one.
    if (!host || !(isIpLiteral(host.host) || isThisMachineName(host.host, env))) return 'foreign-host';
  }
  const checksOrigin = req.upgrade === true || !SAFE_METHODS.has(asciiUpper(trimAscii(req.method)));
  if (!checksOrigin) return 'trusted';
  const origin = trimAscii(req.origin ?? '');
  if (origin === '' || asciiLower(origin) === LOCAL_TRUST_FILE_ORIGIN) return 'trusted';
  return isOwnOrigin(origin, host, env) ? 'trusted' : 'foreign-origin';
}

/** `localTrustVerdict(...) === 'trusted'`. */
export function isLocallyTrusted(req: LocalTrustRequest, env: LocalTrustEnvironment): boolean {
  return localTrustVerdict(req, env) === 'trusted';
}

interface Authority {
  /** ASCII lower case, without brackets or a trailing dot. */
  host: string;
  /** Digits, or '' when the authority names no port. */
  port: string;
}

/** Trim ASCII whitespace only; `String.prototype.trim` also takes Unicode spaces. */
function trimAscii(text: string): string {
  return text.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function asciiUpper(text: string): string {
  return text.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

/** Split `host[:port]` or `[ipv6][:port]`; null when it is neither. */
function splitAuthority(authority: string): Authority | null {
  const text = asciiLower(trimAscii(authority));
  let host: string;
  let port = '';
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close < 0) return null;
    host = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return null;
      port = rest.slice(1);
    }
  } else {
    const colon = text.indexOf(':');
    if (colon < 0) {
      host = text;
    } else if (text.indexOf(':', colon + 1) < 0) {
      host = text.slice(0, colon);
      port = text.slice(colon + 1);
    } else {
      // More than one colon: a bare IPv6 literal, which names no port.
      host = text;
    }
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || (port !== '' && !/^\d{1,5}$/.test(port))) return null;
  return { host, port };
}

/** An IPv4 dotted quad, or an IPv6 literal with or without a zone. */
function isIpLiteral(host: string): boolean {
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad) return quad.slice(1).every((octet) => Number(octet) <= 255);
  const address = withoutZone(host);
  return address.includes(':') && /^[0-9a-f:.]+$/.test(address);
}

function withoutZone(host: string): string {
  const percent = host.indexOf('%');
  return percent < 0 ? host : host.slice(0, percent);
}

function isThisMachineName(host: string, env: LocalTrustEnvironment): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // Only the mDNS name, which the system resolver answers from this machine's
  // own records: never a name derived from it, which DNS would answer.
  for (const raw of env.hostNames) {
    const name = splitAuthority(raw)?.host;
    if (name && name.length > '.local'.length && name.endsWith('.local') && host === name) return true;
  }
  return false;
}

function isOwnOrigin(origin: string, host: Authority | null, env: LocalTrustEnvironment): boolean {
  // A browser never sends a path; a trailing slash from a non-browser client is
  // tolerated, since host and port still have to be this daemon's.
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)\/?$/i.exec(origin);
  if (!match) return false;
  const scheme = asciiLower(match[1]);
  // Own keys only: `constructor://` must not find Object.prototype.constructor.
  const defaultPort = Object.prototype.hasOwnProperty.call(LOCAL_TRUST_DEFAULT_PORTS, scheme)
    ? LOCAL_TRUST_DEFAULT_PORTS[scheme]
    : undefined;
  if (defaultPort === undefined || match[2].includes('@')) return false;
  const authority = splitAuthority(match[2]);
  if (!authority) return false;
  const port = authority.port === '' ? defaultPort : Number(authority.port);
  const addressed = host !== null && host.host === authority.host
    && (host.port === '' ? defaultPort : Number(host.port)) === port;
  if (!addressed && port !== env.port) return false;
  // An IP literal must be this machine's: any address with the daemon's port
  // would admit a page served from another host's server on that port.
  if (isIpLiteral(authority.host)) return env.isLocalAddress(withoutZone(authority.host));
  return isThisMachineName(authority.host, env);
}
