/**
 * ESP32 WiFi provisioning — whether a serial-attached board needs a
 * `wifi_provision`, and the credential id that lets it answer "I already hold
 * these" with its radio off.
 *
 * Both questions used to be read off `device_info.wifiConfigured`, which cannot
 * answer either of them:
 *
 *  - A board parked on USB serial has its WiFi driver off, so `WiFi.SSID()` is
 *    empty and it reports `wifiConfigured: false`. Every serial reopen, lease
 *    resume and daemon restart re-provisioned it, and on most boards a provision
 *    joins the AP — a radio wake the firmware's own parking then has to undo.
 *  - A board that persists a provision for a later join (the `adwifi` store:
 *    IPS10, T-Display-S3-Pro, NM-EPD-420, EPD47) reports `true` from that store
 *    instead, so the daemon never sent it CHANGED credentials at all.
 *
 * Both are "does this board hold the credentials this daemon would send?". The
 * daemon puts an id of those credentials in the provision ({@link WifiProvisionDecision}
 * reads it back from `device_info.wifiCredId`), and the board stores it beside
 * the credentials themselves.
 *
 * The id is HMAC-SHA256 keyed by the pairing token the same provision carries,
 * never a bare hash: anyone who saw a bare hash of an SSID and password could
 * test password guesses against it offline. Both daemons converge on one token
 * per machine, so their ids agree; `agentdeck token rotate` re-provisions each
 * board once. The HMAC is computed where a crypto library is —
 * `bridge/src/esp32-wifi-cred.ts` (node:crypto) and the generated Swift mirror
 * (CryptoKit) — so this module stays importable in a browser. Behaviour is
 * pinned by `shared/esp32-wifi-provision-vectors.json`, which the shared,
 * bridge and Swift suites replay.
 */

/** Domain separation for the id's HMAC message. Bump the suffix, never reuse it. */
export const WIFI_CRED_ID_DOMAIN = 'agentdeck-wifi-cred-v1';

/** Hex characters of the HMAC-SHA256 digest an id keeps (64 bits). */
export const WIFI_CRED_ID_HEX_LENGTH = 16;

/**
 * The board whose radio-up provision the Node daemon re-sends, so it re-learns
 * the bridge endpoint it persists for a WiFi-only boot (2026-07-07).
 */
export const WIFI_PROVISION_ENDPOINT_REFRESH_BOARD = 'ips_10';

/**
 * Whether a provision carrying these can have an id. Without a token there is
 * no key, and without an SSID and password a board has nothing to store; such
 * a provision carries no id, and a board that receives it clears its own.
 */
export function wifiCredIdComputable(authToken: string, ssid: string, password: string): boolean {
  return authToken !== '' && ssid !== '' && password !== '';
}

/**
 * The HMAC message an id signs, UTF-8 encoded by the caller; the key is the
 * provision's `authToken`, UTF-8 encoded, and the id is the first
 * {@link WIFI_CRED_ID_HEX_LENGTH} lowercase hex characters of the digest.
 */
export function wifiCredIdMessage(ssid: string, password: string): string {
  return `${WIFI_CRED_ID_DOMAIN}\0${ssid}\0${password}`;
}

/** What one serial connection's latest `device_info` says, and what this daemon would send it. */
export interface WifiProvisionInput {
  connected: boolean;
  /** A provision already went over this connection (one per connection). */
  provisionSent: boolean;
  /** `device_info.board`; absent until a board has identified on this tty. */
  board?: string | null;
  wifiConfigured?: boolean | null;
  wifiConnected?: boolean | null;
  wifiRadioParked?: boolean | null;
  /**
   * `device_info.wifiCredId`: a string ("" = none stored) from firmware that
   * knows the field, absent from older firmware. Only a string counts.
   */
  wifiCredId?: string | null;
  /** The id of the provision this daemon would send; null when it has none to offer. */
  expectedCredId?: string | null;
  /**
   * Re-send to a {@link WIFI_PROVISION_ENDPOINT_REFRESH_BOARD} whose radio is up.
   * The Node daemon has done this since 2026-07-07. The Swift daemon never
   * has, and does not start now: `auth_provision` carries the endpoint to any
   * firmware that reads it, and on that board this provision re-joins the AP.
   * An operator's request never makes one: it leaves a joined board alone.
   */
  refreshIps10Endpoint?: boolean;
  /**
   * The operator asked for this provision just now (`POST /esp32/wifi`: the
   * macOS app's Wi-Fi sheet, `agentdeck wifi-setup`). Two rules stand in for
   * an operator's request and give way to one: a provision that already went
   * over this connection may have carried the credentials just replaced, and
   * old firmware gets one send per request rather than its daemon's legacy
   * rule. A joined board and a board whose id matches are still left alone:
   * a request must not re-join an IPS10's access point each time it is made.
   */
  manual?: boolean;
}

