/**
 * ESP32 Serial Bridge — bidirectional USB serial communication.
 *
 * Detects ESP32 devices (CH340/CP210x) on USB serial ports,
 * opens the port for read+write, and sends newline-delimited JSON
 * matching the same protocol as WebSocket.
 *
 * Read path: parses newline-delimited JSON from ESP32 (device_info,
 * wifi_provision_ack, wifi_status). Non-JSON debug lines are ignored.
 *
 * ESP32 side reads lines starting with '{' and passes to Protocol::parseMessage().
 */

import { exec, execFile } from 'child_process';
import {
  openSync,
  close,
  read,
  write,
  readFileSync,
  writeFileSync,
  mkdirSync,
  constants as fsConstants,
  type WriteStream,
  type ReadStream,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { BridgeEvent } from './types.js';
import { SERIAL_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import type { ESP32ToHostMessage, WifiProvisionMessage } from '@agentdeck/shared/protocol';
import { formatResetTime } from '@agentdeck/shared';
import { debug, logTagged } from './logger.js';

/** @internal Exported for testing only */
export const ESP32_PORT_PATTERNS = [
  /\/dev\/cu\.usbserial-\w+/,    // CP210x / CH340 (cu.usbserial-XXXX)
  /\/dev\/cu\.wchusbserial\w+/,  // CH340 (cu.wchusbserialXXXX — 86 Box)
  /\/dev\/cu\.usbmodem\w+/,      // Native USB JTAG (IPS 3.5", Round AMOLED)
  /\/dev\/ttyUSB\w+/,            // Linux CH340
  /\/dev\/ttyACM\w+/,            // Linux native USB
];

/** @internal Exported for testing only */
export const EXCLUDE_PATTERNS = [
  /Bluetooth/i,
  /WLAN/i,
];

/** No-traffic threshold. ESP32 firmware should answer device_info/heartbeat JSON. */
const STALE_THRESHOLD_MS = 60000; // 60 seconds
const INITIAL_READ_TIMEOUT_MS = 20000;
const DEVICE_INFO_RETRY_MS = 5000;
const DEVICE_INFO_READ_RETRY_MS = 5000;
const DEVICE_INFO_MAX_REQUESTS = 10;
// A serial port that opens fine but never speaks the AgentDeck protocol (e.g. a
// TRMNL e-ink panel, or any third-party USB-serial device) would otherwise be
// reopened every poll — and opening a port toggles DTR/RTS, which resets an
// ESP32. After this many failed identification cycles we denylist the port for a
// cooldown so we stop holding/resetting foreign hardware.
const FOREIGN_MAX_PROBE_FAILURES = 3;
const FOREIGN_DENYLIST_COOLDOWN_MS = 10 * 60_000; // 10 minutes, then re-probe once
const FOREIGN_CDC_GRACE_MS = 90_000; // a held-open CDC port gets this long to identify
// An *identified* CDC port (live or cache-restored board) that reads nothing for
// this long since (re)connect is half-open: the board reset/re-enumerated and its
// RX pipe is dead, but heartbeat writes keep succeeding so the write-death reaper
// never fires. Larger than FOREIGN_CDC_GRACE_MS so an unidentified foreign port is
// always caught by the foreign clause first.
const CDC_SILENT_READ_TIMEOUT_MS = 120_000;
// An *identified* UART port whose RX died mid-connection: it HAS read before,
// then went silent. The dual read+write stale clause can never catch this —
// heartbeat writes land in the kernel buffer every 5s, so writeAge stays ~0
// forever (same trap the CDC comment above documents, but for a port that used
// to read). With keepalive acks every 5s, this long a silence is ~36 missed
// acks: the board hung, rebooted into a bad state, or the CH340 RX path
// wedged. Recycle the FD so re-poll reopens it — the reopen's DTR/RTS toggle
// resets the board, which is the self-heal.
const UART_SILENT_READ_TIMEOUT_MS = 180_000;
const SERIAL_OPEN_PROBE_TIMEOUT_MS = 1500;
// Serial open-failure backoff. Every open() (including the probe subprocess)
// toggles DTR/RTS and RESETS the attached board, so a port that keeps failing
// to open — a wedged CH340, a stuck bridge — must escalate its retry cadence
// instead of rebooting an otherwise-healthy board every 10s poll. Mirror of
// Swift ESP32Serial.openFailureBackoff. See GitHub #78 / memory
// ips10-wedged-ch340-daemon-reset-poke.
const SERIAL_OPEN_FAIL_ESCALATION_THRESHOLD = 4;
const SERIAL_TRANSIENT_MAX_BACKOFF_MS = 60_000;
const SERIAL_OPEN_PERMANENT_BLOCK_MS = 300_000; // 5 min: EACCES, or an escalated wedge

/**
 * Backoff (ms) before re-attempting to open a port that failed to open.
 * Transient cadence by consecutive failCount: 1→10s, 2→20s, 3→40s, 4→80s,
 * 5→160s, 6+→300s — the exponential cap rises from SERIAL_TRANSIENT_MAX_BACKOFF_MS
 * (60s) to SERIAL_OPEN_PERMANENT_BLOCK_MS (5 min) once failCount reaches
 * SERIAL_OPEN_FAIL_ESCALATION_THRESHOLD, so 300s is reached at the 6th failure
 * (a gradual ramp, not a cliff at the 4th). EACCES (permanent) uses the flat
 * 5-min block. Kept pure + exported so the cadence is unit-tested.
 */
export function serialOpenFailureBackoffMs(failCount: number, isPermanent: boolean): number {
  if (isPermanent) return SERIAL_OPEN_PERMANENT_BLOCK_MS;
  const cap = failCount >= SERIAL_OPEN_FAIL_ESCALATION_THRESHOLD
    ? SERIAL_OPEN_PERMANENT_BLOCK_MS
    : SERIAL_TRANSIENT_MAX_BACKOFF_MS;
  return Math.min(10_000 * Math.pow(2, failCount - 1), cap);
}
const SERIAL_WRITE_INTERVAL_MS = 120;
const SERIAL_MAX_QUEUE = 24;
// Firmware acks ONLY lines containing the quoted substring `"keepalive"`
// (esp32/src/net/serial_client.cpp sendHeartbeatAck) — those acks are the sole
// periodic board→host liveness signal, and every read-age check in this module
// (isResponsive, the half-open reapers) is calibrated to that 5s cadence. The
// former `serial_keepalive` type did NOT match the firmware's substring check,
// so boards never acked and the only reads were 60s device_info refreshes —
// one lost reply looked like a minute-long outage.
/** @internal Exported for testing only */
export const SERIAL_KEEPALIVE_JSON = JSON.stringify({ type: 'keepalive' });
const SERIAL_OPEN_PROBE_SCRIPT = `
const fs = require('fs');
const port = process.argv[1];
let fd = -1;
try {
  fd = fs.openSync(port, fs.constants.O_RDWR | (fs.constants.O_NOCTTY || 0) | (fs.constants.O_NONBLOCK || 0));
  fs.closeSync(fd);
  process.exit(0);
} catch (err) {
  if (fd >= 0) {
    try { fs.closeSync(fd); } catch {}
  }
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
}
`;

/** @internal Exported for testing only */
export interface SerialConnection {
  port: string;
  fd: number | null;
  stream: WriteStream;
  reader: ReadStream | null;
  readBuf: string;
  connected: boolean;
  deviceInfo: {
    board?: string;
    version?: string;
    buildHash?: string;
    buildEpoch?: number;
    wifiConfigured?: boolean;
    wifiConnected?: boolean;
    wifiRadioParked?: boolean;
    /** The board's own WiFi IP as it reports over serial. Lets the daemon match
     * this serial connection to the same board's WiFi WebSocket and prefer the
     * single serial path (getSerialReachableBoards → transport dedup). */
    ip?: string;
    uptimeSec?: number;
    resetReason?: string;
    resetReasonCode?: number;
    otaSupported?: boolean;
    otaSlotCount?: number;
    otaSlotSize?: number;
    otaFreeSketchSpace?: number;
    otaReason?: string;
    timelineCount?: number;
    sessionCount?: number;
    usageFiveH?: number;
    processingCount?: number;
  } | null;
  /** True once a device_info arrived on THIS connection (vs. cache-seeded).
   * Identify retries key off this — a cache-seeded deviceInfo must not stop
   * re-requests, or a reflashed board keeps its stale buildHash in /devices
   * until the next reboot-while-attached. */
  deviceInfoFresh: boolean;
  provisionSent: boolean;
  connectedAt: number;
  lastReadAt: number;  // Timestamp of last successful read from ESP32
  lastWriteAt: number; // Timestamp of last successful write to ESP32
  lastDeviceInfoRequestAt: number;
  deviceInfoRequestsSent: number;
  writeQueue: string[];
  writeTimer: ReturnType<typeof setTimeout> | null;
  /** While set and in the future, non-JSON serial lines from this port are
   * logged verbatim — opened by a panic marker line so crash backtraces
   * (Guru Meditation / register dump / Backtrace) land in the daemon log
   * instead of being silently discarded. */
  panicLogUntil?: number;
  panicLogLines?: number;
}

let connections: SerialConnection[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pollInProgress = false;
const openingPorts = new Set<string>();
const lastKnownDeviceInfoByPort = new Map<string, NonNullable<SerialConnection['deviceInfo']>>();
const lastErrorByPort = new Map<string, string>();
// Foreign (non-AgentDeck) serial ports: failure count + denylist-until timestamp.
const foreignProbeFailures = new Map<string, number>();
// Ports that fail to OPEN (wedged bridge): consecutive failure count + whether
// EACCES + last attempt. Drives serialOpenFailureBackoffMs so we don't DTR-reset
// a healthy board every poll. Cleared on a successful open or when the port is
// gone (a re-plug re-tries fresh) — same discipline as foreignProbeFailures.
const openFailures = new Map<string, { count: number; isPermanent: boolean; lastAttempt: number }>();
function recordSerialOpenFailure(port: string, err: any): void {
  const prev = openFailures.get(port);
  openFailures.set(port, {
    count: (prev?.count ?? 0) + 1,
    isPermanent: err?.code === 'EACCES',
    lastAttempt: Date.now(),
  });
}
const foreignDenylistUntil = new Map<string, number>();
let deviceInfoCacheLoaded = false;
let stateProvider: (() => BridgeEvent | null) | null = null;
let usageProvider: (() => BridgeEvent | null) | null = null;
let displayStateProvider: (() => BridgeEvent | null) | null = null;
let sessionsListProvider: (() => BridgeEvent | null) | null = null;
let initialStateProvider: (() => BridgeEvent[]) | null = null;
let messageHandler: ((port: string, msg: ESP32ToHostMessage) => void) | null = null;

// Events to forward — shared constant from @agentdeck/shared
const FORWARDED_EVENTS = SERIAL_FORWARDED_EVENTS;

function deviceInfoCachePath(): string {
  return join(process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck'), 'esp32-device-cache.json');
}

function loadDeviceInfoCache(): void {
  if (deviceInfoCacheLoaded) return;
  deviceInfoCacheLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(deviceInfoCachePath(), 'utf-8')) as Record<string, NonNullable<SerialConnection['deviceInfo']>>;
    for (const [port, info] of Object.entries(parsed)) {
      if (info?.board) lastKnownDeviceInfoByPort.set(port, info);
    }
  } catch {
    // Missing cache is normal.
  }
}

function persistDeviceInfoCache(): void {
  try {
    const path = deviceInfoCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(lastKnownDeviceInfoByPort), null, 2), 'utf-8');
  } catch (err) {
    debug('ESP32', `Failed to persist device cache: ${String(err)}`);
  }
}

