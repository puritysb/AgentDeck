/**
 * Daemon WS Client — persistent WS connection from session bridges to the daemon.
 *
 * Session bridges push state_update events to the daemon over this channel,
 * replacing the daemon's HTTP polling of /health endpoints.
 *
 * Connection lifecycle:
 *   1. Session bridge calls connect(daemonPort) after registration
 *   2. Sends `session_push_register` with sessionId + port
 *   3. On state_changed, sends `session_push_state` with state + modelName
 *   4. Reconnects with exponential backoff on disconnect
 */

import WebSocket from 'ws';
import { sessionWeight } from '@agentdeck/shared';
import { debug } from './logger.js';

const TAG = 'DaemonWsClient';
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 30000;

export interface SessionPushState {
  type: 'session_push_state';
  sessionId: string;
  state: string;
  modelName?: string;
  effortLevel?: string;
  permissionMode?: string;
  projectName?: string;
  agentType?: string;
}

export interface SessionPushRegister {
  type: 'session_push_register';
  sessionId: string;
  port: number;
  agentType?: string;
  projectName?: string;
  /** Explicit deck/tab sort override. Always sent as a concrete integer
   *  (unweighted ⇒ 0, never omitted) — receivers merge retain-on-absent, so an
   *  only-sent-when-set field could be set but never reset. See shared
   *  sessionWeight / SESSION_WEIGHT_MIN..MAX. */
  weight: number;
}

export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private daemonPort: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE;
  private closed = false;
  private registered = false;

  constructor(
    private readonly sessionId: string,
    private readonly sessionPort: number,
    private readonly agentType?: string,
    private readonly projectName?: string,
    /** Deck/tab sort override; normalized via shared sessionWeight() at send time. */
    private readonly weight?: number,
    /**
     * Resolves the current daemon port on each (re)connect attempt. Lets the
     * client follow port drift (daemon restart onto a fallback port) and cover
     * the case where the daemon is not up yet when the session bridge starts.
     *
     * May be sync (`number | null`) or async (`Promise<number | null>`). The
     * async shape exists so callers can run a `/health` probe fallback when
     * the registry is empty — `findDaemonPortAsync` in `session-registry.ts`
     * does exactly this to cover the App-Store-vs-CLI data-dir split.
     *
     * Return `null` to defer — the client will keep retrying on backoff.
     */
    private readonly portProvider?: () => number | null | Promise<number | null>,
  ) {}

  /**
   * Start the connection loop. If `daemonPort` is null and a `portProvider`
   * was supplied, the client waits on backoff until the provider yields a
   * port (daemon catches up on a later launch).
   */
  connect(daemonPort: number | null): void {
    if (this.closed) return;
    if (daemonPort != null) {
      this.daemonPort = daemonPort;
      void this.doConnect();
    } else {
      this.scheduleReconnect();
    }
  }

  /** Push state update to daemon */
  pushState(state: string, modelName?: string, effortLevel?: string, permissionMode?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: SessionPushState = {
      type: 'session_push_state',
      sessionId: this.sessionId,
      state,
      modelName,
      effortLevel,
      permissionMode,
      projectName: this.projectName,
      agentType: this.agentType,
    };
    this.ws.send(JSON.stringify(msg));
  }

  /** Clean shutdown */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.registered = false;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.registered;
  }

  // ---- Internals ----

  private async doConnect(): Promise<void> {
    if (this.closed) return;
    if (this.portProvider) {
      let resolved: number | null;
      try {
        resolved = await this.portProvider();
      } catch (err) {
        debug(TAG, `portProvider threw: ${err instanceof Error ? err.message : String(err)}`);
        resolved = null;
      }
      if (this.closed) return;
      if (resolved != null && resolved !== this.daemonPort) {
        debug(TAG, `Daemon port resolved ${this.daemonPort ?? 'null'} → ${resolved}`);
        this.daemonPort = resolved;
      }
    }
    if (!this.daemonPort) {
      this.scheduleReconnect();
      return;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    const url = `ws://127.0.0.1:${this.daemonPort}`;
    debug(TAG, `Connecting to daemon at ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      debug(TAG, `Connected to daemon:${this.daemonPort}`);
      this.reconnectDelay = RECONNECT_BASE;
      this.sendRegister();
    });

    this.ws.on('close', () => {
      debug(TAG, 'Daemon WS closed');
      this.registered = false;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      debug(TAG, `WS error: ${err.message}`);
      // close event will fire after error
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session_push_ack') {
          this.registered = true;
          debug(TAG, 'Registration acknowledged');
        }
      } catch {
        // Ignore non-JSON daemon broadcasts
      }
    });
  }

  /**
   * Build the register frame (exposed for tests). `weight` is always a
   * concrete integer — the Swift daemon preserves an existing weight when the
   * key is absent (legacy senders), so a current sender must send the explicit
   * 0 to be able to reset one.
   */
  buildRegisterFrame(): SessionPushRegister {
    return {
      type: 'session_push_register',
      sessionId: this.sessionId,
      port: this.sessionPort,
      agentType: this.agentType,
      projectName: this.projectName,
      weight: sessionWeight(this.weight),
    };
  }

  private sendRegister(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(this.buildRegisterFrame()));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    debug(TAG, `Reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, RECONNECT_MAX);
  }
}