export type WifiProvisionReason =
  | 'not-connected'
  | 'unidentified'
  | 'already-sent'
  | 'endpoint-refresh'
  | 'wifi-connected'
  | 'credentials-match'
  | 'credentials-differ'
  | 'legacy-configured'
  | 'legacy-unconfigured'
  | 'operator-request';

export interface WifiProvisionDecision {
  send: boolean;
  reason: WifiProvisionReason;
  /**
   * The answer came from the rule that predates the id — the firmware does not
   * report one, or this daemon has none to compare. That rule is the Node
   * daemon's (a board reporting saved credentials is left alone). The Swift
   * daemon keeps its own there, once per port per credential set per app
   * lifetime: either daemon taking the other's would change what old firmware
   * gets today.
   */
  legacy: boolean;
}

/** Whether to send `wifi_provision` to one serial connection, and why. */
export function wifiProvisionDecision(input: WifiProvisionInput): WifiProvisionDecision {
  const verdict = (send: boolean, reason: WifiProvisionReason, legacy = false): WifiProvisionDecision =>
    ({ send, reason, legacy });
  if (!input.connected) return verdict(false, 'not-connected');
  // Nothing has confirmed an AgentDeck board on this tty yet, and WiFi
  // credentials are not something to write speculatively.
  if (!input.board) return verdict(false, 'unidentified');
  if (input.provisionSent && input.manual !== true) return verdict(false, 'already-sent');
  if (input.refreshIps10Endpoint === true && input.manual !== true &&
      input.board === WIFI_PROVISION_ENDPOINT_REFRESH_BOARD &&
      input.wifiConnected === true &&
      input.wifiRadioParked !== true) {
    return verdict(true, 'endpoint-refresh');
  }
  // Joined: re-injecting credentials would fight the firmware's radio policy.
  if (input.wifiConnected === true) return verdict(false, 'wifi-connected');
  if (typeof input.wifiCredId === 'string' && input.expectedCredId) {
    return input.wifiCredId === input.expectedCredId
      ? verdict(false, 'credentials-match')
      : verdict(true, 'credentials-differ');
  }
  // Nothing says which credentials the board holds, and the operator has just
  // asked for these: the request is the one-off event the legacy rule guesses at.
  if (input.manual === true) return verdict(true, 'operator-request');
  return input.wifiConfigured === true
    ? verdict(false, 'legacy-configured', true)
    : verdict(true, 'legacy-unconfigured', true);
}

/** 802.11 caps an SSID at 32 octets; ESP-IDF refuses a longer one. */
export const WIFI_SSID_MAX_BYTES = 32;

/**
 * A WPA/WPA2/WPA3-Personal passphrase is 8–63 characters. Exactly 64 is read as
 * the raw 256-bit key in hex, by ESP-IDF as by every access point. The firmware
 * refuses an empty password (`missing credentials`), so an open network has no
 * provision either. Lengths are UTF-8 bytes: the firmware measures with strlen.
 */
export const WIFI_PASSWORD_MIN_BYTES = 8;
export const WIFI_PASSPHRASE_MAX_BYTES = 63;
export const WIFI_PSK_HEX_LENGTH = 64;

export type WifiCredentialsProblem =
  | 'ssid-missing'
  | 'ssid-too-long'
  | 'password-too-short'
  | 'password-too-long'
  | 'control-character';

