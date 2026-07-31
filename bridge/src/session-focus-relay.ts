/**
 * Session Focus Relay — daemon subscribes to a focused session bridge's
 * WebSocket to relay its full state events to all daemon clients,
 * and routes commands from daemon clients to the focused session.
 *
 * Only one session can be focused at a time. Focusing a new session
 * disconnects from the previous one.
 *
 * Events are passed to onEvent callback (not broadcast directly) so the
 * daemon can merge session state with daemon-level metadata (modelCatalog,
 * gatewayAvailable, ollamaStatus, etc.) before broadcasting.
 */

import WebSocket from 'ws';
import { listActive as listActiveSessions } from './session-registry.js';
import type { PluginCommand, BridgeEvent } from './types.js';
import { debug } from './logger.js';

/** Where a focusable LOCAL session lives (loopback dial to its bridge port).
 *  Remote sessions are reachable only via the same-socket resolver. */
export interface FocusTarget {
  host: string;
  port: number;
}

const TAG = 'focus-relay';

/**
 * Events relayed from a focused session to daemon clients. Canonical set for
 * BOTH ends of the relay: the daemon side filters here, and the worker side
 * (`DaemonWsClient.forwardEvent`) imports this same set — the two ends cannot
 * drift on which events ride the push socket.
 */
export const RELAYED_EVENTS = new Set([
  'state_update',
  'prompt_options',
  'usage_update',
]);

/** Commands routed from daemon clients to focused session */
const ROUTED_COMMANDS = new Set([
  'respond',
  'interrupt',
  'escape',
  'select_option',
  'send_prompt',
  'navigate_option',
  'switch_mode',
]);

export type FocusEventHandler = (event: BridgeEvent) => void;

export class SessionFocusRelay {
  private ws: WebSocket | null = null;
  private focusedSessionId: string | null = null;
  private focusedTarget: FocusTarget | null = null;
  private onEvent: FocusEventHandler | null = null;
  private closed = false;
  /** Resolver for a remote session's live push socket (same-socket reverse control). */
  private sameSocketResolver: ((sessionId: string) => WebSocket | null) | null = null;
  /** When focused via same-socket, the worker's push socket we drive commands down. */
  private focusedSender: WebSocket | null = null;

  /** Set handler for relayed events. Daemon should merge and broadcast. */
  setEventHandler(handler: FocusEventHandler): void {
    this.onEvent = handler;
  }

  /**
   * Install a resolver mapping a sessionId to its live push socket. This is the
   * ONLY reverse path for remote (cross-machine) sessions: the daemon drives the
   * session by writing `session_command_down` frames back down the socket the
   * worker already opened — so NAT'd / SSH-only workers need no inbound
   * reachability, and the daemon never dials back.
   */
  setSameSocketResolver(resolver: (sessionId: string) => WebSocket | null): void {
    this.sameSocketResolver = resolver;
  }

  /**
   * Feed a `session_event_up` event that rode back up a worker's push socket
   * (same-socket reverse control). Only applied while that session is focused.
   */
  ingestReverseEvent(sessionId: string, event: BridgeEvent): void {
    if (sessionId !== this.focusedSessionId || !this.focusedSender) return;
    if (!RELAYED_EVENTS.has(event.type)) return;
    debug(TAG, `Relay(same-socket) ${event.type} from session ${sessionId}`);
    // prompt_options used to be source-less, allowing a late event from the
    // previous focus to become buttons for the newly selected session. Stamp
    // the relay identity before it leaves this boundary (parity with the
    // local dial path's stamping in connect()).
    const tagged = event.type === 'prompt_options'
      ? { ...event, sessionId, focusedSessionId: sessionId }
      : event;
    this.onEvent?.(tagged as BridgeEvent);
  }

  /**
   * Drop the same-socket focus when the focused worker's push socket goes away.
   * `closedSocket` guards against the stale-socket race: when a worker
   * reconnects, the NEW socket takes over focus (see `migrateSender`) before
   * the OLD one finishes closing — the old close must not tear the new focus
   * down. A no-arg call (legacy) unfocuses unconditionally.
   */
  handleSenderClosed(sessionId: string, closedSocket?: WebSocket): void {
    if (sessionId !== this.focusedSessionId || !this.focusedSender) return;
    if (closedSocket !== undefined && closedSocket !== this.focusedSender) return;
    this.unfocus();
  }

  /**
   * A currently-focused session re-registered with a new push socket (worker
   * reconnect). Move the focus to the new socket so control continues without
   * an unfocus/refocus cycle: stop the old sender's forwarding (best-effort),
   * swap, and re-send `session_focus_down` down the new socket.
   */
  migrateSender(sessionId: string, newSender: WebSocket): void {
    if (sessionId !== this.focusedSessionId || !this.focusedSender) return;
    if (this.focusedSender === newSender) return;
    if (this.focusedSender.readyState === WebSocket.OPEN) {
      try {
        this.focusedSender.send(JSON.stringify({ type: 'session_unfocus_down', sessionId }));
      } catch { /* closing */ }
    }
    this.focusedSender = newSender;
    debug(TAG, `Migrated focus for ${sessionId} to new push socket`);
    try { newSender.send(JSON.stringify({ type: 'session_focus_down', sessionId })); } catch { /* closing */ }
  }

