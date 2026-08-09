import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import type { BridgeEvent, PluginCommand } from './types.js';
import { isLocalConnection, validateToken } from './auth.js';
import { debug, log } from './logger.js';
import { WS_PING_INTERVAL_MS } from '@agentdeck/shared';

export class WsServer {
  private wss: WebSocketServer;
  private commandCallback: ((cmd: PluginCommand) => void) | null = null;
  private rawMessageCallback: ((msg: Record<string, unknown>, sender: WebSocket) => boolean) | null = null;
  private binaryCallback: ((data: Buffer, sender: WebSocket) => void) | null = null;
  private onPongCallback: ((ws: WebSocket) => void) | null = null;
  private onConnectCallback: ((ws: WebSocket) => void) | null = null;
  private onDisconnectCallback: ((ws: WebSocket) => void) | null = null;
  private clientAlive = new Map<WebSocket, boolean>();
  private esp32Clients = new Set<WebSocket>();
  // Unauthorized closes used to be debug-only, which made a fleet-wide
  // credential mismatch invisible: every board reconnected every few seconds,
  // got closed 4001, and the daemon log stayed empty — the diagnosis needed
  // `netstat`. Report it at normal level, throttled per IP so a flapping board
  // describes the problem instead of becoming one.
  private unauthorizedByIp = new Map<string, { loggedAt: number; suppressed: number }>();
  private static readonly UNAUTHORIZED_LOG_INTERVAL_MS = 60_000;
  // Per-IP connect timestamps for the flap guard (window: 30s, threshold: >6).
  private recentConnectsByIp = new Map<string, number[]>();
  private flappingClients = new Set<WebSocket>();
  // IPs that have ever sent device_info this daemon lifetime. A board that
  // predates the `?clientType=esp32` tag (XTeink 6ccbe140) is only recognized
  // AFTER its first device_info — one connect too late, because the initial
  // burst already went out untagged. Remembering the IP makes every subsequent
  // connect board-class from byte one, so the ≤4096B invariant holds and a
  // heap-tight board can't be killed by its own welcome payload.
  private knownBoardIps = new Set<string>();
  private socketRemoteIp = new Map<WebSocket, string>();
  private eventTransformer: ((event: BridgeEvent, client: WebSocket) => BridgeEvent | null) | null = null;
  // Clients that registered as the Ulanzi Studio plugin. Their WebSocket
  // presence is the daemon's D200H connectivity signal.
  private ulanziClients = new Set<WebSocket>();
  // TUI dashboards (`agentdeck dashboard`) that registered via
  // `client_register {clientType:"tui"}`. Volunteer-roster model like the
  // Stream Deck plugin — presence only lives as long as the WS does, so the
  // topology row disappears the moment the TUI exits.
  private tuiClients = new Map<WebSocket, { id: string; name: string }>();
  private pingTimer: ReturnType<typeof setInterval>;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });

    // Catch server-level errors (e.g., upgrade failures, internal ws errors)
    // Without this handler, EventEmitter throws synchronously → process dies
    this.wss.on('error', (err) => {
      debug('WS', `WebSocketServer error: ${err}`);
    });

    // Server-side ping/pong to detect zombie connections
    this.pingTimer = setInterval(() => {
      const dead: WebSocket[] = [];
      for (const ws of this.wss.clients) {
        if (this.clientAlive.get(ws) === false) {
          dead.push(ws);
          continue;
        }
        this.clientAlive.set(ws, false);
        ws.ping();
      }
      // Terminate outside iteration — ws.terminate() synchronously removes
      // the client from wss.clients Set, which would corrupt the iterator.
      for (const ws of dead) {
        debug('WS', 'Terminating unresponsive client');
        this.clientAlive.delete(ws);
        ws.terminate();
      }
    }, WS_PING_INTERVAL_MS);

    this.wss.on('connection', (ws, req: IncomingMessage) => {
      // Token auth for remote connections
      const remoteIp = req.socket.remoteAddress || '';
      if (!isLocalConnection(remoteIp)) {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const token = url.searchParams.get('token') || '';
        if (!validateToken(token)) {
          // Whatever the peer called itself, bounded and sanitized: it is a
          // string from an unauthenticated peer heading for a terminal.
          const claimed = url.searchParams.get('clientType')
            ?? (url.searchParams.get('esp32') === '1' ? 'esp32' : null);
          const peerKind = claimed?.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24)
            || (this.knownBoardIps.has(remoteIp) ? 'esp32' : undefined);
          this.logUnauthorized(remoteIp, token.length > 0, peerKind);
          ws.close(4001, 'Unauthorized');
          return;
        }
        debug('WS', `Remote client authenticated from ${remoteIp}`);
      }
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      this.socketRemoteIp.set(ws, remoteIp);
      if (url.searchParams.get('clientType') === 'esp32' || url.searchParams.get('esp32') === '1') {
        this.esp32Clients.add(ws);
        debug('WS', 'ESP32 WiFi client tagged from query');
      } else if (this.knownBoardIps.has(remoteIp)) {
        this.esp32Clients.add(ws);
        debug('WS', `ESP32 WiFi client tagged from known board IP ${remoteIp}`);
      }

      // Flap guard: a client whose IP reconnected >6 times in the last 30s is
      // marked flapping. It is still served (rejecting outright would blind a
      // recovering board forever), but sendInitialState skips the expensive
      // burst for it — a marginal-RF board must not be able to resonate the
      // daemon into event-loop saturation (connect → heavy serialize → client
      // dies on the burst → immediate reconnect → repeat).
      {
        const now = Date.now();
        const recent = (this.recentConnectsByIp.get(remoteIp) ?? []).filter((t) => now - t < 30_000);
        recent.push(now);
        this.recentConnectsByIp.set(remoteIp, recent);
        if (recent.length > 6) {
          this.flappingClients.add(ws);
          debug('WS', `Flapping client ${remoteIp}: ${recent.length} connects/30s — initial burst reduced`);
        }
      }

      debug('WS', 'Plugin connected');
      this.clientAlive.set(ws, true);

      // Send current state to newly connected client
      if (this.onConnectCallback) {
        this.onConnectCallback(ws);
      }

      ws.on('pong', () => {
        this.clientAlive.set(ws, true);
        // A display-only board sends no application messages while idle, so a
        // message-based lastSeen brands every healthy quiet board "stale". Its
        // pong every WS_PING_INTERVAL_MS is real liveness — surface it.
        this.onPongCallback?.(ws);
      });

      ws.on('message', (data, isBinary) => {
        // Binary frames are device audio (voice capture), not JSON — route
        // them out before the parser, which would otherwise log a parse error
        // per 1 KB PCM frame.
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          this.binaryCallback?.(buf, ws);
          return;
        }
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          debug('WS', `recv cmd: ${msg.type}`);
          // Track Ulanzi plugin presence for D200H health reporting.
          if (msg.type === 'client_register' && msg.clientType === 'ulanzi-plugin') {
            const was = this.ulanziClients.size > 0;
            this.ulanziClients.add(ws);
            if (!was) {
              debug('WS', 'Ulanzi plugin registered — D200H connected');
            }
          }
          // Track TUI dashboard presence (topology row on all dashboards).
          if (msg.type === 'client_register' && msg.clientType === 'tui') {
            const dev = (Array.isArray(msg.devices) ? msg.devices[0] : null) as
              | { id?: unknown; name?: unknown }
              | null;
            const name = typeof dev?.name === 'string' && dev.name ? dev.name : 'terminal';
            const id = typeof dev?.id === 'string' && dev.id ? dev.id : name;
            this.tuiClients.set(ws, { id, name });
            debug('WS', `TUI dashboard registered: ${id}`);
          }
          // Allow raw message callback to intercept relay events (e.g. deck_slot_map)
          if (this.rawMessageCallback && this.rawMessageCallback(msg, ws)) {
            return; // handled
          }
          if (this.commandCallback) {
            this.commandCallback(msg as unknown as PluginCommand);
          }
        } catch (err) {
          debug('WS', `Failed to parse message: ${err}`);
        }
      });

      ws.on('close', () => {
        debug('WS', 'Plugin disconnected');
        this.clientAlive.delete(ws);
        this.esp32Clients.delete(ws);
        this.flappingClients.delete(ws);
        this.socketRemoteIp.delete(ws);
        this.tuiClients.delete(ws);
        if (this.ulanziClients.delete(ws) && this.ulanziClients.size === 0) {
          debug('WS', 'Ulanzi plugin gone — D200H disconnected');
        }
        if (this.onDisconnectCallback) {
          this.onDisconnectCallback(ws);
        }
      });

      ws.on('error', (err) => {
        debug('WS', `WebSocket error: ${err}`);
      });
    });
  }

  private broadcastHooks: Array<(event: BridgeEvent) => void> = [];

  /** Register a hook that gets called on every broadcast (e.g., ESP32 serial relay). */
  onBroadcast(hook: (event: BridgeEvent) => void): void {
    this.broadcastHooks.push(hook);
  }

  setEventTransformer(transformer: ((event: BridgeEvent, client: WebSocket) => BridgeEvent | null) | null): void {
    this.eventTransformer = transformer;
  }

  isEsp32Client(ws: WebSocket): boolean {
    return this.esp32Clients.has(ws);
  }

  /** True when this socket's remote IP has been reconnecting fast enough to
   *  count as flapping (see the connection handler). Callers use it to skip
   *  the heavy parts of the initial burst so a marginal client can't resonate
   *  the daemon into saturation. */
  isFlappingClient(ws: WebSocket): boolean {
    return this.flappingClients.has(ws);
  }

  markEsp32Client(ws: WebSocket): void {
    this.esp32Clients.add(ws);
    const ip = this.socketRemoteIp.get(ws);
    if (ip) this.knownBoardIps.add(ip);
  }

  private payloadFor(event: BridgeEvent, client: WebSocket, cachedPayload?: string): string | null {
    if (!this.eventTransformer) return cachedPayload ?? JSON.stringify(event);
    const transformed = this.eventTransformer(event, client);
    if (!transformed) return null;
    return transformed === event ? (cachedPayload ?? JSON.stringify(event)) : JSON.stringify(transformed);
  }

  broadcast(event: BridgeEvent): void {
    const payload = JSON.stringify(event);
    const clientCount = this.wss.clients.size;
    debug('WS', `broadcast(${event.type}) to ${clientCount} clients`);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        const clientPayload = this.payloadFor(event, client, payload);
        if (!clientPayload) continue;
        try { client.send(clientPayload); } catch { /* client disconnecting */ }
      }
    }
    // Relay to registered hooks (ESP32 serial, etc.)
    for (const hook of this.broadcastHooks) {
      try { hook(event); } catch { /* best-effort */ }
    }
  }

  onCommand(callback: (cmd: PluginCommand) => void): void {
    this.commandCallback = callback;
  }

  /** Register a callback for binary frames (device audio). */
  onPong(callback: (ws: WebSocket) => void): void {
    this.onPongCallback = callback;
  }

  onBinary(callback: (data: Buffer, sender: WebSocket) => void): void {
    this.binaryCallback = callback;
  }

  /** Register a callback for raw messages before PluginCommand dispatch. Return true to consume. */
  onRawMessage(callback: (msg: Record<string, unknown>, sender: WebSocket) => boolean): void {
    this.rawMessageCallback = callback;
  }

  /** Broadcast to all clients except the sender */
  broadcastExcept(event: BridgeEvent, except: WebSocket): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client !== except && client.readyState === WebSocket.OPEN) {
        const clientPayload = this.payloadFor(event, client, payload);
        if (!clientPayload) continue;
        try { client.send(clientPayload); } catch { /* client disconnecting */ }
      }
    }
  }

  onClientConnect(callback: (ws: WebSocket) => void): void {
    this.onConnectCallback = callback;
  }

  onClientDisconnect(callback: (ws: WebSocket) => void): void {
    this.onDisconnectCallback = callback;
  }

  sendTo(ws: WebSocket, event: BridgeEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = this.payloadFor(event, ws);
      if (!payload) return;
      try { ws.send(payload); } catch { /* client disconnecting */ }
    }
  }

  getClientCount(): number {
    return this.wss.clients.size;
  }

  getUlanziClientCount(): number {
    return this.ulanziClients.size;
  }

  /** Registered TUI dashboards (`client_register {clientType:"tui"}`), deduped
   *  by client id so a TUI that reconnects (new WS, same host+pid) yields one
   *  entry while both sockets briefly overlap. */
  getTuiClients(): Array<{ id: string; name: string }> {
    const byId = new Map<string, { id: string; name: string }>();
    for (const info of this.tuiClients.values()) byId.set(info.id, info);
    return [...byId.values()];
  }

  /**
   * Report a 4001 close once per IP per minute, naming the likely cause. The
   * two cases read very differently to an operator: a peer that presented
   * nothing is usually an unpaired client, while a peer that presented a token
   * we do not accept is a provisioned device whose credential went stale —
   * which USB serial can re-arm and nothing else can.
   *
   * `peerKind` exists because an IP alone is not an identity on a LAN with a
   * DHCP pool and a dozen boards on it. A board hammering the daemon every ~10s
   * for a day was diagnosed by hand — cross-referencing ARP against the WiFi
   * registry, then reading `wifi_provision_ack` IPs out of the log to work out
   * which serial port they came from — and the answer ("it is an ESP32, not a
   * companion app") was in the rejected request's own query string the whole
   * time. The firmware tags itself `?clientType=esp32`; log what it said.
   */
  private logUnauthorized(ip: string, presentedToken: boolean, peerKind?: string): void {
    const now = Date.now();
    const prev = this.unauthorizedByIp.get(ip);
    if (prev && now - prev.loggedAt < WsServer.UNAUTHORIZED_LOG_INTERVAL_MS) {
      prev.suppressed++;
      return;
    }
    // Bound the map: it is keyed by LAN peers, but a long-lived daemon on a
    // busy network should not accumulate them forever.
    if (this.unauthorizedByIp.size > 64) this.unauthorizedByIp.clear();
    const repeated = prev?.suppressed ? ` — plus ${prev.suppressed} more since the last line` : '';
    this.unauthorizedByIp.set(ip, { loggedAt: now, suppressed: 0 });
    const who = peerKind ? `${ip} (${peerKind})` : ip;
    // The advice differs by peer: an ESP32 has a USB serial channel that works
    // precisely when authentication is what is broken, and a companion app or
    // reader does not — for those, an operator-opened pairing code is the path
    // that needs no camera and no cable.
    const howToFix = peerKind === 'esp32'
      ? 'Attach it over USB serial and the daemon re-arms its token automatically.'
      : 'Pair it with "agentdeck pair" (code) or "agentdeck qr".';
    log(presentedToken
      ? `[agentdeck] Rejected ${who}: pairing token not accepted${repeated}. `
        + `A provisioned device looping here needs its token re-armed over USB serial.`
      : `[agentdeck] Rejected ${who}: no pairing token${repeated}. ${howToFix}`);
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.clientAlive.clear();
    // Spread to array — client.close() modifies wss.clients Set
    for (const client of [...this.wss.clients]) {
      client.close();
    }
    this.wss.close();
  }
}