// ESP32 without WiFi/NTP can't parse ISO dates — shared formatResetTime
// handles undefined and pre-formatted strings.

/**
 * Prepare a BridgeEvent for serial transmission.
 * - Pre-format ISO reset times (ESP32 has no NTP)
 * - Strip fields the ESP32 firmware doesn't parse (reduce size for small RX buffers)
 */
/** @internal Exported for testing only */
// Firmware (handleSessionsList) only stores the first N sessions; both sides
// must agree on the same cap. Keep in sync with esp32/src/net/protocol.cpp
// (sessions[10] / MOSAIC_MAX / min(...,10)).
export const SERIAL_SESSIONS_CAP = 10;

/**
 * Pick which sessions survive the serial session cap.
 *
 * A naive `slice(0, cap)` lets a single agent type (e.g. several idle Claude Code
 * sessions) fill every slot and starve other agents — a running Codex/OpenClaw
 * session that lands past the cap never reaches the firmware's creature renderer.
 *
 * Instead we round-robin across agent types so each present type claims at least
 * one slot before any type takes a second. Within a type, live + active
 * (non-idle) sessions are preferred so a processing session is never dropped in
 * favour of an idle sibling. Order within a type is otherwise preserved (stable).
 */
/** Total byte budget for a shipped timeline_history frame. The smallest board
 * line buffer is 4096 (InkDeck is 8192) — a larger line is discarded whole
 * on-device, so shipping it is pure waste at best and a WS-client killer at
 * worst. Mirrors ESP32Serial.timelineHistoryByteBudget (Swift daemon). */
export const TIMELINE_HISTORY_BYTE_BUDGET = 3500;

/** Keep the NEWEST entries whose summed JSON size fits the byte budget,
 * preserving chronological order for the ones that survive.
 * @internal Exported for testing only */
export function budgetTimelineEntries(entries: any[]): any[] {
  const kept: any[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(entries[i]), 'utf8') + 1;
    if (total + size > TIMELINE_HISTORY_BYTE_BUDGET) break;
    total += size;
    kept.push(entries[i]);
  }
  return kept.reverse();
}

export function roundRobinByAgentType(sessions: any[], cap: number): any[] {
  if (sessions.length <= cap) return sessions;

  const groups = new Map<string, any[]>();
  const order: string[] = [];
  for (const s of sessions) {
    const key = typeof s?.agentType === 'string' ? s.agentType : '';
    let bucket = groups.get(key);
    if (!bucket) { bucket = []; groups.set(key, bucket); order.push(key); }
    bucket.push(s);
  }

  // Within each type: alive first, then active (non-idle) first. Stable for ties.
  const rank = (s: any): number => {
    const alive = s?.alive ? 1 : 0;
    const state = typeof s?.state === 'string' ? s.state : '';
    const active = state && state !== 'idle' ? 1 : 0;
    return alive * 2 + active;
  };
  for (const key of order) {
    groups.get(key)!.sort((a, b) => rank(b) - rank(a));
  }

  const result: any[] = [];
  let progressed = true;
  while (result.length < cap && progressed) {
    progressed = false;
    for (const key of order) {
      const bucket = groups.get(key)!;
      if (bucket.length === 0) continue;
      result.push(bucket.shift());
      progressed = true;
      if (result.length >= cap) break;
    }
  }
  return result;
}

