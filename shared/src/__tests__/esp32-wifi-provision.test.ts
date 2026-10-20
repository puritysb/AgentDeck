import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WIFI_CRED_ID_DOMAIN,
  WIFI_CRED_ID_HEX_LENGTH,
  WIFI_PROVISION_ACK_LEDGER_EMPTY,
  WIFI_PROVISION_ACK_TIMEOUT_MS,
  wifiCredIdComputable,
  wifiCredIdMessage,
  wifiCredentialsProblem,
  wifiProvisionAckAnswered,
  wifiProvisionAckWritten,
  wifiProvisionDecision,
  type WifiCredentialsProblem,
  type WifiProvisionAckLedger,
  type WifiProvisionDecision,
  type WifiProvisionInput,
} from '../esp32-wifi-provision.js';

const VECTORS = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../esp32-wifi-provision-vectors.json', import.meta.url)), 'utf8')) as {
  domain: string;
  hexLength: number;
  credIds: Array<{ name: string; token: string; ssid: string; password: string; credId: string | null }>;
  decisionDefaults: WifiProvisionInput;
  decisions: Array<{ name: string; input: Partial<WifiProvisionInput> } & WifiProvisionDecision>;
  credentials: Array<{ name: string; ssid: string; password: string; problem: WifiCredentialsProblem | null }>;
  ackTimeoutMs: number;
  ackLedger: Array<{
    name: string;
    events: Array<{ write: number; credId?: string } | { ack: boolean; ackCredId?: string }>;
    ledger: WifiProvisionAckLedger;
  }>;
};

describe('ESP32 WiFi provision rules (shared vectors)', () => {
  it('names the id the way both HMAC implementations compute it', () => {
    expect(WIFI_CRED_ID_DOMAIN).toBe(VECTORS.domain);
    expect(WIFI_CRED_ID_HEX_LENGTH).toBe(VECTORS.hexLength);
    expect(wifiCredIdMessage('ssid', 'pw')).toBe(`${VECTORS.domain}\u0000ssid\u0000pw`);
  });

  for (const v of VECTORS.credIds) {
    it(`id inputs: ${v.name}`, () => {
      expect(wifiCredIdComputable(v.token, v.ssid, v.password)).toBe(v.credId !== null);
      if (v.credId !== null) expect(v.credId).toMatch(new RegExp(`^[0-9a-f]{${VECTORS.hexLength}}$`));
    });
  }

  it('the separator keeps the SSID/password boundary', () => {
    expect(wifiCredIdMessage('ab', 'c')).not.toBe(wifiCredIdMessage('a', 'bc'));
  });

  for (const v of VECTORS.decisions) {
    it(`decision: ${v.name}`, () => {
      expect(wifiProvisionDecision({ ...VECTORS.decisionDefaults, ...v.input }))
        .toEqual({ send: v.send, reason: v.reason, legacy: v.legacy });
    });
  }

  it('every reason the decision can give is pinned by a vector', () => {
    const reasons = new Set(VECTORS.decisions.map((v) => v.reason));
    for (const reason of [
      'not-connected', 'unidentified', 'already-sent', 'endpoint-refresh', 'wifi-connected',
      'credentials-match', 'credentials-differ', 'legacy-configured', 'legacy-unconfigured',
      'operator-request',
    ]) expect(reasons).toContain(reason);
  });

  for (const v of VECTORS.credentials) {
    it(`credentials: ${v.name}`, () => {
      expect(wifiCredentialsProblem(v.ssid, v.password)).toBe(v.problem);
    });
  }

  it('an ack is owed for the shared timeout', () => {
    expect(WIFI_PROVISION_ACK_TIMEOUT_MS).toBe(VECTORS.ackTimeoutMs);
  });

  for (const v of VECTORS.ackLedger) {
    it(`ack ledger: ${v.name}`, () => {
      let ledger = WIFI_PROVISION_ACK_LEDGER_EMPTY;
      const answered: boolean[] = [];
      const expected: boolean[] = [];
      for (const event of v.events) {
        if ('write' in event) {
          ledger = wifiProvisionAckWritten(ledger, event.write, event.credId);
        } else {
          const answer = wifiProvisionAckAnswered(ledger, event.ackCredId);
          answered.push(answer.latest);
          expected.push(event.ack);
          ledger = answer.ledger;
        }
      }
      expect(answered).toEqual(expected);
      expect(ledger).toEqual(v.ledger);
    });
  }

  it('every credential problem is pinned by a vector', () => {
    const problems = new Set(VECTORS.credentials.map((v) => v.problem));
    for (const problem of [
      null, 'ssid-missing', 'ssid-too-long', 'password-too-short', 'password-too-long', 'control-character',
    ]) expect(problems).toContain(problem);
  });
});
