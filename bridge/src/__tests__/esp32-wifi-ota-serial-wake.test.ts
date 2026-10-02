import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { BridgeCore } from '../bridge-core.js';

// A board the daemon drives over USB parks its WiFi radio, so a WiFi OTA found
// "No online WiFi ESP32 target" for it (TRMNL 7.5", 2026-10-03). The daemon now
// closes that one board's serial port, waits for it to join WiFi, transfers,
// and reopens the port afterwards.

const serial = vi.hoisted(() => ({
  hold: vi.fn<(matches: (board: string) => boolean, ms: number, reason: string) => string | null>(),
  release: vi.fn<(port: string) => void>(),
}));
vi.mock('../esp32-serial.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../esp32-serial.js')>()),
  holdESP32SerialBoard: serial.hold,
  releaseESP32SerialHold: serial.release,
}));

const { __setOtaTimeoutsForTest, __resetWifiEsp32OtaState, __wifiOtaTestApi } = await import('../daemon-server.js');

const DEVICE = { board: 'trmnl_75', ip: '192.168.68.62', version: '1.6.0', otaSupported: true, otaSlotSize: 3_342_336 };
const CHUNK = 1024;
const PORT = '/dev/cu.usbmodem1CDBD474F4D81';

function writeFirmware(bytes: number): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ota-wake-'));
  const path = join(dir, 'firmware.bin');
  writeFileSync(path, Buffer.alloc(bytes, 0xcd));
  return { dir, path };
}

function ackingCore(): BridgeCore {
  const ack = (evt: any, stage: string, seq?: number) =>
    setImmediate(() => __wifiOtaTestApi.handleEsp32OtaReply({
      type: 'esp32_ota_ack', otaId: evt.otaId, stage, seq, offset: evt.offset ?? 0, written: (evt.offset ?? 0) + CHUNK,
    }));
  const sendTo = (_sock: WebSocket, evt: any) => {
    if (evt.type === 'esp32_ota_begin') ack(evt, 'begin');
    else if (evt.type === 'esp32_ota_end') ack(evt, 'end');
    else if (evt.type === 'esp32_ota_chunk') ack(evt, 'chunk', evt.seq);
  };
  return { wsServer: { sendTo } } as unknown as BridgeCore;
}

const liveWs = () => ({ readyState: 1 }) as unknown as WebSocket;

beforeEach(() => {
  serial.hold.mockReset();
  serial.release.mockReset();
  __setOtaTimeoutsForTest({ begin: 200, chunk: 200, end: 200, reconnectWait: 300, serialWakeWait: 2000 });
});
afterEach(() => __resetWifiEsp32OtaState());

describe('WiFi OTA to a board parked on USB serial', () => {
  it('releases only that board, waits for it on WiFi, transfers, then reopens the port', async () => {
    const { dir, path } = writeFirmware(4 * CHUNK);
    try {
      serial.hold.mockImplementation((matches) => {
        if (!matches('trmnl_75')) return null;
        // The board times serial out and rejoins WiFi a moment later.
        setTimeout(() => __wifiOtaTestApi.registerWifiEsp32(DEVICE, liveWs()), 50);
        return PORT;
      });

      const res = await __wifiOtaTestApi.performWifiEsp32Ota(ackingCore(), 'trmnl_75', path);

      expect(res.ok).toBe(true);
      expect(serial.hold).toHaveBeenCalledTimes(1);
      const [matches] = serial.hold.mock.calls[0];
      expect(matches('ttgo_t_display')).toBe(false);
      expect(serial.release).toHaveBeenCalledWith(PORT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports that the board never joined WiFi and reopens its port', async () => {
    const { dir, path } = writeFirmware(CHUNK);
    try {
      __setOtaTimeoutsForTest({ serialWakeWait: 300 });
      serial.hold.mockReturnValue(PORT);

      await expect(__wifiOtaTestApi.performWifiEsp32Ota(ackingCore(), 'trmnl_75', path))
        .rejects.toThrow(/did not join WiFi/);
      expect(serial.release).toHaveBeenCalledWith(PORT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves serial alone when the board is already live on WiFi', async () => {
    const { dir, path } = writeFirmware(2 * CHUNK);
    try {
      __wifiOtaTestApi.registerWifiEsp32(DEVICE, liveWs());
      const res = await __wifiOtaTestApi.performWifiEsp32Ota(ackingCore(), 'trmnl_75', path);
      expect(res.ok).toBe(true);
      expect(serial.hold).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the original error when the board is on neither transport', async () => {
    const { dir, path } = writeFirmware(CHUNK);
    try {
      serial.hold.mockReturnValue(null);
      await expect(__wifiOtaTestApi.performWifiEsp32Ota(ackingCore(), 'trmnl_75', path))
        .rejects.toThrow(/No online WiFi ESP32 target/);
      expect(serial.release).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