export function prepareForSerial(event: BridgeEvent, _conn?: Pick<SerialConnection, 'deviceInfo'>): BridgeEvent {
  const e = event as any;

  if (event.type === 'usage_update') {
    // WHITELIST of the fields the firmware actually parses (protocol.cpp
    // handleUsageUpdate). The old blocklist approach silently leaked every
    // NEW usage field onto the wire — modelCatalog alone (3.2KB) pushed the
    // line past the firmware's 4096-byte line buffer, so boards discarded
    // EVERY usage_update and their gauges froze on stale values.
    const cx = e.codexRateLimits
      ? {
          primary: e.codexRateLimits.primary
            ? { usedPercent: e.codexRateLimits.primary.usedPercent, resetsAt: formatResetTime(e.codexRateLimits.primary.resetsAt), stale: e.codexRateLimits.primary.stale }
            : undefined,
          secondary: e.codexRateLimits.secondary
            ? { usedPercent: e.codexRateLimits.secondary.usedPercent, resetsAt: formatResetTime(e.codexRateLimits.secondary.resetsAt), stale: e.codexRateLimits.secondary.stale }
            : undefined,
        }
      : undefined;
    // Subscriptions carry an ISO `until`; a serial device has no reliable
    // clock, so pre-format to a short "~M/D" the panel can render as-is.
    const subs = Array.isArray(e.subscriptions)
      ? e.subscriptions.map((sub: { name?: string; until?: string }) => ({
          name: limitString(sub.name, 27),
          until: formatShortDate(sub.until),
        })).filter((sub: { name?: string }) => sub.name)
      : undefined;
    const ag = e.antigravityStatus
      ? { planName: limitString(e.antigravityStatus.planName, 23), availableCredits: e.antigravityStatus.availableCredits }
      : undefined;
    return {
      type: 'usage_update',
      fiveHourPercent: e.fiveHourPercent,
      sevenDayPercent: e.sevenDayPercent,
      fiveHourResetsAt: formatResetTime(e.fiveHourResetsAt),
      sevenDayResetsAt: formatResetTime(e.sevenDayResetsAt),
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      toolCalls: e.toolCalls,
      sessionDurationSec: e.sessionDurationSec,
      estimatedCostUsd: e.estimatedCostUsd,
      usageStale: e.usageStale,
      ...(cx ? { codexRateLimits: cx } : {}),
      ...(subs ? { subscriptions: subs } : {}),
      ...(ag ? { antigravityStatus: ag } : {}),
    } as BridgeEvent;
  }

  if (event.type === 'state_update') {
    return {
      type: 'state_update',
      state: e.state,
      permissionMode: e.permissionMode,
      agentType: limitString(e.agentType, 15),
      currentTool: limitString(e.currentTool, 39),
      toolInput: limitString(e.toolInput, 79),
      projectName: limitString(e.projectName, 39),
      modelName: limitString(e.modelName, 31),
      effortLevel: limitString(e.effortLevel, 7),
      promptType: limitString(e.promptType, 19),
      question: limitString(e.question, 199),
      options: sanitizeOptions(e.options),
      gatewayAvailable: Boolean(e.gatewayAvailable),
      gatewayConnected: Boolean(e.gatewayConnected),
      gatewayHasError: Boolean(e.gatewayHasError),
    } as BridgeEvent;
  }

  if (event.type === 'timeline_event' || event.type === 'timeline_history') {
    // Panels have no local timezone — attach host-local "HH:MM" so the
    // InkDeck ticker (and future e-ink timelines) shows wall-clock time.
    const stamp = (entry: any) => {
      if (!entry || !Number.isFinite(entry.ts)) return entry;
      const d = new Date(entry.ts);
      return {
        ...entry,
        // Bound to the firmware's TimelineEntry buffers (raw[120]/detail[200]/
        // projectName[40]) so a history seed with long chat bodies can't
        // balloon the line.
        raw: limitString(entry.raw, 119) ?? '',
        detail: limitString(entry.detail, 199),
        ...(typeof entry.projectName === 'string' ? { projectName: limitString(entry.projectName, 39) } : {}),
        localHm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      };
    };
    if (event.type === 'timeline_event') return { ...e, entry: stamp(e.entry) };
    // The firmware ring keeps at most 64 rows (TIMELINE_MAX_ENTRIES) — older
    // entries would be shifted straight out again, so ship only the newest.
    // Row cap alone is not enough: a busy afternoon of CJK entries made the
    // 64-row frame ~37KB — far past the boards' 4KB line buffer, so serial
    // firmware discarded it whole and heap-tight WiFi boards dropped the
    // socket on it (chronic reconnect flap). Budget by BYTES, newest first.
    return {
      ...e,
      entries: Array.isArray(e.entries)
        ? budgetTimelineEntries(e.entries.slice(-64).map(stamp))
        : e.entries,
    };
  }

  if (event.type === 'sessions_list') {
    const raw = Array.isArray(e.sessions) ? e.sessions : [];
    return {
      type: 'sessions_list',
      sessions: roundRobinByAgentType(raw, SERIAL_SESSIONS_CAP).map((s: any) => ({
        id: limitString(s.id, 31),
        projectName: limitString(s.projectName, 39),
        modelName: limitString(s.modelName, 31),
        agentType: limitString(s.agentType, 15),
        state: limitString(s.state, 19),
        port: Number.isFinite(s.port) ? s.port : 0,
        alive: Boolean(s.alive),
        // Per-session detail for the IPS10 D1 mosaic (cells show tool/elapsed,
        // and awaiting cells render the real option buttons Claude reported).
        currentTool: limitString(s.currentTool, 39),
        promptType: limitString(s.promptType, 19),
        question: limitString(s.question, 159),
        elapsedSec: Number.isFinite(s.elapsedSec) ? Math.round(s.elapsedSec) : undefined,
        // Shared activity one-liner — the glanceable "what is it doing" line
        // (InkDeck session cards render it; other boards ignore it).
        activity: limitString(s.activity, 79),
        // Daemon-computed latest milestone (TIMELINE parity for the IPS10
        // cards). Omitted when absent to spare the 4KB serial line budget.
        ...(typeof s.lastEventText === 'string' && s.lastEventText
          ? {
              lastEventText: limitString(s.lastEventText, 99),
              ...(typeof s.lastEventTask === 'string' && s.lastEventTask
                ? { lastEventTask: limitString(s.lastEventTask, 39) } : {}),
              ...(typeof s.lastEventHm === 'string' && s.lastEventHm
                ? { lastEventHm: limitString(s.lastEventHm, 5) } : {}),
            }
          : {}),
        options: sanitizeOptions(s.options),
      })),
    } as BridgeEvent;
  }

  return event;
}

/**
 * Truncate to a UTF-8 BYTE budget on a code-point boundary. Firmware buffers are
 * byte-sized (`char raw[120]`, `question[160]`, …); the old UTF-16 `slice(0, max)`
 * let a 119-"char" 한글 string weigh ~357 bytes, so the board's strncpy did the
 * real cut — mid-sequence — and the panel rendered a broken trailing glyph.
 * Mirrored by the Swift daemon (ESP32Serial.limitUtf8Bytes).
 */
function limitString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value;
  let used = 0;
  let end = 0;
  for (const ch of value) {                       // iterates code points, not UTF-16 units
    const n = Buffer.byteLength(ch, 'utf-8');
    if (used + n > maxBytes) break;
    used += n;
    end += ch.length;
  }
  return value.slice(0, end);
}

/** ISO date → short "~M/D" for clock-less serial panels ('' when absent/invalid). */
function formatShortDate(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `~${d.getMonth() + 1}/${d.getDate()}`;
}

function sanitizeOptions(options: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(options)) return undefined;
  return options.slice(0, 8).map((o: any, index) => ({
    label: limitString(o?.label, 79) ?? '',
    shortcut: limitString(o?.shortcut, 39),
    index: Number.isFinite(o?.index) ? o.index : index,
    recommended: Boolean(o?.recommended),
    selected: Boolean(o?.selected),
  }));
}

/** Run a shell command with timeout, escalating to SIGKILL if SIGTERM fails. */
function execWithKill(cmd: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = exec(cmd, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    // Serial ioctl can enter uninterruptible kernel I/O on broken CDC ports.
    // On timeout, unblock our promise immediately instead of waiting for exit.
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error(`command timed out: ${cmd}`));
    }, timeoutMs + 1000);
    child.on('exit', () => clearTimeout(killTimer));
  });
}

function execFileWithKill(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const child = execFile(file, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (err) {
        const message = String(stderr || '').trim() || err.message;
        reject(new Error(message));
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });

    killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('exit', () => {
      if (killTimer) clearTimeout(killTimer);
    });
  });
}

async function probePortOpenable(port: string): Promise<void> {
  try {
    await execFileWithKill(process.execPath, ['-e', SERIAL_OPEN_PROBE_SCRIPT, port], SERIAL_OPEN_PROBE_TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`open probe failed: ${message}`);
  }
}

