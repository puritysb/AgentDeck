/**
 * The credential id a `wifi_provision` carries, and the one way this daemon
 * builds that message. The rules (domain string, length, when there is no id,
 * when a board is sent one) are in shared/src/esp32-wifi-provision.ts; the
 * HMAC lives here because shared must stay importable in a browser.
 */
import { createHmac } from 'node:crypto';
import { WIFI_CRED_ID_HEX_LENGTH, wifiCredIdComputable, wifiCredIdMessage } from '@agentdeck/shared';
import type { WifiProvisionMessage } from '@agentdeck/shared/protocol';

/**
 * First {@link WIFI_CRED_ID_HEX_LENGTH} hex characters of HMAC-SHA256 keyed by
 * the pairing token, over `domain NUL ssid NUL password` (UTF-8). null when any
 * input is empty: such a provision carries no id.
 */
export function wifiCredId(authToken: string, ssid: string, password: string): string | null {
  if (!wifiCredIdComputable(authToken, ssid, password)) return null;
  return createHmac('sha256', Buffer.from(authToken, 'utf8'))
    .update(Buffer.from(wifiCredIdMessage(ssid, password), 'utf8'))
    .digest('hex')
    .slice(0, WIFI_CRED_ID_HEX_LENGTH);
}

/**
 * Build a provision for one send. The id comes from the token placed in the
 * same message, so the two cannot disagree: a board stores the id beside
 * exactly the credentials and token that produced it. Build it at send time,
 * not once at startup — the token can change under a running daemon.
 */
export function buildWifiProvision(fields: Omit<WifiProvisionMessage, 'type' | 'credId'>): WifiProvisionMessage {
  const credId = wifiCredId(fields.authToken, fields.ssid, fields.password);
  return {
    type: 'wifi_provision',
    ssid: fields.ssid,
    password: fields.password,
    bridgeIp: fields.bridgeIp,
    bridgePort: fields.bridgePort,
    authToken: fields.authToken,
    ...(credId ? { credId } : {}),
  };
}
