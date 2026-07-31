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
import { isLoopbackHost, formatHostForUrl, type DaemonTarget } from './session-registry.js';
// Canonical relayed-event set — shared with the daemon side so the two ends of
// the push socket cannot drift on which events are worth forwarding.
import { RELAYED_EVENTS } from './session-focus-relay.js';
import type { PluginCommand, BridgeEvent } from './types.js';

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
  /** This session's LAN host (display / diagnostics on the daemon side). */
  host?: string;
  /**
   * Explicit remote-attach intent. Sent only when the user opted in
   * (`--remote-daemon`) AND the resolved daemon advertises `sameSocketControl`.
   * The daemon must trust this flag over the socket's source IP: an
   * `ssh -L`-forwarded worker arrives on loopback and is indistinguishable
   * from a local session by IP alone.
   */
  remoteAttach?: boolean;
  /** Explicit deck/tab sort override. Always sent as a concrete integer
   *  (unweighted ⇒ 0, never omitted) — receivers merge retain-on-absent, so an
   *  only-sent-when-set field could be set but never reset. See shared
   *  sessionWeight / SESSION_WEIGHT_MIN..MAX. */
  weight: number;
}

/** Daemon → worker: run a plugin command against this session (same-socket reverse control). */
export interface SessionCommandDown {
  type: 'session_command_down';
  sessionId: string;
  command: PluginCommand;
}

/** Worker → daemon: a relayed session event, riding back up the push socket. */
export interface SessionEventUp {
  type: 'session_event_up';
  sessionId: string;
  event: BridgeEvent;
}

/** Daemon → worker: (un)focus — the worker forwards events up only while focused. */
export interface SessionFocusDown {
  type: 'session_focus_down' | 'session_unfocus_down';
  sessionId: string;
}


