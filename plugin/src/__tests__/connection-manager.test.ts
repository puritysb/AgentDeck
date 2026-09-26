import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State, PermissionMode, OPENCLAW_CAPABILITIES } from '@agentdeck/shared';
import type { StateUpdateEvent, PluginCommand } from '@agentdeck/shared';

// ---- Mocks ----

// Mock BridgeClient
vi.mock('../bridge-client.js', async () => {
  const { EventEmitter } = await import('events');

  class MockBridgeClient extends EventEmitter {
    _connected = false;
    _port = 9120;
    _portProvider: (() => number | null) | null = null;

    connect(port?: number) {
      if (port != null) this._port = port;
    }
    reconnectTo(port: number) {
      this._port = port;
    }
    disconnect() {
      this._connected = false;
      this.emit('disconnected');
    }
    setPortProvider(provider: (() => number | null) | null) {
      this._portProvider = provider;
    }
    send = vi.fn();
    isConnected() { return this._connected; }
    getCapabilities() { return null; }
    getPort() { return this._port; }

    // Test helpers
    _simulateConnect() {
      this._connected = true;
      this.emit('connected');
    }
    _simulateDisconnect() {
      this._connected = false;
      this.emit('disconnected');
    }
    _simulateStateUpdate(ev: StateUpdateEvent) {
      this.emit('state_update', ev);
    }
  }
  return { BridgeClient: MockBridgeClient };
});

// Mock fs so daemon.json discovery can be driven from the tests.
// `daemonFiles` maps an absolute path → the JSON that file should contain.
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

// Mock logger
vi.mock('../log.js', () => ({
  dlog: vi.fn(),
  dinfo: vi.fn(),
  dwarn: vi.fn(),
  derr: vi.fn(),
  dtrace: vi.fn(),
}));

import os from 'os';
import path from 'path';
import { ConnectionManager } from '../connection-manager.js';

// Helper to access internal mock
function getBridge(cm: ConnectionManager): any {
  return (cm as any).bridge;
}

function makeStateUpdate(state: State, agent?: 'openclaw' | 'claude-code'): StateUpdateEvent {
  return {
    type: 'state_update',
    state,
    permissionMode: PermissionMode.DEFAULT,
    ...(agent === 'openclaw' ? {
      agentType: 'openclaw',
      agentCapabilities: OPENCLAW_CAPABILITIES,
    } : {}),
  };
}

