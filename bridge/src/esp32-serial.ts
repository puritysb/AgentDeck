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
import { debug } from './logger.js';

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
const SERIAL_OPEN_TIMEOUT_MS = 3000;
const SERIAL_OPEN_PROBE_TIMEOUT_MS = 1500;
const SERIAL_WRITE_INTERVAL_MS = 120;
const SERIAL_MAX_QUEUE = 24;
const SERIAL_KEEPALIVE_JSON = JSON.stringify({ type: 'serial_keepalive' });
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
  deviceInfo: { board?: string; version?: string; wifiConfigured?: boolean; wifiConnected?: boolean } | null;
  provisionSent: boolean;
  connectedAt: number;
  lastReadAt: number;  // Timestamp of last successful read from ESP32
  lastWriteAt: number; // Timestamp of last successful write to ESP32
  lastDeviceInfoRequestAt: number;
  deviceInfoRequestsSent: number;
  writeQueue: string[];
  writeTimer: ReturnType<typeof setTimeout> | null;
}

let connections: SerialConnection[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pollInProgress = false;
const openingPorts = new Set<string>();
const lastKnownDeviceInfoByPort = new Map<string, NonNullable<SerialConnection['deviceInfo']>>();
const lastErrorByPort = new Map<string, string>();
let deviceInfoCacheLoaded = false;
let stateProvider: (() => BridgeEvent | null) | null = null;
let usageProvider: (() => BridgeEvent | null) | null = null;
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
// Firmware (handleSessionsList) only stores the first 6 sessions; both sides
// must agree on the same cap. Keep in sync with esp32/src/net/protocol.cpp.
export const SERIAL_SESSIONS_CAP = 6;

/**
 * Pick which sessions survive the 6-slot serial cap.
 *
 * A naive `slice(0, 6)` lets a single agent type (e.g. several idle Claude Code
 * sessions) fill every slot and starve other agents — a running Codex/OpenClaw
 * session that lands at index 6+ never reaches the firmware's creature renderer.
 *
 * Instead we round-robin across agent types so each present type claims at least
 * one slot before any type takes a second. Within a type, live + active
 * (non-idle) sessions are preferred so a processing session is never dropped in
 * favour of an idle sibling. Order within a type is otherwise preserved (stable).
 */
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

export function prepareForSerial(event: BridgeEvent, conn?: Pick<SerialConnection, 'deviceInfo'>): BridgeEvent {
  const e = event as any;

  if (event.type === 'usage_update') {
    // Pre-format ISO dates + strip unused fields
    const { ollamaStatus, tokenStatus, extraUsageEnabled, extraUsageMonthlyLimit,
            extraUsageUsedCredits, extraUsageUtilization, costSpent, costLimit,
            sessionPercent, resetTime, resetDate, ...keep } = e;
    return {
      ...keep,
      fiveHourResetsAt: formatResetTime(keep.fiveHourResetsAt),
      sevenDayResetsAt: formatResetTime(keep.sevenDayResetsAt),
    };
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
      })),
    } as BridgeEvent;
  }

  return event;
}

function limitString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
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

/** @internal Exported for testing only */
export function handleSerialLine(conn: SerialConnection, line: string): void {
  if (!line.startsWith('{')) return; // Skip debug output like "[WiFi] Connected"

  try {
    const msg = JSON.parse(line) as ESP32ToHostMessage;
    if (msg.type) {
      conn.lastReadAt = Date.now();  // Update last read timestamp
      debug('ESP32', `← ${conn.port}: ${msg.type}`);

      if (msg.type === 'device_info') {
        conn.deviceInfo = {
          board: msg.board,
          version: msg.version,
          wifiConfigured: msg.wifiConfigured,
          wifiConnected: msg.wifiConnected,
        };
        if (conn.deviceInfo.board) {
          lastKnownDeviceInfoByPort.set(conn.port, conn.deviceInfo);
          persistDeviceInfoCache();
        }
      } else if (!conn.deviceInfo &&
                 conn.deviceInfoRequestsSent < DEVICE_INFO_MAX_REQUESTS &&
                 Date.now() - conn.lastDeviceInfoRequestAt >= DEVICE_INFO_READ_RETRY_MS) {
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
      connected: true, deviceInfo: lastKnownDeviceInfoByPort.get(port) ?? null, provisionSent: false,
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

    return conn;
  } catch (err: any) {
    if (fd != null) {
      closeFd(fd);
    }
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

  // Send usage_update (so ESP32 always has fresh usage/reset times)
  // Only send if API usage data is present (fiveHourPercent defined),
  // otherwise the ESP32 would reset its cached values to "no data" sentinel.
  if (usageProvider) {
    const event = usageProvider();
    if (event && (event as any).fiveHourPercent != null) {
      for (const conn of connections) {
        if (!hasLiveDeviceInfo(conn)) continue;
        sendToConnection(conn, JSON.stringify(prepareForSerial(event, conn)));
      }
    }
  }

  // Retry device identification. Some boards answer heartbeats/provisioning
  // but miss the first request after USB reset; without a retry they stay
  // anonymous and surfaces render them as reconnecting.
  const now = Date.now();
  for (const conn of connections) {
    if (!conn.connected || conn.deviceInfo) continue;
    if (conn.deviceInfoRequestsSent >= DEVICE_INFO_MAX_REQUESTS) continue;
    if (now - conn.lastDeviceInfoRequestAt < DEVICE_INFO_RETRY_MS) continue;
    debug('ESP32', `${conn.port}: device_info not received yet — retrying request`);
    sendDeviceInfoRequest(conn);
  }

  // Check for stale connections and trigger recovery
  checkStaleConnections();
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
      if (writeAge > STALE_THRESHOLD_MS) {
        debug('ESP32', `Stale CDC connection (no write for >60s): ${conn.port}`);
        closeConnection(conn);
        staleCount++;
      }
      continue;
    }

    if ((!hasRead && readAge > INITIAL_READ_TIMEOUT_MS) ||
        (hasRead && readAge > STALE_THRESHOLD_MS && writeAge > STALE_THRESHOLD_MS)) {
      debug('ESP32', `Stale connection detected: ${conn.port} (${Math.floor(readAge / 1000)}s ${hasRead ? 'since last read' : 'without initial read'}, ${Math.floor(writeAge / 1000)}s since write)`);
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

    // Add new ports
    for (const port of ports) {
      if (connections.some(c => c.port === port) || openingPorts.has(port)) continue;

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
  sendToConnection(conn, JSON.stringify(msg));
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
    if (!conn.connected) continue;
    // Skip if already provisioned or WiFi already configured
    if (!conn.deviceInfo?.board) continue;
    if (conn.provisionSent) continue;
    if (conn.deviceInfo?.wifiConnected) continue;
    sendToConnection(conn, JSON.stringify(msg));
    conn.provisionSent = true;
    count++;
    debug('ESP32', `→ ${conn.port}: wifi_provision (SSID: ${msg.ssid})`);
  }
  return count;
}

/**
 * Get device info for all connected ESP32 devices.
 */
export function getESP32DeviceInfo(): Array<{ port: string; board?: string; version?: string; wifiConfigured?: boolean; wifiConnected?: boolean }> {
  const now = Date.now();
  return connections
    .filter(c => isResponsive(c, now))
    .map(c => ({
      port: c.port,
      ...c.deviceInfo,
    }));
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
  wifiConfigured?: boolean;
  wifiConnected?: boolean;
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
    wifiConfigured: c.deviceInfo?.wifiConfigured,
    wifiConnected: c.deviceInfo?.wifiConnected,
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