  /** Get currently focused session ID */
  getFocusedSessionId(): string | null {
    return this.focusedSessionId;
  }

  /** Focus a session by ID. Disconnects from previous session. */
  focus(sessionId: string): void {
    const stillLive =
      (this.focusedSender && this.focusedSender.readyState === WebSocket.OPEN) ||
      this.ws?.readyState === WebSocket.OPEN;
    if (this.focusedSessionId === sessionId && stillLive) {
      debug(TAG, `Already focused on ${sessionId}`);
      return;
    }

    this.unfocus();

    // 1. Same-socket: if the worker has a live push socket, drive it down that
    //    socket. No inbound dial, works for NAT'd / SSH-only workers. This is
    //    the ONLY path for remote sessions — a remote session whose socket
    //    dropped stays unfocusable until its worker reconnects.
    const sender = this.sameSocketResolver?.(sessionId) ?? null;
    if (sender && sender.readyState === WebSocket.OPEN) {
      this.focusedSessionId = sessionId;
      this.focusedSender = sender;
      debug(TAG, `Focusing session ${sessionId} via same-socket reverse control`);
      try { sender.send(JSON.stringify({ type: 'session_focus_down', sessionId })); } catch { /* closing */ }
      return;
    }

    // 2. Local sessions: dial the bridge's loopback port from sessions.json
    //    (the pre-existing local focus mechanism).
    const session = listActiveSessions().find(s => s.id === sessionId && s.agentType !== 'daemon');
    if (!session) {
      debug(TAG, `Session ${sessionId} not found, not local, or is daemon`);
      return;
    }

    this.focusedSessionId = sessionId;
    this.focusedTarget = { host: '127.0.0.1', port: session.port };
    debug(TAG, `Focusing session ${sessionId} at 127.0.0.1:${session.port}`);
    this.connect();
  }

  /** Unfocus current session. */
  unfocus(): void {
    // Same-socket: tell the worker to stop forwarding events up its push socket.
    if (this.focusedSender) {
      if (this.focusedSender.readyState === WebSocket.OPEN && this.focusedSessionId) {
        try {
          this.focusedSender.send(JSON.stringify({ type: 'session_unfocus_down', sessionId: this.focusedSessionId }));
        } catch { /* closing */ }
      }
      this.focusedSender = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.focusedSessionId) {
      debug(TAG, `Unfocused session ${this.focusedSessionId}`);
    }
    this.focusedSessionId = null;
    this.focusedTarget = null;
  }

  /** Route a command to the focused session. Returns true if handled. */
  routeCommand(cmd: PluginCommand): boolean {
    if (!this.focusedSessionId || !ROUTED_COMMANDS.has(cmd.type)) {
      return false;
    }
    // Same-socket (remote sessions): send the command down the worker's push socket.
    if (this.focusedSender) {
      if (this.focusedSender.readyState !== WebSocket.OPEN) return false;
      debug(TAG, `Routing(same-socket) ${cmd.type} → session ${this.focusedSessionId}`);
      this.focusedSender.send(JSON.stringify({ type: 'session_command_down', sessionId: this.focusedSessionId, command: cmd }));
      return true;
    }
    // Local sessions: the loopback WS dialed in connect().
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    debug(TAG, `Routing ${cmd.type} → session ${this.focusedSessionId}`);
    this.ws.send(JSON.stringify(cmd));
    return true;
  }

  /** Stop relay entirely. */
  stop(): void {
    this.closed = true;
    this.unfocus();
  }

  private connect(): void {
    if (this.closed || !this.focusedTarget) return;

    const { port } = this.focusedTarget;
    // Local sessions only — loopback, no token (same-machine is authenticated).
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws = ws;
    const sessionId = this.focusedSessionId;

    ws.on('open', () => {
      debug(TAG, `Connected to session ${sessionId} at 127.0.0.1:${port}`);
    });

    ws.on('message', (raw: Buffer | string) => {
      if (this.focusedSessionId !== sessionId) return;

      try {
        const evt = JSON.parse(raw.toString()) as BridgeEvent;
        if (RELAYED_EVENTS.has(evt.type)) {
          debug(TAG, `Relay ${evt.type} from session ${sessionId}`);
          // prompt_options used to be source-less, allowing a late event from
          // the previous focus to become buttons for the newly selected session.
          // Stamp the captured relay identity before it leaves this boundary.
          const tagged = evt.type === 'prompt_options' && sessionId
            ? { ...evt, sessionId, focusedSessionId: sessionId }
            : evt;
          this.onEvent?.(tagged as BridgeEvent);
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    ws.on('close', () => {
      if (this.focusedSessionId === sessionId) {
        debug(TAG, `Session ${sessionId} WS closed`);
        this.ws = null;
      }
    });

    ws.on('error', () => {});
  }
}
