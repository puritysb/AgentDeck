import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Server, IncomingMessage } from 'http';
import type { BridgeEvent, PluginCommand } from './types.js';
import { isLocalConnection, validateToken } from './auth.js';
import { mayAdoptEsp32, noteEsp32Adopted } from './pairing-window.js';
import { debug, log } from './logger.js';
import { DEVICE_ID_HEADER, normalizeDeviceId, WS_PING_INTERVAL_MS, State } from '@agentdeck/shared';

const AWAITING_STATES: readonly string[] = [
  State.AWAITING_PERMISSION,
  State.AWAITING_OPTION,
  State.AWAITING_DIFF,
];

/**
 * Issue #272 step 1 instrumentation: classifies whether a broadcast event
 * carries a field a human could act on (a session in an AWAITING_* state) vs
 * one that is cosmetic, at the ONE place the daemon decides to push a frame
 * to every WS client — trmnl_75 (push panel) included. This is deliberately
 * NOT per-board: broadcast() sends the same event to every WS client, and
 * only the pushed board's own on-device contentHash decides whether it
 * repaints (see esp32/src/ui/eink/eink_display.cpp). The daemon has no
 * per-field diff of what changed, so "actionable" here means only "this
 * event carries an awaiting session somewhere in it" — the same Tier-A
 * signal used in #272's own reproduction script, not a claim about ghosting.
 */
export function broadcastActionability(event: BridgeEvent): 'actionable' | 'cosmetic' | 'n/a' {
  if (event.type === 'state_update') {
    const state = (event as { state?: unknown }).state;
    return typeof state === 'string' && AWAITING_STATES.includes(state) ? 'actionable' : 'cosmetic';
  }
  if (event.type === 'sessions_list') {
    const sessions = (event as { sessions?: Array<{ state?: unknown }> }).sessions ?? [];
    return sessions.some((s) => typeof s.state === 'string' && AWAITING_STATES.includes(s.state))
      ? 'actionable'
      : 'cosmetic';
  }
  return 'n/a';
}

/** The User-Agent links2004/WebSockets (the ESP32 firmware client) sends on every upgrade. */
export function isBoardWebSocketLibrary(userAgent: string | string[] | undefined): boolean {
  const ua = Array.isArray(userAgent) ? userAgent.join(' ') : userAgent ?? '';
  return /arduino-WebSocket-Client/i.test(ua);
}

export class WsServer {
  private wss: WebSocketServer;
  // Server-wide broadcast attempts, not deliveries or panel repaints. Bounded
  // storage, independent of debug logging and the number of connected clients.
  private readonly broadcastInstanceId = randomUUID();
  private readonly broadcastStartedAt = Date.now();
  private readonly broadcastStartedMono = performance.now();
  private readonly broadcastCounts = { actionable: 0, cosmetic: 0, unclassified: 0 };

  getBroadcastMetrics() {
    const { actionable, cosmetic, unclassified } = this.broadcastCounts;
    return {
      instanceId: this.broadcastInstanceId,
      startedAt: this.broadcastStartedAt,
      capturedAt: Date.now(),
      elapsedMs: Math.floor(performance.now() - this.broadcastStartedMono),
      total: actionable + cosmetic + unclassified,
      actionable, cosmetic, unclassified,
    };
  }

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
  /**
   * Supplies the credential for a cable-free ESP32 re-arm, or null when this
   * server must not hand one out. Injected rather than imported so the WS layer
   * never reaches for a token itself — a session bridge shares this class and
   * has no business provisioning boards.
   */
  private esp32AdoptionProvider:
    | (() => { authToken: string; bridgeIp: string; bridgePort: number } | null)
    | null = null;
  /**
   * The operator-approval half of the credential path, or null when this server
   * must not consult it. Injected for the same reason as the provider above: a
   * session bridge shares this class, and an approval roster is the daemon's to
   * own — a bridge answering "is this peer approved?" would be a second, unowned
   * copy of the decision.
   */
  private pairingApproval:
    | {
      isApproved: (ip: string, deviceId: string | null) => boolean;
      record: (ip: string, deviceId: string | null, staleToken: boolean) => void;
    }
    | null = null;
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
        // The id a client offers on the handshake, if it offers one. Read here
        // rather than from a later frame because the decision happens now:
        // `client_register` arrives only after a socket exists, which is after
        // this branch has already accepted or refused.
        const rawDeviceId = req.headers[DEVICE_ID_HEADER];
        const deviceId = normalizeDeviceId(
          Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId,
        );
        // An operator-approved peer authenticates without a token. This is the
        // credential path for a device that can neither scan a QR nor be
        // reached over USB — the approval was granted on the host, against the
        // peer's key, by someone who could see the knock.
        if (!validateToken(token) && this.pairingApproval?.isApproved(remoteIp, deviceId)) {
          debug('WS', `Operator-approved peer at ${remoteIp} admitted without a token`);
        } else if (!validateToken(token)) {
          // Whatever the peer called itself, bounded and sanitized: it is a
          // string from an unauthenticated peer heading for a terminal.
          const claimed = url.searchParams.get('clientType')
            ?? (url.searchParams.get('esp32') === '1' ? 'esp32' : null);
          const peerKind = claimed?.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24)
            || (this.knownBoardIps.has(remoteIp) ? 'esp32' : undefined);

