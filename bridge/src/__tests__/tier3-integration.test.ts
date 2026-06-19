/**
 * Tier 3 integration tests: mDNS recovery, Display sleep/wake, Voice transcription.
 *
 * These test less-frequently-broken subsystems but cover real production bugs:
 * - mDNS crash recovery after sleep/wake (EADDRNOTAVAIL)
 * - Display state broadcast to all clients
 * - Voice transcription endpoint with silence detection
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import { HookServer } from '../hook-server.js';
import { WsServer } from '../ws-server.js';
import { DisplayMonitor } from '../display-monitor.js';
import { WsTestClient } from './helpers/ws-test-client.js';
import { invalidateMdnsInstance, isNonFatalMdnsError } from '../mdns.js';
import type { BridgeEvent, DisplayStateEvent } from '../types.js';

// ─── mDNS crash recovery ────────────────────────────────────────────

describe('mDNS crash recovery', () => {
  it('invalidateMdnsInstance does not throw when no instance exists', () => {
    // Should be safe to call multiple times even with no active mDNS
    expect(() => invalidateMdnsInstance()).not.toThrow();
    expect(() => invalidateMdnsInstance()).not.toThrow();
  });

  it('isNonFatalMdnsError matches recoverable mDNS multicast failures', () => {
    // These are the errors bridge-core.ts uncaughtException handler must tolerate.
    const recoverableErrors: Array<[string, string?]> = [
      ['bind EADDRNOTAVAIL 224.0.0.251:5353', 'EADDRNOTAVAIL'],
      ['address already in use on the network'],
      ['EADDRNOTAVAIL: address not available 0.0.0.0:5353', 'EADDRNOTAVAIL'],
      // Windows WSL/Hyper-V virtual interface has no route to the mDNS group —
      // bonjour-service throws this async on every daemon start (regression repro).
      ['send EHOSTUNREACH 224.0.0.251:5353', 'EHOSTUNREACH'],
      ['send ENETUNREACH 224.0.0.251:5353', 'ENETUNREACH'],
      ['send EHOSTUNREACH ff02::fb:5353', 'EHOSTUNREACH'],
    ];

    for (const [msg, code] of recoverableErrors) {
      expect(isNonFatalMdnsError(msg, code)).toBe(true);
    }
  });

  it('isNonFatalMdnsError does NOT match unrelated fatal errors', () => {
    const fatalErrors: Array<[string, string?]> = [
      ['EACCES: permission denied', 'EACCES'],
      ['ECONNREFUSED 127.0.0.1:9120', 'ECONNREFUSED'],
      ['TypeError: Cannot read property of null'],
      ['EADDRNOTAVAIL 0.0.0.0:9120', 'EADDRNOTAVAIL'], // Not the mDNS endpoint
      // EHOSTUNREACH to a real peer (not the multicast group) must still crash.
      ['connect EHOSTUNREACH 10.0.0.5:443', 'EHOSTUNREACH'],
    ];

    for (const [msg, code] of fatalErrors) {
      expect(isNonFatalMdnsError(msg, code)).toBe(false);
    }
  });
});

// ─── Display sleep/wake broadcast ───────────────────────────────────

describe('Display sleep/wake broadcast', () => {
  it('DisplayMonitor initial state is ON', () => {
    const monitor = new DisplayMonitor();
    expect(monitor.isDisplayOn()).toBe(true);
    monitor.stop(); // Clean up without starting
  });

  it('display_state event has correct shape', () => {
    const event: DisplayStateEvent = { type: 'display_state', displayOn: true };
    expect(event.type).toBe('display_state');
    expect(typeof event.displayOn).toBe('boolean');

    const asleepEvent: DisplayStateEvent = { type: 'display_state', displayOn: false };
    expect(asleepEvent.displayOn).toBe(false);
  });

  it('display_state broadcasts to WS clients', async () => {
    const hookServer = new HookServer();
    await hookServer.listen(0);
    const addr = hookServer.getServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const wsServer = new WsServer(hookServer.getServer());
    const client = new WsTestClient();
    await client.connect(`ws://127.0.0.1:${port}`);

    try {
      await new Promise((r) => setTimeout(r, 50));

      // Simulate display state change broadcast
      const displayEvent: BridgeEvent = { type: 'display_state', displayOn: false };
      wsServer.broadcast(displayEvent);

      const evt = await client.waitForType('display_state');
      expect((evt as DisplayStateEvent).displayOn).toBe(false);

      // Wake
      client.clear();
      wsServer.broadcast({ type: 'display_state', displayOn: true } as BridgeEvent);

      const wakeEvt = await client.waitForType('display_state');
      expect((wakeEvt as DisplayStateEvent).displayOn).toBe(true);
    } finally {
      await client.close();
      wsServer.close();
      await hookServer.close();
    }
  });

  it('display_state broadcasts to multiple clients', async () => {
    const hookServer = new HookServer();
    await hookServer.listen(0);
    const addr = hookServer.getServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const wsServer = new WsServer(hookServer.getServer());
    const client1 = new WsTestClient();
    const client2 = new WsTestClient();
    await client1.connect(`ws://127.0.0.1:${port}`);
    await client2.connect(`ws://127.0.0.1:${port}`);

    try {
      await new Promise((r) => setTimeout(r, 50));

      wsServer.broadcast({ type: 'display_state', displayOn: false } as BridgeEvent);

      const [evt1, evt2] = await Promise.all([
        client1.waitForType('display_state'),
        client2.waitForType('display_state'),
      ]);

      expect((evt1 as DisplayStateEvent).displayOn).toBe(false);
      expect((evt2 as DisplayStateEvent).displayOn).toBe(false);
    } finally {
      await client1.close();
      await client2.close();
      wsServer.close();
      await hookServer.close();
    }
  });

  it('SSE also receives display_state', async () => {
    const hookServer = new HookServer();
    await hookServer.listen(0);
    const addr = hookServer.getServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const sseEvents: string[] = [];
      const controller = new AbortController();

      const ssePromise = fetch(`http://127.0.0.1:${port}/sse`, { signal: controller.signal })
        .then(async (res) => {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value);
              if (text.includes('event: display_state')) {
                sseEvents.push('display_state');
                controller.abort();
              }
            }
          } catch { /* AbortError */ }
        })
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 50));

      hookServer.broadcastSse({ type: 'display_state', displayOn: false } as BridgeEvent);

      await Promise.race([ssePromise, new Promise((r) => setTimeout(r, 2000))]);

      expect(sseEvents).toContain('display_state');
    } finally {
      await hookServer.close();
    }
  });
});