export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private target: DaemonTarget | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectBase: number;
  private reconnectDelay: number;
  private closed = false;
  private registered = false;
  /** True while a remote daemon has focused this session (same-socket reverse). */
  private focused = false;
  /** Applies a command the daemon sent down the socket — same handler as the local WS server. */
  private applyCommand: ((cmd: PluginCommand) => void) | null = null;
  /** Yields the initial events to emit up when the daemon focuses this session. */
  private focusSnapshot: (() => BridgeEvent[]) | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly sessionPort: number,
    private readonly agentType?: string,
    private readonly projectName?: string,
    /** Deck/tab sort override; normalized via shared sessionWeight() at send time. */
    private readonly weight?: number,
    /**
     * Resolves the daemon target (host + port + optional token) on each
     * (re)connect attempt. Lets the client follow port drift (daemon restart
     * onto a fallback port), cover the daemon-not-up-yet case, and — when the
     * remote-attach path is enabled — discover a daemon on another machine.
     *
     * `resolveDaemonTarget` in `session-registry.ts` is the canonical provider
     * (local → explicit host → mDNS). Return `null` to defer; the client keeps
     * retrying on backoff.
     */
    private readonly targetProvider?: () => DaemonTarget | null | Promise<DaemonTarget | null>,
    /** This session's LAN host (display / diagnostics on the daemon side). */
    private readonly sessionHost?: string,
    /**
     * User opted in to remote attach (`--remote-daemon` /
     * `AGENTDECK_REMOTE_DAEMON=1`). Combined per-target with the daemon's
     * advertised `sameSocketControl` capability to decide whether the
     * registration carries `remoteAttach: true`, and to refuse dialing a
     * capability-less target at all.
     */
    private readonly remoteEnabled?: boolean,
    /** Reconnect backoff base in ms — injectable so tests don't wait out real 2s+ backoffs. */
    reconnectBaseMs?: number,
  ) {
    this.reconnectBase = reconnectBaseMs ?? RECONNECT_BASE;
    this.reconnectDelay = this.reconnectBase;
  }

  /**
   * Start the connection loop. If `target` is null and a `targetProvider`
   * was supplied, the client waits on backoff until the provider yields a
   * target (daemon catches up on a later launch).
   *
   * Note: when a `targetProvider` exists, its result — null included —
   * replaces this seed on every (re)connect attempt; the seed only covers
   * the very first dial in provider-less usage.
   */
  connect(target: DaemonTarget | null): void {
    if (this.closed) return;
    if (target != null) {
      this.target = target;
      void this.doConnect();
    } else {
      this.scheduleReconnect();
    }
  }

  /**
   * Enable same-socket reverse control. When a remote daemon focuses this
   * session it sends `session_command_down` frames back down the push socket
   * (no inbound dial to our port — works for NAT'd / SSH-only workers).
   * `applyCommand` feeds inner commands into the same handler the local WS
   * server uses; `focusSnapshot` yields the initial events to emit up on focus.
   */
  setReverseControl(applyCommand: (cmd: PluginCommand) => void, focusSnapshot: () => BridgeEvent[]): void {
    this.applyCommand = applyCommand;
    this.focusSnapshot = focusSnapshot;
  }

  /** Forward a broadcast event up the push socket while the daemon has us focused. */
  forwardEvent(evt: BridgeEvent): void {
    if (!this.focused || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!RELAYED_EVENTS.has(evt.type)) return;
    const msg: SessionEventUp = { type: 'session_event_up', sessionId: this.sessionId, event: evt };
    try { this.ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
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
      // ws throws if closed while still CONNECTING — terminate covers that case.
      try { this.ws.close(); } catch { try { this.ws.terminate(); } catch { /* ignore */ } }
      this.ws = null;
    }
    this.registered = false;
    this.focused = false;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.registered;
  }

  // ---- Internals ----

  private async doConnect(): Promise<void> {
    if (this.closed) return;
    if (this.targetProvider) {
      let resolved: DaemonTarget | null;
      try {
        resolved = await this.targetProvider();
      } catch (err) {
        debug(TAG, `targetProvider threw: ${err instanceof Error ? err.message : String(err)}`);
        resolved = null;
      }
      if (this.closed) return;
      // Under remote intent the client itself refuses a capability-less target,
      // independent of the resolver's own gate — a downgraded/replaced daemon
      // must never be dialed just because a resolver variant let it through.
      if (this.remoteEnabled && resolved && resolved.sameSocketControl !== true) {
        debug(TAG, `Resolved daemon ${resolved.host}:${resolved.port} lacks sameSocketControl under remote intent — refusing`);
        resolved = null;
      }
      // The provider result replaces the cached target on EVERY resolution,
      // null included: after the daemon disappears or is replaced by an
      // incapable one, redialing the stale target would bypass the capability
      // refusal (and reuse a dead token). Null holds the reconnect loop until
      // a valid target resolves again.
      const prev = this.target ? `${this.target.host}:${this.target.port}` : 'null';
      const next = resolved ? `${resolved.host}:${resolved.port}` : 'null';
      if (prev !== next) {
        debug(TAG, `Daemon target resolved ${prev} → ${next}${resolved ? '' : ' (resolution failed; holding reconnect)'}`);
      }
      this.target = resolved;
    }
    if (!this.target) {
      this.scheduleReconnect();
      return;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    const { host, port, token } = this.target;
    // Loopback needs no token (daemon treats same-machine as authenticated);
    // a remote daemon requires its advertised pairing token on the query string.
    const url = isLoopbackHost(host)
      ? `ws://127.0.0.1:${port}`
      : `ws://${formatHostForUrl(host)}:${port}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    // Never log the URL itself — it can carry the daemon's pairing token.
    debug(TAG, `Connecting to daemon at ws://${formatHostForUrl(host)}:${port} (token: ${token ? 'yes' : 'no'})`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      debug(TAG, `Connected to daemon ${host}:${port}`);
      this.reconnectDelay = this.reconnectBase;
      this.sendRegister();
    });

    this.ws.on('close', () => {
      debug(TAG, 'Daemon WS closed');
      this.registered = false;
      this.focused = false;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      debug(TAG, `WS error: ${err.message}`);
      // close event will fire after error
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case 'session_push_ack':
            this.registered = true;
            debug(TAG, 'Registration acknowledged');
            break;
          // ── Same-socket reverse control (daemon → this session) ──
          // Down-frames addressed to another session are ignored outright: a
          // daemon-side routing bug must not drive this session's PTY.
          case 'session_command_down':
            if (msg.sessionId !== this.sessionId) {
              debug(TAG, `ignoring session_command_down for foreign session ${msg.sessionId}`);
              break;
            }
            if (msg.command && this.applyCommand) {
              debug(TAG, `reverse cmd: ${msg.command.type}`);
              this.applyCommand(msg.command as PluginCommand);
            }
            break;
          case 'session_focus_down':
            if (msg.sessionId !== this.sessionId) break;
            this.focused = true;
            debug(TAG, 'Focused by daemon — forwarding events up');
            // Emit an initial snapshot so the controlling deck shows state at once.
            if (this.focusSnapshot) {
              for (const evt of this.focusSnapshot()) this.forwardEvent(evt);
            }
            break;
          case 'session_unfocus_down':
            if (msg.sessionId !== this.sessionId) break;
            this.focused = false;
            debug(TAG, 'Unfocused by daemon');
            break;
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
      host: this.sessionHost,
      // Per-target decision: intent (user opt-in) AND capability (daemon can
      // actually drive us down this socket). A capability-less daemon (Swift
      // App Store) gets a plain local-style registration instead.
      remoteAttach: (this.remoteEnabled && this.target?.sameSocketControl === true) || undefined,
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
