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

/** How long a port that failed to connect is skipped during discovery. Long
 *  enough to fall through to the other daemon.json candidate on the next
 *  backoff tick, short enough that a daemon restart is picked up quickly. */
const PORT_QUARANTINE_MS = 30_000;

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
  'display_state',
  'sessions_list',
  'review_status',
  'voice_state',
] as const;

export class ConnectionManager extends EventEmitter implements AgentLink {
  readonly bridge: BridgeClient;
  private started = false;
  private lastDaemonPort: number | null = null;
  /** port → epoch-ms of the failure that quarantined it. */
  private portQuarantine = new Map<number, number>();
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

  // ===== Private =====

  /** Read daemon.json to find the daemon's port.
   *
   * The Node.js CLI writes `~/.agentdeck/daemon.json`; the Swift in-process
   * daemon (App Store sandboxed macOS app) writes inside the app sandbox.
   * A legacy App Group path remains as a read fallback for pre-1.0 App Store
   * candidates. First live match wins.
   *
   * A live pid is NOT proof the port is served: a daemon can be wedged, a
   * daemon.json can outlive the process that wrote it, and pids get recycled.
   * Without the quarantine below, one unhealthy candidate permanently shadows
   * the healthy one behind it — the plugin would sit "offline" forever on a
   * machine where the other daemon is running fine. Ports that fail to connect
   * are skipped for a cooldown so discovery falls through to the next
   * candidate, and the quarantine self-clears once every candidate is
   * exhausted so recovery never requires a plugin restart.
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
               'bound.serendipity.agent.deck', 'Data',
               'Library', 'Application Support', 'AgentDeck', 'daemon.json'),
          join(home, 'Library', 'Group Containers',
               'group.bound.serendipity.agent.deck', 'daemon.json'),
        ];

    const readCandidates = (): Array<{ file: string; port: number }> => {
      const out: Array<{ file: string; port: number }> = [];
      for (const daemonFile of candidates) {
        try {
          const data = readFileSync(daemonFile, 'utf-8');
          const info = JSON.parse(data) as { port: number; pid: number };
          if (!Number.isSafeInteger(info.pid) || info.pid <= 0 ||
              !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) continue;
          try { process.kill(info.pid, 0); } catch (err) {
            // Access denial (e.g. an elevated Windows daemon) is not proof of
            // absence. Let the bounded WebSocket handshake judge reachability.
            if ((err as NodeJS.ErrnoException).code === 'ESRCH') continue;
          }
          out.push({ file: daemonFile, port: info.port });
        } catch {
          continue;
        }
      }
      return out;
    };

    const live = readCandidates();
    const now = Date.now();
    let fresh = live.filter(c => {
      const failedAt = this.portQuarantine.get(c.port);
      return failedAt === undefined || now - failedAt >= PORT_QUARANTINE_MS;
    });

    // Every live candidate is quarantined — drop the quarantine and retry them
    // all rather than reporting "missing" while daemons are demonstrably up.
    if (fresh.length === 0 && live.length > 0) {
      this.portQuarantine.clear();
      fresh = live;
    }

    const chosen = fresh[0];
    if (chosen) {
      this.lastDaemonPort = chosen.port;
      this.daemonStatus = 'found';
      this.discoveryMessage = chosen.file;
      return chosen.port;
    }

    this.lastDaemonPort = null;
    this.daemonStatus = 'missing';
    this.discoveryMessage = 'daemon.json not found';
    return null;
  }

  /** Quarantine the port we just failed on so the next probe tries the next
   *  daemon.json candidate instead of retrying the same dead endpoint. */
  private quarantineCurrentPort(): void {
    const port = this.bridge.getPort();
    if (port > 0) {
      this.portQuarantine.set(port, Date.now());
      dlog(TAG, `quarantined port ${port} for ${PORT_QUARANTINE_MS}ms`);
    }
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
      // Proven good — clear the quarantine so a later failure gets a full
      // sweep of candidates rather than a partially-exhausted one.
      this.portQuarantine.clear();
      this.emit('connected');
    });

    this.bridge.on('disconnected', () => {
      dinfo(TAG, 'Daemon disconnected');
      // The endpoint we were told about did not hold up. Quarantine it so the
      // next discovery pass can fall through to the other daemon (Swift app vs
      // CLI) instead of retrying this one forever.
      this.quarantineCurrentPort();
      this.emit('disconnected');
    });

    // A failed initial handshake never emits 'disconnected': there was no
    // connection to lose. It must still advance discovery past this endpoint.
    this.bridge.on('connection-attempt-failed', () => {
      this.quarantineCurrentPort();
    });

    this.bridge.on('stale-changed', (stale: boolean) => {
      this.emit('stale-changed', stale);
    });
  }
}
