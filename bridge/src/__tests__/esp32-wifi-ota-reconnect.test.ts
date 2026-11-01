import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { BridgeCore } from '../bridge-core.js';
import {
  abortWifiEsp32Ota,
  __setOtaTimeoutsForTest,
  __resetWifiEsp32OtaState,
  __wifiOtaTestApi,
} from '../daemon-server.js';

// ─── WiFi OTA reconnect-follow ───────────────────────────────────────────────
// Serial-backtrace diagnosis of the TTGO 2.5MB WiFi OTA proved the board does
// NOT reset/brownout/watchdog mid-transfer: under classic single-core ESP32
// WiFi-flash coexistence the TCP task is briefly starved, the *WebSocket* drops,
// the board survives and re-registers a NEW socket under the same board:ip key
// ~3-4s later. The old sender captured the socket once and streamed into the
// dead one, so the transfer stalled and failed on the chunk-ack timeout. This
// verifies the fix: the sender follows the board to its reconnected socket and
// resends the not-yet-acked chunk (acks route by otaId; the firmware keeps its
// otaRx cursor), so the transfer completes across a mid-flight disconnect. The
// hardware drop is probabilistic, so this reproduces it deterministically.

const KEY_DEVICE = { board: 'ttgo_t_display', ip: '192.168.68.73', version: '0.1.2', otaSupported: true, otaSlotSize: 6291456 };
const CHUNK = 1024;

function fakeWs(): WebSocket {
  // Only readyState is read by the sender's liveSocket() (WebSocket.OPEN === 1).
  return { readyState: 1 } as unknown as WebSocket;
}

function writeFirmware(bytes: number): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ota-fw-'));
  const path = join(dir, 'firmware.bin');
  writeFileSync(path, Buffer.alloc(bytes, 0xab));
  return { dir, path };
}

/**
 * Fake BridgeCore whose wsServer.sendTo drives OTA acks by otaId. `dropSeq`, if
 * set, makes the FIRST chunk with that seq silently vanish on `socketA` (the
 * dropped socket) and simultaneously simulates the board reconnecting on
 * `socketB`; every other frame is acked on whatever socket it was sent to. Acks
 * are deferred (setImmediate) so the sender's waitForOtaAck registers first.
 */
function makeCore(opts: {
  socketA: WebSocket;
  socketB?: WebSocket;
  dropSeq?: number;
  onDrop?: () => void;
}): { core: BridgeCore; sends: Array<{ sock: WebSocket; evt: any }> } {
  const sends: Array<{ sock: WebSocket; evt: any }> = [];
  let dropped = false;
  const ack = (evt: any, stage: string, seq?: number) =>
    setImmediate(() =>
      __wifiOtaTestApi.handleEsp32OtaReply({
        type: 'esp32_ota_ack',
        otaId: evt.otaId,
        stage,
        seq,
        offset: evt.offset ?? 0,
        written: (evt.offset ?? 0) + CHUNK,
      }),
    );
  const sendTo = (sock: WebSocket, evt: any) => {
    sends.push({ sock, evt });
    if (evt.type === 'esp32_ota_begin') return ack(evt, 'begin');
    if (evt.type === 'esp32_ota_end') return ack(evt, 'end');
    if (evt.type === 'esp32_ota_chunk') {
      if (!dropped && opts.dropSeq === evt.seq && sock === opts.socketA) {
        // Socket died right as this chunk was sent — no ack. Simulate the board
        // reconnecting on a fresh socket (same board:ip key).
        dropped = true;
        opts.onDrop?.();
        return;
      }
      return ack(evt, 'chunk', evt.seq);
    }
    // esp32_ota_abort — no ack needed
    return;
  };
  const core = { wsServer: { sendTo } } as unknown as BridgeCore;
  return { core, sends };
}

afterEach(() => __resetWifiEsp32OtaState());

