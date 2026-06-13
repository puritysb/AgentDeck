import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  BridgeEvent,
  PluginCommand,
  AgentCapabilities,
  BRIDGE_WS_PORT,
  RECONNECT_BACKOFF_MS,
  WS_ACTIVITY_TIMEOUT_MS,
  WS_STALE_TIMEOUT_MS,
} from '@agentdeck/shared';
import type { AgentLink } from './agent-link.js';
import { dlog, dwarn, derr } from './log.js';

export type PortProvider = () => number | null;

export class BridgeClient extends EventEmitter implements AgentLink {
  private ws: WebSocket | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private _watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private _lastActivityAt = 0;
  private _stale = false;
  private _connected = false;
  private _port = BRIDGE_WS_PORT;
  private _connectGeneration = 0;
  private _capabilities: AgentCapabilities | null = null;
  private _portProvider: PortProvider | null = null;
  private _backoffIdx = 0;

  /**
   * Install a port provider. Called before each (re)connect attempt.
   * Returning null skips that attempt — used when daemon.json is missing or
   * the recorded pid is dead. The same provider survives across reconnects.
   */
  setPortProvider(provider: PortProvider | null): void {
    this._portProvider = provider;
  }

  connect(port?: number): void {
    if (port != null) this._port = port;
    dlog('Bridge', `connect(port=${this._port})`);
    this.cleanup();
    this._connectGeneration++;
    const gen = this._connectGeneration;
    this._backoffIdx = 0;
    this.attemptConnect(gen);
  }

  /** Reconnect to a different session on a different port */
  reconnectTo(port: number): void {
    dlog('Bridge', `reconnectTo(port=${port})`);
    this._port = port;
    // Clean up old connection without emitting 'disconnected'
    this.cleanup();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.connect(port);
  }

  disconnect(): void {
    dlog('Bridge', 'disconnect()');
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.emit('disconnected');
  }

  send(command: PluginCommand): void {
    if (this.ws && this._connected) {
      dlog('Bridge', `send(${command.type})`);
      this.ws.send(JSON.stringify(command));
    } else {
      dwarn('Bridge', `send(${command.type}) dropped — not connected`);
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  getCapabilities(): AgentCapabilities | null {
    return this._capabilities;
  }

  getPort(): number {
    return this._port;
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this._connectGeneration) return;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    const delay = RECONNECT_BACKOFF_MS[
      Math.min(this._backoffIdx, RECONNECT_BACKOFF_MS.length - 1)
    ];
    if (this._backoffIdx < RECONNECT_BACKOFF_MS.length - 1) this._backoffIdx++;
    dlog('Bridge', `next attempt in ${delay}ms (backoffIdx=${this._backoffIdx})`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (gen !== this._connectGeneration) return;
      if (this._connected) return;
      this.attemptConnect(gen);
    }, delay);
  }

  private attemptConnect(gen: number): void {
    if (gen !== this._connectGeneration) return;

    // Resolve target port via provider on every attempt so that daemon port
    // drift (or daemon absence) is picked up without restarting the plugin.
    if (this._portProvider) {
      const resolved = this._portProvider();
      if (resolved == null) {
        dlog('Bridge', 'attemptConnect skipped: portProvider returned null (daemon offline)');
        if (this._connected) {
          // Daemon disappeared while we were connected — force a close so the
          // 'disconnected' event fires through the existing 'close' path.
          try { this.ws?.close(); } catch { /* ignore */ }
        }
        this.scheduleReconnect(gen);
        return;
      }
      if (resolved !== this._port) {
        dlog('Bridge', `port rebind ${this._port} -> ${resolved}`);
        this._port = resolved;
        if (this.ws) {
          const stale = this.ws;
          this.ws = null;
          stale.removeAllListeners();
          try { stale.close(); } catch { /* ignore */ }
        }
      }
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.CONNECTING) {
        dlog('Bridge', 'attemptConnect skipped: socket still connecting')
        return;
      }
      const staleWs = this.ws;
      this.ws = null;
      staleWs.removeAllListeners();
      try {
        if (
          staleWs.readyState === WebSocket.OPEN ||
          staleWs.readyState === WebSocket.CLOSING
        ) {
          staleWs.close();
        }
      } catch (err) {
        dlog('Bridge', `stale socket cleanup ignored: ${err}`);
      }
    }

