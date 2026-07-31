/**
 * Daemon-side registry of sessions that attached from another machine over the
 * push channel (see `daemon-ws-client.ts`). Local sessions live in
 * `sessions.json`; remote ones never touch this daemon's disk, so we track them
 * in memory keyed by sessionId, fed by `session_push_register` /
 * `session_push_state` and pruned when the push socket closes.
 *
 * The stored `sender` (the live push socket) is the ONLY control path: the
 * daemon drives the session down this socket (same-socket reverse control) and
 * never dials back. `host` + `port` are display/diagnostic metadata.
 */
import type { WebSocket } from 'ws';
import { sanitizeWeightForWire } from '@agentdeck/shared';
import type { EnrichedSession } from './session-aggregator.js';
import type { AgentType } from './types.js';

export interface RemoteSession {
  sessionId: string;
  host: string;
  port: number;
  agentType?: string;
  projectName?: string;
  state?: string;
  modelName?: string;
  effortLevel?: string;
  permissionMode?: string;
  /** Explicit deck/tab sort override, normalized for the cross-platform wire. */
  weight?: number;
  startedAt: string;
  updatedAt: number;
  /**
   * The live push socket this worker opened to us. Same-socket reverse control
   * drives the session by writing commands back down THIS socket, so a NAT'd /
   * SSH-only worker needs no inbound reachability. A session with no open
   * sender is unreachable until its worker reconnects.
   */
  sender?: WebSocket;
}

const remoteSessions = new Map<string, RemoteSession>();

export function registerRemoteSession(info: {
  sessionId: string;
  host: string;
  port: number;
  agentType?: string;
  projectName?: string;
  weight?: unknown;
  sender?: WebSocket;
}): void {
  const existing = remoteSessions.get(info.sessionId);
  const weight = info.weight === undefined
    ? existing?.weight
    : sanitizeWeightForWire(info.weight);
  remoteSessions.set(info.sessionId, {
    ...existing,
    sessionId: info.sessionId,
    host: info.host,
    port: info.port,
    agentType: info.agentType,
    projectName: info.projectName ?? existing?.projectName,
    weight,
    sender: info.sender ?? existing?.sender,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    updatedAt: Date.now(),
  });
}

/** The live push socket for a remote session (same-socket reverse control), if any. */
export function getRemoteSender(sessionId: string): WebSocket | undefined {
  return remoteSessions.get(sessionId)?.sender;
}

/**
 * Update a remote session's pushed state. When `sender` is given, the update is
 * applied only if it is the session's registered push socket — a stale socket
 * (pre-reconnect) must not clobber state pushed by the live one.
 */
export function updateRemoteSessionState(
  sessionId: string,
  state: string,
  modelName?: string,
  effortLevel?: string,
  permissionMode?: string,
  sender?: WebSocket,
): void {
  const s = remoteSessions.get(sessionId);
  if (!s) return;
  if (sender !== undefined && s.sender !== undefined && s.sender !== sender) return;
  s.state = state;
  s.modelName = modelName;
  s.effortLevel = effortLevel;
  s.permissionMode = permissionMode;
  s.updatedAt = Date.now();
}

export function getRemoteSession(sessionId: string): RemoteSession | undefined {
  return remoteSessions.get(sessionId);
}

/**
 * Remove a remote session. When `sender` is given, the entry is removed only if
 * that socket is still its registered sender: a worker reconnect replaces
 * `sender` first, and the OLD socket's close handler must not delete the NEW
 * registration.
 */
export function removeRemoteSession(sessionId: string, sender?: WebSocket): void {
  if (sender !== undefined) {
    const current = remoteSessions.get(sessionId);
    if (current?.sender !== undefined && current.sender !== sender) return;
  }
  remoteSessions.delete(sessionId);
}

export function hasRemoteSessions(): boolean {
  return remoteSessions.size > 0;
}

/** Render the remote sessions as enriched rows for the daemon sessions list. */
export function listRemoteEnriched(): EnrichedSession[] {
  const now = Date.now();
  return [...remoteSessions.values()].map((s) => ({
    id: s.sessionId,
    port: s.port,
    projectName: s.projectName ?? 'remote',
    agentType: s.agentType as AgentType | undefined,
    alive: true,
    state: s.state,
    modelName: s.modelName,
    effortLevel: s.effortLevel,
    permissionMode: s.permissionMode,
    weight: s.weight,
    startedAt: s.startedAt,
    controlMode: 'managed' as const,
    elapsedSec: Math.max(0, Math.round((now - Date.parse(s.startedAt)) / 1000)) || undefined,
  }));
}
