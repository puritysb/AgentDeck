import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { __resetWifiEsp32OtaState, __wifiOtaTestApi } from '../daemon-server.js';
import { handleSerialLine, type SerialConnection } from '../esp32-serial.js';

// A board reports the same device_info over USB serial and over its WiFi
// WebSocket, and the daemon keeps one registry per transport. The WiFi one
// once dropped the t_embed battery fields for a day, and it never carried the
// heap fields at all, so a WiFi-only board's heap could not be read anywhere.
// The failure counter is the one field that tells a heap at 0 KB from an
// allocation that failed, so both registries must carry it, explicit 0
// included.

const HEAP_FIELDS = [
  'freeHeapKb', 'minFreeHeapKb', 'largestFreeBlockKb',
  'allocFailures', 'allocFailLastBytes', 'allocFailLastCaps',
] as const;

const report = {
  type: 'device_info', board: 'ips_35', version: '1.9.2', ip: '192.168.68.70',
  wifiConfigured: true, wifiConnected: true,
  freeHeapKb: 63, minFreeHeapKb: 0, largestFreeBlockKb: 21,
  allocFailures: 2, allocFailLastBytes: 1664, allocFailLastCaps: 2052,
};

function serialConn(): SerialConnection {
  return {
    port: '/dev/cu.usbmodem-test', fd: null,
    stream: { destroyed: false, writable: true, write: () => true } as never,
    reader: null, readBuf: '', connected: true, deviceInfo: null, deviceInfoFresh: false,
    provisionSent: false, connectedAt: Date.now(), lastReadAt: Date.now(), lastWriteAt: Date.now(),
    lastDeviceInfoRequestAt: 0, deviceInfoRequestsSent: 0, writeQueue: [], writeTimer: null,
  } as SerialConnection;
}

function viaWifi(d: Record<string, unknown>): Record<string, unknown> {
  __wifiOtaTestApi.registerWifiEsp32(d, { readyState: 1 } as unknown as WebSocket);
  return __wifiOtaTestApi.listWifiEsp32Devices()[0] as unknown as Record<string, unknown>;
}

function viaSerial(d: Record<string, unknown>): Record<string, unknown> {
  const conn = serialConn();
  handleSerialLine(conn, JSON.stringify(d));
  return conn.deviceInfo as unknown as Record<string, unknown>;
}

describe('ESP32 heap fields reach both device registries', () => {
  afterEach(() => __resetWifiEsp32OtaState());

  it('carries every heap field over serial and over WiFi', () => {
    const wifi = viaWifi(report);
    const serial = viaSerial(report);
    for (const field of HEAP_FIELDS) {
      expect(wifi[field], `wifi ${field}`).toBe(report[field]);
      expect(serial[field], `serial ${field}`).toBe(report[field]);
    }
  });

  it('keeps an explicit zero failure count, which absent firmware cannot send', () => {
    const zero = { ...report, allocFailures: 0, allocFailLastBytes: undefined, allocFailLastCaps: undefined };
    expect(viaWifi(zero).allocFailures).toBe(0);
    expect(viaSerial(zero).allocFailures).toBe(0);
    __resetWifiEsp32OtaState();
    const old = { ...zero, allocFailures: undefined };
    expect(viaWifi(old).allocFailures).toBeUndefined();
    expect(viaSerial(old).allocFailures).toBeUndefined();
  });
});
