import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import type { ConnectionSnapshot } from '../connection-manager.js';
import { ConnectionManager } from '../connection-manager.js';
import {
  buildConnectionStatusPayload,
  isRetryNowMessage,
  isRequestConnectionStatusMessage,
  CONNECTION_STATUS_EVENT,
  RETRY_CONNECTION_EVENT,
  REQUEST_CONNECTION_STATUS_EVENT,
} from '../connection-status-pi.js';

// ---- Mocks for the retry round-trip section below (mirrors
// connection-manager.test.ts's daemon.json discovery fixtures) ----

vi.mock('../bridge-client.js', async () => {
  const { EventEmitter } = await import('events');
  class MockBridgeClient extends EventEmitter {
    _connected = false;
    _port = 9120;
    connect(port?: number) { if (port != null) this._port = port; }
    reconnectTo(port: number) { this._port = port; }
    disconnect() { this._connected = false; this.emit('disconnected'); }
    setPortProvider() {}
    send = vi.fn();
    isConnected() { return this._connected; }
    getCapabilities() { return null; }
    getPort() { return this._port; }
  }
  return { BridgeClient: MockBridgeClient };
});

const daemonFiles = new Map<string, string>();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: (path: any, ...rest: any[]) => {
      const key = String(path);
      if (key.endsWith('daemon.json')) {
        const hit = [...daemonFiles.entries()].find(([f]) => key === f);
        if (!hit) throw new Error(`ENOENT: ${key}`);
        return hit[1];
      }
      return (actual.readFileSync as any)(path, ...rest);
    },
  };
});

vi.mock('../log.js', () => ({
  dlog: vi.fn(), dinfo: vi.fn(), dwarn: vi.fn(), derr: vi.fn(), dtrace: vi.fn(),
}));

function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    connected: false,
    bridgePort: 9120,
    daemonPort: null,
    daemonStatus: 'unknown',
    lastProbeAt: 0,
    lastRetryAt: null,
    message: '',
    ...overrides,
  };
}

describe('buildConnectionStatusPayload — snapshot -> PI payload mapping', () => {
  it('never probed yet: unknown status, no path, no port, no probe time', () => {
    const payload = buildConnectionStatusPayload(snapshot());

    expect(payload).toEqual({
      event: CONNECTION_STATUS_EVENT,
      connected: false,
      daemonStatusLabel: 'Not probed yet',
      daemonPath: '—',
      port: null,
      lastProbeAt: null,
      lastRetryAt: null,
    });
  });

  it('daemon.json not found: missing status, plain-words path, still no port', () => {
    const payload = buildConnectionStatusPayload(snapshot({
      daemonStatus: 'missing',
      message: 'daemon.json not found',
      lastProbeAt: 1_000,
    }));

    expect(payload.daemonStatusLabel).toBe('Daemon not found');
    expect(payload.daemonPath).toBe('not found');
    expect(payload.port).toBeNull();
    expect(payload.lastProbeAt).toBe(1_000);
  });

  it('daemon found but not yet connected: shows the DISCOVERED port and resolved path', () => {
    const payload = buildConnectionStatusPayload(snapshot({
      connected: false,
      daemonStatus: 'found',
      daemonPort: 9130,
      bridgePort: 9120, // stale target from a previous attempt — must not leak through
      message: '/Users/x/.agentdeck/daemon.json',
      lastProbeAt: 2_000,
    }));

    expect(payload.connected).toBe(false);
    expect(payload.daemonStatusLabel).toBe('Daemon found');
    expect(payload.daemonPath).toBe('/Users/x/.agentdeck/daemon.json');
    expect(payload.port).toBe(9130);
  });

  it('connected: shows the LIVE bridge port, not the (possibly stale) discovery candidate', () => {
    const payload = buildConnectionStatusPayload(snapshot({
      connected: true,
      daemonStatus: 'found',
      daemonPort: 9130,
      bridgePort: 9120,
      message: '/Users/x/.agentdeck/daemon.json',
    }));

    expect(payload.connected).toBe(true);
    expect(payload.port).toBe(9120);
  });

  it('carries lastRetryAt through untouched, including null', () => {
    expect(buildConnectionStatusPayload(snapshot({ lastRetryAt: null })).lastRetryAt).toBeNull();
    expect(buildConnectionStatusPayload(snapshot({ lastRetryAt: 5_000 })).lastRetryAt).toBe(5_000);
  });

  it('a zero/negative port never renders as a real port', () => {
    const payload = buildConnectionStatusPayload(snapshot({
      connected: true,
      bridgePort: 0,
    }));
    expect(payload.port).toBeNull();
  });
});

