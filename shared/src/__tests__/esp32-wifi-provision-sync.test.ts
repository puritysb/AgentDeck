// Drift gate for the generated ESP32 WiFi provisioning mirrors
// (shared/src/esp32-wifi-provision.ts → Swift and the firmware header). A hand
// edit to a generated file, or a skipped `pnpm generate-esp32-wifi-provision-rules`,
// fails here. Behaviour stays pinned by shared/esp32-wifi-provision-vectors.json,
// which the shared, bridge and Swift suites replay.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rulesMod from '../esp32-wifi-provision.js';
import { OUTPUTS, rulesFrom } from '../../../scripts/generate-esp32-wifi-provision-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(rulesMod);

describe('generated ESP32 WiFi provision mirrors in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(rules));
    });
  }

  it('emitters embed the SSOT constants', () => {
    const [swift, cpp] = OUTPUTS.map(([, emit]) => emit(rules));
    expect(swift).toContain(`static let credIdDomain = ${JSON.stringify(rulesMod.WIFI_CRED_ID_DOMAIN)}`);
    expect(swift).toContain(`static let credIdHexLength = ${rulesMod.WIFI_CRED_ID_HEX_LENGTH}`);
    expect(swift).toContain(`static let endpointRefreshBoard = ${JSON.stringify(rulesMod.WIFI_PROVISION_ENDPOINT_REFRESH_BOARD)}`);
    expect(swift).toContain(`static let ssidMaxBytes = ${rulesMod.WIFI_SSID_MAX_BYTES}`);
    expect(swift).toContain(`static let passwordMinBytes = ${rulesMod.WIFI_PASSWORD_MIN_BYTES}`);
    expect(swift).toContain(`static let passphraseMaxBytes = ${rulesMod.WIFI_PASSPHRASE_MAX_BYTES}`);
    expect(swift).toContain(`static let pskHexLength = ${rulesMod.WIFI_PSK_HEX_LENGTH}`);
    expect(swift).toContain(`static let ackTimeoutMs = ${rulesMod.WIFI_PROVISION_ACK_TIMEOUT_MS}`);
    expect(cpp).toContain(`constexpr size_t HEX_LENGTH = ${rulesMod.WIFI_CRED_ID_HEX_LENGTH};`);
  });

  it('the Swift suite replays the shared vector file (grep the test wiring)', () => {
    const swiftTest = readFileSync(`${repoRoot}apple/AgentDeckTests/ESP32WifiProvisionRulesTests.swift`, 'utf8');
    expect(swiftTest).toContain('shared/esp32-wifi-provision-vectors.json');
    expect(swiftTest).toContain('ESP32WifiProvisionRules.decision(');
    expect(swiftTest).toContain('ESP32WifiProvisionRules.credId(');
    expect(swiftTest).toContain('ESP32WifiProvisionRules.credentialsProblem(');
    expect(swiftTest).toContain('ESP32WifiProvisionRules.ackWritten(');
    expect(swiftTest).toContain('ESP32WifiProvisionRules.ackAnswered(');
  });

  it('both firmware device_info builders report the stored id', () => {
    // An absent key reads as "firmware predates the field" and sends the
    // daemon to its legacy rule, so new firmware must never omit it.
    for (const rel of ['esp32/src/net/protocol.cpp', 'esp32/src/net/serial_client.cpp']) {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8').includes('resp["wifiCredId"]'), rel).toBe(true);
    }
  });
});
