/**
 * ConnectionManager → Property Inspector status line (#307).
 *
 * The OFFLINE key on the device only ever shows the word OFFLINE — nothing
 * there can distinguish "no daemon.json anywhere" from "found one but its
 * pid is dead" from "found a live daemon on a fallback port but haven't
 * connected yet." `ConnectionManager.getConnectionSnapshot()` already
 * carries every fact needed to tell those apart (see connection-manager.ts);
 * this module is the single place that turns that snapshot into the flat
 * payload the Property Inspector renders, and the single place an inbound
 * "retry now" / "send me the current status" message from the PI is
 * recognized. Keep the PI itself a dumb renderer: timestamps ride as raw
 * epoch-ms so the client derives "N ago" against its own clock rather than a
 * string baked at send time — the same rule AGENTS.md applies to every other
 * freshness field (a relative-time string frozen at send time goes stale the
 * moment the PI sits open without a new push).
 */
import type { JsonValue } from '@elgato/utils';
import type { ConnectionSnapshot } from './connection-manager.js';

/** Message type tag carried on every plugin → PI status payload. */
export const CONNECTION_STATUS_EVENT = 'connectionStatus' as const;
/** PI → plugin: "I just became visible, send the current snapshot." */
export const REQUEST_CONNECTION_STATUS_EVENT = 'requestConnectionStatus' as const;
/** PI → plugin: the user pressed the "Retry now" button. */
export const RETRY_CONNECTION_EVENT = 'retryNow' as const;

export interface ConnectionStatusPiPayload {
  [key: string]: JsonValue;
  event: typeof CONNECTION_STATUS_EVENT;
  /** Is the plugin's WebSocket to a daemon currently open. */
  connected: boolean;
  /** Plain-words daemon.json discovery outcome — never the raw enum. */
  daemonStatusLabel: string;
  /** Resolved daemon.json path, or a plain-words reason none is usable. */
  daemonPath: string;
  /** Port actually carrying traffic (connected) or last discovered (not yet connected). */
  port: number | null;
  /** Epoch-ms of the last discovery probe, or null if none has run yet. */
  lastProbeAt: number | null;
  /** Epoch-ms of the last user-triggered retry, or null if never retried. */
  lastRetryAt: number | null;
}

function daemonStatusLabel(status: ConnectionSnapshot['daemonStatus']): string {
  switch (status) {
    case 'found':
      return 'Daemon found';
    case 'missing':
      return 'Daemon not found';
    default:
      return 'Not probed yet';
  }
}

function daemonPathLabel(snapshot: ConnectionSnapshot): string {
  switch (snapshot.daemonStatus) {
    case 'found':
      // `message` is the resolved daemon.json path when discovery succeeded.
      return snapshot.message || '—';
    case 'missing':
      return 'not found';
    default:
      return '—';
  }
}

/**
 * The single source for the snapshot → PI payload shape. `retryNow()` and
 * `getConnectionSnapshot()` both return `ConnectionSnapshot`, so the retry
 * round-trip in plugin.ts is exactly: `retryNow()` → this → `sendToPropertyInspector`.
 */
export function buildConnectionStatusPayload(snapshot: ConnectionSnapshot): ConnectionStatusPiPayload {
  // Connected: the port actually carrying traffic (bridgePort) is the fact
  // worth showing. Not connected: discovery's own candidate (daemonPort) is
  // the interesting one — e.g. "found a daemon, but on a fallback port we
  // haven't reached yet."
  const port = snapshot.connected ? snapshot.bridgePort : snapshot.daemonPort;

  return {
    event: CONNECTION_STATUS_EVENT,
    connected: snapshot.connected,
    daemonStatusLabel: daemonStatusLabel(snapshot.daemonStatus),
    daemonPath: daemonPathLabel(snapshot),
    port: port && port > 0 ? port : null,
    lastProbeAt: snapshot.lastProbeAt > 0 ? snapshot.lastProbeAt : null,
    lastRetryAt: snapshot.lastRetryAt,
  };
}

/** True when `payload` is the PI's "Retry now" button message. */
export function isRetryNowMessage(payload: unknown): boolean {
  return isPiEvent(payload, RETRY_CONNECTION_EVENT);
}

/** True when `payload` is the PI's "I just appeared, send status" message. */
export function isRequestConnectionStatusMessage(payload: unknown): boolean {
  return isPiEvent(payload, REQUEST_CONNECTION_STATUS_EVENT);
}

function isPiEvent(payload: unknown, event: string): boolean {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as { event?: unknown }).event === event
  );
}
