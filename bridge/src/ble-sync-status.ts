/**
 * Live link state for the daemon-managed Python BLE sync clients
 * (iDotMatrix `sync.py`, Timebox `sync_ble.py`).
 *
 * The Node daemon spawns these clients but cannot see the BLE link: both
 * scripts reconnect *inside* their own loop, so the child process stays alive
 * across a powered-off panel and "process running" says nothing about whether
 * anything is being driven. Node therefore reported only the configured device
 * list in `/health`, and every consumer that renders `BLEMatrixHealth.connected`
 * — the macOS menubar topology list, the Dashboard TopologyRail, the TUI —
 * drew both panels as disconnected forever while they were streaming happily.
 *
 * The clients now print one `AGENTDECK_STATUS {...}` line per state *change*
 * (see `pysync/matrix_sync_common.py`); this module folds those into the same
 * `{connected, statusReason, displayDimmed, hasFrame, lastError}` shape the
 * Swift daemon's `TimeboxModule.refreshShadow()` / `IDotMatrixModule` emit, so
 * the two daemons can't disagree about why a panel isn't streaming.
 *
 * `statusReason` wording is mirrored from `TimeboxModule.currentStatusReason()`
 * (Swift) — keep the two in step, `MenuBarTopologyList.bleMatrixStatus()`
 * keys its LED colour off the words "paused" / "connecting" / "retry".
 */

/** One BLE panel's live link state, in the `BLEMatrixHealth` wire shape. */
export interface BleLinkSnapshot {
  connected: boolean;
  hasFrame: boolean;
  displayDimmed: boolean;
  statusReason: string;
  lastError: string | null;
  lastPushAtMs: number | null;
}

/** Parsed `AGENTDECK_STATUS` payload from a sync client. */
export interface BleStatusLine {
  connected?: unknown;
  phase?: unknown;
  hasFrame?: unknown;
  dimmed?: unknown;
  error?: unknown;
}

export interface BleLinkTracker {
  /** Fold one parsed `AGENTDECK_STATUS` line from the child into the state. */
  applyStatusLine(payload: BleStatusLine): void;
  /** The supervisor is (re)spawning the child — link state is unknown again. */
  noteSpawn(): void;
  /** The child exited; `retryAtMs` is when the supervisor will respawn it. */
  noteExit(reason: string | null, retryAtMs: number | null): void;
  /** No child at all (BLE runtime missing, sync never started). */
  noteUnavailable(reason: string): void;
  /** Current state, given how many devices are configured right now. */
  snapshot(configuredDeviceCount: number): BleLinkSnapshot;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function createBleLinkTracker(): BleLinkTracker {
  let connected = false;
  // Sticky: a panel that has been painted once still has our frame on it while
  // the link is down, which is exactly what `hasFrame` means to the renderers.
  let hasFrame = false;
  let displayDimmed = false;
  let lastError: string | null = null;
  let lastPushAtMs: number | null = null;
  let retryAtMs: number | null = null;
  /** Set while no child is running at all — distinct from "child up, link down". */
  let unavailableReason: string | null = null;
  let everSpawned = false;

  return {
    applyStatusLine(payload: BleStatusLine): void {
      unavailableReason = null;
      connected = asBool(payload.connected);
      if (asBool(payload.hasFrame)) {
        hasFrame = true;
        lastPushAtMs = Date.now();
      }
      displayDimmed = asBool(payload.dimmed);
      // Explicit null clears a stale error once the client recovers — the
      // client always sends the key, so absence here only means a legacy
      // client, and retaining is the safer read for that case.
      if ('error' in payload) lastError = asText(payload.error);
      if (connected) retryAtMs = null;
    },
    noteSpawn(): void {
      everSpawned = true;
      unavailableReason = null;
      retryAtMs = null;
      connected = false;
      displayDimmed = false;
    },
    noteExit(reason: string | null, nextRetryAtMs: number | null): void {
      connected = false;
      displayDimmed = false;
      lastError = asText(reason);
      retryAtMs = nextRetryAtMs;
    },
    noteUnavailable(reason: string): void {
      connected = false;
      displayDimmed = false;
      unavailableReason = reason;
      retryAtMs = null;
    },
    snapshot(configuredDeviceCount: number): BleLinkSnapshot {
      return {
        connected,
        hasFrame,
        displayDimmed,
        lastError,
        lastPushAtMs,
        statusReason: reasonFor({
          configuredDeviceCount,
          connected,
          displayDimmed,
          lastError,
          retryAtMs,
          unavailableReason,
          everSpawned,
        }),
      };
    },
  };
}

interface ReasonInput {
  configuredDeviceCount: number;
  connected: boolean;
  displayDimmed: boolean;
  lastError: string | null;
  retryAtMs: number | null;
  unavailableReason: string | null;
  everSpawned: boolean;
}

/**
 * Human-readable reason the panel isn't streaming, so `/health` can tell
 * "device off", "paused while the host display sleeps" and "never attempted"
 * apart instead of an ambiguous `connected:false, lastError:null`.
 * Mirrors `TimeboxModule.currentStatusReason()` in the Swift daemon.
 */
export function reasonFor(input: ReasonInput): string {
  if (input.configuredDeviceCount === 0) return 'no device configured';
  if (input.connected) return input.displayDimmed ? 'paused: host display asleep' : 'connected';
  if (input.unavailableReason) return input.unavailableReason;
  if (input.lastError) return input.lastError;
  if (input.retryAtMs !== null && Date.now() < input.retryAtMs) return 'retrying (backed off)';
  if (!input.everSpawned) return 'sync not started';
  return 'connecting…';
}

/**
 * Fold several per-device trackers into the single module-level
 * `BLEMatrixHealth` the wire carries. `connected` is all-or-nothing so a
 * two-panel setup with one dead panel doesn't read as fully healthy, and the
 * surfaced reason is the first unhappy panel's.
 */
export function mergeBleLinkSnapshots(
  snapshots: BleLinkSnapshot[],
  configuredDeviceCount: number,
): BleLinkSnapshot {
  if (snapshots.length === 0) {
    return {
      connected: false,
      hasFrame: false,
      displayDimmed: false,
      lastError: null,
      lastPushAtMs: null,
      statusReason: reasonFor({
        configuredDeviceCount,
        connected: false,
        displayDimmed: false,
        lastError: null,
        retryAtMs: null,
        unavailableReason: null,
        everSpawned: false,
      }),
    };
  }
  const unhappy = snapshots.find((s) => !s.connected);
  const pushes = snapshots.map((s) => s.lastPushAtMs).filter((v): v is number => v !== null);
  return {
    connected: unhappy === undefined,
    hasFrame: snapshots.some((s) => s.hasFrame),
    displayDimmed: snapshots.every((s) => s.displayDimmed),
    lastError: snapshots.find((s) => s.lastError !== null)?.lastError ?? null,
    lastPushAtMs: pushes.length > 0 ? Math.max(...pushes) : null,
    statusReason: (unhappy ?? snapshots[0]).statusReason,
  };
}