describe('inbound PI message recognition', () => {
  it('isRetryNowMessage matches only the retryNow event', () => {
    expect(isRetryNowMessage({ event: RETRY_CONNECTION_EVENT })).toBe(true);
    expect(isRetryNowMessage({ event: REQUEST_CONNECTION_STATUS_EVENT })).toBe(false);
    expect(isRetryNowMessage({ event: 'somethingElse' })).toBe(false);
    expect(isRetryNowMessage(null)).toBe(false);
    expect(isRetryNowMessage(undefined)).toBe(false);
    expect(isRetryNowMessage('retryNow')).toBe(false); // not an object
  });

  it('isRequestConnectionStatusMessage matches only the requestConnectionStatus event', () => {
    expect(isRequestConnectionStatusMessage({ event: REQUEST_CONNECTION_STATUS_EVENT })).toBe(true);
    expect(isRequestConnectionStatusMessage({ event: RETRY_CONNECTION_EVENT })).toBe(false);
    expect(isRequestConnectionStatusMessage(null)).toBe(false);
  });
});

// ---- Retry round-trip ----
//
// This is what plugin.ts's onSendToPlugin handler does on a `retryNow`
// message, without pulling in the whole @elgato/streamdeck SDK: recognize
// the PI's message, drive the real ConnectionManager, and rebuild the PI
// payload from whatever it returns. The point of the test is that a retry
// which changes discovery's answer is actually visible in the next payload
// — not just that retryNow() was called.
describe('retry round-trip: PI message -> ConnectionManager.retryNow() -> payload', () => {
  const home = os.homedir();
  const cliDaemonFile = path.join(home, '.agentdeck', 'daemon.json');

  beforeEach(() => {
    daemonFiles.clear();
    delete process.env.AGENTDECK_DATA_DIR;
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
  });

  it('before any daemon.json exists: payload reports "not found"', () => {
    const cm = new ConnectionManager();
    const payload = buildConnectionStatusPayload(cm.getConnectionSnapshot());
    expect(payload.daemonStatusLabel).toBe('Not probed yet');
  });

  it('a retryNow message from the PI drives discovery, and the rebuilt payload reflects the new answer', () => {
    const cm = new ConnectionManager();
    cm.start();

    // Simulate what the PI's "requestConnectionStatus" push would have shown
    // before the daemon existed.
    const before = buildConnectionStatusPayload(cm.getConnectionSnapshot());
    expect(before.daemonStatusLabel).toBe('Daemon not found');
    expect(before.port).toBeNull();

    // The daemon now exists — this is the fact retryNow() is supposed to pick up.
    daemonFiles.set(cliDaemonFile, JSON.stringify({ port: 9120, pid: 4242 }));

    // Exactly the inbound message plugin.ts's onSendToPlugin recognizes.
    const inbound = { event: 'retryNow' };
    expect(isRetryNowMessage(inbound)).toBe(true);

    cm.retryNow();
    const after = buildConnectionStatusPayload(cm.getConnectionSnapshot());

    expect(after.daemonStatusLabel).toBe('Daemon found');
    expect(after.daemonPath).toBe(cliDaemonFile);
    expect(after.port).toBe(9120);
    expect(after.lastRetryAt).toEqual(expect.any(Number));
  });

  it('a non-retry message must not be treated as a retry', () => {
    const inbound = { event: 'requestConnectionStatus' };
    expect(isRetryNowMessage(inbound)).toBe(false);
  });
});