// ─── Voice transcription endpoint ───────────────────────────────────

describe('Voice transcription endpoint', () => {
  let hookServer: HookServer;
  let port: number;

  beforeEach(async () => {
    hookServer = new HookServer();
    await hookServer.listen(0);
    const addr = hookServer.getServer().address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await hookServer.close();
  });

  it('returns 503 when no voice manager is set', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(200), // Minimal WAV-like data
    });

    expect(res.status).toBe(503);
    const json = await res.json() as any;
    expect(json.error).toContain('Voice manager not available');
  });

  it('returns 400 for empty audio data', async () => {
    // Set a dummy voice manager
    hookServer.setVoiceManager({
      transcribeFile: async () => 'hello',
    } as any);

    const res = await fetch(`http://127.0.0.1:${port}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(10), // Too short
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toContain('too short');
  });

  it('returns transcription from voice manager', async () => {
    hookServer.setVoiceManager({
      transcribeFile: async () => 'go on and fix the bug',
    } as any);

    // Create a minimal WAV-like buffer (>100 bytes)
    const wavData = Buffer.alloc(200);
    // RIFF header
    wavData.write('RIFF', 0);
    wavData.writeUInt32LE(192, 4);
    wavData.write('WAVE', 8);

    const res = await fetch(`http://127.0.0.1:${port}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: wavData,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.text).toBe('go on and fix the bug');
  });

  it('returns 500 when voice manager throws', async () => {
    hookServer.setVoiceManager({
      transcribeFile: async () => { throw new Error('whisper not found'); },
    } as any);

    const wavData = Buffer.alloc(200);
    wavData.write('RIFF', 0);

    const res = await fetch(`http://127.0.0.1:${port}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: wavData,
    });

    expect(res.status).toBe(500);
    const json = await res.json() as any;
    expect(json.error).toContain('whisper not found');
  });
});

// ─── WS broadcast hook (serial relay) ───────────────────────────────

describe('WsServer broadcast hooks (serial relay)', () => {
  it('onBroadcast hook receives all broadcast events', async () => {
    const hookServer = new HookServer();
    await hookServer.listen(0);
    const addr = hookServer.getServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const wsServer = new WsServer(hookServer.getServer());
    const relayed: BridgeEvent[] = [];

    // Register broadcast hook (like ESP32 serial relay does)
    wsServer.onBroadcast((evt) => relayed.push(evt));

    try {
      wsServer.broadcast({ type: 'display_state', displayOn: true } as BridgeEvent);
      wsServer.broadcast({ type: 'state_update', state: 'idle', permissionMode: 'default' } as BridgeEvent);

      expect(relayed).toHaveLength(2);
      expect(relayed[0].type).toBe('display_state');
      expect(relayed[1].type).toBe('state_update');
    } finally {
      wsServer.close();
      await hookServer.close();
    }
  });

  it('broadcast hook errors do not crash server', async () => {
    const hookServer = new HookServer();
    await hookServer.listen(0);
    const addr = hookServer.getServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const wsServer = new WsServer(hookServer.getServer());

    // Register a hook that throws
    wsServer.onBroadcast(() => { throw new Error('serial write failed'); });

    try {
      // Should not throw — errors are caught (best-effort relay)
      expect(() => {
        wsServer.broadcast({ type: 'display_state', displayOn: true } as BridgeEvent);
      }).not.toThrow();
    } finally {
      wsServer.close();
      await hookServer.close();
    }
  });
});
