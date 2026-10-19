/**
 * `GET /esp32/wifi` and `POST /esp32/wifi`: the WiFi credentials this daemon
 * hands to serial-attached ESP32 boards, read and set by the operator.
 *
 * Before these routes a daemon learned the credentials only from a file it read
 * at startup (`agentdeck wifi-setup` wrote `~/.agentdeck/wifi-config.json` and
 * said "applies on next restart"), and the macOS app had no way at all: its
 * Wi-Fi sheet wrote a `wifi.config` frame straight to the serial port, which no
 * firmware has ever parsed, and nothing in the app saved credentials for its
 * own daemon. Both daemons serve these routes in one wire shape, because the
 * app calls whichever daemon holds the port (the Swift twin is in
 * DaemonServer.swift).
 *
 * Never served: the password, and a board's credential id, which with the
 * pairing token tests password guesses offline. The credentials never cross
 * the LAN, and arriving from this machine is not enough to read or change
 * them ({@link wifiSetupAuthorized}).
 */
import { wifiCredentialsProblem, type WifiCredentialsProblem } from '@agentdeck/shared';
import type { WifiProvisionMessage } from '@agentdeck/shared/protocol';
import type { WifiProvisionOutcome, WifiSetupBoardRow } from './esp32-serial.js';
import { buildWifiProvision, wifiCredId } from './esp32-wifi-cred.js';
import type { WifiConfig } from './wifi-config.js';

/** What the routes read and drive; the daemon wires the real ones. */
export interface WifiSetupDeps {
  loadConfig(): WifiConfig | null;
  /** Throws when the file cannot be written. */
  saveConfig(config: WifiConfig): void;
  /** Whether this daemon runs the serial channel at all (a `--local` one does not). */
  serialRunning(): boolean;
  boards(expectedCredId: string | null): WifiSetupBoardRow[];
  provision(msg: WifiProvisionMessage, opts: { manual: boolean }): WifiProvisionOutcome[];
  authToken(): string;
  bridgeIp(): string;
  bridgePort: number;
}

export interface WifiSetupResponse {
  status: number;
  body: Record<string, unknown>;
}

export type WifiSetupError = WifiCredentialsProblem | 'invalid-body' | 'save-failed' | 'local-token-required';

/** Loopback socket addresses as both daemons report them. */
export const WIFI_SETUP_LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** The largest `POST /esp32/wifi` body either daemon reads (Swift: `ESP32WifiSetup.maxBodyBytes`). */
export const WIFI_SETUP_MAX_BODY_BYTES = 4 * 1024;

/**
 * How much of an oversized body is read and discarded before the request is
 * dropped instead: enough for any client that sent a real body, so its refusal
 * arrives as an answer, not a reset.
 */
export const WIFI_SETUP_MAX_DRAIN_BYTES = 64 * 1024;

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * A `POST /esp32/wifi` body as both daemons read it (the Swift twin is
 * `ESP32WifiSetup.parseBody`; shared/esp32-wifi-setup-vectors.json `bodies`
 * pins it): none is `{}`. Not a body, answered `invalid-body`: one over the
 * limit, bytes that are not UTF-8, a leading byte-order mark (JSON has none),
 * a key or string holding half a surrogate pair, or JSON the two parsers read
 * differently ({@link ambiguousJson}). A replacing decoder would save U+FFFD in
 * the network name, and the two daemons do not replace alike. Any JSON value
 * parses; {@link applyWifiSetup} refuses all but an object.
 */
export function parseWifiSetupBody(bytes: Uint8Array | null): { ok: true; value: unknown } | { ok: false } {
  if (bytes === null || bytes.length > WIFI_SETUP_MAX_BODY_BYTES) return { ok: false };
  if (bytes.length === 0) return { ok: true, value: {} };
  try {
    // ignoreBOM keeps a byte-order mark in the text, where JSON.parse refuses it.
    const text = STRICT_UTF8.decode(bytes);
    const value: unknown = JSON.parse(text, (key, field: unknown) => {
      if (LONE_SURROGATE.test(key) || (typeof field === 'string' && LONE_SURROGATE.test(field))) {
        throw new SyntaxError('half a surrogate pair');
      }
      return field;
    });
    return ambiguousJson(text) ? { ok: false } : { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether JSON text names a key twice in one object or puts a comma before a
 * closing bracket. The daemons' parsers disagree on both — JSON.parse keeps the
 * last of two equal keys and refuses the comma, Foundation keeps the first and
 * accepts it — so the same request would save different credentials, or none,
 * depending on which daemon holds the port. Run on text a parser accepted.
 * The Swift twin is `ESP32WifiSetup.ambiguousJSON`.
 */
function ambiguousJson(text: string): boolean {
  // One entry per open container: an object's keys so far, or null for an array.
  const open: Array<Set<string> | null> = [];
  let previous = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = open[open.length - 1];
      // In an object, a string right after `{` or `,` is a key.
      if (keys && (previous === '{' || previous === ',')) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
      }
      i = end;
      previous = '"';
    } else if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
      if (c === '{') open.push(new Set());
      else if (c === '[') open.push(null);
      else if (c === '}' || c === ']') {
        if (previous === ',') return true;
        open.pop();
      }
      previous = c;
    }
  }
  return false;
}