/**
 * Why a board could not use these credentials, or null when it could. Both
 * daemons refuse `POST /esp32/wifi` with this word (HTTP 400), and the macOS
 * sheet checks the same rule before it sends. A control character is refused
 * outright: NUL separates the fields of the credential id, and the firmware
 * stores C strings.
 */
export function wifiCredentialsProblem(ssid: string, password: string): WifiCredentialsProblem | null {
  if (ssid === '') return 'ssid-missing';
  if (hasControlCharacter(ssid) || hasControlCharacter(password)) return 'control-character';
  if (utf8ByteLength(ssid) > WIFI_SSID_MAX_BYTES) return 'ssid-too-long';
  const passwordBytes = utf8ByteLength(password);
  if (passwordBytes < WIFI_PASSWORD_MIN_BYTES) return 'password-too-short';
  if (passwordBytes > WIFI_PASSPHRASE_MAX_BYTES &&
      !(passwordBytes === WIFI_PSK_HEX_LENGTH && isHexKey(password))) {
    return 'password-too-long';
  }
  return null;
}

/** C0 controls and DEL. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isHexKey(text: string): boolean {
  return /^[0-9A-Fa-f]+$/.test(text);
}

/**
 * How long after the latest provision a board's answer to it may still come.
 * The board answers a provision within about 11 s of starting it (it waits up
 * to 10 s for the join), a little later when something else held it, and it
 * takes provisions one at a time; an answer owed for longer than this was lost
 * (the board reset, or a line was dropped while it was busy joining).
 */
export const WIFI_PROVISION_ACK_TIMEOUT_MS = 30_000;

/**
 * Which provision a `wifi_provision_ack` answers. The board answers one
 * provision at a time, in the order written. Current firmware echoes the
 * provision's `credId` in its ack; older firmware names none, so each serial
 * connection also counts the answers it is owed: an ack that arrives while a
 * later provision is still owed one answers an earlier provision, and must not
 * be shown as the later one's result.
 */
export interface WifiProvisionAckLedger {
  /** Provisions written on this connection whose ack has not come. */
  owed: number;
  /** When the latest was written (epoch ms); 0 = none. */
  lastWriteAt: number;
  /** The latest provision's `credId`; '' = it carried none. */
  latestCredId: string;
}

export const WIFI_PROVISION_ACK_LEDGER_EMPTY: WifiProvisionAckLedger = { owed: 0, lastWriteAt: 0, latestCredId: '' };

/** The ledger after writing a provision carrying `credId` at `now` (epoch ms). */
export function wifiProvisionAckWritten(
  ledger: WifiProvisionAckLedger,
  now: number,
  credId = '',
): WifiProvisionAckLedger {
  const lost = ledger.owed > 0 && now - ledger.lastWriteAt > WIFI_PROVISION_ACK_TIMEOUT_MS;
  return { owed: (lost ? 0 : ledger.owed) + 1, lastWriteAt: now, latestCredId: credId };
}

/**
 * An ack arrived, naming `ackCredId` ('' = none): whether it answers the
 * latest provision, and the ledger after it. When both the ack and the latest
 * provision carry an id, the ids decide; a mismatch answers an earlier
 * provision, and leaves the latest owed. Otherwise the count decides, and an
 * ack nothing was owed for (a provision from before this connection's count
 * began) is taken as the latest answer.
 */
export function wifiProvisionAckAnswered(
  ledger: WifiProvisionAckLedger,
  ackCredId = '',
): { latest: boolean; ledger: WifiProvisionAckLedger } {
  if (ledger.latestCredId !== '' && ackCredId !== '') {
    if (ackCredId === ledger.latestCredId) return { latest: true, ledger: { ...ledger, owed: 0 } };
    return { latest: false, ledger: { ...ledger, owed: ledger.owed > 1 ? ledger.owed - 1 : ledger.owed } };
  }
  if (ledger.owed > 1) return { latest: false, ledger: { ...ledger, owed: ledger.owed - 1 } };
  return { latest: true, ledger: { ...ledger, owed: 0 } };
}
