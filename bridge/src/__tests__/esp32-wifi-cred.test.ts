/**
 * The credential id a `wifi_provision` carries, computed with node:crypto.
 * Replays shared/esp32-wifi-provision-vectors.json, which the shared suite and
 * the Swift (CryptoKit) suite replay too, so the two daemons send the same id.
 */
import { describe, it, expect } from 'vitest';
import vectors from '../../../shared/esp32-wifi-provision-vectors.json';
import { buildWifiProvision, wifiCredId } from '../esp32-wifi-cred.js';

describe('wifiCredId', () => {
  it('replays every credential-id vector', () => {
    expect(vectors.credIds.length).toBeGreaterThan(0);
    for (const v of vectors.credIds) {
      expect(wifiCredId(v.token, v.ssid, v.password), v.name).toBe(v.credId);
    }
  });

  it('is lowercase hex of the shared length', () => {
    const id = wifiCredId(vectors.credIds[0].token, vectors.credIds[0].ssid, vectors.credIds[0].password);
    expect(id).toMatch(new RegExp(`^[0-9a-f]{${vectors.hexLength}}$`));
  });
});

describe('buildWifiProvision', () => {
  const v = vectors.credIds[0];
  const fields = { ssid: v.ssid, password: v.password, bridgeIp: '192.168.1.50', bridgePort: 9120, authToken: v.token };

  it('carries the id of its own credentials and token', () => {
    const msg = buildWifiProvision(fields);
    expect(msg).toEqual({ type: 'wifi_provision', ...fields, credId: v.credId });
  });

  it('derives the id from the token it carries', () => {
    const rotated = vectors.credIds.find((c) => c.name.startsWith('a rotated token'))!;
    expect(buildWifiProvision({ ...fields, authToken: rotated.token }).credId).toBe(rotated.credId);
  });

  it('omits the key when there is no id to offer', () => {
    // A board receiving such a provision clears its stored id.
    expect(buildWifiProvision({ ...fields, authToken: '' })).not.toHaveProperty('credId');
    expect(buildWifiProvision({ ...fields, password: '' })).not.toHaveProperty('credId');
  });
});