          // Cable-free re-arm. A board cannot type a pairing code, so the
          // operator names its address instead (`agentdeck pair --adopt <ip>`)
          // and the daemon pushes the credential down the socket the board just
          // opened. `auth_provision` reaches the same firmware handler over the
          // WebSocket as over serial, and that handler persists to NVS — so this
          // survives the board's next reboot, which is the whole point.
          //
          // The socket is still unauthenticated and stays that way: it is never
          // registered as a client, never added to any roster, and receives this
          // one frame and nothing else. The board reconnects holding the token.
          // The firmware puts its model in the query of the very connection
          // being refused (`/?clientType=esp32&board=<name>`), so a refusal can
          // say WHICH board it is instead of only its address. Without it an
          // operator has to cross-reference ARP against a DHCP pool to find the
          // one unit that needs a cable — the same cross-referencing by hand
          // that `peerKind` was added to end, left half-done because the second
          // field in the same query string went unread.
          const board = url.searchParams.get('board')?.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24);

          if (peerKind === 'esp32' && this.esp32AdoptionProvider && mayAdoptEsp32(remoteIp)) {
            const payload = this.esp32AdoptionProvider();
            if (payload) {
              try {
                ws.send(JSON.stringify({ type: 'auth_provision', ...payload }));
              } catch { /* peer vanished mid-handshake */ }
              // Listen while the socket is briefly up. Firmware announces
              // `device_info` the instant a WebSocket connects — precisely so a
              // WiFi-only board is not anonymous — and the board that most needs
              // adopting is the one too old to put `board=` in its query string,
              // so hanging up without reading is throwing away the only
              // self-identification such a board can make. It stays a LOG: the
              // peer is unauthenticated, so nothing here registers a client,
              // enters a roster, or is trusted beyond being printed.
              let identified = false;
              const onIdentify = (raw: unknown): void => {
                if (identified) return;
                const text = typeof raw === 'string' ? raw : String(raw);
                // An unauthenticated peer's frame heading for a log line.
                if (text.length > 4096) return;
                let msg: { type?: unknown; board?: unknown; version?: unknown };
                try { msg = JSON.parse(text); } catch { return; }
                if (!msg || msg.type !== 'device_info') return;
                identified = true;
                const clean = (v: unknown, max: number): string | undefined =>
                  typeof v === 'string' ? v.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, max) || undefined : undefined;
                const named = clean(msg.board, 24);
                const version = clean(msg.version, 16);
                if (named) {
                  log(`[agentdeck] Adopted board at ${remoteIp} identifies as ${named}`
                    + (version ? ` v${version}` : ''));
                }
              };
              ws.on('message', onIdentify);

              noteEsp32Adopted(remoteIp, board || undefined);
              // Normal close, not 4001: the board should redial immediately with
              // its new credential, not treat this endpoint as one that refused
              // it. Delayed so the frame flushes first — and so the announcement
              // above has a moment to arrive.
              const bye = setTimeout(() => {
                ws.off('message', onIdentify);
                try { ws.close(1000, 'Re-armed — reconnect with the new token'); } catch { /* gone */ }
              }, 500);
              bye.unref?.();
              return;
            }
          }

          // Turn the refusal into something an operator can act on. A peer that
          // presented a token we do not accept is recorded as such: that reads
          // very differently to a new device — usually a provisioned one whose
          // credential went stale.
          // Deliberately OUTSIDE `logUnauthorized`'s per-IP 60 s throttle: that
          // throttle exists so a looping device does not flood a terminal, but
          // this counts the attempts the operator is shown.
          this.pairingApproval?.record(remoteIp, deviceId, token.length > 0);
          this.logUnauthorized(remoteIp, token.length > 0, peerKind, board);
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
      } else if (isBoardWebSocketLibrary(req.headers['user-agent'])) {
        // links2004/WebSockets announces itself on every upgrade. An untagged
        // board (firmware older than the `?clientType=esp32` tag) is thereby
        // board-class from byte one — not one connect too late — so dashboards
        // no longer need the board frame limit applied to them just in case.
        this.esp32Clients.add(ws);
        debug('WS', 'ESP32 WiFi client tagged from its WebSocket library');
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
    const actionability = broadcastActionability(event);
    this.broadcastCounts[actionability === 'n/a' ? 'unclassified' : actionability]++;
    debug('WS', `broadcast(${event.type}) to ${clientCount} clients actionability=${actionability}`);
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

  /**
   * Enable cable-free ESP32 re-arming on this server (daemon only).
   *
   * Whether any given board is re-armed is still decided by the operator's
   * window (`mayAdoptEsp32`); this only grants the server the ability at all.
   */
  setEsp32AdoptionProvider(
    provider: (() => { authToken: string; bridgeIp: string; bridgePort: number } | null) | null,
  ): void {
    this.esp32AdoptionProvider = provider;
  }

  /**
   * Enable operator-approval authentication on this server (daemon only).
   *
   * With no hooks the server behaves exactly as before: a peer authenticates by
   * token or not at all, and a refusal is only logged.
   */
  setPairingApprovalHooks(
    hooks: {
      isApproved: (ip: string, deviceId: string | null) => boolean;
      record: (ip: string, deviceId: string | null, staleToken: boolean) => void;
    } | null,
  ): void {
    this.pairingApproval = hooks;
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
  private logUnauthorized(ip: string, presentedToken: boolean, peerKind?: string, board?: string): void {
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
    // `board` is absent on firmware old enough to predate the query parameter,
    // and that absence is itself dating information — say so rather than
    // printing an empty pair of parentheses.
    const what = peerKind && board ? `${peerKind}, ${board}`
      : peerKind ? `${peerKind}, board not reported — firmware predates the board query param`
      : undefined;
    const who = what ? `${ip} (${what})` : ip;
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