/**
 * Read a `POST /esp32/wifi` body to its end, keeping at most the limit: null
 * when it ran over. Reading on rather than destroying the request lets the
 * refusal reach the caller on an intact connection, as the Swift daemon's does;
 * past {@link WIFI_SETUP_MAX_DRAIN_BYTES} the request is dropped.
 */
export function readWifiSetupBody(req: NodeJS.ReadableStream & { destroy(): void }): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > WIFI_SETUP_MAX_DRAIN_BYTES) {
        req.destroy();
      } else if (total > WIFI_SETUP_MAX_BODY_BYTES) {
        chunks.length = 0;
      } else {
        chunks.push(buf);
      }
    });
    req.on('end', () => resolve(total > WIFI_SETUP_MAX_BODY_BYTES ? null : Buffer.concat(chunks)));
    req.on('error', reject);
    // After 'end' this settles nothing; before it, the request was dropped.
    req.on('close', () => reject(new Error('request closed before its body ended')));
  });
}

/**
 * The `/integrations/zai` rule, for the same reason: credentials stay on the
 * loopback interface, and the caller presents the pairing token as a bearer.
 * Same-machine trust alone would let anything that reaches the port from this
 * machine replace the network every board joins. The macOS app and
 * `agentdeck wifi-setup` hold the token. (A local process can still read it
 * from `/health`: same-machine trust is not closed by construction.)
 */
export function wifiSetupAuthorized(
  remoteAddress: string | undefined,
  authorization: string | string[] | undefined,
  validateToken: (token: string) => boolean,
): boolean {
  if (!remoteAddress || !WIFI_SETUP_LOOPBACK_ADDRESSES.includes(remoteAddress)) return false;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const token = authorization.slice('Bearer '.length);
  return token !== '' && validateToken(token);
}

/** The answer to a caller {@link wifiSetupAuthorized} refuses. */
export function wifiSetupRefusal(): WifiSetupResponse {
  return refuse(403, 'local-token-required');
}

/** `GET /esp32/wifi`: what is configured and what each live serial board holds. */
export function wifiSetupStatus(deps: WifiSetupDeps): WifiSetupResponse {
  const config = deps.loadConfig();
  const expectedCredId = config ? wifiCredId(deps.authToken(), config.ssid, config.password) : null;
  const serial = deps.serialRunning();
  return {
    status: 200,
    body: {
      ok: true,
      configured: config !== null,
      ssid: config?.ssid ?? '',
      autoProvision: config?.autoProvision ?? false,
      serial,
      boards: serial ? deps.boards(expectedCredId) : [],
    },
  };
}

/**
 * `POST /esp32/wifi` with `{ssid, password, autoProvision?}`: check the
 * credentials with the shared rule, save them (the daemon reads the file again
 * on the next board's device_info, so they apply without a restart), and send
 * them to every live serial board as an operator request. `autoProvision`
 * (default true) governs only the automatic sends that follow.
 */
export function applyWifiSetup(body: unknown, deps: WifiSetupDeps): WifiSetupResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'invalid-body');
  const fields = body as Record<string, unknown>;
  if (fields.autoProvision !== undefined && typeof fields.autoProvision !== 'boolean') {
    return refuse(400, 'invalid-body');
  }
  const ssid = typeof fields.ssid === 'string' ? fields.ssid : '';
  const password = typeof fields.password === 'string' ? fields.password : '';
  const problem = wifiCredentialsProblem(ssid, password);
  if (problem) return refuse(400, problem);
  const autoProvision = fields.autoProvision !== false;
  try {
    deps.saveConfig({ ssid, password, autoProvision });
  } catch {
    return refuse(500, 'save-failed');
  }
  const boards = deps.serialRunning()
    ? deps.provision(buildWifiProvision({
      ssid,
      password,
      bridgeIp: deps.bridgeIp(),
      bridgePort: deps.bridgePort,
      authToken: deps.authToken(),
    }), { manual: true })
    : [];
  return { status: 200, body: { ok: true, saved: true, autoProvision, boards } };
}

function refuse(status: number, error: WifiSetupError): WifiSetupResponse {
  return { status, body: { ok: false, error } };
}
