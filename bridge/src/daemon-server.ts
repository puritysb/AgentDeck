/**
 * AgentDeck Daemon — lightweight monitoring server.
 *
 * No PTY, no voice, no utility. Provides:
 * - WS server for display clients
 * - mDNS advertisement
 * - OpenClaw Gateway proxy
 * - Usage relay (sibling HTTP → WS → direct API)
 * - Pixoo + ADB + Serial device modules
 *
 * Exports `startDaemon()` called by cli.ts.
 */

import { createServer, type Server } from 'http';
import { createHash, randomUUID } from 'crypto';
import WebSocket from 'ws';
import { BridgeCore, buildCappedTimelineHistory } from './bridge-core.js';
import { buildDisplayStateEvent } from './display-dim.js';
import { SERIAL_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import { prepareForSerial } from './esp32-serial.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import { BridgeLogStream } from './log-stream.js';
import { PassiveSessionObserver } from './passive-observer.js';
import { SessionTimelineRelay } from './session-timeline-relay.js';
import { SessionFocusRelay } from './session-focus-relay.js';
import { updatePushState } from './session-aggregator.js';
import { setAwaitingOverlay, clearAwaitingOverlay, isPermissionNotification, applyAwaitingOverlayToObserved } from './awaiting-overlay.js';
import { resolvePending, sweepStalePending, drainAllPending } from './permission-resolver.js';
import { VoiceManager } from './voice.js';
import { VoiceAssistantManager } from './voice-assistant.js';
import {
  listActive as listActiveSessions,
  findAvailablePort,
  findExistingDaemon,
  DAEMON_DEFAULT_PORT,
  probeDaemonHealth,
  requestDaemonShutdown,
  scanDaemonPortWindow,
  shouldConcedePortToOccupant,
  waitForDaemonExit,
  writeDaemonInfo,
  removeDaemonInfo,
  readDaemonInfo,
  removeDaemonSession,
  getCandidateDataDirs,
} from './session-registry.js';
import { fetchUsageFromApi, hasOAuthToken, resetConsecutiveFailures, type ApiUsageData } from './usage-api.js';
import { isLocalConnection, validateToken } from './auth.js';
import { getLastFrame, renderPreviewFrame, onFrameRendered, offFrameRendered } from './pixoo/pixoo-bridge.js';
import { loadIDotMatrixDevices } from './idotmatrix/idotmatrix-settings.js';
import { handlePixooWake } from './pixoo/pixoo-client.js';
import { triggerMdnsRecovery } from './mdns.js';
import { rgbToBmp, pixooLiveHtml } from './hook-server.js';
import { enableDebugLog, debug } from './logger.js';
import { initApme, isTimelineProjectionEnabled, loadApmeConfig, type ApmeModule } from './apme/index.js';
import { FallbackTaskTimeline } from './fallback-task-timeline.js';
import { handleApmeRequest } from './apme/http.js';
import { readModelFromTranscript } from './apme/claude-transcript-reader.js';
import { transcriptTimelineForSession, lastAssistantTextFromTranscript } from './session-transcript-timeline.js';
import { lastAgentMessageFromCodexRollout } from './codex-rollout-response.js';
import { callFoundationModelsHelper } from './foundation-models-helper.js';
import {
  initModules,
  stopModules,
  createDefaultModules,
  type DeviceModule,
} from './modules/index.js';
import { SerialModule } from './modules/serial-module.js';
import { esp32ConnectionCount, getESP32DeviceInfo, onESP32Message, sendWifiProvisionToAll, handleESP32Wake, getESP32Ports, getSerialConnectionStatus, getSerialLastError, getSerialReachableBoards } from './esp32-serial.js';
import { loadWifiConfig } from './wifi-config.js';
import { getConnectedAdbDevices, hasAdb, getAdbDeviceCount } from './adb-reverse.js';
import { getPixooDeviceDetails, pixooDeviceCount } from './pixoo/pixoo-bridge.js';
import { loadTimeboxDevices } from './timebox/timebox-settings.js';
import { getLanIp, stripUnsafeText, cleanRawText, prepareMarkdownDetail, type TimelineEntry } from '@agentdeck/shared';
import { injectOpenClawSession } from './openclaw-session.js';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  BRIDGE_WS_PORT,
  OPENCLAW_CAPABILITIES,
  State,
  type BridgeEvent,
  type AdapterEvent,
  type ModelCatalogEntry,
} from './types.js';

function exitProcessNow(code = 0): void {
  if (code === 0) {
    try {
      process.kill(process.pid, 'SIGKILL');
      return;
    } catch {
      // fall through
    }
  }
  process.exit(code);
}

// WiFi ESP32 boards (InkDeck) that announced device_info over the plugin WS.
// Keyed board:ip; entries age out after an hour so a re-IP'd board doesn't
// leave ghosts in `agentdeck devices`.
interface WifiEsp32Device {
  board: string;
  version?: string;
  buildHash?: string;
  buildEpoch?: number;
  ip?: string;
  protocolRevision?: number;
  uptimeSec?: number;
  resetReason?: string;
  resetReasonCode?: number;
  otaSupported?: boolean;
  otaSlotCount?: number;
  otaSlotSize?: number;
  otaFreeSketchSpace?: number;
  otaReason?: string;
  lastSeenMs: number;
}
const wifiEsp32Devices = new Map<string, WifiEsp32Device>();
const wifiEsp32Sockets = new Map<string, WebSocket>();

interface OtaWaiter {
  stage: string;
  seq?: number;
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const otaWaiters = new Map<string, OtaWaiter>();

function listWifiEsp32Devices(): Array<WifiEsp32Device & { stale: boolean; serialActive: boolean }> {
  const now = Date.now();
  const serialBoards = getSerialReachableBoards();
  const out: Array<WifiEsp32Device & { stale: boolean; serialActive: boolean }> = [];
  for (const [key, d] of wifiEsp32Devices) {
    if (now - d.lastSeenMs > 60 * 60 * 1000) {
      wifiEsp32Devices.delete(key);
      wifiEsp32Sockets.delete(key);
      continue;
    }
    // serialActive: this WiFi board is also live on USB serial, so its WiFi path
    // is a hot standby — display events are driven over serial (single path).
    const serialActive = isWifiTransportRedundant({ board: d.board, ip: d.ip }, serialBoards);
    out.push({ ...d, stale: now - d.lastSeenMs > 90_000, serialActive });
  }
  return out;
}

function wifiEsp32Key(d: { board?: unknown; ip?: unknown }): string {
  const board = typeof d.board === 'string' && d.board ? d.board : 'unknown';
  const ip = typeof d.ip === 'string' && d.ip ? d.ip : 'no-ip';
  return `${board}:${ip}`;
}

/**
 * Single-path transport dedup. A physical ESP32 can be reachable over BOTH a
 * USB serial connection and a WiFi WebSocket at once (e.g. inkdeck/ttgo/tc001
 * plugged in for flashing while still joined to the AP). Serial is the more
 * reliable, lower-latency path, so when a board is live on serial we drive it
 * over serial only and suppress the redundant WiFi copy — no board receives the
 * same event twice.
 *
 * Match is by board id, confirmed by the board's WiFi IP when both sides report
 * one. If the serial side reports no IP (radio parked / pre-DHCP) the board id
 * is the only shared key and we still prefer serial. Pure + exported for tests.
 */
export function isWifiTransportRedundant(
  wifi: { board?: string; ip?: string } | null,
  serialBoards: Array<{ board: string; ip?: string }>,
): boolean {
  if (!wifi || !wifi.board || wifi.board === 'unknown') return false;
  for (const s of serialBoards) {
    if (s.board !== wifi.board) continue;
    // Same board type on serial: dedup unless both report IPs that differ
    // (two distinct physical units of the same board model).
    if (!s.ip || !wifi.ip || s.ip === wifi.ip) return true;
  }
  return false;
}

/** Reverse-lookup a WiFi ESP32 socket to its registered {board, ip} identity. */
function wifiEsp32IdentityForSocket(ws: WebSocket): { board?: string; ip?: string } | null {
  for (const [key, registeredWs] of wifiEsp32Sockets) {
    if (registeredWs !== ws) continue;
    const d = wifiEsp32Devices.get(key);
    return d ? { board: d.board, ip: d.ip } : null;
  }
  return null;
}

/** True when this WiFi ESP32 socket's board is also live on USB serial, so its
 *  WiFi event copy should be suppressed in favour of the serial path. */
function isWifiEsp32RedundantWithSerial(ws: WebSocket): boolean {
  return isWifiTransportRedundant(wifiEsp32IdentityForSocket(ws), getSerialReachableBoards());
}

function registerWifiEsp32(d: Record<string, unknown>, ws: WebSocket): void {
  const key = wifiEsp32Key(d);
  const previous = wifiEsp32Devices.get(key);
  const uptimeSec = typeof d.uptimeSec === 'number' ? d.uptimeSec : undefined;
  const resetReason = typeof d.resetReason === 'string' ? d.resetReason : undefined;
  const resetReasonCode = typeof d.resetReasonCode === 'number' ? d.resetReasonCode : undefined;
  wifiEsp32Devices.set(key, {
    board: typeof d.board === 'string' ? d.board : 'unknown',
    version: typeof d.version === 'string' ? d.version : undefined,
    buildHash: typeof d.buildHash === 'string' ? d.buildHash : undefined,
    buildEpoch: typeof d.buildEpoch === 'number' ? d.buildEpoch : undefined,
    ip: typeof d.ip === 'string' ? d.ip : undefined,
    protocolRevision: typeof d.protocolRevision === 'number' ? d.protocolRevision : undefined,
    uptimeSec,
    resetReason,
    resetReasonCode,
    otaSupported: typeof d.otaSupported === 'boolean' ? d.otaSupported : undefined,
    otaSlotCount: typeof d.otaSlotCount === 'number' ? d.otaSlotCount : undefined,
    otaSlotSize: typeof d.otaSlotSize === 'number' ? d.otaSlotSize : undefined,
    otaFreeSketchSpace: typeof d.otaFreeSketchSpace === 'number' ? d.otaFreeSketchSpace : undefined,
    otaReason: typeof d.otaReason === 'string' ? d.otaReason : undefined,
    lastSeenMs: Date.now(),
  });
  wifiEsp32Sockets.set(key, ws);
  if (previous?.uptimeSec != null && uptimeSec != null && uptimeSec + 10 < previous.uptimeSec) {
    log(`[agentdeck] ESP32 reboot observed: ${key} uptime ${previous.uptimeSec}s -> ${uptimeSec}s reset=${resetReason ?? 'unknown'} code=${resetReasonCode ?? 'unknown'}`);
  }
  debug('daemon', `WiFi ESP32 registered: ${key} v${String(d.version ?? '')} build=${String(d.buildHash ?? '')} uptime=${String(uptimeSec ?? '')} reset=${String(resetReason ?? '')}`);
}

function touchWifiEsp32Socket(ws: WebSocket): void {
  const now = Date.now();
  for (const [key, registeredWs] of wifiEsp32Sockets) {
    if (registeredWs !== ws) continue;
    const device = wifiEsp32Devices.get(key);
    if (device) device.lastSeenMs = now;
    return;
  }
}

function unregisterWifiEsp32Socket(ws: WebSocket): void {
  for (const [key, registeredWs] of wifiEsp32Sockets) {
    if (registeredWs !== ws) continue;
    wifiEsp32Sockets.delete(key);
    // Keep the last device_info snapshot until normal age-out. A reconnect after
    // a board reboot must compare the new uptime against the previous one; if we
    // delete here every crash looks like a fresh device.
    debug('daemon', `WiFi ESP32 disconnected: ${key}`);
  }
}

function handleEsp32OtaReply(msg: Record<string, unknown>): boolean {
  if (msg.type !== 'esp32_ota_ack' && msg.type !== 'esp32_ota_error') return false;
  const otaId = typeof msg.otaId === 'string' ? msg.otaId : '';
  const waiter = otaId ? otaWaiters.get(otaId) : undefined;
  if (!waiter) return true;

  if (msg.type === 'esp32_ota_error') {
    clearTimeout(waiter.timer);
    otaWaiters.delete(otaId);
    waiter.reject(new Error(typeof msg.error === 'string' ? msg.error : 'esp32_ota_error'));
    return true;
  }

  const stage = typeof msg.stage === 'string' ? msg.stage : '';
  const seq = typeof msg.seq === 'number' ? msg.seq : undefined;
  if (stage !== waiter.stage) return true;
  if (waiter.seq != null && seq !== waiter.seq) return true;

  clearTimeout(waiter.timer);
  otaWaiters.delete(otaId);
  waiter.resolve(msg);
  return true;
}

function waitForOtaAck(otaId: string, stage: string, seq: number | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      otaWaiters.delete(otaId);
      reject(new Error(`OTA ${stage}${seq != null ? ` #${seq}` : ''} timed out`));
    }, timeoutMs);
    otaWaiters.set(otaId, { stage, seq, resolve, reject, timer });
  });
}

function findWifiOtaTarget(target: string): { key: string; device: WifiEsp32Device; ws: WebSocket } {
  const matches: Array<{ key: string; device: WifiEsp32Device; ws: WebSocket }> = [];
  for (const [key, device] of wifiEsp32Devices) {
    const ws = wifiEsp32Sockets.get(key);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (key === target || device.board === target || device.ip === target) {
      matches.push({ key, device, ws });
    }
  }
  if (matches.length === 0) throw new Error(`No online WiFi ESP32 target matches "${target}"`);
  if (matches.length > 1) throw new Error(`Target "${target}" is ambiguous: ${matches.map(m => m.key).join(', ')}`);
  return matches[0];
}