async function openFdWithProbe(port: string): Promise<number> {
  // Isolate potentially wedged macOS CDC/serial open calls in a short-lived
  // process. Promise.race around fs.open() in this daemon can leave late file
  // descriptors owned by the daemon after timeout, permanently blocking polls.
  await probePortOpenable(port);
  return openSync(port, fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
}

function readFromFd(fd: number, buf: Buffer): Promise<{ bytesRead: number }> {
  return new Promise((resolve, reject) => {
    read(fd, buf, 0, buf.length, null, (err, bytesRead) => {
      if (err) reject(err);
      else resolve({ bytesRead });
    });
  });
}

function writeToFd(fd: number, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    write(fd, data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function closeFd(fd: number): void {
  close(fd, () => {});
}

async function detectESP32Ports(): Promise<string[]> {
  try {
    const platform = process.platform;
    let output: string;

    if (platform === 'darwin') {
      output = await execWithKill('ls /dev/cu.usb* /dev/cu.wchusbserial* 2>/dev/null || true');
    } else if (platform === 'linux') {
      output = await execWithKill('ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true');
    } else {
      return [];
    }

    const ports = output.trim().split('\n').filter(Boolean);

    // Filter to ESP32 patterns, exclude known non-ESP32
    return ports.filter(port => {
      if (EXCLUDE_PATTERNS.some(p => p.test(port))) return false;
      return ESP32_PORT_PATTERNS.some(p => p.test(port));
    }).sort(compareSerialPorts);
  } catch (err) {
    lastErrorByPort.set('detect', `port detection failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function compareSerialPorts(a: string, b: string): number {
  const aNative = /usbmodem|ttyACM/.test(a);
  const bNative = /usbmodem|ttyACM/.test(b);
  if (aNative !== bNative) return aNative ? 1 : -1;
  return a.localeCompare(b);
}

function serialError(port: string, message: string): void {
  lastErrorByPort.set(port, message);
  debug('ESP32', message);
}

function isResponsive(conn: Pick<SerialConnection, 'connected' | 'lastReadAt' | 'lastWriteAt' | 'port' | 'connectedAt'>, now = Date.now()): boolean {
  if (!conn.connected) return false;

  const hasRead = conn.lastReadAt > 0;
  if (hasRead && (now - conn.lastReadAt) <= STALE_THRESHOLD_MS) {
    return true;
  }

  // Fallback for native USB CDC ports: if we have written to it successfully recently,
  // and it is open, consider it responsive. This prevents native CDC displays (which may
  // not send read data due to DTR/RTS line states in raw fs mode) from being marked disconnected.
  const isCDC = /usbmodem|ttyACM/.test(conn.port);
  if (isCDC && conn.lastWriteAt > 0 && (now - conn.lastWriteAt) <= STALE_THRESHOLD_MS) {
    return true;
  }

  // If no read has occurred yet, allow an initial grace period
  if (conn.lastReadAt <= 0) {
    return (now - conn.connectedAt) <= INITIAL_READ_TIMEOUT_MS;
  }

  return false;
}

/** @internal Exported for testing only */
export function isRetryableSerialIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EAGAIN' || code === 'EWOULDBLOCK';
}

function hasLiveDeviceInfo(conn: Pick<SerialConnection, 'deviceInfo' | 'lastReadAt' | 'port'>): boolean {
  const isCDC = /usbmodem|ttyACM/.test(conn.port);
  if (isCDC) {
    // CDC ports may have no read traffic but can still run dashboard/sessions if cached board type exists
    return Boolean(conn.deviceInfo?.board);
  }
  return Boolean(conn.deviceInfo?.board) && conn.lastReadAt > 0;
}

// ESP32 crash output is plain text on the same UART/CDC stream as the JSON
// protocol. These markers open a capture window so the whole dump (register
// dump lines don't individually match) is logged before the board reboots.
const PANIC_MARKER_RE = /Guru Meditation|Backtrace:|register dump|abort\(\) was called|assert failed|Stack smashing|Stack canary|Debug exception reason|ELF file SHA256|Rebooting\.\.\./i;
const PANIC_CAPTURE_WINDOW_MS = 10_000;
const PANIC_CAPTURE_MAX_LINES = 200;

/** @internal Exported for testing only */
export function capturePanicLine(conn: SerialConnection, line: string): boolean {
  const now = Date.now();
  const inWindow = conn.panicLogUntil != null && now < conn.panicLogUntil;
  const isMarker = PANIC_MARKER_RE.test(line);
  if (!inWindow && !isMarker) return false;
  if (isMarker) {
    // (Re)open the window on every marker — "Rebooting..." after the dump
    // keeps the bootloader reset-cause lines in scope too.
    conn.panicLogUntil = now + PANIC_CAPTURE_WINDOW_MS;
    if (!inWindow) conn.panicLogLines = 0;
  }
  const count = conn.panicLogLines ?? 0;
  if (count >= PANIC_CAPTURE_MAX_LINES) return false;
  conn.panicLogLines = count + 1;
  logTagged('esp32-panic', `${conn.port}: ${line}`);
  return true;
}

/** @internal Exported for testing only */
export function handleSerialLine(conn: SerialConnection, line: string): void {
  if (!line.startsWith('{')) {
    // Not protocol JSON — usually boot/debug chatter, but crash dumps arrive
    // here too. Capture those instead of dropping them.
    capturePanicLine(conn, line);
    return;
  }

  try {
    const msg = JSON.parse(line) as ESP32ToHostMessage;
    if (msg.type) {
      conn.lastReadAt = Date.now();  // Update last read timestamp
      debug('ESP32', `← ${conn.port}: ${msg.type}`);

      if (msg.type === 'device_info') {
        conn.deviceInfo = {
          board: msg.board,
          version: msg.version,
          buildHash: msg.buildHash,
          buildEpoch: msg.buildEpoch,
          wifiConfigured: msg.wifiConfigured,
          wifiConnected: msg.wifiConnected,
          wifiRadioParked: msg.wifiRadioParked,
          ip: (msg as any).ip,
          uptimeSec: msg.uptimeSec,
          resetReason: msg.resetReason,
          resetReasonCode: msg.resetReasonCode,
          otaSupported: msg.otaSupported,
          otaSlotCount: msg.otaSlotCount,
          otaSlotSize: msg.otaSlotSize,
          otaFreeSketchSpace: msg.otaFreeSketchSpace,
          otaReason: msg.otaReason,
          // Board-side reality counters (debug aid — surfaced on /devices so
          // "device shows nothing" can be diagnosed without stealing the port)
          timelineCount: (msg as any).timelineCount,
          sessionCount: (msg as any).sessionCount,
          usageFiveH: (msg as any).usageFiveH,
          processingCount: (msg as any).processingCount,
        };
        conn.deviceInfoFresh = true;
        if (conn.deviceInfo.board) {
          lastKnownDeviceInfoByPort.set(conn.port, conn.deviceInfo);
          persistDeviceInfoCache();
        }
      } else if (!conn.deviceInfoFresh &&
                 conn.deviceInfoRequestsSent < DEVICE_INFO_MAX_REQUESTS &&
                 Date.now() - conn.lastDeviceInfoRequestAt >= DEVICE_INFO_READ_RETRY_MS) {
        // Retry until a device_info arrives on THIS connection — the cache
        // seed keeps /devices populated meanwhile but must not silence the
        // re-identify (a lost reply or reflashed board would stay stale).
        sendDeviceInfoRequest(conn);
      }

      if (messageHandler) {
        messageHandler(conn.port, msg);
      }
    }
  } catch {
    // Not valid JSON — ignore (ESP32 debug output)
  }
}

async function startReadLoop(conn: SerialConnection): Promise<void> {
  const buf = Buffer.alloc(1024);
  while (conn.connected && conn.fd != null) {
    try {
      const fd = conn.fd;
      if (fd == null) break;
      const { bytesRead } = await readFromFd(fd, buf);
      if (bytesRead > 0) {
        const str = buf.toString('utf-8', 0, bytesRead);
        conn.readBuf += str;
        let newlineIdx: number;
        while ((newlineIdx = conn.readBuf.indexOf('\n')) !== -1) {
          const line = conn.readBuf.slice(0, newlineIdx).trim();
          conn.readBuf = conn.readBuf.slice(newlineIdx + 1);
          if (line.length > 0) {
            handleSerialLine(conn, line);
          }
        }
        if (conn.readBuf.length > 8192) {
          conn.readBuf = '';
        }
      } else {
        // EOF
        await new Promise(r => setTimeout(r, 20));
      }
    } catch (err: any) {
      if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
        // No data right now, wait 20ms and try again
        await new Promise(r => setTimeout(r, 20));
      } else {
        debug('ESP32', `Serial read error on ${conn.port}: ${err.message}`);
        closeConnection(conn);
        break;
      }
    }
  }
}

async function openPort(port: string): Promise<SerialConnection | null> {
  let fd: number | null = null;
  try {
    // Use one read/write fd. Opening /dev/cu.* separately for read and write
    // can make macOS serial look writable while ESP32 never receives host JSON.
    fd = await openFdWithProbe(port);

    const platform = process.platform;
    const isCDC = /usbmodem|ttyACM/.test(port);
    if (!isCDC && platform === 'darwin') {
      await execWithKill(`stty -f ${port} 115200 cs8 -cstopb -parenb -hupcl raw -echo`);
    } else if (!isCDC && platform === 'linux') {
      await execWithKill(`stty -F ${port} 115200 cs8 -cstopb -parenb -hupcl raw -echo`);
    }

    const stream = {
      destroyed: false,
      writable: true,
      write: () => true,
      destroy: () => {},
      on: () => {},
    } as any;

    const conn: SerialConnection = {
      port, fd, stream, reader: null, readBuf: '',
      connected: true, deviceInfo: lastKnownDeviceInfoByPort.get(port) ?? null,
      deviceInfoFresh: false, provisionSent: false,
      connectedAt: Date.now(),
      lastReadAt: 0,
      lastWriteAt: Date.now(),
      lastDeviceInfoRequestAt: 0,
      deviceInfoRequestsSent: 0,
      writeQueue: [],
      writeTimer: null,
    };

    const portType = isCDC ? 'CDC' : 'UART';
    debug('ESP32', `Opened serial port (r/w): ${port} [${portType}]`);

    // Start async read loop
    void startReadLoop(conn);

    // Request device info on connect
    sendDeviceInfoRequest(conn);

    // Send full initial state (state + usage + sessions) so ESP32 doesn't
    // have to wait for next state change or heartbeat cycle
    if (initialStateProvider) {
      const events = initialStateProvider();
      for (const event of events) {
        if (!FORWARDED_EVENTS.has(event.type)) continue;
        // Skip usage_update without API data — would reset ESP32 to "no data"
        if (event.type === 'usage_update' && (event as any).fiveHourPercent == null) continue;
        if ((event.type === 'usage_update' || event.type === 'sessions_list') && !hasLiveDeviceInfo(conn)) continue;
        sendToConnection(conn, JSON.stringify(prepareForSerial(event, conn)));
      }
    } else if (stateProvider) {
      const event = stateProvider();
      if (event) sendToConnection(conn, JSON.stringify(prepareForSerial(event, conn)));
    }

    openFailures.delete(port); // opened cleanly — reset the backoff
    return conn;
  } catch (err: any) {
    if (fd != null) {
      closeFd(fd);
    }
    recordSerialOpenFailure(port, err);
    serialError(port, `Failed to open ${port}: ${err.message}`);
    return null;
  }
}

function closeConnection(conn: SerialConnection): void {
  conn.connected = false;
  if (conn.writeTimer) {
    clearTimeout(conn.writeTimer);
    conn.writeTimer = null;
  }
  conn.writeQueue = [];
  if (conn.fd != null) closeFd(conn.fd);
  conn.fd = null;
}

function sendToConnection(conn: SerialConnection, json: string, priority = false): void {
  if (!conn.connected) return;
  if (priority) {
    conn.writeQueue.unshift(json);
  } else {
    conn.writeQueue.push(json);
  }
  while (conn.writeQueue.length > SERIAL_MAX_QUEUE) {
    const dropIdx = conn.writeQueue.findIndex((queued) =>
      queued.startsWith('{"type":"state_update"') || queued.startsWith('{"type":"sessions_list"')
    );
    conn.writeQueue.splice(dropIdx >= 0 ? dropIdx : 0, 1);
  }
  scheduleWriteFlush(conn, 0);
}

function scheduleWriteFlush(conn: SerialConnection, delayMs: number): void {
  if (conn.writeTimer || !conn.connected) return;
  conn.writeTimer = setTimeout(() => flushNextWrite(conn), delayMs);
}

function flushNextWrite(conn: SerialConnection): void {
  conn.writeTimer = null;
  if (!conn.connected) return;
  const json = conn.writeQueue.shift();
  if (!json) return;
  if (conn.fd == null) {
    closeConnection(conn);
    return;
  }

  writeToFd(conn.fd, json + '\n')
    .then(() => {
      conn.lastWriteAt = Date.now();
      if (conn.writeQueue.length > 0) {
        scheduleWriteFlush(conn, SERIAL_WRITE_INTERVAL_MS);
      }
    })
    .catch((err) => {
      if (isRetryableSerialIoError(err)) {
        conn.writeQueue.unshift(json);
        scheduleWriteFlush(conn, SERIAL_WRITE_INTERVAL_MS);
        return;
      }
      debug('ESP32', `Serial write error on ${conn.port}: ${err.message}`);
      closeConnection(conn);
    });
}

function sendDeviceInfoRequest(conn: SerialConnection): void {
  conn.lastDeviceInfoRequestAt = Date.now();
  conn.deviceInfoRequestsSent++;
  sendToConnection(conn, JSON.stringify({ type: 'device_info_request' }), true);
}

function sendSerialKeepalive(conn: SerialConnection): void {
  // ESP32 marks USB as connected only after successfully parsing recent JSON.
  // Keep this independent from larger state/session payloads so display
  // reconnect overlays do not flap when a board is slow to parse UI updates.
  conn.writeQueue = conn.writeQueue.filter((queued) => queued !== SERIAL_KEEPALIVE_JSON);
  sendToConnection(conn, SERIAL_KEEPALIVE_JSON, true);
}

/**
 * Register a callback that returns the current state_update event.
 * Used to send periodic heartbeats so ESP32 gets data even without
 * state changes (e.g., after reboot while bridge is idle).
 */
export function setESP32StateProvider(provider: () => BridgeEvent | null): void {
  stateProvider = provider;
}

/**
 * Register a callback that returns the current usage_update event.
 * Heartbeat sends both state + usage every cycle so ESP32 stays in sync.
 */
export function setESP32UsageProvider(provider: () => BridgeEvent | null): void {
  usageProvider = provider;
}

/**
 * Register a callback that returns the current display_state event.
 * display_state is otherwise edge-triggered (on change + on connect); a board
 * that misses the wake edge (half-open serial, daemon handoff) would stay
 * dark until power-cycled. The heartbeat re-sync makes it self-heal.
 */
export function setESP32DisplayStateProvider(provider: () => BridgeEvent | null): void {
  displayStateProvider = provider;
}

/**
 * Register a callback that returns the current sessions_list event.
 * Like display_state it is otherwise edge-triggered (on change + on connect);
 * a board that (re)connects during a quiet window — daemon handoff, half-open
 * serial — would sit on an empty roster ("no active sessions") until the next
 * unrelated session change. The heartbeat re-sync makes it self-heal.
 */
export function setESP32SessionsListProvider(provider: () => BridgeEvent | null): void {
  sessionsListProvider = provider;
}

/**
 * Register a provider that returns all initial state events (state + usage + sessions).
 * Called when a new ESP32 device connects to send full state immediately.
 */
export function setESP32InitialStateProvider(provider: () => BridgeEvent[]): void {
  initialStateProvider = provider;
}

/**
 * Register a handler for messages received from ESP32 devices.
 * Called with (portPath, parsedMessage) for each JSON message.
 */
export function onESP32Message(handler: (port: string, msg: ESP32ToHostMessage) => void): void {
  messageHandler = handler;
}

let heartbeatCount = 0;
function sendHeartbeat(): void {
  if (connections.length === 0) return;
  heartbeatCount++;

  for (const conn of connections) {
    if (conn.connected) sendSerialKeepalive(conn);
    // Refresh the identity snapshot about once a minute even after a fresh
    // device_info landed — its debug counters (sessionCount/timelineCount)
    // are point-in-time, and a connect-moment snapshot reading "0" on
    // /devices masquerades as "board parses nothing".
    if (conn.deviceInfoFresh && Date.now() - conn.lastDeviceInfoRequestAt > 60_000) {
      sendDeviceInfoRequest(conn);
    }
  }

  // Send state_update (stripped for serial — smaller payload)
  if (stateProvider) {
    const event = stateProvider();
    if (event) {
      for (const conn of connections) {
        sendToConnection(conn, JSON.stringify(prepareForSerial(event, conn)));
      }
    }
  }

  // Re-sync display_state every cycle. It is edge-triggered elsewhere, and a
  // board that misses a wake edge would otherwise stay blacked out until the
  // next reconnect or a power cycle (payload is ~70 bytes; the firmware
  // handler is idempotent).
  if (displayStateProvider) {
    const event = displayStateProvider();
    if (event) {
      for (const conn of connections) {
        sendToConnection(conn, JSON.stringify(prepareForSerial(event, conn)));
      }
    }
  }

  // Re-sync sessions_list every cycle for the same reason: it is edge-triggered
  // elsewhere, so a board that reconnects during a quiet window shows "no active
  // sessions" until the next session change. Only send once a device has
  // identified (matches the sessions_list gating in the broadcast path).
  if (sessionsListProvider) {
    const event = sessionsListProvider();
    if (event) {
      for (const conn of connections) {
        if (!hasLiveDeviceInfo(conn)) continue;
        sendToConnection(conn, JSON.stringify(prepareForSerial(event, conn)));
      }
    }
  }

  // Send usage_update (so ESP32 always has fresh usage/reset times)
  // Only send once SOME usage signal is present — Claude 5h/7d, Codex limits,
  // or Antigravity credits — otherwise the ESP32 would reset its cached values
  // to the "no data" sentinel before any provider has populated them.
  if (usageProvider) {
    const event = usageProvider();
    const u = event as any;
    const hasUsage = u && (u.fiveHourPercent != null || u.codexRateLimits != null || u.antigravityStatus != null);
    if (hasUsage && event) {
      for (const conn of connections) {
        if (!hasLiveDeviceInfo(conn)) continue;
        sendToConnection(conn, JSON.stringify(prepareForSerial(event, conn)));
      }
    }
  }

  // Retry device identification. Some boards answer heartbeats/provisioning
  // but miss the first request after USB reset; without a retry they stay
  // anonymous and surfaces render them as reconnecting.
  //
  // Gate on deviceInfoFresh, NOT conn.deviceInfo: a cache-seeded connection has
  // a non-null (stale) deviceInfo but deviceInfoFresh=false. Keying off
  // conn.deviceInfo froze such a connection at the cache seed forever — a board
  // reflashed/OTA-updated on the same port (e.g. inkdeck round8→round9) would
  // keep reporting its old buildHash/no-OTA because no path ever re-requested.
  // deviceInfoFresh only flips true once a LIVE device_info lands on THIS
  // connection, so a fresh board stops the retries (capped at MAX) as before.
  const now = Date.now();
  for (const conn of connections) {
    if (!shouldRetryDeviceInfoIdentify(conn, now)) continue;
    const seeded = conn.deviceInfo ? ' (cache-seeded — refreshing identity)' : '';
    debug('ESP32', `${conn.port}: no live device_info yet${seeded} — retrying request`);
    sendDeviceInfoRequest(conn);
  }

  // Check for stale connections and trigger recovery
  checkStaleConnections();
}

/**
 * A connection that opened cleanly but has never spoken the AgentDeck protocol:
 * no device_info, no cached board for this port, and not a single valid JSON
 * line read. Strong evidence it's a foreign device (e.g. a TRMNL panel) we
 * should stop holding/resetting rather than an AgentDeck board that's just slow.
 */
/** @internal Exported for testing only */
export function isUnidentifiedForeign(conn: SerialConnection): boolean {
  return !conn.deviceInfo?.board && !lastKnownDeviceInfoByPort.has(conn.port) && conn.lastReadAt === 0;
}

/**
 * A CDC port that IS an AgentDeck board (live device_info, or a cached board for
 * this port) yet has produced no read since this (re)connection. A healthy board
 * answers device_info/keepalive within seconds, so lastReadAt===0 well past a
 * generous grace means a half-open USB-CDC pipe (board reset / re-enumerated)
 * that heartbeat writes will never revive — the FD must be recycled so re-poll
 * re-probes. Mutually exclusive with isUnidentifiedForeign (this REQUIRES an
 * identified board; that one requires none).
 */
/** @internal Exported for testing only */
export function isHalfOpenIdentifiedCdc(
  conn: Pick<SerialConnection, 'port' | 'deviceInfo' | 'lastReadAt' | 'connectedAt'>,
  now = Date.now(),
): boolean {
  const isCDC = /usbmodem|ttyACM/.test(conn.port);
  if (!isCDC) return false;
  const isIdentified = Boolean(conn.deviceInfo?.board) || lastKnownDeviceInfoByPort.has(conn.port);
  return isIdentified && conn.lastReadAt === 0 && (now - conn.connectedAt) > CDC_SILENT_READ_TIMEOUT_MS;
}

/**
 * A UART port that IS an AgentDeck board and used to read, but has been
 * RX-silent past UART_SILENT_READ_TIMEOUT_MS. Half-open mirror of
 * isHalfOpenIdentifiedCdc for mid-life RX death: successful heartbeat writes
 * keep the write-death clause from ever firing, so without this check the
 * zombie FD is held forever and the board can never be DTR/RTS-recycled.
 * (2026-07-17 live case: ips_10 + ulanzi_tc001 + ttgo silent 4–20+ min with
 * transportOpen=true, lastWriteSecondsAgo=0.)
 */
/** @internal Exported for testing only */
export function isSilentIdentifiedUart(
  conn: Pick<SerialConnection, 'port' | 'deviceInfo' | 'lastReadAt'>,
  now = Date.now(),
): boolean {
  const isCDC = /usbmodem|ttyACM/.test(conn.port);
  if (isCDC) return false;
  const isIdentified = Boolean(conn.deviceInfo?.board) || lastKnownDeviceInfoByPort.has(conn.port);
  return isIdentified && conn.lastReadAt > 0 && (now - conn.lastReadAt) > UART_SILENT_READ_TIMEOUT_MS;
}

/**
 * Whether the periodic heartbeat should (re)send a device_info_request to
 * re-identify this connection. Keys off deviceInfoFresh (a LIVE reply on THIS
 * connection), NOT conn.deviceInfo — a cache-seeded connection carries a stale
 * deviceInfo but deviceInfoFresh=false and must keep re-requesting until the
 * board answers, so a reflashed/OTA-updated board on the same port refreshes
 * its buildHash/OTA fields instead of freezing at the cache seed. Capped by
 * DEVICE_INFO_MAX_REQUESTS and paced by DEVICE_INFO_RETRY_MS.
 */
/** @internal Exported for testing only */
export function shouldRetryDeviceInfoIdentify(
  conn: Pick<SerialConnection, 'connected' | 'deviceInfoFresh' | 'deviceInfoRequestsSent' | 'lastDeviceInfoRequestAt'>,
  now = Date.now(),
): boolean {
  if (!conn.connected || conn.deviceInfoFresh) return false;
  if (conn.deviceInfoRequestsSent >= DEVICE_INFO_MAX_REQUESTS) return false;
  if (now - conn.lastDeviceInfoRequestAt < DEVICE_INFO_RETRY_MS) return false;
  return true;
}

function denylistForeignPort(port: string, reason: string): void {
  foreignDenylistUntil.set(port, Date.now() + FOREIGN_DENYLIST_COOLDOWN_MS);
  foreignProbeFailures.delete(port);
  debug('ESP32', `Denylisting non-AgentDeck port ${port} for ${Math.round(FOREIGN_DENYLIST_COOLDOWN_MS / 60000)}min (${reason})`);
}

/** @internal Exported for testing only. True if the port is in active cooldown. */
export function isForeignPortDenylisted(port: string, now = Date.now()): boolean {
  const until = foreignDenylistUntil.get(port);
  return until != null && until > now;
}

/** @internal Exported for testing only. Clear all foreign-port tracking state. */
export function __resetForeignPortState(): void {
  foreignProbeFailures.clear();
  foreignDenylistUntil.clear();
}

/** @internal Exported for testing only.
 *  Count a failed identification cycle; denylist once it crosses the threshold. */
export function recordForeignProbeFailure(port: string): void {
  const next = (foreignProbeFailures.get(port) ?? 0) + 1;
  foreignProbeFailures.set(port, next);
  if (next >= FOREIGN_MAX_PROBE_FAILURES) {
    denylistForeignPort(port, `${next} failed probes`);
  }
}

/**
 * Check for stale connections (no read for >60s) and close them.
 * This allows re-poll to automatically reconnect devices that stopped responding.
 */
function checkStaleConnections(): void {
  const now = Date.now();
  let staleCount = 0;

  for (const conn of connections) {
    if (!conn.connected) continue;

    const isCDC = /usbmodem|ttyACM/.test(conn.port);
    const hasRead = conn.lastReadAt > 0;
    const readAge = hasRead ? now - conn.lastReadAt : now - conn.connectedAt;
    const writeAge = now - conn.lastWriteAt;

    // For CDC ports, do not close due to lack of read traffic if write is active and healthy.
    if (isCDC) {
      // A held-open CDC port that never identifies is a foreign device; denylist
      // it so we stop occupying it (CDC ports aren't otherwise reaped on silence).
      if (isUnidentifiedForeign(conn) && (now - conn.connectedAt) > FOREIGN_CDC_GRACE_MS) {
        denylistForeignPort(conn.port, 'CDC never identified');
        closeConnection(conn);
        staleCount++;
        continue;
      }
      // A CDC port whose board is identified but has read nothing since connect is
      // half-open (board reset, RX pipe dead). Recycle the FD so re-poll re-probes;
      // the reopen's DTR/RTS toggle may itself revive the board. Feed the foreign
      // probe-failure counter so a permanently-dead board denylists after a few
      // strikes instead of getting DTR/RTS-reset every grace window.
      if (isHalfOpenIdentifiedCdc(conn, now)) {
        debug('ESP32', `Half-open CDC (identified, no read since connect): ${conn.port} — recycling`);
        recordForeignProbeFailure(conn.port);
        closeConnection(conn);
        staleCount++;
        continue;
      }
      if (writeAge > STALE_THRESHOLD_MS) {
        debug('ESP32', `Stale CDC connection (no write for >60s): ${conn.port}`);
        closeConnection(conn);
        staleCount++;
      }
      continue;
    }

    // Identified UART that read before but went RX-silent: the dual clause
    // below requires writeAge > 60s too, which 5s heartbeat writes prevent
    // forever. Recycle regardless of write health; re-poll's reopen (DTR/RTS
    // toggle) resets the board.
    if (isSilentIdentifiedUart(conn, now)) {
      debug('ESP32', `Half-open UART (identified, RX silent ${Math.floor(readAge / 1000)}s, writes healthy): ${conn.port} — recycling`);
      closeConnection(conn);
      staleCount++;
      continue;
    }

    if ((!hasRead && readAge > INITIAL_READ_TIMEOUT_MS) ||
        (hasRead && readAge > STALE_THRESHOLD_MS && writeAge > STALE_THRESHOLD_MS)) {
      debug('ESP32', `Stale connection detected: ${conn.port} (${Math.floor(readAge / 1000)}s ${hasRead ? 'since last read' : 'without initial read'}, ${Math.floor(writeAge / 1000)}s since write)`);
      // A UART port closed before ever identifying counts as a foreign probe
      // failure; enough failures denylist it so we stop reopening (and resetting) it.
      if (isUnidentifiedForeign(conn)) recordForeignProbeFailure(conn.port);
      closeConnection(conn);
      staleCount++;
    }
  }

  if (staleCount > 0) {
    // Remove stale connections immediately, then trigger re-poll
    connections = connections.filter(c => c.connected);
    debug('ESP32', `Closed ${staleCount} stale connection(s), re-polling...`);
    pollForDevices().catch(err => {
      debug('ESP32', `Re-poll after stale cleanup failed: ${err.message}`);
    });
  }
}

/**
 * Start ESP32 serial bridge.
 * Detects USB serial ports and opens connections.
 * Call broadcast() to send events to all connected ESP32 devices.
 *
 * Non-blocking: initial device detection runs in background so a hung
 * USB port (stty stuck in kernel I/O) cannot block bridge startup.
 */
export function startESP32Serial(): void {
  loadDeviceInfoCache();

  // Fire-and-forget initial detection (non-blocking)
  pollForDevices().catch(err => {
    debug('ESP32', `Initial poll failed: ${err.message}`);
  });

  // Poll for new/disconnected devices every 10 seconds
  pollTimer = setInterval(() => {
    pollForDevices().catch(err => {
      debug('ESP32', `Poll failed: ${err.message}`);
    });
  }, 10000);

  // Heartbeat: send current state every 5 seconds so ESP32 stays in sync
  heartbeatTimer = setInterval(sendHeartbeat, 5000);

  debug('ESP32', 'Serial bridge started');
}

async function pollForDevices(): Promise<void> {
  if (pollInProgress) return;
  pollInProgress = true;

  try {
    const ports = [...new Set(await detectESP32Ports())];

    const portSet = new Set(ports);

    // Forget foreign-port state for ports that are gone (a replug re-probes
    // fresh) or whose cooldown has elapsed. Then skip ports still in cooldown so
    // we don't reopen — and reset — a non-AgentDeck device every poll.
    const nowTs = Date.now();
    for (const [p, until] of [...foreignDenylistUntil]) {
      if (until <= nowTs || !portSet.has(p)) foreignDenylistUntil.delete(p);
    }
    for (const p of [...foreignProbeFailures.keys()]) {
      if (!portSet.has(p)) foreignProbeFailures.delete(p);
    }
    // A wedged bridge stays enumerated, so a vanished port was unplugged /
    // power-cycled / re-enumerated — the wedge may be gone. Forget its
    // open-failure backoff so a re-plug retries immediately.
    for (const p of [...openFailures.keys()]) {
      if (!portSet.has(p)) openFailures.delete(p);
    }
    const allowedPorts = ports.filter((p) => {
      const until = foreignDenylistUntil.get(p);
      if (until && until > nowTs) {
        debug('ESP32', `Skipping denylisted non-AgentDeck port ${p} (${Math.ceil((until - nowTs) / 1000)}s left)`);
        return false;
      }
      return true;
    });

    // Remove disconnected or unplugged ports. Read silence alone is handled
    // separately so half-duplex-but-rendering boards are not reset every minute.
    connections = connections.filter(c => {
      if (!c.connected) {
        closeConnection(c);
        return false;
      }
      if (!portSet.has(c.port)) {
        debug('ESP32', `Serial port disappeared: ${c.port}`);
        closeConnection(c);
        return false;
      }
      return true;
    });

    // Add new ports (denylisted foreign ports are excluded via allowedPorts)
    for (const port of allowedPorts) {
      if (connections.some(c => c.port === port) || openingPorts.has(port)) continue;

      // Open-failure backoff: don't re-open (and DTR-reset) a wedged port every
      // poll. openPort() itself records/clears the failure; here we just skip
      // while the escalating backoff window has not elapsed.
      const of = openFailures.get(port);
      if (of && (nowTs - of.lastAttempt) < serialOpenFailureBackoffMs(of.count, of.isPermanent)) {
        continue;
      }

      openingPorts.add(port);
      try {
        const conn = await openPort(port);
        if (conn && !connections.some(c => c.port === port)) {
          connections.push(conn);
        } else if (conn) {
          conn.connected = false;
          closeConnection(conn);
        }
      } finally {
        openingPorts.delete(port);
      }
    }
  } finally {
    pollInProgress = false;
  }
}

/**
 * Broadcast a BridgeEvent to all connected ESP32 devices via serial.
 */
export function broadcastESP32(event: BridgeEvent): void {
  if (connections.length === 0) return;
  if (!FORWARDED_EVENTS.has(event.type)) return;

  // Debug: log sessions_list and state_update details for ESP32 troubleshooting
  if (event.type === 'sessions_list') {
    const e = event as any;
    const summary = (e.sessions || []).map((s: any) =>
      `${s.agentType}:${s.state ?? '?'}(${s.alive ? 'alive' : 'dead'})`
    ).join(', ');
    debug('ESP32', `→ sessions_list: [${summary}]`);
  } else if (event.type === 'state_update') {
    const e = event as any;
    debug('ESP32', `→ state_update: agent=${e.agentType} state=${e.state}`);
  }

  for (const conn of connections) {
    if (event.type === 'sessions_list' && !hasLiveDeviceInfo(conn)) continue;
    const prepared = prepareForSerial(event, conn);
    sendToConnection(conn, JSON.stringify(prepared));
  }
}

/**
 * Send a WiFi provision message to a specific ESP32 device by port path.
 */
export function sendWifiProvision(port: string, msg: WifiProvisionMessage): boolean {
  const conn = connections.find(c => c.port === port && c.connected);
  if (!conn) return false;
  sendToConnection(conn, JSON.stringify(msg), true);
  conn.provisionSent = true;
  debug('ESP32', `→ ${port}: wifi_provision (SSID: ${msg.ssid})`);
  return true;
}

/**
 * Send WiFi provision to all connected ESP32 devices that haven't been provisioned.
 */
export function sendWifiProvisionToAll(msg: WifiProvisionMessage): number {
  let count = 0;
  for (const conn of connections) {
    if (!shouldSendWifiProvision(conn)) continue;
    sendToConnection(conn, JSON.stringify(msg), true);
    conn.provisionSent = true;
    count++;
    debug('ESP32', `→ ${conn.port}: wifi_provision (SSID: ${msg.ssid})`);
  }
  return count;
}

/** @internal Exported for testing only */
export function shouldSendWifiProvision(conn: Pick<SerialConnection, 'connected' | 'deviceInfo' | 'provisionSent'>): boolean {
  if (!conn.connected) return false;
  if (!conn.deviceInfo?.board) return false;
  if (conn.provisionSent) return false;
  // IPS10 carries a daemon endpoint in NVS in addition to WiFi credentials.
  // Refresh it once while USB serial is active and the radio is online, even
  // if the board is already configured/connected; otherwise a stale endpoint
  // can survive and WiFi-only operation keeps dialing the old daemon host.
  if (conn.deviceInfo.board === 'ips_10' && conn.deviceInfo.wifiConnected && !conn.deviceInfo.wifiRadioParked) {
    return true;
  }
  if (conn.deviceInfo.wifiConnected) return false;
  // Auto-provision is for first setup. A configured board may intentionally have
  // WiFi off (IPS10 USB-primary radio parking) or may be temporarily away from
  // its AP; repeatedly injecting credentials would fight firmware policy.
  if (conn.deviceInfo.wifiConfigured) return false;
  return true;
}

/**
 * Get device info for all connected ESP32 devices.
 */
export function getESP32DeviceInfo(): Array<{
  port: string;
  board?: string;
  version?: string;
  buildHash?: string;
  buildEpoch?: number;
  wifiConfigured?: boolean;
  wifiConnected?: boolean;
  wifiRadioParked?: boolean;
  uptimeSec?: number;
  otaSupported?: boolean;
  otaSlotCount?: number;
  otaSlotSize?: number;
  otaFreeSketchSpace?: number;
  otaReason?: string;
}> {
  const now = Date.now();
  return connections
    .filter(c => isResponsive(c, now))
    .map(c => ({
      port: c.port,
      ...c.deviceInfo,
    }));
}

/**
 * Board identities currently reachable over a LIVE, responsive USB serial
 * connection (has announced device_info and is actively read/written). The
 * daemon uses this to enforce single-path communication: when a physical board
 * is driven over serial, its WiFi WebSocket copy is redundant and is suppressed
 * (see daemon-server transport dedup). A power-only USB (no enumerated port) or
 * a silent/booting port is NOT responsive, so it never appears here and the
 * board keeps using WiFi — exactly the desired fallback.
 *
 * `ip` is the board's own WiFi IP (when connected), used to confirm the serial
 * connection and the WiFi socket are the same physical unit before deduping.
 */
export function getSerialReachableBoards(): Array<{ board: string; ip?: string }> {
  const now = Date.now();
  const out: Array<{ board: string; ip?: string }> = [];
  for (const c of connections) {
    if (!isResponsive(c, now)) continue;
    const board = c.deviceInfo?.board;
    if (!board) continue;
    out.push({ board, ip: c.deviceInfo?.wifiConnected ? c.deviceInfo?.ip : undefined });
  }
  return out;
}

/**
 * Wake recovery — close stale file descriptors, force immediate re-poll.
 */
export function handleESP32Wake(): void {
  debug('ESP32', `Wake recovery — closing ${connections.length} stale connection(s)`);
  for (const conn of connections) {
    conn.connected = false;
    closeConnection(conn);
  }
  connections = [];
  // Delay re-poll 2s to let USB bus stabilize after wake
  setTimeout(() => {
    pollForDevices().catch(err => {
      debug('ESP32', `Wake poll failed: ${err.message}`);
    });
  }, 2000);
}

/**
 * Stop ESP32 serial bridge and close all connections.
 */
export function stopESP32Serial(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const conn of connections) {
    conn.connected = false;
    closeConnection(conn);
  }
  connections = [];
  messageHandler = null;
  debug('ESP32', 'Serial bridge stopped');
}

/**
 * Get number of connected ESP32 devices.
 */
export function esp32ConnectionCount(): number {
  const now = Date.now();
  return connections.filter(c => isResponsive(c, now)).length;
}

/**
 * Get list of connected ESP32 serial port paths.
 */
export function getESP32Ports(): string[] {
  const now = Date.now();
  return connections.filter(c => isResponsive(c, now)).map(c => c.port);
}

/**
 * Get detailed connection status for all ESP32 devices.
 * Used by /api/status endpoint to show connection health.
 */
export function getSerialConnectionStatus(): Array<{
  port: string;
  connected: boolean;
  board?: string;
  version?: string;
  buildHash?: string;
  buildEpoch?: number;
  wifiConfigured?: boolean;
  wifiConnected?: boolean;
  wifiRadioParked?: boolean;
  uptimeSec?: number;
  otaSupported?: boolean;
  otaSlotCount?: number;
  otaSlotSize?: number;
  otaFreeSketchSpace?: number;
  otaReason?: string;
  timelineCount?: number;
  sessionCount?: number;
  usageFiveH?: number;
  processingCount?: number;
  transportOpen: boolean;
  lastReadAt: number;
  lastWriteAt: number;
  lastReadSecondsAgo: number | null;
  lastWriteSecondsAgo: number;
  stale: boolean;
}> {
  const now = Date.now();
  return connections.map(c => ({
    port: c.port,
    connected: isResponsive(c, now),
    transportOpen: c.connected,
    board: c.deviceInfo?.board,
    version: c.deviceInfo?.version,
    buildHash: c.deviceInfo?.buildHash,
    buildEpoch: c.deviceInfo?.buildEpoch,
    wifiConfigured: c.deviceInfo?.wifiConfigured,
    wifiConnected: c.deviceInfo?.wifiConnected,
    wifiRadioParked: c.deviceInfo?.wifiRadioParked,
    uptimeSec: c.deviceInfo?.uptimeSec,
    resetReason: c.deviceInfo?.resetReason,
    resetReasonCode: c.deviceInfo?.resetReasonCode,
    otaSupported: c.deviceInfo?.otaSupported,
    otaSlotCount: c.deviceInfo?.otaSlotCount,
    otaSlotSize: c.deviceInfo?.otaSlotSize,
    otaFreeSketchSpace: c.deviceInfo?.otaFreeSketchSpace,
    otaReason: c.deviceInfo?.otaReason,
    timelineCount: c.deviceInfo?.timelineCount,
    sessionCount: c.deviceInfo?.sessionCount,
    usageFiveH: c.deviceInfo?.usageFiveH,
    processingCount: c.deviceInfo?.processingCount,
    lastReadAt: c.lastReadAt,
    lastWriteAt: c.lastWriteAt,
    lastReadSecondsAgo: c.lastReadAt > 0 ? Math.floor((now - c.lastReadAt) / 1000) : null,
    lastWriteSecondsAgo: Math.floor((now - c.lastWriteAt) / 1000),
    stale: c.connected && !isResponsive(c, now),
  }));
}

export function getSerialLastError(): string | null {
  if (lastErrorByPort.size === 0) return null;
  return Array.from(lastErrorByPort.entries())
    .map(([port, error]) => `${port}: ${error}`)
    .join('; ');
}
