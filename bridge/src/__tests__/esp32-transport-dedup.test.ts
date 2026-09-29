import { describe, expect, it } from 'vitest';
import { isWifiTransportRedundant } from '../daemon-server.js';

// ─── Single-path transport dedup ─────────────────────────────────────────────
// A physical ESP32 can be reachable over both USB serial and WiFi at once
// (plugged in for flashing while still joined to the AP). Serial is preferred,
// so the WiFi copy of display events must be suppressed to avoid double-sending.
// isWifiTransportRedundant decides that, given the WiFi board identity and the
// set of boards currently live on serial.
describe('isWifiTransportRedundant', () => {
  it('dedups when the same board id is live on serial (both report matching IP)', () => {
    expect(isWifiTransportRedundant(
      { board: 'ttgo_t_display', ip: '192.168.68.61' },
      [{ board: 'ttgo_t_display', ip: '192.168.68.61' }],
    )).toBe(true);
  });

  it('dedups by board id alone when serial reports no IP (radio parked / pre-DHCP)', () => {
    expect(isWifiTransportRedundant(
      { board: 'trmnl_75', ip: '192.168.68.64' },
      [{ board: 'trmnl_75' }],
    )).toBe(true);
  });

  it('dedups when the WiFi side has no IP but the board id matches serial', () => {
    expect(isWifiTransportRedundant(
      { board: 'ulanzi_tc001' },
      [{ board: 'ulanzi_tc001', ip: '192.168.68.57' }],
    )).toBe(true);
  });

  it('does NOT dedup a WiFi-only board with no serial presence (86box: USB power-only)', () => {
    expect(isWifiTransportRedundant(
      { board: '86box', ip: '192.168.68.71' },
      [{ board: 'trmnl_75', ip: '192.168.68.64' }, { board: 'ttgo_t_display', ip: '192.168.68.61' }],
    )).toBe(false);
  });

  it('does NOT dedup two distinct physical units of the same model on different IPs', () => {
    expect(isWifiTransportRedundant(
      { board: 'ips_35', ip: '192.168.68.69' },
      [{ board: 'ips_35', ip: '192.168.68.99' }], // a different ips_35 on serial
    )).toBe(false);
  });

  it('never dedups an unresolved/unknown board identity', () => {
    expect(isWifiTransportRedundant(null, [{ board: 'ttgo_t_display' }])).toBe(false);
    expect(isWifiTransportRedundant({ board: 'unknown', ip: '192.168.68.61' }, [{ board: 'unknown' }])).toBe(false);
    expect(isWifiTransportRedundant({ ip: '192.168.68.61' }, [{ board: 'ttgo_t_display' }])).toBe(false);
  });

  it('returns false when nothing is live on serial (WiFi is the only path)', () => {
    expect(isWifiTransportRedundant({ board: 'trmnl_75', ip: '192.168.68.64' }, [])).toBe(false);
  });
});
