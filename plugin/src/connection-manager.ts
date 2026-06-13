/**
 * ConnectionManager — daemon-only connection.
 *
 * The plugin connects exclusively to the daemon (port from daemon.json).
 * All session/agent interaction goes through daemon commands.
 * If daemon is not running, plugin shows disconnected state.
 */
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  PluginCommand,
  AgentCapabilities,
} from '@agentdeck/shared';
import type { BridgeEvent } from '@agentdeck/shared';
import type { AgentLink } from './agent-link.js';
import { BridgeClient } from './bridge-client.js';
import { dlog, dinfo, dwarn } from './log.js';

const TAG = 'ConnMgr';

export interface ConnectionSnapshot {
  connected: boolean;
  bridgePort: number;
  daemonPort: number | null;
  daemonStatus: 'found' | 'missing' | 'unknown';
  lastProbeAt: number;
  lastRetryAt: number | null;
  message: string;
}

/** Events forwarded from the bridge */
const FORWARDED_EVENTS = [
  'state_update',
  'prompt_options',
  'usage_update',
  'connection',
  'user_prompt',
  'voice_state',
  'timeline_event',
  'timeline_history',
  'display_state',
  'voice_assistant_state',
  'sessions_list',
] as const;

export class ConnectionManager extends EventEmitter implements AgentLink {
  readonly bridge: BridgeClient;
  private started = false;
  private gatewayAvailable = false;
  private lastDaemonPort: number | null = null;
  private daemonStatus: ConnectionSnapshot['daemonStatus'] = 'unknown';
  private lastProbeAt = 0;
  private lastRetryAt: number | null = null;
  private discoveryMessage = '';

  constructor() {
    super();
    this.bridge = new BridgeClient();
    this.setupBridgeListeners();
  }

  // ===== AgentLink interface =====

  send(command: PluginCommand): void {
    dlog(TAG, `send(${command.type}): bridge=${this.bridge.isConnected()}`);
    if (this.bridge.isConnected()) {
      this.bridge.send(command);
    } else {
      dwarn(TAG, `send(${command.type}) dropped — not connected`);
    }
  }

  isConnected(): boolean {
    return this.bridge.isConnected();
  }

  getCapabilities(): AgentCapabilities | null {
    return this.bridge.getCapabilities();
  }

  disconnect(): void {
    this.bridge.disconnect();
  }

  // ===== Public API =====

  /**
   * Start daemon-only connection.
   *
   * The BridgeClient resolves the target port via the installed provider on
   * every reconnect attempt, so a stale daemon.json, dead pid, or port drift
   * is picked up without restarting the plugin. If the provider returns null
   * we stay in a silent offline state (backoff-throttled retries) until the
   * daemon comes back.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.bridge.setPortProvider(() => this.findDaemonPort());
    const initial = this.findDaemonPort();
    dinfo(TAG, `start(daemon port=${initial ?? 'not found'})`);
    this.bridge.connect(initial ?? undefined);
  }

  /** Get current bridge port. */
  getBridgePort(): number {
    return this.bridge.getPort();
  }

  getConnectionSnapshot(): ConnectionSnapshot {
    return {
      connected: this.bridge.isConnected(),
      bridgePort: this.bridge.getPort(),
      daemonPort: this.lastDaemonPort,
      daemonStatus: this.daemonStatus,
      lastProbeAt: this.lastProbeAt,
      lastRetryAt: this.lastRetryAt,
      message: this.discoveryMessage,
    };
  }

  retryNow(): ConnectionSnapshot {
    this.lastRetryAt = Date.now();
    const port = this.findDaemonPort();
    if (!this.bridge.isConnected()) {
      this.bridge.connect(port ?? undefined);
    }
    return this.getConnectionSnapshot();
  }

  // ===== Agent/Session Commands (all via daemon) =====

  /**
   * Focus a specific session via daemon command.
   * Daemon will relay state_update for the focused session.
   */
  focusSession(sessionId: string): void {
    dinfo(TAG, `focusSession(${sessionId})`);
    this.bridge.send({ type: 'focus_session', sessionId } as any);
  }

  /**
   * Switch to OpenClaw via daemon.
   */
  switchToOpenClaw(): void {
    dinfo(TAG, 'switchToOpenClaw()');
    this.bridge.send({ type: 'switch_agent', agent: 'openclaw' });
  }

  /**
   * Switch to Claude Code via daemon.
   */
  switchToClaude(): void {
    dinfo(TAG, 'switchToClaude()');
    this.bridge.send({ type: 'switch_agent', agent: 'claude-code' });
  }

  /**
   * Whether OpenClaw Gateway is available (reported by daemon).
   */
  setBridgeGatewayAvailable(available: boolean): void {
    this.gatewayAvailable = available;
  }

  isGatewayAvailable(): boolean {
    return this.gatewayAvailable;
  }

  // ===== Private =====

  /** Read daemon.json to find the daemon's port.
   *
   * The Node.js CLI writes `~/.agentdeck/daemon.json`; the Swift in-process
   * daemon (App Store sandboxed macOS app) writes inside the app sandbox.
   * A legacy App Group path remains as a read fallback for pre-1.0 App Store
   * candidates. First live match wins.
   */
  private findDaemonPort(): number | null {
    this.lastProbeAt = Date.now();
    const dataDirOverride = process.env.AGENTDECK_DATA_DIR;
    const home = homedir();
    const candidates = dataDirOverride
      ? [join(dataDirOverride, 'daemon.json')]
      : [
          join(home, '.agentdeck', 'daemon.json'),
          join(home, 'Library', 'Containers',
               'bound.serendipity.agentdeck.dashboard', 'Data',
               'Library', 'Application Support', 'AgentDeck', 'daemon.json'),
          join(home, 'Library', 'Group Containers',
               'group.bound.serendipity.agentdeck.dashboard', 'daemon.json'),
        ];
    for (const daemonFile of candidates) {
      try {
        const data = readFileSync(daemonFile, 'utf-8');
        const info = JSON.parse(data) as { port: number; pid: number };
        try { process.kill(info.pid, 0); } catch { continue; }
        this.lastDaemonPort = info.port;
        this.daemonStatus = 'found';
        this.discoveryMessage = daemonFile;
        return info.port;
      } catch {
        continue;
      }
    }
    this.lastDaemonPort = null;
    this.daemonStatus = 'missing';
    this.discoveryMessage = 'daemon.json not found';
    return null;
  }

  private setupBridgeListeners(): void {
    // Forward all bridge events
    for (const eventName of FORWARDED_EVENTS) {
      this.bridge.on(eventName, (ev: BridgeEvent) => {
        this.emit(eventName, ev);
      });
    }

    this.bridge.on('connected', () => {
      dinfo(TAG, 'Daemon connected');
      this.emit('connected');
    });

    this.bridge.on('disconnected', () => {
      dinfo(TAG, 'Daemon disconnected');
      this.emit('disconnected');
    });

    this.bridge.on('stale-changed', (stale: boolean) => {
      this.emit('stale-changed', stale);
    });
  }
}