    try {
      dlog('Bridge', `attemptConnect ws://localhost:${this._port} (gen=${gen})`);
      this.ws = new WebSocket(`ws://localhost:${this._port}`);

      this.ws.on('open', () => {
        if (gen !== this._connectGeneration) return;
        dlog('Bridge', 'WebSocket open');
        this._connected = true;
        this._backoffIdx = 0;
        this.markActivity();
        this.startWatchdog(gen);
        this.emit('connected');
      });

      this.ws.on('ping', () => {
        this.markActivity();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        if (gen !== this._connectGeneration) return;
        this.markActivity();
        try {
          const event = JSON.parse(data.toString()) as BridgeEvent;
          dlog('Bridge', `recv(${event.type})`);
          // Track agent capabilities from state updates
          if (event.type === 'state_update' && event.agentCapabilities) {
            this._capabilities = event.agentCapabilities;
          }
          this.emit(event.type, event);
        } catch (err) {
          derr('Bridge', `message parse error: ${err}`);
        }
      });

      this.ws.on('close', () => {
        if (gen !== this._connectGeneration) return;
        const wasConnected = this._connected;
        this._connected = false;
        this.setStale(false);
        if (wasConnected) {
          dlog('Bridge', 'WebSocket closed (was connected)');
          this.emit('disconnected');
        }
        this.scheduleReconnect(gen);
      });

      this.ws.on('error', (err) => {
        if (gen !== this._connectGeneration) return;
        dlog('Bridge', `WebSocket error: ${err.message}`);
      });
    } catch (err) {
      dlog('Bridge', `attemptConnect exception: ${err}`);
      this.scheduleReconnect(gen);
    }
  }

  private _lastWatchdogTick = Date.now();

  private startWatchdog(gen: number): void {
    this.stopWatchdog();
    this._lastWatchdogTick = Date.now();
    this._watchdogTimer = setInterval(() => {
      if (gen !== this._connectGeneration) return;

      const now = Date.now();
      const tickGap = now - this._lastWatchdogTick;
      this._lastWatchdogTick = now;

      // Detect system wake via time discontinuity (tick should be ~10s, >20s = likely sleep)
      if (tickGap > 20_000) {
        dlog('Bridge', `Wake detected (tick gap ${tickGap}ms)`);
        if (this._connected) {
          // Immediately check if connection is still alive
          try { this.ws?.ping(); } catch { /* ignore */ }
          setTimeout(() => {
            if (gen !== this._connectGeneration) return;
            if (this._connected && Date.now() - this._lastActivityAt > 5_000) {
              dwarn('Bridge', 'No pong after wake — terminating');
              this.ws?.terminate();
            }
          }, 3000);
        } else {
          // Not connected — reset backoff and try immediately
          this._backoffIdx = 0;
          this.attemptConnect(gen);
        }
        return;
      }

      if (!this._connected) return;
      const elapsed = now - this._lastActivityAt;
      if (elapsed > WS_ACTIVITY_TIMEOUT_MS) {
        dwarn('Bridge', `No activity for ${elapsed}ms — terminating connection`);
        this.ws?.terminate();
      } else if (elapsed > WS_STALE_TIMEOUT_MS) {
        // Soft-stale: the daemon went quiet (no pings/state) but hasn't hit the
        // hard timeout yet. Flag it so the UI can dim the last-known render.
        this.setStale(true);
      }
    }, 10_000);
  }

  /** Record inbound activity (open/ping/message) and clear any soft-stale flag. */
  private markActivity(): void {
    this._lastActivityAt = Date.now();
    this.setStale(false);
  }

  private setStale(stale: boolean): void {
    if (this._stale === stale) return;
    this._stale = stale;
    this.emit('stale-changed', stale);
  }

  /** True when connected but the daemon has gone quiet past the soft-stale
   *  window (still short of the hard disconnect). */
  isStale(): boolean {
    return this._connected && this._stale;
  }

  private stopWatchdog(): void {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  private cleanup(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.stopWatchdog();
  }
}
