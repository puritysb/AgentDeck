/**
 * AgentDeck daemon WebSocket client for the Ulanzi plugin.
 *
 * Mirrors plugin/src/{connection-manager,bridge-client}.ts:
 *  - discover the daemon port from daemon.json (Node CLI ~/.agentdeck or the
 *    App Store Swift sandbox / Group Container paths) on every (re)connect, so
 *    it attaches to whichever daemon owns 9120 (Swift OR Node) and survives drift;
 *    when the registry is absent (Windows Studio + WSL2), probe loopback 9120;
 *  - reconnect with backoff + a wake/activity watchdog;
 *  - announce itself via `client_register` with clientType `ulanzi-plugin`
 *    (the daemon uses this presence as the D200H health signal).
 */
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { discoverDaemonPort } from './daemon-discovery.js';
import {
  BridgeEvent,
  RECONNECT_BACKOFF_MS,
  WS_ACTIVITY_TIMEOUT_MS,
  WS_STALE_TIMEOUT_MS,
} from '@agentdeck/shared';
import { dlog, dinfo, dwarn } from './log.js';

const TAG = 'daemon';

export interface DaemonClientEvents {
  connected: () => void;
  disconnected: () => void;
  event: (ev: BridgeEvent) => void;
}

export class DaemonClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;
  private port: number | null = null;
  private gen = 0;
  private attemptId = 0;
  private backoffIdx = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;
  private lastTick = 0;

  start(): void {
    this.stop();
    this.backoffIdx = 0;
    this.attempt(this.gen);
  }

  stop(): void {
    this.gen++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopWatchdog();
    this.connected = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      this.ws.terminate();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Accepts any `{type, …}` command (PluginCommand or the layout engine's
   *  ButtonCommand) — the daemon parses by `type`. */
  send(command: { type: string; [k: string]: unknown }): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(command));
    } else {
      dwarn(TAG, `send(${command.type}) dropped — not connected`);
    }
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.gen) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.backoffIdx, RECONNECT_BACKOFF_MS.length - 1)];
    if (this.backoffIdx < RECONNECT_BACKOFF_MS.length - 1) this.backoffIdx++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen !== this.gen || this.connected) return;
      this.attempt(gen);
    }, delay);
  }

  private async attempt(gen: number): Promise<void> {
    if (gen !== this.gen) return;

    const attemptId = ++this.attemptId;
    const resolved = await discoverDaemonPort();
    if (gen !== this.gen || attemptId !== this.attemptId) return;
    if (resolved == null) {
      dlog(TAG, 'no healthy local daemon found — retrying');
      if (this.connected) { try { this.ws?.close(); } catch { /* ignore */ } }
      this.scheduleReconnect(gen);
      return;
    }
    if (resolved !== this.port) {
      dlog(TAG, `port -> ${resolved}`);
      this.port = resolved;
    }

    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      stale.removeAllListeners();
      stale.on('error', () => {});
      try { stale.terminate(); } catch { /* ignore */ }
    }

    try {
      // Connect via 127.0.0.1, NOT localhost: the daemon binds IPv4-only
      // (`httpServer.listen(port, '0.0.0.0')`), but macOS resolves `localhost`
      // to IPv6 `::1` first. Ulanzi Studio's bundled Node lacks the Happy-Eyeballs
      // IPv4 fallback that the Stream Deck runtime has, so `localhost` lands on
      // `::1`, gets ECONNREFUSED, and the deck shows OFFLINE despite a live daemon.
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { handshakeTimeout: 3000 });
      this.ws.on('open', () => {
        if (gen !== this.gen) return;
        this.connected = true;
        this.backoffIdx = 0;
        this.markActivity();
        this.startWatchdog(gen);
        dinfo(TAG, `connected on ${this.port}`);
        this.sendClientRegister();
        this.emit('connected');
      });
      this.ws.on('ping', () => this.markActivity());
      this.ws.on('message', (data: WebSocket.Data) => {
        if (gen !== this.gen) return;
        this.markActivity();
        try {
          const ev = JSON.parse(data.toString()) as BridgeEvent;
          this.emit('event', ev);
        } catch { /* ignore malformed */ }
      });
      this.ws.on('close', () => {
        if (gen !== this.gen) return;
        this.stopWatchdog();
        const was = this.connected;
        this.connected = false;
        if (was) { dwarn(TAG, 'disconnected'); this.emit('disconnected'); }
        this.scheduleReconnect(gen);
      });
      this.ws.on('error', (err) => dlog(TAG, `ws error: ${err.message}`));
    } catch (err) {
      dlog(TAG, `attempt exception: ${err}`);
      this.scheduleReconnect(gen);
    }
  }

  private sendClientRegister(): void {
    this.send({
      type: 'client_register',
      clientType: 'ulanzi-plugin',
      // Studio does not include the concrete device model in the main-service
      // handshake. Keep the historical d200h wire identity (the health route
      // and existing clients depend on it), but label the plugin truthfully now
      // that the same 14-key action also runs on D200X.
      clientLabel: 'Ulanzi D200H / D200X',
      devices: [{ id: 'd200h', name: 'Ulanzi D200H / D200X', family: 'd200h', columns: 5, rows: 3 }],
    });
  }

  private startWatchdog(gen: number): void {
    this.stopWatchdog();
    this.lastTick = Date.now();
    this.watchdog = setInterval(() => {
      if (gen !== this.gen) return;
      const now = Date.now();
      const gap = now - this.lastTick;
      this.lastTick = now;
      if (gap > 20_000) {
        // wake from sleep
        if (this.connected) {
          try { this.ws?.ping(); } catch { /* ignore */ }
          setTimeout(() => {
            if (gen === this.gen && this.connected && Date.now() - this.lastActivityAt > 5_000) {
              this.ws?.terminate();
            }
          }, 3000);
        } else {
          this.backoffIdx = 0;
          this.attempt(gen);
        }
        return;
      }
      if (!this.connected) return;
      const elapsed = now - this.lastActivityAt;
      if (elapsed > WS_ACTIVITY_TIMEOUT_MS) {
        dwarn(TAG, `no activity ${elapsed}ms — terminating`);
        this.ws?.terminate();
      } else if (elapsed > WS_STALE_TIMEOUT_MS) {
        this.emit('stale');
      }
    }, 10_000);
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private stopWatchdog(): void {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }
}