describe('ConnectionManager', () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    cm = new ConnectionManager();
  });

  it('starts disconnected', () => {
    expect(cm.isConnected()).toBe(false);
    expect(cm.getCapabilities()).toBeNull();
  });

  it('start() begins bridge connection to daemon', () => {
    const bridge = getBridge(cm);
    const bridgeConnect = vi.spyOn(bridge, 'connect');

    cm.start();

    expect(bridgeConnect).toHaveBeenCalled();
  });

  it('start() installs a port provider so daemon.json is re-read every attempt', () => {
    const bridge = getBridge(cm);
    cm.start();
    // Provider is wired — BridgeClient will invoke it per attempt.
    // We only verify the wire-up; the actual fs read is exercised in integration tests.
    expect(typeof bridge._portProvider).toBe('function');
  });

  it('emits connected when bridge connects', () => {
    const events: string[] = [];
    cm.on('connected', () => events.push('connected'));

    cm.start();
    getBridge(cm)._simulateConnect();

    expect(cm.isConnected()).toBe(true);
    expect(events).toContain('connected');
  });

  it('emits disconnected when bridge disconnects', () => {
    const events: string[] = [];
    cm.on('disconnected', () => events.push('disconnected'));

    cm.start();
    getBridge(cm)._simulateConnect();
    getBridge(cm)._simulateDisconnect();

    expect(events).toContain('disconnected');
  });

  it('forwards state_update from bridge', () => {
    const received: StateUpdateEvent[] = [];
    cm.on('state_update', (ev: StateUpdateEvent) => received.push(ev));

    cm.start();
    getBridge(cm)._simulateConnect();

    const ev = makeStateUpdate(State.IDLE, 'openclaw');
    getBridge(cm)._simulateStateUpdate(ev);

    expect(received).toHaveLength(1);
    expect(received[0].state).toBe(State.IDLE);
  });

  it('send() delegates to bridge', () => {
    cm.start();
    getBridge(cm)._simulateConnect();

    const cmd: PluginCommand = { type: 'interrupt' };
    cm.send(cmd);

    expect(getBridge(cm).send).toHaveBeenCalledWith(cmd);
  });

  it('send() drops command when not connected', () => {
    const cmd: PluginCommand = { type: 'interrupt' };
    cm.send(cmd);

    expect(getBridge(cm).send).not.toHaveBeenCalled();
  });

  it('getBridgePort returns bridge port', () => {
    expect(cm.getBridgePort()).toBe(9120);
  });

  it('getConnectionSnapshot exposes connection and discovery state', () => {
    const snap = cm.getConnectionSnapshot();

    expect(snap.connected).toBe(false);
    expect(snap.bridgePort).toBe(9120);
    expect(snap.daemonStatus).toBe('unknown');
  });

  it('retryNow probes daemon discovery and reconnects immediately when disconnected', () => {
    const bridge = getBridge(cm);
    const bridgeConnect = vi.spyOn(bridge, 'connect');

    const snap = cm.retryNow();

    expect(bridgeConnect).toHaveBeenCalled();
    expect(snap.lastRetryAt).toBeTypeOf('number');
  });

  // ===== Agent Switching =====

  describe('switchToOpenClaw()', () => {
    it('sends switch_agent command to bridge', () => {
      cm.start();
      getBridge(cm)._simulateConnect();

      cm.switchToOpenClaw();

      expect(getBridge(cm).send).toHaveBeenCalledWith({
        type: 'switch_agent',
        agent: 'openclaw',
      });
    });
  });

  describe('switchToClaude()', () => {
    it('sends switch_agent command to bridge', () => {
      cm.start();
      getBridge(cm)._simulateConnect();

      cm.switchToClaude();

      expect(getBridge(cm).send).toHaveBeenCalledWith({
        type: 'switch_agent',
        agent: 'claude-code',
      });
    });
  });

  // ===== Daemon discovery fallthrough =====
  //
  // Both daemons can be installed: the CLI writes ~/.agentdeck/daemon.json and
  // the App Store app writes inside its sandbox container. A live pid does not
  // prove the port is served, so an unhealthy first candidate must not
  // permanently shadow a healthy second one.

  describe('findDaemonPort() candidate fallthrough', () => {
    const home = os.homedir();
    const cliFile = path.join(home, '.agentdeck', 'daemon.json');
    const swiftFile = path.join(
      home, 'Library', 'Containers', 'bound.serendipity.agent.deck', 'Data',
      'Library', 'Application Support', 'AgentDeck', 'daemon.json',
    );

    beforeEach(() => {
      daemonFiles.clear();
      delete process.env.AGENTDECK_DATA_DIR;
      // Every pid in these fixtures is "alive" — the whole point is that
      // liveness alone is not enough to pick the right daemon.
      vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    });

    it('tries the socket when a daemon PID probe is permission denied', () => {
      daemonFiles.set(cliFile, JSON.stringify({ port: 9120, pid: 1234 }));
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      });
      cm.start();
      expect(cm.getConnectionSnapshot().daemonPort).toBe(9120);
    });

    it('skips a daemon whose PID is confirmed absent', () => {
      daemonFiles.set(cliFile, JSON.stringify({ port: 9120, pid: 1234 }));
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      cm.start();
      expect(cm.getConnectionSnapshot().daemonPort).toBeNull();
    });

    it.each([
      { port: 9120, pid: 0 }, { port: 9120, pid: -1 },
      { port: 9120, pid: '1234' }, { port: 65536, pid: 1234 },
      { port: 0, pid: 1234 }, { port: '9120', pid: 1234 },
    ])('rejects malformed daemon identity %j before probing', info => {
      daemonFiles.set(cliFile, JSON.stringify(info));
      vi.mocked(process.kill).mockClear();
      cm.start();
      expect(cm.getConnectionSnapshot().daemonPort).toBeNull();
      expect(process.kill).not.toHaveBeenCalled();
    });

    it('prefers the CLI daemon when it is healthy', () => {
      daemonFiles.set(cliFile, JSON.stringify({ port: 9120, pid: 1234 }));
      daemonFiles.set(swiftFile, JSON.stringify({ port: 9130, pid: 5678 }));

      cm.start();
      expect(cm.getConnectionSnapshot().daemonPort).toBe(9120);
    });

    it('falls through to the Swift daemon after the CLI port fails', () => {
      daemonFiles.set(cliFile, JSON.stringify({ port: 9120, pid: 1234 }));
      daemonFiles.set(swiftFile, JSON.stringify({ port: 9130, pid: 5678 }));

      cm.start();
      expect(cm.getConnectionSnapshot().daemonPort).toBe(9120);

      // The CLI endpoint drops — its pid is still alive, so without the
      // quarantine discovery would hand back 9120 forever.
      (cm.bridge as any)._simulateDisconnect();
      expect(cm.retryNow().daemonPort).toBe(9130);
    });

    it('falls through after an initial handshake failure without a prior connection', () => {
      daemonFiles.set(cliFile, JSON.stringify({ port: 9120, pid: 1234 }));
      daemonFiles.set(swiftFile, JSON.stringify({ port: 9130, pid: 5678 }));
      cm.start();
      cm.bridge.emit('connection-attempt-failed', 9120);
      expect(cm.isConnected()).toBe(false);
      expect(cm.retryNow().daemonPort).toBe(9130);
    });

    it('reports the daemon as found even when every candidate has failed', () => {
      daemonFiles.set(cliFile, JSON.stringify({ port: 9120, pid: 1234 }));
      daemonFiles.set(swiftFile, JSON.stringify({ port: 9130, pid: 5678 }));

      cm.start();
      (cm.bridge as any)._simulateDisconnect();   // quarantines 9120
      cm.retryNow();
      (cm.bridge as any)._simulateDisconnect();   // quarantines 9130
      const snap = cm.retryNow();

      // Quarantine self-clears rather than degrading to "missing" while both
      // daemons are demonstrably running.
      expect(snap.daemonStatus).toBe('found');
      expect([9120, 9130]).toContain(snap.daemonPort);
    });

    it('reports missing when no daemon.json exists', () => {
      cm.start();
      const snap = cm.getConnectionSnapshot();
      expect(snap.daemonStatus).toBe('missing');
      expect(snap.daemonPort).toBeNull();
    });
  });
});