describe('WiFi OTA reconnect-follow', () => {
  it('completes a transfer across a mid-flight WS disconnect by resending on the reconnected socket', async () => {
    __setOtaTimeoutsForTest({ begin: 200, chunk: 50, end: 200, reconnectWait: 1000 });
    const { dir, path } = writeFirmware(8 * CHUNK); // 8 chunks: seq 0..7
    try {
      const socketA = fakeWs();
      const socketB = fakeWs();
      const { core, sends } = makeCore({
        socketA,
        socketB,
        dropSeq: 4,
        onDrop: () => {
          __wifiOtaTestApi.unregisterWifiEsp32Socket(socketA);
          __wifiOtaTestApi.registerWifiEsp32(KEY_DEVICE, socketB);
        },
      });
      __wifiOtaTestApi.registerWifiEsp32(KEY_DEVICE, socketA);

      const res = await __wifiOtaTestApi.performWifiEsp32Ota(core, 'ttgo_t_display', path);

      expect(res.ok).toBe(true);
      expect(res.chunks).toBe(8);
      expect(res.reconnectResends).toBe(1);
      // seq 4 was sent twice: once into the dead socketA, once into socketB.
      const seq4 = sends.filter((s) => s.evt.type === 'esp32_ota_chunk' && s.evt.seq === 4);
      expect(seq4).toHaveLength(2);
      expect(seq4[0].sock).toBe(socketA);
      expect(seq4[1].sock).toBe(socketB);
      // The end frame lands on the reconnected socket.
      expect(sends.find((s) => s.evt.type === 'esp32_ota_end')?.sock).toBe(socketB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast when the board drops mid-OTA and never reconnects', async () => {
    __setOtaTimeoutsForTest({ begin: 200, chunk: 50, end: 200, reconnectWait: 300 });
    const { dir, path } = writeFirmware(8 * CHUNK);
    try {
      const socketA = fakeWs();
      const { core } = makeCore({
        socketA,
        dropSeq: 3,
        onDrop: () => __wifiOtaTestApi.unregisterWifiEsp32Socket(socketA), // gone, no reconnect
      });
      __wifiOtaTestApi.registerWifiEsp32(KEY_DEVICE, socketA);

      await expect(
        __wifiOtaTestApi.performWifiEsp32Ota(core, 'ttgo_t_display', path),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a clean transfer (no disconnect) completes with zero reconnect-resends', async () => {
    __setOtaTimeoutsForTest({ begin: 200, chunk: 50, end: 200, reconnectWait: 1000 });
    const { dir, path } = writeFirmware(5 * CHUNK);
    try {
      const socketA = fakeWs();
      const { core } = makeCore({ socketA });
      __wifiOtaTestApi.registerWifiEsp32(KEY_DEVICE, socketA);

      const res = await __wifiOtaTestApi.performWifiEsp32Ota(core, 'ttgo_t_display', path);
      expect(res.ok).toBe(true);
      expect(res.chunks).toBe(5);
      expect(res.reconnectResends).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Owner replacement invalidates outstanding continuations before sockets close.
it('aborts an in-flight owner and ignores its late ACK before a fresh transfer', async () => {
  __setOtaTimeoutsForTest({ begin: 200, chunk: 100, end: 200, reconnectWait: 300 });
  const { dir, path } = writeFirmware(3 * CHUNK);
  try {
    const socketA = fakeWs();
    const first = makeCore({ socketA, dropSeq: 1, onDrop: () => setImmediate(abortWifiEsp32Ota) });
    __wifiOtaTestApi.registerWifiEsp32(KEY_DEVICE, socketA);
    await expect(__wifiOtaTestApi.performWifiEsp32Ota(first.core, 'ttgo_t_display', path)).rejects.toThrow();
    const oldId = first.sends[0].evt.otaId;
    __wifiOtaTestApi.handleEsp32OtaReply({ type: 'esp32_ota_ack', otaId: oldId, stage: 'chunk', seq: 1 });
    expect(first.sends.filter(s => s.evt.type === 'esp32_ota_abort')).toHaveLength(1);
    expect(first.sends.some(s => s.evt.type === 'esp32_ota_end')).toBe(false);
    const next = makeCore({ socketA });
    expect((await __wifiOtaTestApi.performWifiEsp32Ota(next.core, 'ttgo_t_display', path)).ok).toBe(true);
    expect(next.sends[0].evt.otaId).not.toBe(oldId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('refuses a post-wake ACK whose wall deadline passed before its timer', async () => {
  __setOtaTimeoutsForTest({ begin: 200, chunk: 100, end: 200, reconnectWait: 300 });
  const { dir, path } = writeFirmware(3 * CHUNK);
  try {
    const socketA = fakeWs(); let sends: Array<{ sock: WebSocket; evt: any }>;
    const fixture = makeCore({ socketA, dropSeq: 1, onDrop: () => setImmediate(() => {
      const old = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(old + 1000);
      const frame = sends.find(s => s.evt.type === 'esp32_ota_chunk' && s.evt.seq === 1)!.evt;
      __wifiOtaTestApi.handleEsp32OtaReply({ type: 'esp32_ota_ack', otaId: frame.otaId, stage: 'chunk', seq: 1 });
    }) });
    sends = fixture.sends;
    __wifiOtaTestApi.registerWifiEsp32(KEY_DEVICE, socketA);
    await expect(__wifiOtaTestApi.performWifiEsp32Ota(fixture.core, 'ttgo_t_display', path)).rejects.toThrow('timed out');
    expect(sends.some(s => s.evt.type === 'esp32_ota_end')).toBe(false);
  } finally { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); }
});