async function readJsonBody(req: import('http').IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error('request_body_too_large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

// WiFi OTA ack timeouts. The transport is a WebSocket over TCP, so a chunk/ack
// is never lost while the connection is alive — a "timeout" means the board is
// slow (a classic ESP32 like TTGO/TC001 can stall past several seconds on a
// flash-sector erase or a brief WiFi-stack starvation) or the WiFi link briefly
// blipped and TCP is retransmitting. Both recover if we wait, so the timeouts
// are generous: a healthy board still acks in milliseconds, and these only cap
// how long we ride out a stall before declaring the transfer dead. Resending on
// the SAME live socket would be wrong — it desyncs the firmware's strict
// seq/offset cursor (handleOtaChunk → "unexpected_offset"); a timeout followed
// by a board RECONNECT is the one case where resend is correct (see
// performWifiEsp32Ota — the board never processed the lost chunk, and its otaRx
// cursor persisted across the reconnect). `let` (not const) so tests can shrink
// them via __setOtaTimeoutsForTest; production never mutates them.
let OTA_BEGIN_ACK_TIMEOUT_MS = 15_000; // erasing/preparing the target OTA slot
let OTA_CHUNK_ACK_TIMEOUT_MS = 30_000; // slow classic-ESP32 flash write / WiFi stall
let OTA_END_ACK_TIMEOUT_MS = 30_000;   // whole-image MD5 verify + set-boot-partition

// How long to wait for a board to re-register a live WS after it drops its
// socket mid-OTA, and the cap on such reconnect-driven resends per transfer.
// Serial-backtrace diagnosis of the TTGO 2.5MB WiFi OTA showed the board does
// NOT reset/brownout/watchdog mid-transfer — it survives, prints "[WS]
// Disconnected", and re-registers under the SAME board:ip key with a NEW socket
// ~3-4s later (classic single-core ESP32 WiFi-flash coexistence briefly starves
// the TCP task → the connection drops, not the board). The old code captured the
// socket once and kept sending into the dead one, so the transfer stalled at the
// disconnect and failed 30s later on the chunk-ack timeout. Following the board
// to its reconnected socket lets the transfer resume where it stalled, because
// acks route by otaId (socket-independent) and the firmware keeps its otaRx
// cursor across the reconnect.
let OTA_RECONNECT_WAIT_MS = 20_000;
const OTA_MAX_RECONNECT_RESENDS = 12;

// ── Test-only seams for the WiFi-OTA reconnect-follow path ───────────────────
// The reconnect-follow bug is a socket-lifecycle race that hardware reproduces
// only probabilistically (a WiFi-flash coexistence drop). These exports let a
// deterministic unit test register/replace a board's socket mid-transfer and
// drive acks by otaId, with the ack timeouts shrunk so the drop→timeout→resend
// cycle runs in milliseconds. Not used by production code.
/** @internal */
export function __setOtaTimeoutsForTest(t: { begin?: number; chunk?: number; end?: number; reconnectWait?: number }): void {
  if (t.begin != null) OTA_BEGIN_ACK_TIMEOUT_MS = t.begin;
  if (t.chunk != null) OTA_CHUNK_ACK_TIMEOUT_MS = t.chunk;
  if (t.end != null) OTA_END_ACK_TIMEOUT_MS = t.end;
  if (t.reconnectWait != null) OTA_RECONNECT_WAIT_MS = t.reconnectWait;
}
/** @internal */
export function __resetWifiEsp32OtaState(): void {
  for (const [, w] of otaWaiters) clearTimeout(w.timer);
  otaWaiters.clear();
  wifiEsp32Devices.clear();
  wifiEsp32Sockets.clear();
  OTA_BEGIN_ACK_TIMEOUT_MS = 15_000;
  OTA_CHUNK_ACK_TIMEOUT_MS = 30_000;
  OTA_END_ACK_TIMEOUT_MS = 30_000;
  OTA_RECONNECT_WAIT_MS = 20_000;
}
/** @internal */
export const __wifiOtaTestApi = {
  registerWifiEsp32,
  unregisterWifiEsp32Socket,
  handleEsp32OtaReply,
  performWifiEsp32Ota,
};

async function performWifiEsp32Ota(core: BridgeCore, target: string, firmwarePath: string): Promise<Record<string, unknown>> {
  const { key, device } = findWifiOtaTarget(target);
  if (device.otaSupported !== true) {
    throw new Error(`Target ${key} does not report OTA support${device.otaReason ? ` (${device.otaReason})` : ''}`);
  }

  const firmware = readFileSync(firmwarePath);
  if (device.otaSlotSize && firmware.length > device.otaSlotSize) {
    throw new Error(`Firmware is ${firmware.length} bytes, OTA slot is ${device.otaSlotSize} bytes`);
  }

  const otaId = randomUUID();
  const md5 = createHash('md5').update(firmware).digest('hex');

  // Always resolve the board's CURRENTLY-registered socket, never a captured
  // reference — the board re-registers a fresh socket on a mid-OTA reconnect.
  const liveSocket = (): WebSocket | undefined => {
    const s = wifiEsp32Sockets.get(key);
    return s && s.readyState === WebSocket.OPEN ? s : undefined;
  };
  // Wait up to ms for a live socket (rides out the ~3-4s reconnect gap).
  const awaitLiveSocket = async (ms: number): Promise<WebSocket | undefined> => {
    const deadline = Date.now() + ms;
    let s = liveSocket();
    while (!s && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      s = liveSocket();
    }
    return s;
  };
  const sendVia = (sock: WebSocket, evt: BridgeEvent) => core.wsServer.sendTo(sock, evt);

  let reconnectResends = 0;
  // Send one OTA frame and wait for its ack, following the board to a fresh
  // socket if it reconnects mid-flight. On an ack timeout, if a NEW live socket
  // has appeared (the board reconnected), the frame was lost to the dead socket
  // — resend the same seq on the new socket once. The firmware's otaRx cursor
  // persists across the reconnect, so a resend of the not-yet-processed seq is
  // accepted; a genuinely-gone board still fails after OTA_RECONNECT_WAIT_MS.
  const sendAndAck = async (evt: BridgeEvent, stage: string, seq: number | undefined, timeoutMs: number): Promise<void> => {
    let sock = await awaitLiveSocket(OTA_RECONNECT_WAIT_MS);
    if (!sock) throw new Error(`OTA ${stage}${seq != null ? ` #${seq}` : ''}: board ${key} offline (no live WS)`);
    sendVia(sock, evt);
    try {
      await waitForOtaAck(otaId, stage, seq, timeoutMs);
    } catch (ackErr) {
      const fresh = await awaitLiveSocket(OTA_RECONNECT_WAIT_MS);
      if (fresh && fresh !== sock && reconnectResends < OTA_MAX_RECONNECT_RESENDS) {
        reconnectResends++;
        debug('daemon', `OTA ${key}: ${stage}${seq != null ? ` #${seq}` : ''} ack lost on dropped socket — resending on reconnected WS (resend ${reconnectResends})`);
        sendVia(fresh, evt);
        await waitForOtaAck(otaId, stage, seq, timeoutMs);
        return;
      }
      throw ackErr;
    }
  };

  try {
    await sendAndAck({ type: 'esp32_ota_begin', otaId, size: firmware.length, md5 } as BridgeEvent, 'begin', undefined, OTA_BEGIN_ACK_TIMEOUT_MS);

    const chunkSize = 1024;
    let offset = 0;
    let seq = 0;
    while (offset < firmware.length) {
      const chunk = firmware.subarray(offset, Math.min(offset + chunkSize, firmware.length));
      await sendAndAck({
        type: 'esp32_ota_chunk',
        otaId,
        seq,
        offset,
        data: chunk.toString('base64'),
      } as BridgeEvent, 'chunk', seq, OTA_CHUNK_ACK_TIMEOUT_MS);
      offset += chunk.length;
      seq++;
    }
    await sendAndAck({ type: 'esp32_ota_end', otaId } as BridgeEvent, 'end', undefined, OTA_END_ACK_TIMEOUT_MS);
    wifiEsp32Sockets.delete(key);
    wifiEsp32Devices.delete(key);

    return {
      ok: true,
      target: key,
      board: device.board,
      bytes: firmware.length,
      chunks: seq,
      reconnectResends,
      md5,
    };
  } catch (err) {
    const sock = liveSocket();
    if (sock) { try { sendVia(sock, { type: 'esp32_ota_abort', otaId } as BridgeEvent); } catch { /* best effort */ } }
    throw err;
  }
}

function loadDaemonSettings(): Record<string, unknown> {
  // Newest settings.json across candidate data dirs — mirrors the
  // daemon.json/sessions.json cross-dir discovery (and honors the
  // AGENTDECK_DATA_DIR test override, which the old hardcoded
  // ~/.agentdeck path ignored). The App Store sandbox container is
  // intentionally NOT a candidate (TCC hang risk — see
  // getCandidateDataDirs), so settings written by the sandboxed Swift
  // app stay invisible here; that coexistence limit is documented in
  // docs/appstore-feature-matrix.md.
  let best: { mtime: number; parsed: Record<string, unknown> } | null = null;
  for (const dir of getCandidateDataDirs()) {
    try {
      const path = join(dir, 'settings.json');
      const mtime = statSync(path).mtimeMs;
      if (best && best.mtime >= mtime) continue;
      best = { mtime, parsed: JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> };
    } catch {
      // Missing or unreadable — skip this candidate.
    }
  }
  return best?.parsed ?? {};
}

function latestTimelinePath(): string | null {
  let best: { path: string; mtime: number } | null = null;
  for (const dir of getCandidateDataDirs()) {
    try {
      const path = join(dir, 'timeline.json');
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      // Missing or unreadable — skip this candidate.
    }
  }
  return best?.path ?? null;
}

// Observed-session attention history: the held PreToolUse device-approval gate
// was removed on 2026-06-27 and stays removed — PreToolUse fires even for tools
// Claude auto-approves, so gating on it produced false attention + a fabricated
// Allow/Deny that never matched Claude's real prompt. The *display-only*
// Notification overlay was restored on 2026-07-05: `notification_type:
// "permission_prompt"` fires only when a permission prompt is actually shown to
// the user, so it is a genuine awaiting signal. Observed sessions surface
// awaiting + question with NO requestId (respond-in-terminal UX); steering with
// real options still exists only on PTY-managed sessions (`agentdeck claude`).

function log(msg: string): void {
  // Timestamped like logger.ts — daemon stderr lands in a long-lived log file,
  // and un-datable restart/incident lines repeatedly blocked root-cause work.
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

// ===== Usage relay (3-tier) =====

interface RelayedUsage {
  usage: ApiUsageData;
  fetchedAt: number;
}

async function fetchUsageViaHttp(siblings: { port: number }[]): Promise<RelayedUsage | null> {
  for (const sibling of siblings) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://127.0.0.1:${sibling.port}/usage`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json() as { status: string; usage: ApiUsageData | null; fetchedAt: number };
      if (!data.usage) continue;
      const age = Date.now() - data.fetchedAt;
      if (age > 5 * 60 * 1000) continue;
      return { usage: data.usage, fetchedAt: data.fetchedAt };
    } catch { /* try next */ }
  }
  return null;
}

async function fetchUsageViaWs(siblings: { port: number }[]): Promise<ApiUsageData | null> {
  for (const sibling of siblings) {
    try {
      const usage = await new Promise<ApiUsageData | null>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${sibling.port}`);
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
        ws.on('message', (raw: Buffer | string) => {
          try {
            const evt = JSON.parse(raw.toString());
            if (evt.type === 'usage_update' && evt.fiveHourPercent != null) {
              clearTimeout(timer);
              ws.close();
              resolve({
                fiveHourPercent: evt.fiveHourPercent ?? null,
                fiveHourResetsAt: evt.fiveHourResetsAt ?? null,
                sevenDayPercent: evt.sevenDayPercent ?? null,
                sevenDayResetsAt: evt.sevenDayResetsAt ?? null,
                extraUsageEnabled: evt.extraUsageEnabled ?? false,
                extraUsageMonthlyLimit: evt.extraUsageMonthlyLimit ?? null,
                extraUsageUsedCredits: evt.extraUsageUsedCredits ?? null,
                extraUsageUtilization: evt.extraUsageUtilization ?? null,
                inferredBillingType: null,
              });
            }
          } catch { /* ignore */ }
        });
        ws.on('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
        ws.on('close', () => { clearTimeout(timer); reject(new Error('ws closed')); });
      });
      if (usage) return usage;
    } catch { /* try next */ }
  }
  return null;
}

async function fetchUsageRelayed(selfPort: number): Promise<ApiUsageData | null> {
  const sessions = listActiveSessions();
  const siblings = sessions.filter(s => s.port !== selfPort && s.agentType !== 'daemon');

  if (siblings.length > 0) {
    const httpResult = await fetchUsageViaHttp(siblings);
    if (httpResult) return httpResult.usage;
    const wsResult = await fetchUsageViaWs(siblings);
    if (wsResult) return wsResult;
    debug('daemon', 'Siblings exist but relay failed — skipping direct API');
    return null;
  }

  debug('daemon', 'No siblings, using direct API');
  return fetchUsageFromApi();
}

/**
 * Stamp OpenClaw origin onto a timeline entry emitted by the Gateway adapter.
 *
 * The adapter emits bare entries (no agentType/projectName); without this the
 * BridgeCore attributor falls back to the daemon's hardcoded projectName
 * ('AgentDeck') and leaves agentType null, so OpenClaw cron activity gets
 * mis-grouped under AgentDeck and never renders as OpenClaw. `?? ` fallbacks
 * preserve any value the adapter did set, and the downstream attributor's own
 * `?? ` keeps these in turn.
 */
export function enrichGatewayTimelineEntry<T extends { agentType?: string; projectName?: string }>(
  entry: T,
): T {
  return {
    ...entry,
    agentType: entry.agentType ?? 'openclaw',
    projectName: entry.projectName ?? 'OpenClaw',
  };
}

/**
 * Classify a `/hooks/<eventName>` POST for the observed-session pipeline.
 *
 * Claude hooks arrive as PascalCase names (already snake_cased by the
 * caller's eventMap → `mapped`); Codex lifecycle hooks (installed into
 * `~/.codex/config.toml`) arrive as `codex_*`; the AgentDeck OpenCode
 * observer plugin posts `opencode_*`. All three share one pipeline —
 * APME run/turn management, the chat_start row, and the stop-completion
 * row — keyed off the returned agent-neutral `boundary`, so a direct
 * `codex` or standalone `opencode` run gets the same prompt → response
 * turn shape on the timeline as a direct `claude` run. (The Swift daemon
 * has carried Codex parity since its observation pass —
 * DaemonServer.swift appendCodexChatStart/End; this closes the same gap
 * on the Node daemon.)
 *
 * Codex notify's `turn_complete` maps to `stop`: it closes a turn the
 * same way, and the caller's open-turn guard collapses a stop +
 * turn_complete pair into a single completion row.
 *
 * `antigravity_*` is accepted for forward-compatibility: Antigravity has
 * no hook installer yet (the IDE exposes no lifecycle hook config; its
 * sessions surface via PassiveSessionObserver transcript polling), but
 * anything that starts POSTing these names gets full turn parity with no
 * daemon change.
 */
export function classifyObservedHookEvent(
  eventName: string,
  mapped: string,
): { boundary: string; agentType: 'claude-code' | 'codex-cli' | 'opencode' | 'antigravity' } {
  const prefixed = /^(codex|opencode|antigravity)_(session_start|session_end|user_prompt_submit|tool_start|tool_end|stop|turn_complete|notification)$/
    .exec(eventName);
  if (!prefixed) return { boundary: mapped, agentType: 'claude-code' };
  return {
    boundary: prefixed[2] === 'turn_complete' ? 'stop' : prefixed[2],
    agentType: prefixed[1] === 'codex' ? 'codex-cli'
      : prefixed[1] === 'opencode' ? 'opencode'
      : 'antigravity',
  };
}

// ===== Daemon options =====

export interface DaemonOptions {
  port?: number;
  debug?: boolean;
  wakeWord?: boolean;
}

function buildNodeModuleHealth(startedModules: DeviceModule[]): Record<string, unknown> {
  const started = new Set(startedModules.map((m) => m.name));
  const modules: Record<string, unknown> = {};

  if (started.has('adb')) {
    const adbAvailable = hasAdb();
    const devices = adbAvailable ? getConnectedAdbDevices() : [];
    modules.adb = {
      available: adbAvailable,
      devices,
      classifiedDevices: [],
      reverseReadyCount: devices.length,
      lastError: adbAvailable ? null : 'adb not found',
    };
  }

  if (started.has('pixoo') || pixooDeviceCount() > 0) {
    const details = getPixooDeviceDetails();
    modules.pixoo = {
      configuredDeviceCount: pixooDeviceCount(),
      deviceIps: details.map((d) => d.ip),
      hasFrame: true,
      displayDimmed: false,
      devices: details.map((d) => ({
        ip: d.ip,
        name: d.name,
        online: !d.backedOff,
        failures: d.failures,
        backedOff: d.backedOff,
      })),
    };
  }

  const timebox = startedModules.find((m) => m.name === 'timebox') as DeviceModule & {
    statusSnapshot?: () => Record<string, unknown>;
  };
  const configuredTimebox = loadTimeboxDevices();
  if (timebox?.statusSnapshot) {
    modules.timebox = timebox.statusSnapshot();
  } else if (configuredTimebox.length > 0) {
    modules.timebox = {
      configuredDeviceCount: configuredTimebox.length,
      devices: configuredTimebox.map((d) => ({
        address: d.address,
        name: d.name ?? 'Timebox Mini',
        brightness: d.brightness ?? 100,
      })),
    };
  }

  const idotmatrix = startedModules.find((m) => m.name === 'idotmatrix') as DeviceModule & {
    statusSnapshot?: () => Record<string, unknown>;
  };
  const configuredIDotMatrix = loadIDotMatrixDevices();
  if (idotmatrix?.statusSnapshot) {
    modules.idotmatrix = idotmatrix.statusSnapshot();
  } else if (configuredIDotMatrix.length > 0) {
    modules.idotmatrix = {
      configuredDeviceCount: configuredIDotMatrix.length,
      devices: configuredIDotMatrix.map((d) => ({
        address: d.address,
        name: d.name ?? 'iDotMatrix',
        brightness: d.brightness ?? 100,
      })),
    };
  }

  if (started.has('serial')) {
    const connectionStatus = getSerialConnectionStatus();
    const connections = connectionStatus.map((status) => ({
      port: status.port,
      connected: status.connected,
      transportOpen: status.transportOpen,
      deviceInfo: status.board ? {
        board: status.board,
        version: status.version,
        buildHash: status.buildHash,
        buildEpoch: status.buildEpoch,
        wifiConfigured: status.wifiConfigured,
        wifiConnected: status.wifiConnected,
        wifiRadioParked: status.wifiRadioParked,
        uptimeSec: status.uptimeSec,
        otaSupported: status.otaSupported,
        otaSlotCount: status.otaSlotCount,
        otaSlotSize: status.otaSlotSize,
        otaFreeSketchSpace: status.otaFreeSketchSpace,
        otaReason: status.otaReason,
        timelineCount: status.timelineCount,
        sessionCount: status.sessionCount,
        usageFiveH: status.usageFiveH,
        processingCount: status.processingCount,
      } : null,
      lastReadAt: status.lastReadAt,
      lastWriteAt: status.lastWriteAt,
      lastReadSecondsAgo: status.lastReadSecondsAgo,
      lastWriteSecondsAgo: status.lastWriteSecondsAgo,
      stale: status.stale,
    }));
    modules.serial = {
      connectedPorts: connections.filter((c) => c.connected).map((c) => c.port),
      connections,
      lastError: getSerialLastError(),
      connectionCount: connections.filter((c) => c.connected).length,
    };
  }

  return modules;
}

// ===== startDaemon =====

export async function startDaemon(opts: DaemonOptions): Promise<void> {
  if (opts.debug) {
    enableDebugLog();
    log('[agentdeck] Debug logging enabled');
  }

  // CLI --wake-word flag OR settings.json wakeWord: true
  const settings = loadDaemonSettings();
  const wakeWordEnabled = opts.wakeWord || settings.wakeWord === true;

  // ===== Singleton guard + port allocation =====
  // 1. Check daemon.json and sessions.json for existing daemon
  const existingInfo = readDaemonInfo();
  if (existingInfo) {
    const probePort = existingInfo.httpPort ?? existingInfo.port;
    const health = await probeDaemonHealth(probePort);
    if (health?.mode === 'daemon') {
      if (health.isSwift) {
        log(`[agentdeck] Swift daemon detected on port ${probePort}. Requesting shutdown to take over...`);
        await requestDaemonShutdown(probePort);
        await waitForDaemonExit(probePort);
        removeDaemonInfo();
      } else {
        log(`[agentdeck] Daemon already running on port ${existingInfo.port} (PID ${existingInfo.pid}).`);
        process.exit(0);
      }
    } else {
      log(`[agentdeck] Ignoring stale daemon entry on port ${existingInfo.port} (PID ${existingInfo.pid}; /health did not respond).`);
      removeDaemonInfo();
    }
  }
  const existingSession = findExistingDaemon();
  if (existingSession) {
    const health = await probeDaemonHealth(existingSession.port);
    if (health?.mode === 'daemon') {
      if (health.isSwift) {
        log(`[agentdeck] Swift daemon detected on port ${existingSession.port}. Requesting shutdown to take over...`);
        await requestDaemonShutdown(existingSession.port);
        await waitForDaemonExit(existingSession.port);
        removeDaemonSession(existingSession);
      } else {
        log(`[agentdeck] Daemon already running on port ${existingSession.port} (PID ${existingSession.pid}).`);
        process.exit(0);
      }
    } else {
      log(`[agentdeck] Ignoring stale daemon session on port ${existingSession.port} (PID ${existingSession.pid}; /health did not respond).`);
      removeDaemonSession(existingSession);
    }
  }

  // 2. Determine port — try default first, fallback if occupied by non-daemon
  const requestedPort = opts.port ?? DAEMON_DEFAULT_PORT;
  let port = requestedPort;

  // If using default port, check if it's available
  if (requestedPort === DAEMON_DEFAULT_PORT) {
    const health = await probeDaemonHealth(requestedPort);
    if (health) {
      if (health.mode === 'daemon') {
        if (health.isSwift) {
          log(`[agentdeck] Swift daemon detected on port ${requestedPort} via /health. Requesting shutdown to take over...`);
          await requestDaemonShutdown(requestedPort);
          await waitForDaemonExit(requestedPort);
        } else {
          // Daemon alive but not in our registry — race condition or stale state
          log(`[agentdeck] Daemon already running on port ${requestedPort} (detected via /health).`);
          process.exit(0);
        }
      } else {
        // Port occupied by non-daemon (e.g. session bridge) — find alternative
        log(`[agentdeck] Port ${requestedPort} occupied (${health.mode ?? 'unknown'}), finding alternative...`);
        port = await findAvailablePort();
      }
    }
  }

  // 3. Cross-implementation sweep of the daemon port window. File discovery
  // has two blind spots that the checks above never cover: the App Store
  // Swift daemon writes daemon.json into its private sandbox container (this
  // process cannot read it), and transient 9120 contention can leave a daemon
  // sitting on a fallback port (9121+). Missing it here means two live
  // daemons: double mDNS advertising, duplicate Gateway/timeline relay, and
  // adb-reverse flapping. Swift occupants are evicted (same policy as above);
  // a live Node daemon wins and we exit.
  const strayDaemons = await scanDaemonPortWindow(new Set([requestedPort]));
  for (const stray of strayDaemons) {
    if (stray.health.isSwift) {
      log(`[agentdeck] Swift daemon detected on fallback port ${stray.port}. Requesting shutdown to take over...`);
      await requestDaemonShutdown(stray.port);
      await waitForDaemonExit(stray.port);
    } else if (shouldConcedePortToOccupant(stray.health, process.pid)) {
      log(`[agentdeck] Daemon already running on port ${stray.port} (detected via port scan).`);
      process.exit(0);
    }
  }

  log(`[agentdeck] Starting daemon on port ${port}...`);

  // ===== APME (lazy — may be null if better-sqlite3 isn't installed) =====
  let apme: ApmeModule | null = null;
  // Fallback task-row emitter, created only when initApme() returns null —
  // keeps task_start/task_end rows on the timeline without the collector.
  let fallbackTasks: FallbackTaskTimeline | null = null;

  // Declare early — HTTP /health handler references this in its closure.
  // Must be declared before the HTTP server so it's initialized (not in TDZ)
  // when the first /health request arrives.
  let gatewayAdapter: OpenClawAdapter | null = null;
  let gatewayConnecting = false;
  let moduleHealthProvider: () => Record<string, unknown> = () => ({});

  // Wi-Fi WebSocket e-ink panels (XTeink X3/X4 CrossPoint fork) self-register
  // their device roster via `client_register{clientType:"eink-device"}` — the
  // same volunteer model as the Stream Deck plugin. This handler lived ONLY in
  // the Swift daemon, so when the dashboard talked to the Node daemon (the
  // common case) these devices never surfaced on the Downstream E-ink rail.
  // Keyed by socket; a registration drops the moment its socket closes
  // (filtered lazily in `collectEinkDevices` on readyState), so no separate
  // TTL sweep is needed.
  const einkRegistrations = new Map<WebSocket, { devices: unknown[]; updatedAt: number }>();
  const collectEinkDevices = (): unknown[] => {
    const out: unknown[] = [];
    for (const [ws, reg] of einkRegistrations) {
      if (ws.readyState !== WebSocket.OPEN) { einkRegistrations.delete(ws); continue; }
      for (const d of reg.devices) out.push(d);
    }
    return out;
  };

  // ===== HTTP server =====
  const httpServer = createServer((req, res) => {
    // APME routes: auth-gated (task prompts, project paths, hook payloads are sensitive).
    if ((req.url ?? '').startsWith('/apme')) {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalConnection(ip)) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const token = url.searchParams.get('token') ?? '';
        if (!validateToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — token required for APME routes' }));
          return;
        }
      }
      void handleApmeRequest(req, res, apme).catch((err) => {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        } catch { /* ignore */ }
      });
      return;
    }
    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Health check is public (no auth) — used by iOS/Android for pairing token discovery
    if (req.method === 'GET' && pathname === '/health') {
      const snap = core.stateMachine.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', mode: 'daemon', state: snap.state,
        gateway: gatewayAdapter?.isAlive() ? 'connected' : 'disconnected',
        uptime: process.uptime(), port, pid: process.pid,
        pairingToken: core.authToken,
        modules: moduleHealthProvider(),
        apme: apme
          ? {
              enabled: true,
              dbPath: apme.store.dbPath,
              judgeBackend: apme.runner.lastBackendProbe ?? { status: 'unknown', backend: loadApmeConfig().judge.backend },
            }
          : { enabled: false, error: apme === null ? 'see startup logs (initApme returned null)' : 'unknown' },
      }));
      return;
    }
    if (req.method === 'GET' && pathname === '/status') {
      const snap = core.stateMachine.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        state: snap.state,
        daemon: { port, pid: process.pid },
        gateway: {
          available: core.cachedGatewayAvailable,
          connected: core.cachedGatewayConnected,
          hasError: core.cachedGatewayHasError,
        },
        clients: core.wsServer.getClientCount(),
        modules: moduleHealthProvider(),
      }));
      return;
    }
    if (req.method === 'GET' && pathname === '/devices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Direct-HID D200H control was retired; the D200H is driven exclusively by
      // the Ulanzi Studio plugin over WebSocket. Report it connected iff that
      // plugin is attached.
      const ulanziPluginConnected = core.wsServer.getUlanziClientCount() > 0;
      res.end(JSON.stringify({
        devices: [
          { type: 'websocket', count: core.wsServer.getClientCount() },
          { type: 'esp32', count: esp32ConnectionCount(), ports: getESP32Ports(), devices: getESP32DeviceInfo() },
          { type: 'esp32-wifi', devices: listWifiEsp32Devices() },
          { type: 'pixoo', details: getPixooDeviceDetails() },
          { type: 'timebox', devices: loadTimeboxDevices() },
          { type: 'idotmatrix', devices: loadIDotMatrixDevices() },
          { type: 'adb', count: getAdbDeviceCount() },
          {
            type: 'd200h',
            connected: ulanziPluginConnected,
            ulanziPluginConnected,
          },
        ],
        modules: moduleHealthProvider(),
      }));
      return;
    }
    if (req.method === 'POST' && pathname === '/esp32/ota') {
      (async () => {
        const body = await readJsonBody(req);
        const target = typeof body.target === 'string' ? body.target : '';
        const firmwarePath = typeof body.firmwarePath === 'string' ? body.firmwarePath : '';
        if (!target || !firmwarePath) {
          throw new Error('target and firmwarePath are required');
        }
        return performWifiEsp32Ota(core, target, firmwarePath);
      })().then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/display-state') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(buildDisplayStateEvent(core.displayMonitor.isDisplayOn())));
      return;
    }
    if (req.method === 'GET' && pathname === '/diag') {
      const snap = core.stateMachine.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionInfo: {
          state: snap.state,
          permissionMode: snap.permissionMode,
          suggestedPrompt: snap.suggestedPrompt,
          lastValidSuggestedPrompt: core.stateMachine.getLastValidSuggestedPrompt(),
          projectName: snap.projectName,
          modelName: snap.modelName,
          billingType: snap.billingType,
        },
        wsClients: core.wsServer.getClientCount(),
        recentJournal: [],
        ptyTail: '',
        journalDir: join(homedir(), '.agentdeck'),
      }));
      return;
    }
    if (req.method === 'GET' && pathname === '/pixoo/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.on('error', () => {}); // Prevent unhandled stream error on client disconnect

      const listener = (frame: Uint8Array) => {
        const bmp = rgbToBmp(frame, 64, 64);
        const b64 = bmp.toString('base64');
        try { res.write(`event: frame\ndata: ${b64}\n\n`); } catch { /* client gone */ }
      };
      onFrameRendered(listener);

      // Send current frame immediately
      const current = getLastFrame() ?? renderPreviewFrame();
      listener(current);

      // Heartbeat
      const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { /* */ }
      }, 30_000);

      req.on('close', () => {
        offFrameRendered(listener);
        clearInterval(heartbeat);
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/pixoo/frame') {
      const sizeParam = parsedUrl.searchParams.get('size');
      const size: 11 | 32 | 64 = sizeParam === '11' ? 11 : sizeParam === '32' ? 32 : 64;
      const layout = parsedUrl.searchParams.get('layout') === 'micro' ? 'micro' : 'standard';
      // The frame cache holds the standard terrarium, so render micro fresh.
      const rgb = layout === 'micro'
        ? renderPreviewFrame(size, 'micro')
        : (getLastFrame(size) ?? renderPreviewFrame(size));
      const bmp = rgbToBmp(rgb, size, size);
      res.writeHead(200, {
        'Content-Type': 'image/bmp',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(bmp);
      return;
    }
    if (req.method === 'GET' && pathname === '/pixoo') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(pixooLiveHtml({ projectName: 'AgentDeck' }));
      return;
    }
    if (req.method === 'GET' && pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.on('error', () => {}); // Prevent unhandled stream error on client disconnect
      res.write(`event: connected\ndata: {}\n\n`);
      req.on('close', () => {});
      return;
    }
    // Hook endpoint — receives Claude Code hook POSTs at /hooks/:eventName.
    // Routes through APME collector the same way session bridge's hook-server does.
    if (req.method === 'POST' && pathname.startsWith('/hooks/')) {
      const eventName = pathname.slice('/hooks/'.length);
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        let json: Record<string, unknown> = {};
        try { json = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        // Map PascalCase event names to snake_case for state machine + APME
        const eventMap: Record<string, string> = {
          SessionStart: 'session_start', SessionEnd: 'session_end',
          PreToolUse: 'tool_start', PostToolUse: 'tool_end',
          Stop: 'stop', UserPromptSubmit: 'user_prompt_submit',
          Notification: 'notification',
        };
        const mapped = eventMap[eventName] ?? eventName;
        // Agent-prefixed lifecycle hooks (codex_* / opencode_*) reuse the
        // same observed-session pipeline as Claude's PascalCase hooks —
        // `boundary` is the agent-neutral semantic every block below keys
        // off. State-machine calls stay Claude-only (`mapped`): observed
        // codex/opencode *state* is owned by the passive observer's turn
        // semantics, not these hooks.
        const { boundary, agentType: hookAgentType } = classifyObservedHookEvent(eventName, mapped);
        // State machine
        if (mapped === 'session_start') core.stateMachine.handleHookEvent('SessionStart', json);
        else if (mapped === 'session_end') core.stateMachine.handleHookEvent('SessionEnd', json);
        else if (mapped === 'user_prompt_submit') core.stateMachine.handleHookEvent('UserPromptSubmit', json);
        else if (mapped === 'stop') core.stateMachine.handleHookEvent('Stop', json);
        else if (mapped === 'tool_start') {
          core.stateMachine.handleHookEvent('PreToolUse', json);
        } else if (mapped === 'tool_end') {
          core.stateMachine.handleHookEvent('PostToolUse', json);
        }
        // Per-session awaiting overlay (observed/direct-`claude` sessions),
        // display-only. Claude emits Notification with `notification_type:
        // "permission_prompt"` only when a permission prompt is actually shown
        // to the user (auto-approved tools fire PreToolUse but never this), so
        // it is a genuine "waiting for explicit response" signal — unlike the
        // removed PreToolUse gate. No requestId is ever set: surfaces render
        // awaiting + question with the respond-in-terminal fallback, never a
        // fabricated Allow/Deny. Keyed by Claude's own session_id and merged
        // into the observed-session list at enrich time (awaiting-overlay.ts).
        const claudeSid = typeof json.session_id === 'string' ? json.session_id : undefined;
        if (claudeSid) {
          if (mapped === 'notification') {
            const message = typeof json.message === 'string' ? json.message : '';
            const notificationType = typeof json.notification_type === 'string' ? json.notification_type : undefined;
            if (isPermissionNotification(notificationType, message)) {
              setAwaitingOverlay(claudeSid, message);
              // Broadcast immediately rather than waiting for the 2s debounce
              // or the 5s observer tick, so the prompt surfaces within one frame.
              core.broadcastSessionsList().catch(() => {});
            }
          } else if (
            mapped === 'tool_start' || mapped === 'tool_end' ||
            mapped === 'user_prompt_submit' || mapped === 'stop' ||
            mapped === 'session_start' || mapped === 'session_end'
          ) {
            // Any subsequent hook means the prompt was answered — drop the
            // overlay. Only rebroadcast if there was actually one to clear
            // (direct-`claude` sessions fire tool hooks constantly).
            if (clearAwaitingOverlay(claudeSid)) {
              core.broadcastSessionsList().catch(() => {});
            }
          }
        }
        // Observed-session activity log. Managed sessions relay their timeline
        // from the session bridge (AGENTDECK_PORT routes their hooks there),
        // but direct `claude`/`codex` runs only reach the daemon through these
        // hooks — without emitting here the daemon timeline (device ticker,
        // Android/Apple lists) goes silent whenever no managed session runs.
        //
        // Task GROUPING is fully hook-driven and TTY-independent: the boundary
        // state machine keys only off `user_prompt_submit` / `session_end` /
        // `/clear`, so it never depends on parsing the agent's terminal output
        // and stays stable across agent CLI UI changes. Per-tool rows are still
        // suppressed here (they drowned the glance surfaces); the `task_start` /
        // `task_end` headers + taskId-tagged `chat_start` rows now carry the
        // work-unit structure.
        //
        // Real per-session id shared by the collector, fallback, and the
        // chat_start row. Concurrent direct `claude`/`codex` runs must NOT
        // collapse onto one bucket: a shared id interleaves their turns into a
        // single task and lets one session's `session_end` tear down another's
        // run mapping. Falls back to a stable id only when a hook omits it.
        const hookSid = typeof json.session_id === 'string' && json.session_id
          ? json.session_id : 'daemon-hook';
        // Claude hooks carry `cwd` (the worktree dir), not project_name/path —
        // capture it so APME runs are attributable to a specific worktree.
        const hookCwd = (typeof json.cwd === 'string' ? json.cwd
          : (typeof json.project_path === 'string' ? json.project_path : '')) || '';
        const hookProject = (typeof json.project_name === 'string' && json.project_name)
          ? json.project_name
          : (hookCwd ? hookCwd.split('/').filter(Boolean).pop() : undefined);
        const hookMessage = json.message as Record<string, unknown> | undefined;
        // Prompt shapes: Claude `{prompt}` / `{message:{content}}`; some Codex
        // builds send `{user_prompt}` (same fallback chain as codex-hook.ts).
        const hookPromptText = typeof json.prompt === 'string' ? json.prompt
          : (typeof hookMessage?.content === 'string' ? hookMessage.content
            : (typeof json.user_prompt === 'string' ? json.user_prompt : ''));
        const isClearBoundary = boundary === 'user_prompt_submit' && /^\s*\/clear\s*$/i.test(hookPromptText);

        // ── APME collector (task/turn segmentation) ──
        if (apme) {
          if (isClearBoundary) {
            // `/clear` closes the active task + run and opens a fresh run, so
            // the next prompt starts a new task 0 — the work-unit boundary.
            apme.collector.splitRun(hookSid, hookCwd || undefined);
          } else {
            // Lazy openRun: open a run when a turn-STARTING hook arrives with no
            // active run — either a normal `session_start`, or (crucially) the
            // first `user_prompt_submit` when `session_start` was missed/late.
            // Without this, `ingestHook` no-ops for want of a run, which is
            // exactly why direct-`claude` timelines showed zero task headers
            // (every follow-up looked like a new top-level chat). Gating on
            // start/prompt avoids two hazards: a stray post-`session_end` tool /
            // stop hook won't spawn a phantom run, and a late `session_start`
            // arriving after a lazy open won't double-open (the run already
            // exists → skip).
            if (!apme.collector.getRunId(hookSid)
                && (boundary === 'session_start' || boundary === 'user_prompt_submit')) {
              apme.collector.openRun({
                sessionId: hookSid,
                agentType: hookAgentType,
                projectName: hookProject,
                projectPath: hookCwd || undefined,
              });
            }
            // Feed the agent-neutral boundary name: the collector's
            // normalizeHookEventName only understands the Claude-shaped
            // vocabulary (user_prompt_submit / tool_start / …), so raw
            // codex_* / opencode_* names would silently skip turn management.
            apme.collector.ingestHook(hookSid, boundary, json);
          }
          // Direct `claude` runs reach the daemon only via these hooks, which
          // never carry the model — so every such run persisted model_id=NULL.
          // Recover it from the transcript Claude writes. Must run before
          // closeRun tears down the session→run mapping.
          if (boundary === 'stop' || boundary === 'session_end') {
            const tp = json.transcript_path;
            if (typeof tp === 'string' && tp) {
              const model = readModelFromTranscript(tp);
              if (model) apme.collector.updateModel(hookSid, model);
            }
          }
          if (boundary === 'session_end') {
            apme.collector.closeRun(hookSid);
          }
        } else if (fallbackTasks) {
          // APME is down — keep the timeline's task hierarchy alive from the
          // same boundary hooks (open on first prompt, close on /clear +
          // session_end), keyed by the real session id.
          fallbackTasks.ingestHook(hookSid, boundary, json);
        }

        // Timeline `chat_start`, emitted AFTER the collector so the active task
        // id is known — tag the row with it so the prompt nests under the
        // (possibly deferred) task_start header instead of reading as its own
        // top-level task. `/clear` is a boundary command, not a turn: no row.
        if (boundary === 'user_prompt_submit' && !isClearBoundary
            && hookPromptText.trim()
            // Codex's OTel turnStarted pseudo-prompt is a turn marker, not a
            // user prompt (same filter as the Swift daemon's chat_start path).
            && hookPromptText.trim() !== 'Codex turn started') {
          const taskId = (apme
            ? apme.collector.getActiveTaskId(hookSid)
            : fallbackTasks?.getActiveTaskId(hookSid)) ?? undefined;
          const promptText = stripUnsafeText(hookPromptText.trim());
          const now = Date.now();
          core.bridgeTimeline.addEntry({
            ts: now, type: 'chat_start',
            raw: promptText.slice(0, 160),
            // Long prompts keep their body reachable via the detail pane —
            // the 160-char raw alone read as clipped on the dashboards.
            ...(promptText.length > 160 ? { detail: promptText.slice(0, 1000) } : {}),
            sessionId: hookSid,
            agentType: hookAgentType,
            startedAt: now,
            ...(taskId ? { taskId } : {}),
            ...(hookProject ? { projectName: hookProject } : {}),
          } as TimelineEntry);
        }

        // Timeline turn completion. Managed sessions relay chat_response from
        // their session bridge, but hook-observed (direct `claude` / `codex` /
        // standalone `opencode`) sessions only reach the daemon here — without
        // a completion row their chat_start rows spin as "running" forever on
        // every dashboard surface. Claude's Stop carries `transcript_path`
        // (the transcript tail's last assistant text is the turn's response —
        // same source the model reader uses above); Codex/OpenCode carry the
        // response inline (`last_assistant_message` / `response` / `output` /
        // `result`, the Swift daemon's field chain). Only emit while a turn is
        // actually open (a chat_start newer than the session's last
        // completion) so a duplicate/late Stop or an interrupted turn doesn't
        // re-emit the previous response.
        if (boundary === 'stop') {
          const rows = core.bridgeTimeline.getHistoryForSession(hookSid, undefined, 24);
          let lastStart: TimelineEntry | undefined;
          let lastResponse: TimelineEntry | undefined;
          let lastCompletionTs = 0;
          for (const row of rows) {
            if (row.type === 'chat_start') lastStart = row;
            else if (row.type === 'chat_response' || row.type === 'chat_end') {
              if (row.type === 'chat_response') lastResponse = row;
              lastCompletionTs = Math.max(lastCompletionTs, row.ts);
            }
          }
          const turnOpen = Boolean(lastStart && lastStart.ts > lastCompletionTs);
          const tp = typeof json.transcript_path === 'string' ? json.transcript_path : '';
          const inlineResponse = [json.last_assistant_message, json.response, json.output, json.result]
            .find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? '';
          // Codex's stop payload rarely carries the text inline; its rollout
          // JSONL (agent_message / task_complete records) is the
          // authoritative source — the Codex counterpart of Claude's
          // transcript tail. Read it whenever a completion row might be
          // emitted (open turn, or a response-only close below).
          const rolloutResponse = !tp && !inlineResponse && hookAgentType === 'codex-cli'
            ? lastAgentMessageFromCodexRollout(hookSid)
            : '';
          const responseText = tp
            ? stripUnsafeText(lastAssistantTextFromTranscript(tp))
            : stripUnsafeText(inlineResponse || rolloutResponse);
          const respRaw = responseText.length > 0
            ? cleanRawText(responseText.length > 200 ? responseText.slice(0, 197) + '...' : responseText)
            : '';
          if (turnOpen && lastStart) {
            const now = Date.now();
            const taskId = (apme
              ? apme.collector.getActiveTaskId(hookSid)
              : fallbackTasks?.getActiveTaskId(hookSid)) ?? lastStart.taskId ?? undefined;
            const base = {
              sessionId: hookSid,
              agentType: hookAgentType,
              startedAt: lastStart.startedAt ?? lastStart.ts,
              endedAt: now,
              ...(taskId ? { taskId } : {}),
              ...(hookProject ? { projectName: hookProject } : {}),
            };
            if (responseText.length > 0) {
              core.bridgeTimeline.addEntry({
                ts: now, type: 'chat_response',
                raw: respRaw,
                detail: prepareMarkdownDetail(responseText.slice(0, 3000)) || undefined,
                ...base,
              } as TimelineEntry);
            } else {
              // No readable response (interrupted / tool-only turn) — still
              // close the row so the dashboards stop the spinner.
              const durS = Math.max(0, Math.round((now - (lastStart.startedAt ?? lastStart.ts)) / 1000));
              core.bridgeTimeline.addEntry({
                ts: now, type: 'chat_end',
                raw: `Completed · ${durS}s`,
                summaryKind: 'none',
                ...base,
              } as TimelineEntry);
            }
          } else if (respRaw && lastResponse?.raw !== respRaw) {
            // Response-only close (Swift daemon parity): the turn's prompt
            // hook was missed — notify-only Codex configs emit just
            // turn_complete, and an OpenCode prompt can surface empty — so
            // there is no open chat_start to anchor on, but the response
            // text is still the turn's result and worth a row. The
            // raw-equality guard keeps a duplicate/late stop from
            // re-emitting the same response.
            const now = Date.now();
            const taskId = (apme
              ? apme.collector.getActiveTaskId(hookSid)
              : fallbackTasks?.getActiveTaskId(hookSid)) ?? undefined;
            core.bridgeTimeline.addEntry({
              ts: now, type: 'chat_response',
              raw: respRaw,
              detail: prepareMarkdownDetail(responseText.slice(0, 3000)) || undefined,
              sessionId: hookSid,
              agentType: hookAgentType,
              endedAt: now,
              ...(taskId ? { taskId } : {}),
              ...(hookProject ? { projectName: hookProject } : {}),
            } as TimelineEntry);
          }
        }

        // ── Response ──
        // PreToolUse returns an empty body → Claude's normal permission flow
        // runs untouched (zero added latency, no daemon-side gate). Every other
        // event acks immediately.
        if (eventName === 'PreToolUse') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        }
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/shutdown') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting_down' }));
      const hardExitTimer = setTimeout(() => {
        log('[agentdeck] Shutdown route timeout — forcing exit.');
        exitProcessNow(0);
      }, 5000);
      core.shutdown();
      return;
    }

    // Manual task-close endpoint — drives `closeTaskExternal` on the APME
    // collector. Used by the CLI (`agentdeck task done` / `task cancel`)
    // and the macOS detail-pane "Mark task complete" button. Body:
    //   { sessionId: string, signal?: 'manual', outcome?: 'success'|'fail'|'abandoned' }
    // sessionId defaults to the active session derived from the daemon's
    // registry; supplying it explicitly is the contract the CLI uses.
    if (req.method === 'POST' && pathname === '/task/close') {
      if (!apme) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'APME not initialized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
          const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId
            ? parsed.sessionId
            : (openclawApmeSessionId ?? '');
          if (!sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sessionId required (no active session to default to)' }));
            return;
          }
          const signalRaw = typeof parsed.signal === 'string' ? parsed.signal : 'manual';
          const outcomeRaw = typeof parsed.outcome === 'string' ? parsed.outcome : undefined;
          const outcome = (outcomeRaw === 'success' || outcomeRaw === 'fail' || outcomeRaw === 'partial' || outcomeRaw === 'abandoned')
            ? outcomeRaw
            : undefined;
          // closeTaskExternal accepts TaskBoundarySignal (open union with
          // string fallback). Narrow only the well-known signals; pass
          // unknown strings through as-is (the runner labels them
          // generically).
          const apmeRef = apme;
          if (!apmeRef) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'APME not initialized' }));
            return;
          }
          const closed = apmeRef.collector.closeTaskExternal(sessionId, signalRaw as Parameters<typeof apmeRef.collector.closeTaskExternal>[1], outcome);
          res.writeHead(closed ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ closed, sessionId, signal: signalRaw, outcome: outcome ?? null }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `bad body: ${String(err)}` }));
        }
      });
      return;
    }

    // On-device Apple Intelligence (FoundationModels) text generation via the
    // daemon-managed *persistent* helper. Keeping it warm in the daemon avoids
    // the ~7s per-process cold start callers would otherwise pay each time
    // (e.g. wtcp branch naming). localhost only; lazily spawns the helper.
    if (req.method === 'POST' && pathname === '/generate') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 16384) req.destroy(); });
      req.on('end', () => {
        let prompt = '', instructions: string | undefined;
        try {
          const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
          prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
          instructions = typeof parsed.instructions === 'string' ? parsed.instructions : undefined;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad JSON' }));
          return;
        }
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'prompt required' }));
          return;
        }
        callFoundationModelsHelper(prompt, instructions)
          .then((text) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text }));
          })
          .catch((err) => {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `generate failed: ${String(err)}` }));
          });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Catch HTTP-level client errors (malformed requests, abrupt disconnects during upgrade)
  httpServer.on('clientError', (err, socket) => {
    debug('daemon', `HTTP client error: ${(err as Error).message}`);
    if (!socket.destroyed) socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port was grabbed between our check and bind — find alternative
        reject(new Error(`EADDRINUSE:${port}`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(port, '0.0.0.0', () => resolve());
  }).catch(async (err: Error) => {
    // Handle race condition: port became unavailable after our pre-bind probe.
    // This is the concurrent-start case (e.g. two logon-trigger fires landing
    // within ~1s): both processes pass the singleton guard because neither has
    // bound yet, then exactly one wins the OS bind and the rest get EADDRINUSE.
    if (err.message.startsWith('EADDRINUSE:') && port === requestedPort) {
      // Re-probe the occupant. If ANOTHER daemon grabbed the port, we lost the
      // race — exit instead of falling back to a new port, or we'd leave two
      // daemons running (and clobber daemon.json to point at the wrong one).
      // Only fall back when a *non-daemon* (e.g. a session bridge) holds it.
      const occupant = await probeDaemonHealth(requestedPort);
      // Harden against a forged/stale `mode:'daemon'` response squatting the
      // port: concede (exit) only to a verified live distinct daemon. A claim
      // backed by a dead/own PID is treated as stale → fall through to a fresh
      // port and keep running. See `shouldConcedePortToOccupant`.
      if (shouldConcedePortToOccupant(occupant, process.pid)) {
        const who = typeof occupant?.pid === 'number' ? `PID ${occupant.pid}` : 'a daemon';
        log(`[agentdeck] Lost startup race for port ${requestedPort} (${who} already serving). Exiting.`);
        process.exit(0);
      }
      if (occupant?.mode === 'daemon') {
        log(`[agentdeck] Port ${requestedPort} reports a daemon but PID ${occupant.pid} is not a live distinct process; treating as stale and falling back.`);
      }
      port = await findAvailablePort();
      log(`[agentdeck] Port ${requestedPort} grabbed by ${occupant?.mode ?? 'a non-daemon'}, retrying on ${port}...`);
      await new Promise<void>((resolve, reject) => {
        httpServer.on('error', (e: NodeJS.ErrnoException) => reject(e));
        httpServer.listen(port, '0.0.0.0', () => resolve());
      });
    } else {
      throw err;
    }
  });

  // Write daemon.json for client discovery (must be after successful bind)
  writeDaemonInfo({ port, pid: process.pid, startedAt: new Date().toISOString() });

  // ===== BridgeCore =====
  const core = new BridgeCore({
    port,
    projectName: 'AgentDeck',
    httpServer,
    isDaemon: true,
  });
  const esp32WifiEvents = new Set<string>([
    ...SERIAL_FORWARDED_EVENTS,
    'esp32_ota_begin',
    'esp32_ota_chunk',
    'esp32_ota_end',
    'esp32_ota_abort',
    'device_info_request',
  ]);
  core.wsServer.setEventTransformer((event, client) => {
    if (!core.wsServer.isEsp32Client(client)) return event;
    if (!esp32WifiEvents.has(event.type)) return null;
    // Single-path guard: only the duplicated *display* payloads are deduped.
    // When the same board is live on USB serial, serial drives it and the WiFi
    // copy is redundant — drop it here. OTA control (esp32_ota_*, WiFi-only) and
    // device_info_request keep flowing so the standby WiFi socket stays live and
    // its lastSeen fresh. When serial disconnects, this flips false on the next
    // event and WiFi resumes automatically — no state migration needed.
    if (SERIAL_FORWARDED_EVENTS.has(event.type) && isWifiEsp32RedundantWithSerial(client)) return null;
    return prepareForSerial(event);
  });

  // Timeline
  const bridgeLogStream = new BridgeLogStream();
  core.wireTimeline(bridgeLogStream);
  const timelinePath = latestTimelinePath();
  if (timelinePath) {
    const loaded = core.bridgeTimeline.loadPersistedFile(timelinePath);
    if (loaded > 0) log(`[agentdeck] Loaded ${loaded} persisted timeline entries`);
    // Close task_start rows orphaned by a previous daemon killed mid-task —
    // clients would otherwise spin their in-flight marker forever.
    const reaped = core.bridgeTimeline.reapOrphanTaskStarts();
    if (reaped > 0) log(`[agentdeck] Closed ${reaped} orphaned task_start rows as interrupted`);
  }
  core.wireDisplayMonitor();
  let lastStateEvent: BridgeEvent | null = null;
  let userFocusedSessionId: string | null = null;
  const attachFocusedSessionId = <T extends BridgeEvent>(event: T): T => {
    if ((event as any).type !== 'state_update') return event;
    return {
      ...(event as any),
      focusedSessionId: userFocusedSessionId ?? '',
    } as T;
  };
  const broadcastFocusedState = () => {
    const gwAlive = gatewayAdapter?.isAlive() ?? false;
    const stateEvent = attachFocusedSessionId(core.buildStateEvent({
      agentType: gwAlive ? 'openclaw' : 'daemon' as any,
      agentCapabilities: gwAlive ? OPENCLAW_CAPABILITIES : undefined,
      snapshot: core.stateMachine.getSnapshot(),
    }));
    lastStateEvent = stateEvent;
    core.wsServer.broadcast(stateEvent);
  };

  // System wake recovery — re-publish mDNS, reconnect devices, refresh usage
  core.onSystemWake(() => {
    log('[daemon] System wake detected — recovering devices');
    triggerMdnsRecovery();
    handleESP32Wake();
    handlePixooWake();
    // Reset backoff from pre-sleep failures and fetch fresh usage after network stabilizes
    resetConsecutiveFailures();
    setTimeout(() => {
      fetchUsageRelayed(port).then((usage) => {
        if (usage) core.updateApiUsage(usage);
        else {
          core.oauthConnected = hasOAuthToken();
          if (core.cachedApiUsage) core.apiUsageStale = true;
        }
      });
    }, 4000);
  });

  // Subscribe to sibling session bridges' timelines + modelCatalog relay
  const timelineRelay = new SessionTimelineRelay(port, core.bridgeTimeline);
  timelineRelay.setOnModelCatalog((models) => {
    // Merge modelCatalog from sibling Claude Code sessions (daemon doesn't run PTY).
    // Gateway may also set catalog — merge both, dedup by key.
    const existing = core.cachedModelCatalog ?? [];
    const existingKeys = new Set(existing.map(m => m.key));
    const merged = [...existing];
    for (const m of models) {
      if (!existingKeys.has(m.key)) {
        merged.push(m);
        existingKeys.add(m.key);
      }
    }
    if (merged.length !== existing.length) {
      core.cachedModelCatalog = merged;
      debug('daemon', `Model catalog merged from sibling: ${merged.length} models total`);
      const snap = core.stateMachine.getSnapshot();
      const stateEvent = attachFocusedSessionId(core.buildStateEvent({
        agentType: gatewayAdapter?.isAlive() ? 'openclaw' : 'daemon' as any,
        agentCapabilities: gatewayAdapter?.isAlive() ? OPENCLAW_CAPABILITIES : undefined,
        snapshot: snap,
      }));
      lastStateEvent = stateEvent;
      core.broadcast(stateEvent);
      core.broadcastUsage();
    }
  });
  timelineRelay.start();

  // Session focus relay — allows SD plugin to interact with a specific session via daemon
  const focusRelay = new SessionFocusRelay();
  focusRelay.setEventHandler((evt) => {
    if (evt.type === 'state_update') {
      const focusedId = focusRelay.getFocusedSessionId();
      if (focusedId) userFocusedSessionId = focusedId;
      // Merge daemon metadata into the session's state_update
      const merged: any = {
        ...evt,
        sessionId: focusedId,
        focusedSessionId: userFocusedSessionId ?? '',
        modelCatalog: (evt as any).modelCatalog ?? core.cachedModelCatalog,
        gatewayAvailable: core.cachedGatewayAvailable,
        gatewayConnected: core.cachedGatewayConnected,
        gatewayAuthStatus: core.cachedGatewayAuthStatus,
        ollamaStatus: core.cachedOllamaStatus,
        gatewayHasError: (evt as any).gatewayHasError ?? core.cachedGatewayHasError,
        moduleHealth: moduleHealthProvider(),
      };
      lastStateEvent = merged;
      core.wsServer.broadcast(merged);
    } else if (evt.type === 'usage_update') {
      // Sync daemon cache with relay's already-adjusted values (prevents oscillation)
      const u = evt as any;
      if (core.cachedApiUsage && u.fiveHourPercent != null) {
        core.cachedApiUsage.fiveHourPercent = u.fiveHourPercent;
        core.cachedApiUsage.fiveHourResetsAt = u.fiveHourResetsAt ?? null;
        core.cachedApiUsage.sevenDayPercent = u.sevenDayPercent ?? core.cachedApiUsage.sevenDayPercent;
        core.cachedApiUsage.sevenDayResetsAt = u.sevenDayResetsAt ?? core.cachedApiUsage.sevenDayResetsAt ?? null;
        core.apiUsagePreAdjusted = true;
      }
      core.wsServer.broadcast(evt);
    } else {
      // prompt_options — relay as-is
      core.wsServer.broadcast(evt);
    }
  });

  // mDNS + device modules
  const deviceModules = createDefaultModules('daemon' as any);
  // AGENTDECK_DAEMON_NO_SERIAL=1 leaves the daemon fully functional over WiFi
  // (mDNS, WiFi WS, WiFi OTA) but never opens the USB serial ports. This frees
  // a board's /dev/cu.* for an exclusive external serial capture (e.g. reading a
  // panic backtrace during a WiFi OTA) that otherwise fights the daemon's serial
  // reader for bytes. Diagnostic gate only; normal daemons keep serial on.
  const serialMode = process.env.AGENTDECK_DAEMON_NO_SERIAL === '1' ? false : 'auto';
  // Note: the D200H has no device module — direct-HID control was retired. It is
  // driven exclusively by the Ulanzi Studio plugin (`ulanzi-plugin`) over WebSocket;
  // the daemon never opens it over HID. Its health is reported via the Ulanzi client
  // count in moduleHealthProvider below.
  const startedModules = await initModules(
    deviceModules,
    { mdns: true, broadcast: true, adb: 'auto', serial: serialMode, pixoo: 'auto', timebox: 'auto', idotmatrix: 'auto' },
    { port, authToken: core.authToken, projectName: 'AgentDeck', wsServer: core.wsServer },
  );

  moduleHealthProvider = () => {
    const modules = buildNodeModuleHealth(startedModules);
    const einkDevices = collectEinkDevices();
    if (einkDevices.length > 0) {
      modules.einkDevices = { available: true, devices: einkDevices };
    }
    const ulanziPluginConnected = core.wsServer.getUlanziClientCount() > 0;
    modules.d200h = {
      connected: ulanziPluginConnected,
      externalOwner: ulanziPluginConnected,
      managerOpened: ulanziPluginConnected,
    };
    return modules;
  };
  core.setModuleHealthProvider(moduleHealthProvider);

  // iDotMatrix BLE is now driven by IDotMatrixModule (registered in
  // createDefaultModules): the module owns spawning the Python sync client,
  // zero-config auto-discovery, and teardown — so the daemon doesn't start it
  // directly here anymore (avoids double-spawn).

  // Serial module state provider (heartbeat needs cached state)
  const serialModule = startedModules.find(m => m.name === 'serial') as SerialModule | undefined;
  if (serialModule) {
    serialModule.setStateProvider(() => lastStateEvent);
    serialModule.setUsageProvider(() => core.buildUsage());
    // Send full state (state + usage + sessions) when new ESP32 device connects
    serialModule.setInitialStateProvider(() => {
      const events: BridgeEvent[] = [];
      if (lastStateEvent) events.push(lastStateEvent);
      events.push(core.buildUsage());
      events.push(buildDisplayStateEvent(core.displayMonitor.isDisplayOn()) as BridgeEvent);
      // Seed the last few timeline entries so a freshly (re)connected board's
      // ticker shows the real latest event instead of whatever its ring last
      // held. Kept to 3 entries — the whole line must stay well under the
      // small serial RX buffers on non-InkDeck boards.
      const recent = core.bridgeTimeline.getHistory().slice(-3);
      if (recent.length > 0) {
        events.push({ type: 'timeline_history', entries: recent } as BridgeEvent);
      }
      // Sessions list (async enrichment runs synchronously from cache here)
      core.broadcastSessionsList().catch(() => {});
      return events;
    });
    // Heartbeat re-sync: display_state is otherwise edge-triggered, and a board
    // that misses the wake edge stays dark until power-cycled.
    serialModule.setDisplayStateProvider(
      () => buildDisplayStateEvent(core.displayMonitor.isDisplayOn()) as BridgeEvent,
    );
    // Heartbeat re-sync: sessions_list is edge-triggered too, so a board that
    // reconnects across a daemon handoff during a quiet window would otherwise
    // stay on "no active sessions" until the next session change.
    serialModule.setSessionsListProvider(() => core.getLastSessionsListEvent());
    // Include ESP32 serial connections in client count for polling guards
    core.setExternalClientCountProvider(() => esp32ConnectionCount());
  }

  // WS-path display_state re-sync: the 5s serial heartbeat above only covers
  // USB-attached boards. WiFi boards (InkDeck) receive display_state edge-
  // triggered over the plugin WS — a missed wake edge would leave an e-ink
  // panel showing the sleep card forever. Re-broadcast at a slow cadence so
  // any board that missed the edge self-heals within 15s.
  {
    const displayResync = setInterval(() => {
      if (core.wsServer.getClientCount() > 0) {
        core.wsServer.broadcast(buildDisplayStateEvent(core.displayMonitor.isDisplayOn()) as BridgeEvent);
      }
    }, 15_000);
    displayResync.unref?.();

    // WiFi ESP32 diagnostics: boards only announce device_info on connect unless
    // asked. Poll slowly so /devices can show uptime/reset changes and distinguish
    // a real reboot from a display/WS redraw.
    const wifiDeviceInfoPoll = setInterval(() => {
      if (core.wsServer.getClientCount() > 0) {
        core.wsServer.broadcast({ type: 'device_info_request' } as unknown as BridgeEvent);
      }
    }, 30_000);
    wifiDeviceInfoPoll.unref?.();

    // WiFi auto-provisioning for ESP32 (enables independent WiFi operation)
    const wifiConfig = loadWifiConfig();
    if (wifiConfig?.autoProvision) {
      const lanIp = getLanIp();
      onESP32Message((portPath, msg) => {
        const shouldRefreshIps10Endpoint = msg.type === 'device_info' &&
          msg.board === 'ips_10' &&
          msg.wifiConnected &&
          !msg.wifiRadioParked;
        if (msg.type === 'device_info' && (!msg.wifiConnected || shouldRefreshIps10Endpoint)) {
          const sent = sendWifiProvisionToAll({
            type: 'wifi_provision' as const,
            ssid: wifiConfig.ssid,
            password: wifiConfig.password,
            bridgeIp: lanIp,
            bridgePort: port,
            authToken: core.authToken,
          });
          if (sent > 0) log(`[agentdeck] WiFi provision sent to ${sent} ESP32 device(s) after ${portPath}`);
        } else if (msg.type === 'wifi_provision_ack') {
          log(msg.success ? `[agentdeck] ESP32 WiFi connected: ${msg.ip} ✓` : `[agentdeck] ESP32 WiFi failed: ${msg.error || 'unknown'}`);
        }
      });
    }
  }

  log(`[agentdeck] WebSocket server ready on port ${port}`);
  log(`[agentdeck] Pairing URL: ${core.wsUrl}`);

  // Initialize APME store + collector so the daemon can serve /apme/* HTTP
  // routes. `setApme` on core is gated against the `daemon` meta-session so
  // register/deregister won't open a bogus run. Session bridges opening their
  // own connection to the same sqlite file is safe under WAL mode.
  // emitTimeline: forward task hierarchy entries (task_start / task_end) into
  // the daemon's bridgeTimeline so downstream dashboards see task headers.
  const daemonProjectTimeline = isTimelineProjectionEnabled();
  apme = await initApme(undefined, {
    emitTimeline: (entry) => core.bridgeTimeline.addEntry(entry),
    projectSampleTimeline: daemonProjectTimeline,
    emitProjectedTimeline: (entry) => core.bridgeTimeline.addEntry(entry, { bypassSuppression: true }),
  });
  if (apme) {
    core.setApme(apme);
    if (daemonProjectTimeline) {
      core.bridgeTimeline.setSuppressLocalChatTool(true);
      log('[agentdeck] APME timeline projection ENABLED — chat/tool rows derive from SessionSample');
    }
    log(`[agentdeck] APME enabled — store=${apme.store.dbPath} routes=/apme/*`);
    // Fire-and-forget judge backend probe. Result is cached on
    // apme.runner.lastBackendProbe and surfaced on /health so users discover
    // misconfiguration (no MLX server running, missing API key, etc.) without
    // having to wait for the first eval to fail.
    void apme.runner.refreshBackendProbe(loadApmeConfig().judge).then(status => {
      if (status.status === 'ready') {
        log(`[agentdeck] APME judge ready: ${status.backend}${status.model ? ` (${status.model})` : ''}${status.latencyMs !== undefined ? ` ${status.latencyMs}ms` : ''}`);
      } else {
        log(`[agentdeck] APME judge ${status.backend} ${status.status} — ${status.reason ?? 'no reason'}. Deterministic layer (lint/build/test) keeps running.`);
      }
    });
  } else {
    // initApme() already logged the specific reason via logError. This second
    // line tells the user where to look + what's lost so the gap doesn't pass
    // for "everything's fine, just no /apme/ routes".
    log('[agentdeck] APME unavailable — no run/turn/task evals will be recorded for sessions on this daemon.');
    // Keep the timeline's task hierarchy alive without APME: emit fallback
    // task_start/task_end rows from the hook boundary signals so the device
    // timeline doesn't degrade to a flat chat/tool stream.
    fallbackTasks = new FallbackTaskTimeline(
      (entry) => core.bridgeTimeline.addEntry(entry),
      { agentType: 'claude-code' },
    );
  }

  // Register session
  core.registerSession('daemon' as any);
  const passiveSessionObserver = new PassiveSessionObserver();
  // The observer scans in the background now (collect() returns the cache
  // immediately). When a scan lands fresh observations, push them out via
  // the debounced broadcast so clients don't wait for the next 10 s poll.
  passiveSessionObserver.onRefreshed = () => core.maybeBroadcastSessionsList();

  // ===== Gateway adapter lifecycle =====
  // (gatewayAdapter + gatewayConnecting declared earlier, before HTTP server)

  // Inject OpenClaw virtual session only after Gateway authentication succeeds.
  // Reachability alone is a topology signal, not proof that commands can route.
  core.setSessionsEnricher((sessions) => {
    // Overlay hook-driven awaiting state onto observed (direct-`claude`)
    // sessions — display-only (no requestId, respond-in-terminal UX). Done here
    // in the synchronous enricher (runs on every broadcast) rather than inside
    // the 5s-throttled observer, so a Notification arriving mid-window still
    // surfaces within one frame. Key = the Claude session UUID embedded in
    // `observed:claude:<uuid>`.
    const observed = applyAwaitingOverlayToObserved(passiveSessionObserver.collect(sessions));
    // Derive per-session elapsed seconds from startedAt so NTP-less devices
    // (ESP32 IPS10 mosaic) render an elapsed value per cell without a wall clock.
    const now = Date.now();
    const enrichedSessions = [...sessions, ...observed].map((s) => {
      if (s.elapsedSec != null || !s.startedAt) return s;
      const sec = Math.round((now - Date.parse(s.startedAt)) / 1000);
      return Number.isFinite(sec) && sec >= 0 ? { ...s, elapsedSec: sec } : s;
    });
    // SSOT: inject iff Gateway is authenticated (gatewayConnected). Reachability
    // / adapter-liveness alone must not materialize a session — that kept a
    // phantom OpenClaw alive on devices after it was effectively off. Shared
    // injector with bridge/src/index.ts; mirror of Swift buildSessionsListEvent.
    const snap = core.stateMachine.getSnapshot();
    return injectOpenClawSession(enrichedSessions, {
      gatewayConnected: core.cachedGatewayConnected,
      state: snap.state,
      projectName: snap.projectName ?? 'OpenClaw',
      modelName: snap.modelName ?? undefined,
      controlMode: 'managed',
    });
  });

  // OpenClaw-specific APME session id. Distinct from `core.sessionId`
  // (the daemon meta-session, which doesn't open a run) and rotates on
  // every connect/disconnect cycle so each Gateway lifetime gets its own
  // APME run with its own task hierarchy. Captured here so both the
  // `connectGatewayAdapter` open + `disconnectGatewayAdapter` close paths
  // can reference the same id.
  let openclawApmeSessionId: string | null = null;

  function connectGatewayAdapter(): void {
    if (gatewayAdapter || gatewayConnecting) return;
    gatewayConnecting = true;
    log('[agentdeck] OpenClaw Gateway detected, connecting...');

    const adapter = new OpenClawAdapter({ autoReconnect: false });
    // Bind APME — without this OpenClaw never reaches the collector and
    // every chat session collapses to a single session_end task. The
    // adapter's idle-gap timer + chat.send/final ingestion needs an active
    // run to attach turns and task boundaries to.
    if (apme) {
      openclawApmeSessionId = `openclaw-${randomUUID()}`;
      try {
        apme.collector.openRun({
          sessionId: openclawApmeSessionId,
          agentType: 'openclaw',
          projectName: 'openclaw',
        });
        adapter.setApmeSession(openclawApmeSessionId, process.cwd());
      } catch (err) {
        debug('APME', `openRun for OpenClaw failed: ${String(err)}`);
        openclawApmeSessionId = null;
      }
    }

    adapter.on('event', (evt: AdapterEvent) => {
      switch (evt.source) {
        case 'hook':
          if (evt.event === 'SessionStart') core.stateMachine.handleHookEvent('SessionStart', {});
          else if (evt.event === 'SessionEnd') core.stateMachine.handleHookEvent('SessionEnd', {});
          break;
        case 'parser':
          core.stateMachine.handleParserEvent(evt.event, evt.data);
          // The OpenClaw adapter emits the real model via a model_info parser
          // event, but it only ever updated the display StateMachine — the APME
          // run was never told, so every openclaw run persisted model_id=NULL.
          if (evt.event === 'model_info' && apme && openclawApmeSessionId) {
            const model = evt.data?.model as string | undefined;
            if (model) apme.collector.updateModel(openclawApmeSessionId, model);
          }
          break;
        case 'metadata':
          if (evt.event === 'model_catalog') {
            const models = evt.data?.models as ModelCatalogEntry[] | undefined;
            if (models) {
              core.cachedModelCatalog = models;
              const snap = core.stateMachine.getSnapshot();
              const stateEvent = attachFocusedSessionId(core.buildStateEvent({
                agentType: 'openclaw',
                agentCapabilities: OPENCLAW_CAPABILITIES,
                snapshot: snap,
              }));
              lastStateEvent = stateEvent;
              core.broadcast(stateEvent);
              core.broadcastUsage();
            }
          } else if (evt.event === 'gateway_health') {
            // Use real-time health event from Gateway WS instead of polling `openclaw doctor`
            const hasError = !(evt.data?.ok as boolean);
            const changed = hasError !== core.cachedGatewayHasError;
            core.cachedGatewayHasError = hasError;
            if (changed) {
              core.stateMachine.emit('state_changed', core.stateMachine.getSnapshot());
            }
          }
          break;
        case 'activity':
          core.stateMachine.onPtyActivity();
          break;
        case 'timeline':
          if (evt.entry) {
            // This handler is wired exclusively to the OpenClaw Gateway adapter
            // (see agentType:'openclaw' at the model_catalog case above), but the
            // adapter emits bare timeline entries without agentType/projectName.
            // Stamp the OpenClaw origin so the attributor doesn't default them to
            // 'AgentDeck'/null. See enrichGatewayTimelineEntry.
            const enriched = enrichGatewayTimelineEntry(evt.entry);
            if (evt.upsert) core.bridgeTimeline.upsertEntry(enriched);
            else core.bridgeTimeline.addEntry(enriched);
            if (enriched.type === 'tool_request') bridgeLogStream.trackToolRequest(enriched.raw);
          }
          break;
        case 'connection': {
          // Do NOT forward gateway adapter connection events as bridge connection
          // events — WS clients would interpret them as their own bridge disconnect
          // and show "disconnected" UI. Gateway status is conveyed via state_update
          // (agentType/gatewayAvailable) and sessions_list.
          if (evt.status === 'connected') {
            core.cachedGatewayAvailable = true;
            core.cachedGatewayConnected = true;
            core.cachedGatewayAuthStatus = 'connected';
            bridgeLogStream.start();
            log('[agentdeck] OpenClaw Gateway connected');
            if (core.stateMachine.getSnapshot().state === 'disconnected') {
              core.stateMachine.handleHookEvent('SessionStart', {});
            }
            // Force full state broadcast
            const snap = core.stateMachine.getSnapshot();
            const gwStateEvent = attachFocusedSessionId(core.buildStateEvent({
              agentType: 'openclaw',
              agentCapabilities: OPENCLAW_CAPABILITIES,
              snapshot: snap,
            }));
            lastStateEvent = gwStateEvent;
            core.wsServer.broadcast(gwStateEvent);
            core.broadcastUsage();
            core.broadcastSessionsList().catch(() => {});
          } else {
            core.cachedGatewayConnected = false;
            core.cachedGatewayAuthStatus = 'gateway_not_found';
            bridgeLogStream.stop();
            log('[agentdeck] OpenClaw Gateway disconnected');
            core.stateMachine.emit('state_changed', core.stateMachine.getSnapshot());
            core.broadcastSessionsList().catch(() => {});
          }
          break;
        }
      }
    });

    adapter.on('exit', () => disconnectGatewayAdapter());

    adapter.start({ port, externalServer: httpServer } as any).then(() => {
      gatewayAdapter = adapter;
      gatewayConnecting = false;
    }).catch((err) => {
      log(`[agentdeck] Failed to connect to Gateway: ${err}`);
      gatewayConnecting = false;
      core.cachedGatewayConnected = false;
      core.cachedGatewayAuthStatus = 'gateway_not_found';
      core.stateMachine.emit('state_changed', core.stateMachine.getSnapshot());
    });
  }

  function disconnectGatewayAdapter(): void {
    if (!gatewayAdapter) return;
    log('[agentdeck] OpenClaw Gateway lost, cleaning up...');
    const wasAlive = gatewayAdapter.isAlive();
    gatewayAdapter.shutdown().catch(() => {});
    gatewayAdapter = null;
    // APME: close the OpenClaw run so the collector fires its
    // session_end boundary and the run becomes eligible for the layer-2
    // judge queue.
    if (apme && openclawApmeSessionId) {
      try { apme.collector.closeRun(openclawApmeSessionId); }
      catch (err) { debug('APME', `closeRun for OpenClaw failed: ${String(err)}`); }
      openclawApmeSessionId = null;
    }
    core.cachedGatewayConnected = false;
    core.cachedGatewayAuthStatus = 'gateway_not_found';
    core.cachedModelCatalog = null;
    if (wasAlive) core.stateMachine.handleHookEvent('SessionEnd', {});
    else core.stateMachine.emit('state_changed', core.stateMachine.getSnapshot());
    // Do NOT broadcast connection:disconnected — that would make WS clients
    // think they lost their bridge connection. State change to 'daemon' agentType
    // and updated sessions_list convey the gateway loss.
    core.broadcastSessionsList().catch(() => {});
  }

  // ===== Voice assistant (wake word) =====
  let voiceAssistant: VoiceAssistantManager | null = null;
  let voiceManager: VoiceManager | null = null;
  let previousDaemonState = State.IDLE;

  if (wakeWordEnabled) {
    voiceManager = new VoiceManager();
    voiceManager.connectToServer().catch((err) => {
      debug('daemon', `whisper-server connection failed: ${err}`);
    });

    voiceAssistant = new VoiceAssistantManager({
      sendPrompt: (text) => {
        if (gatewayAdapter?.isAlive() && gatewayAdapter.handleCommand({ type: 'send_prompt', text })) {
          core.stateMachine.handleUserAction('send_prompt');
        } else {
          debug('daemon', 'Wake word prompt but no active adapter');
        }
      },
      transcribeFile: (filePath) => voiceManager!.transcribeFile(filePath),
    });

    voiceAssistant.on('state_change', (info: { state: string; text?: string; responseText?: string }) => {
      // Broadcast dedicated event (for plugin FORWARDED_EVENTS)
      core.broadcast({
        type: 'voice_assistant_state',
        state: info.state,
        deviceId: 'mac-builtin',
        text: info.text,
        responseText: info.responseText,
      } as BridgeEvent);
      // Piggyback on state_update so all clients (Android/Apple/TUI) get it automatically
      core.updateVoiceAssistantState(
        info.state as import('@agentdeck/shared').VoiceAssistantState,
        info.text,
        info.responseText,
      );
    });

    voiceAssistant.on('wake_word_detected', (info: { deviceId: string; timestamp: number }) => {
      core.broadcast({
        type: 'wake_word_detected',
        deviceId: info.deviceId,
        timestamp: info.timestamp,
      } as BridgeEvent);
    });

    voiceAssistant.start().then((ok) => {
      if (ok) log('[agentdeck] Wake word voice assistant active ("오픈클로")');
      else log('[agentdeck] Wake word not available (missing model or access key)');
    }).catch((err) => {
      log(`[agentdeck] Wake word start failed: ${err}`);
    });
  }

  // ===== State changed → broadcast =====
  core.stateMachine.on('state_changed', (snapshot) => {
    const gwAlive = gatewayAdapter?.isAlive() ?? false;
    const stateEvent = attachFocusedSessionId(core.buildStateEvent({
      agentType: gwAlive ? 'openclaw' : 'daemon' as any,
      agentCapabilities: gwAlive ? OPENCLAW_CAPABILITIES : undefined,
      snapshot,
    }));
    lastStateEvent = stateEvent;
    core.wsServer.broadcast(stateEvent);
    core.maybeBroadcastSessionsList();
    core.broadcastUsage();

    // Voice assistant: reset timeout on any activity during processing
    if (snapshot.state === State.PROCESSING && voiceAssistant?.getState() === 'processing') {
      voiceAssistant.resetResponseTimeout();
    }

    // Voice assistant: PROCESSING→IDLE triggers TTS response
    const wasActive = previousDaemonState === State.PROCESSING;
    previousDaemonState = snapshot.state;
    if (wasActive && snapshot.state === State.IDLE && voiceAssistant?.getState() === 'processing') {
      const lastEntry = core.bridgeTimeline.getLastEntry('chat_end');
      const responseText = lastEntry?.detail ?? lastEntry?.raw ?? '';
      voiceAssistant.handleResponse(responseText || '완료했습니다.').catch((err) => {
        debug('daemon', `Voice assistant TTS error: ${err}`);
      });
    }
  });

  // ===== Commands from WS clients =====
  // ===== Internal WS: session push channel =====
  core.wsServer.onRawMessage((msg, sender) => {
    // WiFi ESP32 boards announce device_info over WS on connect. Capture the
    // sender here so OTA can address the exact socket instead of broadcasting.
    if (msg.type === 'device_info') {
      core.wsServer.markEsp32Client(sender);
      registerWifiEsp32(msg, sender);
      return true;
    }
    touchWifiEsp32Socket(sender);
    if (msg.type === 'client_register'
        && (msg as { clientType?: unknown }).clientType === 'eink-device') {
      // XTeink X3/X4 (fork) volunteering its E-ink roster. Store per-socket so
      // the Downstream E-ink rail can render it; drops on socket close.
      const devices = Array.isArray((msg as { devices?: unknown }).devices)
        ? (msg as { devices: unknown[] }).devices : [];
      einkRegistrations.set(sender, { devices, updatedAt: Date.now() });
      debug('daemon', `client_register eink-device devices=${devices.length}`);
      // Push a fresh state so the rail appears within one frame instead of on
      // the next periodic tick.
      if (lastStateEvent && (lastStateEvent as { type?: string }).type === 'state_update') {
        (lastStateEvent as unknown as Record<string, unknown>).moduleHealth = moduleHealthProvider();
        core.wsServer.broadcast(lastStateEvent);
      }
      return true;
    }
    if (handleEsp32OtaReply(msg)) {
      return true;
    }
    if (msg.type === 'session_push_register') {
      const { sessionId, port: sessionPort, agentType: at, projectName: pn } = msg as any;
      debug('daemon', `session_push_register: ${sessionId} port=${sessionPort} agent=${at}`);
      // Acknowledge registration
      try { sender.send(JSON.stringify({ type: 'session_push_ack', sessionId })); } catch { /* client disconnecting */ }
      return true; // consumed
    }
    if (msg.type === 'session_push_state') {
      const { sessionId, state, modelName, effortLevel } = msg as any;
      if (sessionId && state) {
        updatePushState(sessionId, state, modelName, effortLevel);
        // Trigger sessions list broadcast so clients get fresh state
        core.maybeBroadcastSessionsList();
      }
      return true; // consumed
    }
    if (msg.type === 'deck_slot_map') {
      // Plugin pushed its keypad layout. Forward to other viewers (extra
      // plugin instance, dashboard) and re-broadcast sessions_list so slot
      // buttons populate immediately — without this they would stay "Empty"
      // until the next 10 s sessions polling tick after the plugin connect.
      core.wsServer.broadcastExcept(msg as unknown as BridgeEvent, sender);
      core.broadcastSessionsList().catch(() => {});
      return true; // consumed
    }
    if (msg.type === 'query_session_timeline') {
      // Reply to THIS requester only with the session's recent timeline so a
      // device that connected mid-session can fill its Detail view on demand
      // (the live timeline_event stream is forward-only). Useful for any
      // reconnecting surface, not just the XTeink X3.
      const sessionId = (msg as { sessionId?: unknown }).sessionId;
      const since = (msg as { since?: unknown }).since;
      if (typeof sessionId === 'string' && sessionId) {
        const sinceMs = typeof since === 'number' ? since : undefined;
        let entries = core.bridgeTimeline.getHistoryForSession(sessionId, sinceMs);
        // Passively-observed sessions never push timeline rows (the relay only
        // covers managed + hook sessions), so the store comes back empty for
        // them. Reconstruct a recent-activity timeline from their transcript so
        // the device's Detail view isn't stuck on "No recent activity yet".
        if (entries.length === 0) {
          try {
            entries = transcriptTimelineForSession(sessionId, { since: sinceMs });
          } catch { /* read-only best effort */ }
        }
        const historyEvent = buildCappedTimelineHistory(entries, undefined, { sessionId });
        if (historyEvent) {
          try {
            sender.send(JSON.stringify(historyEvent));
          } catch { /* client disconnecting */ }
        }
      }
      return true; // consumed
    }
    return false; // not consumed — pass to command handler
  });

  core.wsServer.onCommand((cmd) => {
    debug('daemon', `cmd: ${cmd.type}`);
    if (gatewayAdapter?.isAlive() && gatewayAdapter.handleCommand(cmd)) {
      switch (cmd.type) {
        case 'respond': core.stateMachine.handleUserAction('respond'); break;
        case 'interrupt': core.stateMachine.handleUserAction('interrupt'); break;
        case 'escape': core.stateMachine.handleUserAction('interrupt'); break;
        case 'select_option': core.stateMachine.handleUserAction('select_option'); break;
        case 'send_prompt': core.stateMachine.handleUserAction('send_prompt'); break;
      }
      return;
    }
    if (cmd.type === 'switch_agent') {
      userFocusedSessionId = null;
      focusRelay.unfocus(); // Clear session focus on agent switch
      const target = (cmd as any).agent as string;
      if (target === 'openclaw' && gatewayAdapter?.isAlive()) {
        // Force broadcast OpenClaw state to all clients
        const snap = core.stateMachine.getSnapshot();
        const gwStateEvent = attachFocusedSessionId(core.buildStateEvent({
          agentType: 'openclaw',
          agentCapabilities: OPENCLAW_CAPABILITIES,
          snapshot: snap,
        }));
        lastStateEvent = gwStateEvent;
        core.wsServer.broadcast(gwStateEvent);
      } else if (target === 'claude-code') {
        // Broadcast daemon/claude-code state — clients reconnect to session bridges independently
        const snap = core.stateMachine.getSnapshot();
        const stateEvent = attachFocusedSessionId(core.buildStateEvent({
          agentType: 'daemon' as any,
          snapshot: snap,
        }));
        lastStateEvent = stateEvent;
        core.wsServer.broadcast(stateEvent);
      }
      return;
    }
    if (cmd.type === 'focus_session') {
      const sessionId = (cmd as any).sessionId as string;
      if (!sessionId) return;
      userFocusedSessionId = sessionId;
      broadcastFocusedState();
      if (sessionId === 'openclaw-gateway' && gatewayAdapter?.isAlive()) {
        focusRelay.unfocus();
        return;
      }
      focusRelay.focus(sessionId);
      return;
    }
    if (cmd.type === 'clear_session_focus') {
      userFocusedSessionId = null;
      focusRelay.unfocus();
      broadcastFocusedState();
      return;
    }
    // Device approval for a gated PreToolUse permission request (observed session).
    // Resolves the held hook HTTP response → Claude allows/denies the tool.
    if (cmd.type === 'permission_decision') {
      const { requestId, decision } = cmd as any;
      if (typeof requestId !== 'string' || (decision !== 'allow' && decision !== 'deny')) return;
      // resolvePending → onResolved clears the overlay + rebroadcasts (sessions_list
      // + focused state), so all surfaces drop the gate. No-op if already resolved.
      resolvePending(requestId, decision);
      return;
    }
    // Session-scoped command: forward inner command to a specific session's bridge
    if (cmd.type === 'session_command') {
      const { sessionId, command } = cmd as any;
      if (!sessionId || !command) return;
      const sessions = listActiveSessions();
      const target = sessions.find(s => s.id === sessionId);
      if (!target) {
        debug('daemon', `session_command: session ${sessionId} not found`);
        return;
      }
      // Focus the session first, then route the command
      userFocusedSessionId = sessionId;
      broadcastFocusedState();
      focusRelay.focus(sessionId);
      // Small delay to let focus take effect, then route
      setTimeout(() => focusRelay.routeCommand(command), 100);
      return;
    }
    // Session-scoped option select from a multi-up panel (IPS10 D1 mosaic):
    // any awaiting cell can be answered, not just the focused one. Focus the
    // named session, then route a plain select_option to its bridge.
    if (cmd.type === 'select_option' && typeof (cmd as any).sessionId === 'string') {
      const sessionId = (cmd as any).sessionId as string;
      const target = listActiveSessions().find(s => s.id === sessionId);
      if (target) {
        userFocusedSessionId = sessionId;
        broadcastFocusedState();
        focusRelay.focus(sessionId);
        setTimeout(() => focusRelay.routeCommand({ type: 'select_option', index: (cmd as any).index }), 100);
        return;
      }
    }
    // Route interactive commands to focused session (if any)
    if (focusRelay.getFocusedSessionId() && focusRelay.routeCommand(cmd)) {
      return;
    }
    if (cmd.type === 'query_usage') {
      fetchUsageRelayed(port).then((usage) => {
        if (usage) core.updateApiUsage(usage);
        else if (core.cachedApiUsage) core.apiUsageStale = true;
      });
    }
  });

  // ===== Client connect =====
  core.wsServer.onClientConnect((ws) => {
    const gwAlive = gatewayAdapter?.isAlive() ?? false;
    core.sendInitialState(ws, {
      agentType: gwAlive ? 'openclaw' : 'daemon' as any,
      agentCapabilities: gwAlive ? OPENCLAW_CAPABILITIES : undefined,
      isAlive: true,  // WS client IS connected to daemon — gateway status conveyed via state_update
    });

    // Fetch usage on connect if stale
    const cacheAge = Date.now() - core.lastApiFetchTime;
    if (!core.cachedApiUsage || (core.lastApiFetchTime > 0 && cacheAge > 5 * 60 * 1000)) {
      fetchUsageRelayed(port).then((usage) => {
        if (usage) core.updateApiUsage(usage);
        else {
          core.oauthConnected = hasOAuthToken();
          if (core.cachedApiUsage) core.apiUsageStale = true;
        }
      });
    }
  });

  core.wsServer.onClientDisconnect((ws) => {
    unregisterWifiEsp32Socket(ws);
  });

  // ===== Probes & polling =====
  core.startOllamaProbe();
  core.startMlxProbe();
  core.startAntigravityProbe();
  core.startGatewayProbe(5000,
    () => connectGatewayAdapter(),
    () => { if (gatewayAdapter && !gatewayAdapter.isAlive()) disconnectGatewayAdapter(); },
  );
  core.startGatewayHealthCheck();
  core.startUsageTick();
  core.startApiUsagePolling(60_000, () => fetchUsageRelayed(port));
  core.startSessionsListPolling();

  // APME: periodically pick up runs that session bridges closed but couldn't
  // eval (session exits within 2s of shutdown). Daemon is long-lived, so it
  // can run the full deterministic + judge pipeline without time pressure.
  if (apme) {
    const { evaluateOutcome } = await import('./apme/outcome.js');
    const { classifyRunSmart } = await import('./apme/classifier.js');
    const { aggregateOverall } = await import('./apme/http.js');

    // Broadcast eval results to all WS clients + timeline when runner completes
    apme.runner.onResult(({ runId, turnId, taskId, layer1Ran, layer2Ran, overall }) => {
      // Task-level eval: a group of turns between boundary signals
      // (TodoWrite all-completed / /clear / session_end). Distinct timeline
      // entry so users see "★ task 85%" rather than another run-level pulse.
      // The task's summary axis is the most user-readable signal and goes
      // into `detail` ahead of the per-axis breakdown.
      if (taskId) {
        const run = apme!.store.getRun(runId);
        const task = apme!.store.getTask(taskId);
        if (!run || !task) return;
        const taskEvals = apme!.store.listEvalsForTask(taskId);
        const overallEval = taskEvals.find(e => e.metric === 'overall');
        if (!overallEval) return;

        const taskEvalEvent: import('@agentdeck/shared').ApmeEvalEvent = {
          type: 'apme_eval',
          run: {
            runId: run.id, sessionId: run.sessionId, agentType: run.agentType, startedAt: run.startedAt,
            modelId: run.modelId ?? undefined, projectName: run.projectName ?? undefined,
            taskPrompt: run.taskPrompt ?? undefined, taskCategory: run.taskCategory ?? undefined,
            outcome: 'committed',
            compositeScore: overallEval.score,
            overallScore: overallEval.score,
            evals: taskEvals.map(e => ({
              layer: e.layer, metric: e.metric, score: e.score,
              judgeModel: e.judgeModel ?? undefined, createdAt: e.createdAt,
            })),
          },
        };
        core.broadcast(taskEvalEvent);
        return;
      }
      // Turn-level eval: broadcast and add timeline entry with turn score
      if (turnId) {
        const run = apme!.store.getRun(runId);
        if (!run) return;
        const turnEvals = apme!.store.listEvalsForTurn(turnId);
        const overall = turnEvals.find(e => e.metric === 'overall');
        if (!overall) return;
        // Persist turn-level outcome + composite so downstream analytics
        // (category scorecard, recommender) can aggregate per-turn scores.
        try {
          apme!.store.updateTurn(turnId, {
            outcome: 'committed',
            compositeScore: overall.score,
          });
        } catch { /* ignore */ }
        // WS broadcast — reuse apme_eval event for turn eval so dashboards pick it up
        const turnEvalEvent: import('@agentdeck/shared').ApmeEvalEvent = {
          type: 'apme_eval',
          run: {
            runId: run.id, sessionId: run.sessionId, agentType: run.agentType, startedAt: run.startedAt,
            modelId: run.modelId ?? undefined, projectName: run.projectName ?? undefined,
            taskPrompt: run.taskPrompt ?? undefined, taskCategory: run.taskCategory ?? undefined,
            outcome: 'committed',
            compositeScore: overall.score,
            overallScore: overall.score,
            evals: turnEvals.map(e => ({
              layer: e.layer, metric: e.metric, score: e.score,
              judgeModel: e.judgeModel ?? undefined, createdAt: e.createdAt,
            })),
          },
        };
        core.broadcast(turnEvalEvent);
        return;
      }
      const run = apme!.store.getRun(runId);
      if (!run) return;
      const evals = apme!.store.listEvalsForRun(runId);
      const overallScore = aggregateOverall(evals);
      if (!layer1Ran && !layer2Ran && overall === undefined && evals.length === 0) {
        debug('APME', `skip run eval timeline for ${runId.slice(0, 8)} — no eval rows produced`);
        return;
      }
      // WS broadcast: apme_eval event (type already in protocol.ts)
      const evalEvent: import('@agentdeck/shared').ApmeEvalEvent = {
        type: 'apme_eval',
        run: {
          runId: run.id, sessionId: run.sessionId, agentType: run.agentType, startedAt: run.startedAt,
          modelId: run.modelId ?? undefined, projectName: run.projectName ?? undefined,
          taskPrompt: run.taskPrompt ?? undefined, taskCategory: run.taskCategory ?? undefined,
          outcome: (run.outcome as import('@agentdeck/shared').ApmeRunSummary['outcome']) ?? undefined,
          compositeScore: run.compositeScore ?? undefined,
          overallScore: overallScore ?? undefined,
          evals: evals.map(e => ({
            layer: e.layer, metric: e.metric, score: e.score,
            judgeModel: e.judgeModel ?? undefined, createdAt: e.createdAt,
          })),
        },
      };
      core.broadcast(evalEvent);
    });

    const apmeEvalTimer = setInterval(() => {
      // 1. Enqueue unevaluated runs for deterministic + judge
      const pending = apme!.store.listUnevaluatedRuns(5);
      for (const run of pending) {
        apme!.runner.enqueue({ runId: run.id, projectPath: run.projectPath ?? undefined });
      }
      // 2. Run outcome detection + composite scoring on recently closed runs
      // that don't have an outcome yet.
      const closedRuns = apme!.store.listRuns({ limit: 20 });
      for (const run of closedRuns) {
        if (run.endedAt && !run.outcome) {
          // Wait at least 10s after close before judging outcome
          const elapsed = Date.now() - run.endedAt;
          if (elapsed > 10_000) {
            evaluateOutcome(apme!.store, run.id);
          }
        }
      }
      // 3. Classify unclassified runs (fire-and-forget from session bridge may
      //    have been killed by process exit — daemon retries here).
      const unclassified = apme!.store.listUnclassifiedRuns(5);
      for (const run of unclassified) {
        void classifyRunSmart(apme!.store, run.id).then(({ signals, category, source }) => {
          apme!.store.updateRun(run.id, {
            taskSignals: JSON.stringify(signals),
            taskCategory: category,
            taskCategorySource: source,
          });
        }).catch(() => {});
      }
      // 3b. Backfill turn outcome/composite for turns with captured response.
      //     Turn-level judge (turn_judge) only fires for non-code categories,
      //     so code-category turns never get outcome/composite otherwise.
      //     Heuristic: response captured = 'committed', composite from overall
      //     turn_judge score if present, otherwise null (not inflated).
      const needOutcome = apme!.store.listTurnsNeedingOutcome(20);
      for (const t of needOutcome) {
        const evs = apme!.store.listEvalsForTurn(t.id);
        const overall = evs.find(e => e.layer === 'turn_judge' && e.metric === 'overall');
        try {
          apme!.store.updateTurn(t.id, {
            outcome: 'committed',
            ...(overall ? { compositeScore: overall.score } : {}),
          });
        } catch { /* ignore */ }
      }
      // 4. Clean up orphaned runs — session bridges that crashed without graceful
      //    shutdown leave runs with no ended_at, no turns, no prompt. Tag as _empty
      //    so the dashboard filters them out.
      const orphans = apme!.store.listOrphanedRuns(1800); // 30 min stale threshold
      for (const id of orphans) {
        apme!.store.updateRun(id, { endedAt: Date.now(), taskCategory: '_empty' });
      }
    }, 30_000); // every 30s
    core.addInterval(apmeEvalTimer);
  }

  // Initial usage fetch (delayed 10s)
  core.addTimeout(setTimeout(() => {
    fetchUsageRelayed(port).then((usage) => {
      if (usage) core.updateApiUsage(usage);
      else {
        core.oauthConnected = hasOAuthToken();
        if (core.cachedApiUsage) core.apiUsageStale = true;
      }
    });
  }, 10_000));

  // Backstop sweep for held PreToolUse approval responses whose per-entry timer
  // somehow didn't fire — resolves anything older than 60s to "ask" so a held
  // socket can't leak and Claude's own prompt isn't lost forever.
  const permissionSweepTimer = setInterval(() => { sweepStalePending(60_000); }, 30_000);
  permissionSweepTimer.unref?.();

  // ===== Shutdown =====
  core.onShutdown(async () => {
    clearInterval(permissionSweepTimer);
    drainAllPending();
    removeDaemonInfo();
    focusRelay.stop();
    timelineRelay.stop();
    voiceAssistant?.stop();
    voiceManager?.disconnectFromServer();
    bridgeLogStream.stop();
    // iDotMatrix BLE sync is stopped by IDotMatrixModule.stop() via stopModules below.
    await Promise.all([
      gatewayAdapter ? gatewayAdapter.shutdown().catch(() => {}) : Promise.resolve(),
      stopModules(startedModules)
    ]);
    gatewayAdapter = null;
    httpServer.close(() => exitProcessNow(0));
    // Force exit if httpServer.close() hangs on CLOSE_WAIT connections
    setTimeout(() => exitProcessNow(0), 5000).unref();
  });

  core.registerProcessHandlers('agentdeck');

  // Trigger initial state broadcast so display hardware modules (D200H, Pixoo, Serial) get populated
  broadcastFocusedState();
  core.broadcastUsage();

  log(`[agentdeck] Daemon running. Gateway probe active.`);
}
