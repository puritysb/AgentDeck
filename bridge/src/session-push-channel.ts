/**
 * Push-channel message handling — the daemon side of the session bridge's
 * `DaemonWsClient` socket (`session_push_register` / `session_push_state` /
 * `session_event_up`).
 *
 * Extracted from the `startDaemon` closure so the REAL registration /
 * state-update / reverse-event logic is integration-testable with fake
 * sockets: the reviewer-required regressions (ssh -L loopback registration,
 * overlapping old/new sockets, event ownership) drive this exact handler.
 */
import type { WebSocket } from 'ws';
import { debug } from './logger.js';
import { isLocalConnection } from './auth.js';
import { updatePushState } from './session-aggregator.js';
import {
  registerRemoteSession,
  updateRemoteSessionState,
  removeRemoteSession,
  getRemoteSession,
} from './remote-sessions.js';
import type { SessionFocusRelay } from './session-focus-relay.js';

/** The slice of BridgeCore the push channel needs — keeps tests free of the real core. */
export interface PushChannelCore {
  broadcastSessionsList(): Promise<void>;
  maybeBroadcastSessionsList(): void;
}

export interface PushChannelDeps {
  core: PushChannelCore;
  focusRelay: SessionFocusRelay;
  /** Production reads the socket's remote address; tests inject a fake. */
  getSenderIp?: (sender: WebSocket) => string;
}

function defaultGetSenderIp(sender: WebSocket): string {
  return (sender as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? '';
}

/**
 * Returns a handler for push-channel frames. The daemon calls it from its WS
 * message dispatch; a `true` return means the frame was consumed.
 */
export function createPushChannelHandler(deps: PushChannelDeps) {
  const { core, focusRelay } = deps;
  const getSenderIp = deps.getSenderIp ?? defaultGetSenderIp;

  return function handlePushChannelMessage(msg: { type?: string }, sender: WebSocket): boolean {
    if (msg.type === 'session_push_register') {
      const { sessionId, port: sessionPort, agentType: at, projectName: pn, host, remoteAttach, weight } = msg as any;
      debug('daemon', `session_push_register: ${sessionId} port=${sessionPort} agent=${at} host=${host ?? '-'} remote=${remoteAttach === true}`);
      // A session on ANOTHER machine isn't in this daemon's sessions.json, so
      // it is tracked in memory and driven back down this very socket.
      // Classification: the worker's explicit `remoteAttach` intent wins — an
      // `ssh -L`-forwarded worker arrives on loopback and is indistinguishable
      // from a local session by IP. The non-local-IP heuristic stays as
      // back-compat for older workers that never send the flag.
      const senderIp = getSenderIp(sender);
      if (remoteAttach === true || (senderIp && !isLocalConnection(senderIp))) {
        const displayHost = typeof host === 'string' && host ? host : senderIp.replace(/^::ffff:/, '');
        registerRemoteSession({
          sessionId,
          host: displayHost,
          port: sessionPort,
          agentType: at,
          projectName: pn,
          weight,
          sender,
        });
        // If this session is currently focused via an OLDER socket (worker
        // reconnect), move the focus to the new one before the old close fires.
        focusRelay.migrateSender(sessionId, sender);
        // Prune when the worker's push socket drops (process exit / network
        // loss) — but only if this socket is still the registered sender: a
        // reconnected worker's NEW registration must survive the OLD close.
        sender.once('close', () => {
          removeRemoteSession(sessionId, sender);
          focusRelay.handleSenderClosed(sessionId, sender);
          core.broadcastSessionsList().catch(() => {});
        });
        core.broadcastSessionsList().catch(() => {});
      }
      // Acknowledge registration — unconditionally, local registrations too:
      // the worker's `registered` / `isConnected` flags depend on this ack.
      try { sender.send(JSON.stringify({ type: 'session_push_ack', sessionId })); } catch { /* client disconnecting */ }
      return true; // consumed
    }
    if (msg.type === 'session_push_state') {
      const { sessionId, state, modelName, effortLevel, permissionMode } = msg as any;
      if (sessionId && state) {
        // Whenever a remote registration exists, the WHOLE update is keyed to
        // its registered sender socket — the aggregator cache included. In the
        // local + --remote-daemon dual-registration case the sessions list
        // dedups to the local row (daemon-server.ts) whose displayed state
        // comes from this cache (session-aggregator.ts enricher via
        // getPushState), so a stale pre-reconnect socket poisoning it would
        // show through despite the registry's own guard. Sessions with no
        // remote registration keep the plain unguarded local path.
        const rs = getRemoteSession(sessionId);
        const staleSender = rs?.sender !== undefined && rs.sender !== sender;
        if (!staleSender) {
          updatePushState(sessionId, state, modelName, effortLevel, permissionMode);
          updateRemoteSessionState(sessionId, state, modelName, effortLevel, permissionMode, sender);
          // Trigger sessions list broadcast so clients get fresh state
          core.maybeBroadcastSessionsList();
        }
      }
      return true; // consumed
    }
    if (msg.type === 'session_event_up') {
      // A focused remote session's event rode back up its push socket
      // (same-socket reverse control). Ownership check: only the session's
      // registered sender may speak for it — a stale or foreign socket's
      // events are dropped.
      const { sessionId, event } = msg as any;
      if (sessionId && event?.type && getRemoteSession(sessionId)?.sender === sender) {
        focusRelay.ingestReverseEvent(sessionId, event);
      }
      return true; // consumed
    }
    return false;
  };
}
