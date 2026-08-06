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
import { SubagentTimelineTracker } from './subagent-timeline.js';
import {
  getRemoteSession,
  getRemoteSender,
  listRemoteEnriched,
} from './remote-sessions.js';
import { createPushChannelHandler } from './session-push-channel.js';
import {
  setAwaitingOverlay,
  setPermissionNotificationOverlay,
  setAskUserQuestionOverlay,
  clearAwaitingOverlay,
  clearAskUserQuestionOverlay,
  getAwaitingOverlay,
  isPermissionNotification,
  applyAwaitingOverlayToObserved,
} from './awaiting-overlay.js';
import { registerPending, resolvePending, sweepStalePending, drainAllPending, isPendingRequest } from './permission-resolver.js';
import {
  shouldHoldPreToolUse, gateReleased, buildGateQuestion,
  consumeStop, requestStop, clearStop, STOP_DENY_REASON,
  queueDirective, takeDirective, clearOnUserPrompt, clearSession as clearSteeringSession,
} from './observed-steering.js';
import {
  notePermissionPromptShown, noteToolEnd, steeringSnapshot,
} from './observed-steering.js';
import { resolveSessionIdPrefix } from './session-id-resolve.js';
import { injectObservedSelection, injectObservedText } from './observed-inject.js';
import {
  setSerialCommandSink, setSerialVoiceSink, setSerialQuiesceCheck, sendSerialJson,
  serialPortConnected, serialPortCapabilities, serialPortBoard,
  liveSerialPortForBoard, serialBoardsAttached,
} from './esp32-serial.js';
import { parsePeripheralMappings, resolvePeripheralAction, commandForAction } from './peripheral-mapping.js';
import { DeviceVoiceCollector } from './device-voice.js';
import { DevicePhotoCollector } from './device-photo.js';
import {
  transcribeWithHelper, synthesizeWavWithHelper,
  recordWithHelper, stopHelperRecording, speakWithHelper,
} from './foundation-models-helper.js';
import { enqueueOpenCodeCommand, pollOpenCodeCommands } from './opencode-steering.js';
import { runSessionReview, reviewSnapshot } from './review-runner.js';

/** Observed-session device approval gate (PreToolUse hold). Default ON — the
 *  precision guards in observed-steering.ts/claude-permission-rules.ts ensure
 *  only genuine would-prompt calls are held. Kill switch for field issues. */
const OBSERVED_APPROVAL_ENABLED = process.env.AGENTDECK_OBSERVED_APPROVAL !== '0';
/** How long a held gate waits for a device decision before releasing the tool
 *  call to Claude's own permission flow. Must stay well under the hook curl's
 *  --max-time 60 so the release reaches Claude before curl gives up. */
const OBSERVED_APPROVAL_HOLD_MS = Math.min(
  50_000,
  Math.max(5_000, Number(process.env.AGENTDECK_APPROVAL_HOLD_MS) || 25_000),
);
/** Inactivity after which an unclosed APME run is treated as abandoned and
 *  finalized. Deliberately generous: an orphan stays reapable forever, so
 *  closing it late costs nothing, while reaping a live run corrupts the unit
 *  being measured. Session bridges own their own collector state and are
 *  invisible to this daemon, so only elapsed silence protects them (runs this
 *  daemon still holds are skipped via `collector.isLiveRun`). */
const APME_ABANDONED_RUN_STALE_SEC = Math.max(
  600,
  Number(process.env.AGENTDECK_APME_ABANDON_SEC) || 7200,
);
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
  ensureDaemonInfo,
  removeDaemonInfo,
  readDaemonInfo,
  removeDaemonSession,
  getCandidateDataDirs,
  getOwnTimelineFile,
} from './session-registry.js';
import { fetchUsageFromApi, hasOAuthToken, resetConsecutiveFailures, type ApiUsageData } from './usage-api.js';
import { isLocalConnection, validateToken } from './auth.js';
import { getLastFrame, renderPreviewFrame, onFrameRendered, offFrameRendered } from './pixoo/pixoo-bridge.js';
import { loadIDotMatrixDevices } from './idotmatrix/idotmatrix-settings.js';
import { handlePixooWake } from './pixoo/pixoo-client.js';
import { triggerMdnsRecovery } from './mdns.js';
import { rgbToBmp, pixooLiveHtml } from './hook-server.js';
import { enableDebugLog, debug, debugThrottled } from './logger.js';
import { CodexOtelTracker, CODEX_OTEL_TRACES_PATH, spanNameSummary } from './codex-otel.js';
import { HookCodexSessions } from './hook-codex-sessions.js';
import { initApme, isTimelineProjectionEnabled, loadApmeConfig, type ApmeModule } from './apme/index.js';
import { FallbackTaskTimeline } from './fallback-task-timeline.js';
import { handleApmeRequest } from './apme/http.js';
import { readModelFromTranscript } from './apme/claude-transcript-reader.js';
import {
  transcriptTimelineForSession, lastAssistantTextFromTranscript,
  lastAssistantTextForSession,
} from './session-transcript-timeline.js';
import {
  DeviceVoiceReplyRouter, speakableReply, spokenDigest, pcmFromWav, type ReplySink,
} from './device-voice-reply.js';
import { rawSessionId, type StateSnapshot } from '@agentdeck/shared';
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
import { getLanIp, stripUnsafeText, cleanRawText, prepareMarkdownDetail, normalizeCommandPrompt, formatDurationSec, type TimelineEntry, PluginCommand } from '@agentdeck/shared';
import { injectOpenClawSession, OPENCLAW_SESSION_ID } from './openclaw-session.js';
import {
  buildCardFeed, buildGlance, applyOutboxDecisions, FeedPullTracker, formatFeedPull,
  normalizeClientIp, parsePullTelemetry,
} from './card-feed.js';
import { threadModule } from './card-modules.js';
import {
  AutonomousPocketEngine,
  createAutonomousPocketModules,
  parsePocketAutonomyConfig,
} from './pocket-autonomy.js';
import { WeatherProvider, parseWeatherSettings } from './weather.js';
import { CalendarProvider, parseCalendarSettings } from './calendar.js';
import { renderGlanceFrame, GLANCE_FRAME_BOARDS } from './glance-frame.js';
import type { UsageEvent } from './types.js';
import { mergeRelayedSessionUsage } from './usage-event.js';
import { CARD_FEED_PATH, CARD_OUTBOX_PATH, GLANCE_FRAME_PATH, type CardFeedResponse, type SessionInfo, type OutboxPushRequest } from '@agentdeck/shared';
import { readFileSync, statSync, writeFileSync, appendFileSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
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
  /** Peripheral telemetry/diag from capability-advertising boards. */
  capabilities?: string[];
  batteryPercent?: number;
  batteryVoltageMv?: number;
  batteryCharging?: boolean;
  usbPowered?: boolean;
  batteryDiag?: number;
  touchReady?: boolean;
  touchDownSamples?: number;
  touchGestures?: number;
  alsReady?: boolean;
  lastSeenMs: number;
}
const wifiEsp32Devices = new Map<string, WifiEsp32Device>();
const wifiEsp32Sockets = new Map<string, WebSocket>();
/** What each ESP32 socket reported about itself, independent of whether the
 *  single-path dedup kept it in the registry above. */
const wsSelfBoard = new Map<WebSocket, string>();
const wsSelfCaps = new Map<WebSocket, string[]>();

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

/** Card-feed pull log. Daemon-lifetime only: it answers "is the wake cadence
 *  working right now", which is exactly the M6 power-ladder check that has no
 *  other observable — a battery client with an empty outbox never identifies
 *  itself and never opens a socket. */
const feedPulls = new FeedPullTracker();

/** Daemon-owned personal feed. It persists aggregate bandit state only — no
 *  card copy, session names, calendar titles or weather locations. */
const pocketAutonomy = new AutonomousPocketEngine({ onError: (message) => log(`[agentdeck] ${message}`) });
const pocketCardModules = [threadModule, ...createAutonomousPocketModules(pocketAutonomy)];
// THREAD is a live AgentDeck session digest. It remains available to legacy
// feed consumers, while the dedicated Pocket surface receives only portable,
// daemon-authored reading cards.
const pocketReaderModules = pocketCardModules.filter((module) => module.id !== 'thread');

/** Glance weather for the card-feed sleep dashboard. Config is read from
 *  settings.json per pull (cheap; honors edits without a restart); the
 *  provider caches the upstream fetch itself. */
const glanceWeather = new WeatherProvider();

/** Glance schedule (today's ICS events) — same config/caching contract as
 *  weather: settings.json `calendar: {ics}`, 30 min cache, never throws. */
const glanceCalendar = new CalendarProvider();

// ===== Pull OTA (feed-carried) — staged firmware per board =====
//
// WS OTA can only reach a board holding a live socket, which a wake-sync-sleep
// battery client (XTeink X3/X4) never does. Staging flips the direction: the
// daemon remembers one firmware per board (`esp32-ota <board> --firmware …
// --stage`), every `GET /feed` response adverts it as `fw: {size, md5}`, and
// the device downloads `GET /esp32/fw` + flashes itself on its next pull.
// Persisted across daemon restarts; a device that already took an md5 skips it
// (its applied-marker), so a stale staging is harmless.
interface StagedFw { firmwarePath: string; md5: string; size: number; stagedAt: number; }
const stagedFwByBoard = new Map<string, StagedFw>();
const stagedFwStatePath = (): string => join(homedir(), '.agentdeck', 'staged-fw.json');

function loadStagedFw(): void {
  try {
    const raw = JSON.parse(readFileSync(stagedFwStatePath(), 'utf8')) as Record<string, StagedFw>;
    for (const [board, s] of Object.entries(raw)) {
      if (s && typeof s.firmwarePath === 'string' && typeof s.md5 === 'string' && typeof s.size === 'number') {
        stagedFwByBoard.set(board, s);
      }
    }
  } catch { /* no staging file — nothing staged */ }
}
loadStagedFw();

function saveStagedFw(): void {
  try {
    writeFileSync(stagedFwStatePath(), JSON.stringify(Object.fromEntries(stagedFwByBoard), null, 2));
  } catch (err) {
    log(`[agentdeck] staged-fw persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Stage a build for a board. Reads the file once to fingerprint it; the file
 *  itself is re-read at device download time (a rebuild at the same path is
 *  re-fingerprinted by re-staging). */
function stageEsp32Fw(board: string, firmwarePath: string): { board: string; bytes: number; md5: string } {
  const firmware = readFileSync(firmwarePath);
  const md5 = createHash('md5').update(firmware).digest('hex');
  stagedFwByBoard.set(board, { firmwarePath, md5, size: firmware.length, stagedAt: Date.now() });
  saveStagedFw();
  log(`[agentdeck] staged firmware for ${board}: ${firmware.length} bytes md5=${md5} — installs on its next feed pull`);
  return { board, bytes: firmware.length, md5 };
}

/** The staged advert for a feed response, re-validated against the file on
 *  disk so a rebuilt-in-place binary never adverts a stale md5. */
function stagedFwAdvert(board: string | undefined): { size: number; md5: string } | undefined {
  if (!board) return undefined;
  const staged = stagedFwByBoard.get(board);
  if (!staged) return undefined;
  try {
    const firmware = readFileSync(staged.firmwarePath);
    const md5 = createHash('md5').update(firmware).digest('hex');
    if (md5 !== staged.md5 || firmware.length !== staged.size) {
      stagedFwByBoard.set(board, { ...staged, md5, size: firmware.length });
      saveStagedFw();
      return { size: firmware.length, md5 };
    }
    return { size: staged.size, md5: staged.md5 };
  } catch {
    return undefined;  // file gone — advert nothing rather than a dead download
  }
}

/** Name a pulling client from the WiFi WS roster. A board that has been
 *  deep-sleeping may have aged out of that roster, which is why the tracker
 *  keeps its own IP→board memory once it has learned one. */
function boardForClientIp(ip: string): string | undefined {
  const want = normalizeClientIp(ip);
  if (!want) return undefined;
  for (const d of wifiEsp32Devices.values()) {
    if (d.ip && normalizeClientIp(d.ip) === want) return d.board;
  }
  return undefined;
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
    // Peripheral telemetry/diag — without these the /devices view silently
    // drops what capability-advertising boards report (the t_embed battery
    // fields were invisible here for a day for exactly this reason).
    capabilities: Array.isArray(d.capabilities) ? d.capabilities as string[] : undefined,
    batteryPercent: typeof d.batteryPercent === 'number' ? d.batteryPercent : undefined,
    batteryVoltageMv: typeof d.batteryVoltageMv === 'number' ? d.batteryVoltageMv : undefined,
    batteryCharging: typeof d.batteryCharging === 'boolean' ? d.batteryCharging : undefined,
    usbPowered: typeof d.usbPowered === 'boolean' ? d.usbPowered : undefined,
    batteryDiag: typeof d.batteryDiag === 'number' ? d.batteryDiag : undefined,
    touchReady: typeof d.touchReady === 'boolean' ? d.touchReady : undefined,
    touchDownSamples: typeof d.touchDownSamples === 'number' ? d.touchDownSamples : undefined,
    touchGestures: typeof d.touchGestures === 'number' ? d.touchGestures : undefined,
    alsReady: typeof d.alsReady === 'boolean' ? d.alsReady : undefined,
    lastSeenMs: Date.now(),
  });
  wifiEsp32Sockets.set(key, ws);
  if (previous?.uptimeSec != null && uptimeSec != null && uptimeSec + 10 < previous.uptimeSec) {
    log(`[agentdeck] ESP32 reboot observed: ${key} uptime ${previous.uptimeSec}s -> ${uptimeSec}s reset=${resetReason ?? 'unknown'} code=${resetReasonCode ?? 'unknown'}`);
  }
  // Plain-log a board APPEARING on WS (absent or stale before) — a sleeping
  // battery board's brief interactive window is exactly when a WS OTA can
  // land, and this line is the only wake signal an operator/script can tail.
  if (!previous || Date.now() - previous.lastSeenMs > 90_000) {
    log(`[agentdeck] ESP32 WiFi registered: ${key}`);
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
                scopedLimits: Array.isArray(evt.scopedLimits) ? evt.scopedLimits : [],
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

/** @internal Exported for the relay-fallback regression test. */
export async function fetchUsageRelayed(selfPort: number): Promise<ApiUsageData | null> {
  const sessions = listActiveSessions();
  const siblings = sessions.filter(s => s.port !== selfPort && s.agentType !== 'daemon');

  if (siblings.length > 0) {
    const httpResult = await fetchUsageViaHttp(siblings);
    if (httpResult) return httpResult.usage;
    const wsResult = await fetchUsageViaWs(siblings);
    if (wsResult) return wsResult;
    // Relay is only an optimization to avoid multiple API pollers. A PTY session
    // bridge only refreshes usage when it has *direct* inbound WS clients, but
    // dashboards/Stream Deck connect to the daemon (sole entry point) — so a
    // sibling with no direct clients never populates its /usage and the relay
    // yields null forever, freezing the daemon's usage at its startup value.
    // Fall back to the direct API; the shared usage-cache.json (120s TTL) dedupes
    // so this can't cause a 429 storm even if a sibling is also actively fetching.
    debug('daemon', 'Siblings exist but relay yielded nothing fresh — falling back to direct API (shared file cache dedupes)');
    return fetchUsageFromApi();
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
export function enrichGatewayTimelineEntry<T extends { agentType?: string; projectName?: string; sessionId?: string }>(
  entry: T,
): T {
  return {
    ...entry,
    agentType: entry.agentType ?? 'openclaw',
    projectName: entry.projectName ?? 'OpenClaw',
    // Devices and the voice-reply router address the gateway session as
    // 'openclaw-gateway'; without this stamp its chat_response rows carry no
    // sessionId, so a board armed for a spoken reply never matches the turn
    // completion and the reply silently never plays (observed 2026-07-31).
    sessionId: entry.sessionId ?? 'openclaw-gateway',
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
  if (eventName === 'codex_subagent_start' || eventName === 'codex_subagent_stop') {
    return { boundary: eventName, agentType: 'codex-cli' };
  }
  const prefixed = /^(codex|opencode|antigravity)_(session_start|session_end|user_prompt_submit|tool_start|tool_end|stop|turn_complete|notification|permission_asked|permission_replied)$/
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
    // Configured but the module never started — say so explicitly. An omitted
    // `connected` reads as "no information" to retain-on-absent clients, and a
    // panel nobody is driving must not inherit a stale connected:true.
    modules.timebox = {
      configuredDeviceCount: configuredTimebox.length,
      connected: false,
      statusReason: 'sync module not started',
      displayDimmed: false,
      hasFrame: false,
      lastError: null,
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
    // Configured but the module never started — see the Timebox note above.
    modules.idotmatrix = {
      configuredDeviceCount: configuredIDotMatrix.length,
      connected: false,
      statusReason: 'sync module not started',
      displayDimmed: false,
      hasFrame: false,
      lastError: null,
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
  // Sessions that posted any hook since this daemon started — the delayed
  // orphan-chat reaper must never force-close a turn belonging to a session
  // that is provably alive (agentic turns regularly outlive any fixed age
  // threshold). Declared before the HTTP handlers that populate it.
  const hookSessionsSeen = new Set<string>();

  // Codex OTel span state. Declared before the HTTP server because the
  // `/otel/v1/traces` handler closes over it — Codex's exporter can POST before
  // the rest of daemon startup finishes.
  const codexOtel = new CodexOtelTracker();
  // Codex sessions known only from `codex_*` hooks — the backstop for when the
  // process scan can't see one (lsof timeout, no rollout held open).
  const hookCodexSessions = new HookCodexSessions();

  // Declare early — HTTP /health handler references this in its closure.
  // Must be declared before the HTTP server so it's initialized (not in TDZ)
  // when the first /health request arrives.
  let gatewayAdapter: OpenClawAdapter | null = null;
  let gatewayConnecting = false;
  let moduleHealthProvider: () => Record<string, unknown> = () => ({});

  // Gateway-local activity state for the virtual `openclaw-gateway` session row.
  // Driven ONLY by the OpenClaw adapter's own parser events — NOT the global
  // `core.stateMachine`, which every observed Claude session hook also feeds
  // (daemon-server.ts:1181-1188). Borrowing `snap.state` there painted OpenClaw
  // as "processing" whenever any unrelated Claude/opencode turn was in flight,
  // even though the Gateway itself was idle. Mirror of Swift DaemonServer's
  // `gatewaySessionState` / `gatewayModelName` dedicated fields.
  let gatewaySessionState = 'idle';
  let gatewayModelName: string | undefined;

  /**
   * Snapshot for an `openclaw` state event: the global machine with the
   * Gateway-local model pinned back on.
   *
   * The Gateway's `model_info` no longer writes `core.stateMachine` (see the
   * parser branch): that machine is fed by every observed Claude/Codex/OpenCode
   * hook, and the hub stamps its broadcasts with the user's focused session —
   * so a model written there by a *different* agent is read as the focused
   * session's own. That is how `GLM-5.2 (1M)` appeared as the model of a Claude
   * session on both decks. Keeping the model out of the shared slot means the
   * Gateway's own events have to carry it explicitly, which is what this does.
   */
  const gatewaySnapshot = (base?: StateSnapshot): StateSnapshot => ({
    ...(base ?? core.stateMachine.getSnapshot()),
    modelName: gatewayModelName ?? null,
  });

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
  // Android dashboard apps (tablet / e-ink launcher) over Wi-Fi WS —
  // `client_register{clientType:"android-dashboard"}`, same volunteer model.
  const androidDashboardRegistrations = new Map<WebSocket, { devices: unknown[]; updatedAt: number }>();
  const collectAndroidDashboards = (): unknown[] => {
    const out: unknown[] = [];
    for (const [ws, reg] of androidDashboardRegistrations) {
      if (ws.readyState !== WebSocket.OPEN) { androidDashboardRegistrations.delete(ws); continue; }
      for (const d of reg.devices) out.push(d);
    }
    return out;
  };
  // Elgato Stream Deck plugin — `client_register{clientType:"streamdeck-plugin"}`
  // with the physical device roster. The Swift daemon has handled this since the
  // Stream Deck topology row shipped; the Node daemon silently dropped it, so on
  // the external-CLI tier the dashboard never showed a Stream Deck row at all.
  const streamDeckRegistrations = new Map<WebSocket, { devices: unknown[]; updatedAt: number }>();
  const collectStreamDeckDevices = (): unknown[] => {
    const out: unknown[] = [];
    for (const [ws, reg] of streamDeckRegistrations) {
      if (ws.readyState !== WebSocket.OPEN) { streamDeckRegistrations.delete(ws); continue; }
      for (const d of reg.devices) out.push(d);
    }
    return out;
  };

  /**
   * Debug hook behind `POST /voice/speak` — synthesize arbitrary text straight
   * to a board's amplifier, bypassing the arming that the real voice loop needs.
   * Without it the only way to hear the speaker is to hold a board's mic button
   * and wait for an agent turn, which is useless for verifying a flash.
   *
   * Assigned late, once the reply router and its sinks exist: those live far
   * below the HTTP server, which is already listening by then, so the route must
   * read this binding at request time rather than close over one in its TDZ.
   */
  let speakToBoard:
    | ((board: string, text: string, opts: { force?: boolean; locale?: string })
        => Promise<{ ok: boolean; detail: string }>)
    | null = null;
  // Assigned after BridgeCore exists. The HTTP handler reads it only after
  // startup; nullable keeps the tiny listen→core initialization window safe.
  let subagentTimeline: SubagentTimelineTracker | null = null;

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
        // Capability: this daemon drives remote sessions down their own push
        // socket (session_focus_down / session_command_down / session_event_up).
        // Workers require this flag before remote-attaching; the Swift daemon
        // does not advertise it and is therefore never selected as a remote hub.
        sameSocketControl: true,
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
          { type: 'tui', devices: core.wsServer.getTuiClients() },
          { type: 'esp32', count: esp32ConnectionCount(), ports: getESP32Ports(), devices: getESP32DeviceInfo() },
          { type: 'esp32-wifi', devices: listWifiEsp32Devices() },
          // Pull-sync clients (M6). Separate from esp32-wifi on purpose: a
          // battery board that wakes, syncs over HTTP and sleeps is never in
          // the WS roster while it matters.
          { type: 'card-feed', clients: feedPulls.clients(), recent: feedPulls.recent(8) },
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
    // Device photo upload — a whole JPEG as one request body. The chunked
    // WS/serial path is loss-prone on this hardware (HWCDC drops 64-byte
    // blocks; the board's WS TX jammed after the first binary frame), and a
    // partial JPEG is worthless, so a board with WiFi posts the image over
    // plain TCP and lets the kernel handle ordering and retransmit.
    if (req.method === 'POST' && pathname === '/esp32/photo') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalConnection(ip)) {
        const token = parsedUrl.searchParams.get('token') ?? '';
        if (!validateToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
      (async () => {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > 8 * 1024 * 1024) throw new Error('photo_too_large');
          chunks.push(buf);
        }
        if (total === 0) throw new Error('empty_body');
        const jpeg = Buffer.concat(chunks);
        const board = parsedUrl.searchParams.get('board') ?? 'esp32';
        const saved = devicePhoto.saveDirect(jpeg, {
          board,
          sessionId: parsedUrl.searchParams.get('sessionId') ?? '',
          width: Number(parsedUrl.searchParams.get('w') ?? 0) || 0,
          height: Number(parsedUrl.searchParams.get('h') ?? 0) || 0,
        });
        // Reply on the board's own transport (serial when it is cabled), the
        // same way the chunked path did — the HTTP response only confirms
        // receipt of the bytes.
        await finishPhotoCapture(saved, boardResultSinkFor(board));
        return { ok: true, bytes: saved.bytes, path: saved.path };
      })().then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }
    // Device voice upload — a whole utterance of raw PCM16LE as one request
    // body. Live streaming lost audio on both of the ips10's transports
    // (115200-baud serial ceiling; hosted-C6 WS stalls overflowing the DRAM
    // ring), and transcription only starts once the utterance is complete, so
    // buffering on-device and letting TCP handle delivery loses nothing.
    // Mirrors /esp32/photo, including replying on the board's own transport.
    if (req.method === 'POST' && pathname === '/esp32/voice') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalConnection(ip)) {
        const token = parsedUrl.searchParams.get('token') ?? '';
        if (!validateToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
      (async () => {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          // 16 kHz mono PCM16 for the firmware's 30 s runaway cap is 960 KB.
          if (total > 2 * 1024 * 1024) throw new Error('utterance_too_large');
          chunks.push(buf);
        }
        if (total === 0) throw new Error('empty_body');
        const board = parsedUrl.searchParams.get('board') ?? 'esp32';
        const saved = deviceVoice.saveDirect(Buffer.concat(chunks), {
          board,
          sessionId: parsedUrl.searchParams.get('sessionId') ?? '',
          sampleRate: Number(parsedUrl.searchParams.get('rate') ?? 0) || 16000,
          durationMs: Number(parsedUrl.searchParams.get('ms') ?? 0) || 0,
        });
        // The HTTP response only confirms receipt of the bytes; the
        // transcript/outcome goes to the board as a voice_result frame.
        await finishVoiceCapture(saved, boardResultSinkFor(board));
        return { ok: true, bytes: total };
      })().then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }
    // Staged spoken reply for an `audio_http_pull` board — raw PCM16LE body.
    // The board fetches at its own pace (TCP flow control), which is what
    // keeps the hosted-C6 RX path from being burst-fed and asserting.
    if (req.method === 'GET' && pathname === '/esp32/voice-reply') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalConnection(ip)) {
        const token = parsedUrl.searchParams.get('token') ?? '';
        if (!validateToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
      const board = parsedUrl.searchParams.get('board') ?? '';
      const staged = board ? stagedVoiceReplies.get(board) : undefined;
      if (!staged) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_staged_reply' }));
        return;
      }
      // Kept until TTL rather than deleted here: an aborted download may retry.
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': staged.pcm.length,
        'X-Sample-Rate': String(staged.sampleRate),
      });
      // Paced writes, NOT res.end(pcm): a single end() hands the whole body
      // to the kernel, which blasts a TCP-initial-window-sized segment burst.
      // TCP flow control lives in lwIP — it cannot protect the hosted C6→P4
      // handoff underneath it, whose RX pool exhausted and ASSERTED the board
      // one second into the first pull (`sdio_rx_get_buffer (*buf)`,
      // 2026-07-31 12:06). 2 KB per 15 ms ≈ 133 KB/s keeps at most a couple
      // of segments in flight while still beating playback rate 4x.
      {
        // 8 KB / 10 ms ≈ 800 KB/s — a 2 MB answer lands in ~2.5 s. The
        // original 2 KB / 15 ms (~133 KB/s) predated the PSRAM-mempool core
        // fix and made long replies take 15+ s to start, which read as "no
        // playback"; with the hosted mempool in PSRAM the burst constraint is
        // gone and only gentle pacing is kept as hygiene.
        const CHUNK = 8192;
        const GAP_MS = 10;
        let off = 0;
        const writeNext = (): void => {
          if (res.destroyed) return;
          if (off >= staged.pcm.length) { res.end(); return; }
          const end = Math.min(off + CHUNK, staged.pcm.length);
          res.write(staged.pcm.subarray(off, end));
          off = end;
          setTimeout(writeNext, GAP_MS).unref?.();
        };
        writeNext();
      }
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
        // Pull-OTA staging: remember the build; the board installs it on its
        // next feed pull (no live WS needed). See stagedFwByBoard.
        if (body.stage === true) {
          return { ok: true, staged: true, ...stageEsp32Fw(target, firmwarePath) };
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
    // ===== Pull OTA (feed-carried) — staged firmware download =====
    // The board saw `fw: {size, md5}` on its feed pull and fetches the image
    // here. Auth mirrors the feed routes (LAN needs the pairing token).
    if (req.method === 'GET' && pathname === '/esp32/fw') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalConnection(ip)) {
        const token = parsedUrl.searchParams.get('token') ?? '';
        if (!validateToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — token required for firmware download' }));
          return;
        }
      }
      const board = parsedUrl.searchParams.get('board') ?? '';
      const staged = stagedFwByBoard.get(board);
      if (!staged) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `nothing staged for board "${board}"` }));
        return;
      }
      try {
        const firmware = readFileSync(staged.firmwarePath);
        // Resumable download: `?from=<offset>` serves the remainder. A 5 MB
        // image over a marginal link never survives one connection (this
        // bridge host's two-NICs-on-one-subnet setup black-holes full-MTU
        // segments in one direction, and a restart-from-zero download can
        // never converge there). The device appends whatever arrives and
        // re-asks from where it stopped, so partial transfers accumulate.
        const fromRaw = Number(parsedUrl.searchParams.get('from') ?? 0);
        const from = Number.isFinite(fromRaw) && fromRaw > 0 ? Math.min(Math.floor(fromRaw), firmware.length) : 0;
        const body = from > 0 ? firmware.subarray(from) : firmware;
        log(`[agentdeck] pull-OTA download: ${board} (${ip}) ← ${body.length} bytes`
          + (from > 0 ? ` (resume from ${from}/${firmware.length})` : ''));
        res.writeHead(from > 0 ? 206 : 200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
          ...(from > 0
            ? { 'Content-Range': `bytes ${from}-${Math.max(from, firmware.length - 1)}/${firmware.length}` }
            : {}),
          'X-FW-MD5': staged.md5,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    // ===== Card Feed pull sync (M6) — wake-sync-sleep battery clients =====
    // Auth mirrors /apme: local connections are free; anything else needs the
    // pairing token (?token=). Devices hold it from provisioning; /health
    // exposes it for LAN pairing.
    // ===== Glance Frame (M8) — daemon-rendered pixels of the glance =====
    // The device-side glance renderer is the offline fallback; this is the
    // rich face. `?format=png` returns the exact dithered panel pixels, so a
    // browser preview IS the production frame (protocol.ts § Glance Frame).
    if (req.method === 'GET' && pathname === GLANCE_FRAME_PATH) {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalConnection(ip)) {
        const token = parsedUrl.searchParams.get('token') ?? '';
        if (!validateToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — token required for glance frame' }));
          return;
        }
      }
      (async () => {
        const board = parsedUrl.searchParams.get('board') ?? 'xteink_x3';
        const preset = GLANCE_FRAME_BOARDS[board];
        const w = Number(parsedUrl.searchParams.get('w'));
        const h = Number(parsedUrl.searchParams.get('h'));
        const geometry = Number.isFinite(w) && Number.isFinite(h) && w >= 128 && h >= 128 && w <= 1600 && h <= 1600
          ? { width: Math.round(w), height: Math.round(h), landscape: w > h }
          : preset ?? GLANCE_FRAME_BOARDS.xteink_x3;
        const sessions = await core.buildSessionsSnapshot();
        const glance = buildGlance({
          sessions: sessions as unknown as SessionInfo[],
          usage: core.buildUsage() as UsageEvent,
          weather: await glanceWeather.get(parseWeatherSettings(loadDaemonSettings())),
          events: await glanceCalendar.get(parseCalendarSettings(loadDaemonSettings())),
        });
        const d = new Date();
        const serverHm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const frame = await renderGlanceFrame({ glance, serverHm, geometry });
        const headers = {
          'X-Frame-Width': String(frame.width),
          'X-Frame-Height': String(frame.height),
          'X-Frame-Sig': frame.sig,
          'Cache-Control': 'no-store',
        };
        // Conditional fetch, one layer down from the feed's deckSig: matching
        // sig → 304, no body, the panel keeps holding the frame it has.
        if (parsedUrl.searchParams.get('sig') === frame.sig) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        if (parsedUrl.searchParams.get('format') === 'png') {
          res.writeHead(200, { ...headers, 'Content-Type': 'image/png' });
          res.end(await frame.png());
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' });
        res.end(frame.packed);
      })().catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
      return;
    }
    if ((req.method === 'GET' && pathname === CARD_FEED_PATH)
      || (req.method === 'POST' && pathname === CARD_OUTBOX_PATH)) {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalConnection(ip)) {
        const token = parsedUrl.searchParams.get('token') ?? '';
        if (!validateToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — token required for card feed routes' }));
          return;
        }
      }
      (async () => {
        if (req.method === 'GET') {
          const sessions = await core.buildSessionsSnapshot();
          const settings = loadDaemonSettings();
          pocketAutonomy.configure(parsePocketAutonomyConfig(settings));
          // Sleep-dashboard glance: provider quota + work wrap-up + weather.
          // Weather resolves from cache almost always (30 min window) and is
          // bounded by its own fetch timeout, so the pull stays fast.
          const glance = buildGlance({
            sessions: sessions as unknown as SessionInfo[],
            usage: core.buildUsage() as UsageEvent,
            weather: await glanceWeather.get(parseWeatherSettings(settings)),
            events: await glanceCalendar.get(parseCalendarSettings(settings)),
          });
          const now = Date.now();
          const pocketReader = parsedUrl.searchParams.get('surface') === 'pocket-reader';
          const feed = buildCardFeed(sessions as unknown as SessionInfo[], now,
            pocketReader ? pocketReaderModules : pocketCardModules, {
            glance,
            echoSig: parsedUrl.searchParams.get('sig') ?? undefined,
            includeSessions: !pocketReader,
          }) as CardFeedResponse & { fw?: { size: number; md5: string } };
          // Pull-OTA advert: rides full AND `unchanged` responses, so a
          // sleeping board learns about a staged build on any pull. Board
          // identity from the query (newer firmware) or the IP memory.
          const pullBoard = parsedUrl.searchParams.get('board') ?? boardForClientIp(ip);
          if (!feed.unchanged) pocketAutonomy.observeDelivery(feed.cards, now, pullBoard ?? undefined);
          const fwAdvert = stagedFwAdvert(pullBoard ?? undefined);
          if (fwAdvert) feed.fw = fwAdvert;
          // A sleeping client's whole visit is this one request: no body, no
          // board id, nothing pushed. Record it, because the gap between two
          // pulls is the only evidence that the timer wake fired at all.
          feedPulls.noteBoard(ip, boardForClientIp(ip));
          log(`[agentdeck] ${formatFeedPull(feedPulls.record(ip, {
            cards: feed.cards.length,
            nextPullSec: feed.nextPullSec,
            unchanged: feed.unchanged === true,
            telemetry: parsePullTelemetry(parsedUrl.searchParams),
          }))}`);
          return feed;
        }
        const body = await readJsonBody(req);
        const board = typeof body.board === 'string' ? body.board : 'unknown';
        // An outbox push is the one request that names the board — bind it to
        // the IP so the (anonymous) feed pulls that follow are attributable.
        if (board !== 'unknown') feedPulls.noteBoard(ip, board);
        const sessions = await core.buildSessionsSnapshot();
        const result = applyOutboxDecisions(body as unknown as OutboxPushRequest, {
          sessions: sessions as unknown as SessionInfo[],
          isPendingRequest,
          dispatch: (cmd) => handleDeviceCommand(cmd as unknown as PluginCommand),
          modules: pocketCardModules,
        });
        const applied = result.results.filter((r) => r.status === 'applied').length;
        if (result.results.length > 0) {
          log(`[agentdeck] outbox push from ${board}: ${applied}/${result.results.length} applied`);
        }
        return result;
      })().then((payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
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
        // Codex observation backstops — which sessions each source believes in.
        // A session present here but absent from sessions_list means the ps
        // observer found it too and won, which is the expected steady state.
        hookCodexSessions: hookCodexSessions.snapshot(),
        codexOtelThreads: codexOtel.snapshot(),
        pocketAutonomy: pocketAutonomy.diagnostics(),
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
          PostToolUseFailure: 'tool_failure',
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
        const earlyHookSid = typeof json.session_id === 'string' && json.session_id
          ? json.session_id : 'daemon-hook';
        const earlyHookCwd = (typeof json.cwd === 'string' ? json.cwd
          : (typeof json.project_path === 'string' ? json.project_path : '')) || '';
        const earlyHookProject = (typeof json.project_name === 'string' && json.project_name)
          ? json.project_name
          : (earlyHookCwd ? earlyHookCwd.split('/').filter(Boolean).pop() : undefined);
        const childHook = subagentTimeline?.handle({
          eventName,
          payload: json,
          sessionId: earlyHookSid,
          agentType: hookAgentType,
          projectName: earlyHookProject,
        }).childOnly === true;
        if (childHook) {
          // Child activity is observation-only. Never let child PreToolUse
          // reach the parent's approval, STOP, state, or APME paths.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(eventName === 'PreToolUse' || eventName === 'Stop'
            ? ''
            : JSON.stringify({ received: true }));
          return;
        }
        // Hook-derived Codex session rows. Placed after the child-hook return so
        // subagent lifecycle never drives the parent row, and kept independent
        // of the state machine: this only decides whether a Codex the process
        // scan can't see still has a session. See bridge/src/hook-codex-sessions.ts.
        if (eventName.startsWith('codex_')) {
          hookCodexSessions.note(eventName, {
            sessionId: typeof json.session_id === 'string' ? json.session_id : undefined,
            cwd: earlyHookCwd || undefined,
            projectName: earlyHookProject,
            toolName: typeof json.tool_name === 'string' ? json.tool_name : undefined,
          });
        }
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
        // Per-session awaiting overlay for observed/direct-`claude` sessions.
        // Permission prompts stay Notification-driven and display-only unless
        // the precision PreToolUse gate below owns a real requestId.
        // AskUserQuestion is different: its PreToolUse payload already carries
        // question/options/tool_use_id, so preserve that structured lifecycle
        // as awaiting_option until the matching PostToolUse/Failure. This avoids
        // both the generic "Claude needs your permission" downgrade and the
        // transcript-mtime false resolution that affected a live 17-minute
        // choice wait. No requestId is fabricated: observed surfaces remain
        // respond-in-terminal only.
        const claudeSid = typeof json.session_id === 'string' ? json.session_id : undefined;
        if (claudeSid) {
          const toolName = typeof json.tool_name === 'string' ? json.tool_name : '';
          const toolUseId = typeof json.tool_use_id === 'string' ? json.tool_use_id : undefined;
          const toolInput = (json.tool_input && typeof json.tool_input === 'object')
            ? json.tool_input as Record<string, unknown> : undefined;
          if (mapped === 'notification') {
            const message = typeof json.message === 'string' ? json.message : '';
            const notificationType = typeof json.notification_type === 'string' ? json.notification_type : undefined;
            if (isPermissionNotification(notificationType, message)) {
              // A genuine terminal prompt appeared — recent undecided gate
              // releases were real prompts, so nothing gets learned as
              // auto-approved (observed-steering learner).
              notePermissionPromptShown(claudeSid);
              // AskUserQuestion emits this generic permission notification
              // several seconds after its structured PreToolUse. Never replace
              // the real question/options with the generic message.
              if (setPermissionNotificationOverlay(claudeSid, message)) {
                // Broadcast immediately rather than waiting for the 2s debounce
                // or the 5s observer tick, so the prompt surfaces within one frame.
                core.broadcastSessionsList().catch(() => {});
              }
            }
          } else if (mapped === 'tool_start' && toolName === 'AskUserQuestion') {
            if (setAskUserQuestionOverlay(claudeSid, toolUseId, toolInput)) {
              debug('daemon', `AskUserQuestion awaiting_option set: sid=${claudeSid} tool=${toolUseId ?? 'unknown'}`);
              core.broadcastSessionsList().catch(() => {});
            }
          } else if (
            mapped === 'tool_start' || mapped === 'tool_end' || mapped === 'tool_failure' ||
            mapped === 'user_prompt_submit' || mapped === 'stop' ||
            mapped === 'session_start' || mapped === 'session_end'
          ) {
            // Steering lifecycle: a PostToolUse right after an undecided gate
            // release (no permission_prompt Notification in between) means
            // Claude auto-approved the call — learn the signature so it is
            // never held again this session. User prompt / session end clear
            // pending STOP + queued directives (the user took over).
            if (mapped === 'tool_end') {
              noteToolEnd(claudeSid, toolName || undefined);
            } else if (mapped === 'user_prompt_submit') {
              if (clearOnUserPrompt(claudeSid)) core.broadcastSessionsList().catch(() => {});
            } else if (mapped === 'session_end') {
              clearSteeringSession(claudeSid);
            }

            const currentOverlay = getAwaitingOverlay(claudeSid);
            let cleared = false;
            if (
              (mapped === 'tool_end' || mapped === 'tool_failure') &&
              toolName === 'AskUserQuestion'
            ) {
              cleared = clearAskUserQuestionOverlay(claudeSid, toolUseId);
              if (cleared) {
                debug('daemon', `AskUserQuestion awaiting_option cleared by ${eventName}: sid=${claudeSid} tool=${toolUseId ?? 'unknown'}`);
              }
            } else if (
              mapped === 'user_prompt_submit' || mapped === 'stop' ||
              mapped === 'session_start' || mapped === 'session_end'
            ) {
              // Authoritative turn/session boundary supersedes every overlay.
              cleared = clearAwaitingOverlay(claudeSid);
            } else if (currentOverlay?.kind !== 'option') {
              // Permission overlay: any subsequent tool hook means the prompt
              // was answered. Held gates are owned by their resolver and must
              // survive unrelated parallel tool hooks.
              const gateStillPending = Boolean(
                currentOverlay?.requestId && isPendingRequest(currentOverlay.requestId)
              );
              if (!gateStillPending) cleared = clearAwaitingOverlay(claudeSid);
            }
            if (cleared) {
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
        // Liveness marker for the delayed orphan-chat reaper: a session that
        // posts ANY hook after daemon startup is alive, and its open turn
        // (even one persisted before the restart) must not be force-closed.
        hookSessionsSeen.add(hookSid);
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
        // Command XML envelopes (`<command-name>/merge</command-name>` …)
        // collapse to their "/merge args" form so a slash-command turn reads
        // as the command the user typed, not an XML blob.
        const hookPromptText = normalizeCommandPrompt(
          typeof json.prompt === 'string' ? json.prompt
            : (typeof hookMessage?.content === 'string' ? hookMessage.content
              : (typeof json.user_prompt === 'string' ? json.user_prompt : '')));
        const isClearBoundary = boundary === 'user_prompt_submit' && /^\s*\/clear\s*$/i.test(hookPromptText);

        // Session ended with a turn still open (the user interrupted the turn
        // then exited, or the process was torn down before its Stop could
        // fire): close the row honestly so dashboards stop the spinner instead
        // of showing "in progress" forever. Runs BEFORE the collector so the
        // interrupted chat_end sorts above the session_end task_end row.
        // Mirrors the Swift daemon's session_end force-close (`hasOpenTurn`
        // → interrupted chat_end).
        if (boundary === 'session_end') {
          const rows = core.bridgeTimeline.getHistoryForSession(hookSid, undefined, 24);
          let lastStart: TimelineEntry | undefined;
          let lastCompletionTs = 0;
          for (const row of rows) {
            if (row.type === 'chat_start') lastStart = row;
            else if (row.type === 'chat_response' || row.type === 'chat_end') {
              lastCompletionTs = Math.max(lastCompletionTs, row.ts);
            }
          }
          if (lastStart && lastStart.ts > lastCompletionTs) {
            const now = Date.now();
            const durS = Math.max(0, Math.round((now - (lastStart.startedAt ?? lastStart.ts)) / 1000));
            core.bridgeTimeline.addEntry({
              ts: now, type: 'chat_end',
              raw: `Interrupted · ${formatDurationSec(durS)}`,
              summaryKind: 'none',
              sessionId: hookSid,
              agentType: hookAgentType,
              startedAt: lastStart.startedAt ?? lastStart.ts,
              endedAt: now,
              ...(lastStart.taskId ? { taskId: lastStart.taskId } : {}),
              ...(hookProject ? { projectName: hookProject } : {}),
            } as TimelineEntry);
          }
        }

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
          // APME: the text below is the assistant half of the turn — hand it to
          // the collector on the SAME branch that decides the timeline row.
          // `setTurnResponse` was reachable only from the PTY session bridge
          // (bridge/src/index.ts), which hook-observed sessions (direct
          // `claude` / `codex` / standalone `opencode`) never go through, so
          // every such turn archived a prompt and its tool calls but no reply:
          // `turns.response` stayed NULL and no `assistant_message` trajectory
          // event was ever written. The dashboard therefore could not replay a
          // conversation the timeline shows in full, and the judge scored those
          // turns against silence. Empty text is still worth recording — it
          // tags `response_kind` tool_only/empty so the runner skips judging.
          if (apme) {
            if (turnOpen) apme.collector.setTurnResponse(hookSid, responseText);
            else if (responseText.length > 0) {
              // No open turn: a missed prompt hook or a late/duplicate stop.
              // The last-closed fallback refuses to overwrite an existing
              // response, so a duplicate stop is a no-op instead of a clobber.
              apme.collector.setLastClosedTurnResponse(hookSid, responseText);
            }
          }
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
                raw: `Completed · ${formatDurationSec(durS)}`,
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
        // PreToolUse and Stop are request-response steering channels (the hook
        // script echoes our body to Claude's stdout); everything else acks.
        if (eventName === 'PreToolUse') {
          const toolName = typeof json.tool_name === 'string' ? json.tool_name : '';
          const toolInput = (json.tool_input && typeof json.tool_input === 'object')
            ? json.tool_input as Record<string, unknown> : undefined;
          // 1. Soft STOP: the user pressed STOP on a device — deny this tool
          //    call with a halt instruction. One-shot (flag consumed).
          if (claudeSid && consumeStop(claudeSid)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: STOP_DENY_REASON,
              },
            }));
            core.broadcastSessionsList().catch(() => {});
            return;
          }
          // 2. Device-approval gate: hold the response for a device decision,
          //    but ONLY for calls the precision guards say Claude would
          //    genuinely prompt for (see shouldHoldPreToolUse — mode gate,
          //    never-prompt/prompt-prone sets, allowlist prediction, learned
          //    auto-approvals, connected-client check). Anything uncertain
          //    falls through to the empty pass-through below.
          if (claudeSid) {
            const gate = shouldHoldPreToolUse({
              sessionId: claudeSid,
              tool: toolName,
              toolInput,
              permissionMode: typeof json.permission_mode === 'string' ? json.permission_mode : undefined,
              cwd: hookCwd || undefined,
              clientCount: core.wsServer.getClientCount(),
              enabled: OBSERVED_APPROVAL_ENABLED,
            });
            if (gate.hold && gate.requestId) {
              const requestId = gate.requestId;
              debug('daemon', `PreToolUse gate held: ${toolName} (${gate.reason}) req=${requestId}`);
              setAwaitingOverlay(claudeSid, buildGateQuestion(toolName, toolInput), requestId);
              core.broadcastSessionsList().catch(() => {});
              registerPending(requestId, res, {
                sessionId: claudeSid,
                tool: toolName,
                timeoutMs: OBSERVED_APPROVAL_HOLD_MS,
                onResolved: (decision) => {
                  // `pass` (timeout) arms the auto-approval learner: if the
                  // tool then runs with no permission_prompt Notification,
                  // the signature is suppressed for this session.
                  gateReleased(claudeSid, requestId, {
                    undecided: decision === 'pass', tool: toolName, toolInput,
                  });
                  clearAwaitingOverlay(claudeSid);
                  core.broadcastSessionsList().catch(() => {});
                },
              });
              return; // response held open — resolved by device / timeout
            }
          }
          // Pass-through: empty body → Claude's normal permission flow runs
          // untouched (zero added latency, no daemon-side gate).
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('');
        } else if (eventName === 'Stop') {
          // Turn-end directive queue: deliver at most one queued deck command
          // by blocking the stop with the directive as the continuation
          // reason. Empty queue (the overwhelmingly common case) → empty body,
          // Claude ends the turn normally — no stop_hook_active loop possible.
          const directive = claudeSid ? takeDirective(claudeSid) : undefined;
          if (claudeSid) clearStop(claudeSid); // turn ended — a pending soft-stop is moot
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (directive) {
            debug('daemon', `Stop hook delivering queued directive for ${claudeSid}: "${directive.slice(0, 60)}"`);
            res.end(JSON.stringify({
              decision: 'block',
              reason: `The user sent this follow-up from their AgentDeck controller: "${directive}". Carry out this instruction now.`,
            }));
            core.broadcastSessionsList().catch(() => {});
          } else {
            res.end('');
          }
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        }
      });
      return;
    }

    // Codex OTel exporter target. Codex (CLI and the ChatGPT.app desktop app)
    // POSTs OTLP/HTTP JSON spans here when `[otel.trace_exporter.otlp-http]`
    // points at the daemon. Only the Swift daemon used to implement this, so a
    // Node-daemon host answered 404 and dropped every span. Always 200: an OTel
    // exporter that sees errors backs off, and nothing here is worth telling
    // Codex about. See bridge/src/codex-otel.ts.
    if (req.method === 'POST' && (pathname === CODEX_OTEL_TRACES_PATH || pathname === '/v1/traces')) {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 8_000_000) req.destroy(); });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        try {
          const json: unknown = body ? JSON.parse(body) : {};
          // Dev capture. Codex's span vocabulary is not a stable API, so when it
          // shifts the only way to re-derive the dispatch table is to look at
          // real batches: `AGENTDECK_CODEX_OTEL_DUMP=/tmp/otel.jsonl agentdeck
          // daemon start`. Bodies are pretty-printed and large — point it at a
          // scratch path and delete it afterwards.
          if (process.env.AGENTDECK_CODEX_OTEL_DUMP) {
            try { appendFileSync(process.env.AGENTDECK_CODEX_OTEL_DUMP, `${body}\n`); } catch { /* dev only */ }
          }
          if (codexOtel.ingest(json) === 0) {
            debugThrottled('codex-otel', 'no-recognized-spans', 60_000,
              `no recognized spans; len=${body.length} names=${spanNameSummary(json)}`);
          }
        } catch {
          debugThrottled('codex-otel', 'unparsable-body', 60_000, `unparsable body len=${body.length}`);
        }
      });
      return;
    }

    // OpenCode observer-plugin steering: the plugin long-polls here and
    // executes returned commands via its in-process SDK client (abort /
    // prompt). See bridge/src/opencode-steering.ts.
    if (req.method === 'GET' && pathname === '/opencode/commands') {
      const sid = parsedUrl.searchParams.get('sid') ?? '';
      if (!sid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sid required' }));
        return;
      }
      const waitMs = Math.round(Number(parsedUrl.searchParams.get('wait') ?? '25') * 1000);
      pollOpenCodeCommands(sid, waitMs).then((commands) => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ commands }));
        } catch { /* client disconnected */ }
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

    // Speak arbitrary text on a board's amplifier — the bench test for the
    // playback half of the voice loop, which otherwise only fires when a
    // dictation happens to arm a board and its session finishes a turn. Body:
    //   { board: string, text: string, force?: boolean, locale?: string }
    // `board` is the name `agentdeck devices` prints (e.g. "t_embed"); serial is
    // preferred over WiFi, matching the reply router's routing policy.
    if (req.method === 'POST' && pathname === '/voice/speak') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        let board = '', text = '', force = false, locale: string | undefined;
        try {
          const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
          board = typeof parsed.board === 'string' ? parsed.board : '';
          text = typeof parsed.text === 'string' ? parsed.text : '';
          force = parsed.force === true;
          locale = typeof parsed.locale === 'string' && parsed.locale ? parsed.locale : undefined;
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `bad body: ${String(err)}` }));
          return;
        }
        if (!board || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'board and text required' }));
          return;
        }
        if (!speakToBoard) {
          // Only reachable in the window between listen() and the voice wiring.
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'voice not initialized yet' }));
          return;
        }
        speakToBoard(board, text, { force, locale })
          .then(({ ok, detail }) => {
            res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ spoke: ok, board, detail }));
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `speak failed: ${String(err)}` }));
          });
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

  // Write daemon.json for client discovery (must be after successful bind).
  // Keep the original startedAt stable when the self-heal timer rewrites it.
  const daemonInfo = { port, pid: process.pid, startedAt: new Date().toISOString() };
  writeDaemonInfo(daemonInfo);

  // ===== BridgeCore =====
  const core = new BridgeCore({
    port,
    projectName: 'AgentDeck',
    httpServer,
    isDaemon: true,
  });
  subagentTimeline = new SubagentTimelineTracker((entry) => {
    core.bridgeTimeline.addEntry(entry, { bypassSuppression: true });
  });
  // Hooks resolve a fallback daemon port through daemon.json. Another process
  // can delete that file while this daemon remains healthy, which makes every
  // standalone Claude/Codex hook silently fall back to an empty :9120. Mirror
  // the Swift daemon's 10-second registry self-heal so timeline ingestion does
  // not stop merely because the discovery file disappeared.
  const daemonInfoHealTimer = setInterval(() => {
    if (ensureDaemonInfo(daemonInfo)) {
      debug('daemon', `Self-healed daemon.json for port ${port}`);
    }
  }, 10_000);
  daemonInfoHealTimer.unref?.();
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
  //
  // The daemon owns timeline persistence: every surface's entries flow through
  // it, so it is the only process positioned to hold the complete history and
  // the only one allowed to write the file. Reads still sweep every candidate
  // data dir (`latestTimelinePath`) so a Node daemon can pick up where a Swift
  // daemon left off, and vice versa — the two implementations share one
  // on-disk format.
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
    // Same for chat turns: a session killed mid-turn (no Stop / SessionEnd)
    // leaves its chat_start spinning "in progress" on every surface. Runs
    // DELAYED (5 min) so live sessions have posted a hook and registered in
    // `hookSessionsSeen` — only stale rows (30 min+) of sessions that stayed
    // silent since startup close; a live long-running turn is untouched and
    // its real Stop still lands normally.
    const chatReaperTimer = setTimeout(() => {
      const reapedTurns = core.bridgeTimeline.reapOrphanChatStarts(undefined, undefined, hookSessionsSeen);
      if (reapedTurns > 0) log(`[agentdeck] Closed ${reapedTurns} orphaned chat_start rows as interrupted`);
    }, 5 * 60_000);
    chatReaperTimer.unref?.();
  }
  // Enabled AFTER rehydration + reaping so the first write carries the restored
  // history instead of truncating the file to whatever this run has seen.
  core.bridgeTimeline.enablePersistence(getOwnTimelineFile());
  core.wireDisplayMonitor();
  let lastStateEvent: BridgeEvent | null = null;
  let userFocusedSessionId: string | null = null;
  /**
   * Stamp the focused session onto a hub `state_update`.
   *
   * This field carries two jobs, and both are load-bearing, which is why it
   * cannot simply be narrowed:
   *  - attribution: `buildStateEvent` sets no `sessionId` at all, so a
   *    hook-observed session's AWAITING_PERMISSION options reach the decks
   *    attributed only by this field (see session-deck-awaiting tests).
   *  - focus ack: the Apple app toggles creature focus against it and needs it
   *    even for a session that emits nothing of its own.
   *
   * The consequence is a standing invariant on the payload: whatever rides along
   * here is read as the focused session's own. So nothing may write a *different*
   * agent's per-session field into `core.stateMachine` — the Gateway's model went
   * in and came out as a Claude session's model. Gateway-specific state lives in
   * `gatewaySessionState` / `gatewayModelName` and is re-attached by
   * `gatewaySnapshot()`.
   */
  const attachFocusedSessionId = <T extends BridgeEvent>(event: T): T => {
    if ((event as any).type !== 'state_update') return event;
    return {
      ...(event as any),
      focusedSessionId: userFocusedSessionId ?? '',
    } as T;
  };

  /**
   * Stamp a *Gateway-specific* state event — one whose payload really is the
   * Gateway's (its parser events, its connection transitions), as opposed to the
   * hub broadcasts above that merely get labelled `openclaw` while the Gateway is
   * alive.
   *
   * These name their own row (`sessionId`), which is the honest attribution and
   * the reason a client never has to guess: an event carrying the Gateway's model
   * now says so. The focus ack rides only when the Gateway IS the focused row —
   * otherwise this event would claim to describe a Claude session, which is
   * precisely how `GLM-5.2 (1M)` became that session's model on both decks. The
   * ack still reaches the Apple app through every hub broadcast.
   */
  const attachGatewayEvent = <T extends BridgeEvent>(event: T): T => {
    if ((event as any).type !== 'state_update') return event;
    return {
      ...(event as any),
      sessionId: OPENCLAW_SESSION_ID,
      focusedSessionId: userFocusedSessionId === OPENCLAW_SESSION_ID ? OPENCLAW_SESSION_ID : '',
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
  // Remote (cross-machine) sessions aren't in sessions.json. Their only
  // reverse path is same-socket: drive the session down the live push socket
  // it opened — no inbound dial, so NAT'd / SSH-only workers just work.
  focusRelay.setSameSocketResolver((sessionId) => getRemoteSender(sessionId) ?? null);
  // Push-channel frames from session bridges (register / state / reverse events).
  const handlePushChannelMessage = createPushChannelHandler({ core, focusRelay });
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
      const hasClaudeData = u.fiveHourPercent != null || u.sevenDayPercent != null;
      if (core.cachedApiUsage && u.fiveHourPercent != null) {
        core.cachedApiUsage.fiveHourPercent = u.fiveHourPercent;
        core.cachedApiUsage.fiveHourResetsAt = u.fiveHourResetsAt ?? null;
        core.cachedApiUsage.sevenDayPercent = u.sevenDayPercent ?? core.cachedApiUsage.sevenDayPercent;
        core.cachedApiUsage.sevenDayResetsAt = u.sevenDayResetsAt ?? core.cachedApiUsage.sevenDayResetsAt ?? null;
        // Scoped caps ride the same relay snapshot. The Swift daemon syncs them on
        // its equivalent live-update path; leaving them out here made the daemon's
        // own next broadcastUsage re-emit a stale scoped set until the next full
        // fetch — the exact drift DaemonServer.swift documents.
        core.cachedApiUsage.scopedLimits = Array.isArray(u.scopedLimits) ? u.scopedLimits : [];
        core.apiUsagePreAdjusted = true;
      }
      // A session bridge broadcasts usage on EVERY state change. In daemon-first
      // mode its snapshot usually has no model context, so the Claude quota model
      // gate (isClaudeSubscriptionModel) yields no percents and the event carries
      // usageStale=true. Forwarding that bare event verbatim clobbered the daemon's
      // own authoritative aggregate on the dashboard: the Claude gauge blanked to
      // "No usage data" on every state tick (the Codex gauge, which ignores global
      // staleness, stayed put — hence the Claude-only flicker).
      //
      // Suppressing the relay instead is NOT an option: usage_update is the ONLY
      // carrier of per-session tokens / cost / duration (state_update has none of
      // those fields), and the daemon's own buildUsage() reads a UsageTracker that
      // no PTY ever feeds, so its session half is zeros. Dropping the event would
      // blank the session numbers for every focus that legitimately carries no
      // Claude quota — Codex, OpenCode, API billing.
      //
      // So split the event by half instead of by event: the ACCOUNT half (quota,
      // scoped caps, extra usage, subscriptions, Codex/Ollama, usageStale) comes
      // from the daemon's authoritative aggregate, the SESSION half from the relay.
      if (hasClaudeData) {
        core.wsServer.broadcast(evt);
      } else {
        core.wsServer.broadcast(mergeRelayedSessionUsage(core.buildUsage() as UsageEvent, u));
      }
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
    const androidDashboards = collectAndroidDashboards();
    if (androidDashboards.length > 0) {
      modules.androidDashboards = { available: true, devices: androidDashboards };
    }
    const streamDeckDevices = collectStreamDeckDevices();
    if (streamDeckDevices.length > 0) {
      modules.streamDeck = { available: true, devices: streamDeckDevices };
    }
    // WiFi-WS ESP32 boards. Same data as /devices `esp32-wifi` — without this
    // the dashboards (macOS/iOS/Android) never learn a WiFi-only board exists,
    // since they read moduleHealth off state_update, not /devices.
    const wifiEsp32 = listWifiEsp32Devices();
    if (wifiEsp32.length > 0) {
      modules.esp32Wifi = {
        available: true,
        devices: wifiEsp32.map((d) => ({
          board: d.board,
          ip: d.ip ?? null,
          version: d.version ?? null,
          stale: d.stale,
          serialActive: d.serialActive,
        })),
      };
    }
    const tuiClients = core.wsServer.getTuiClients();
    if (tuiClients.length > 0) {
      modules.tuiDashboards = {
        available: true,
        devices: tuiClients.map((c) => ({ id: c.id, name: c.name, kind: 'tui' })),
      };
    }
    const ulanziPluginConnected = core.wsServer.getUlanziClientCount() > 0;
    if (ulanziPluginConnected) {
      modules.d200h = {
        connected: true,
        driver: 'ulanzi-plugin',
      };
    }
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
      // held. Kept to 6 entries — the whole line must stay well under the
      // small (4KB) serial RX buffers on non-InkDeck boards; prepareForSerial
      // byte-caps each entry's raw/detail at send time.
      const recent = core.bridgeTimeline.getHistory().slice(-6);
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
  // OTel turn boundaries arrive in milliseconds where the observer only re-reads
  // the rollout tail every scan interval, so a span that changed thread state is
  // worth a broadcast of its own.
  codexOtel.onChanged = () => core.maybeBroadcastSessionsList();
  hookCodexSessions.onChanged = () => core.maybeBroadcastSessionsList();

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
    // Codex OTel spans overlay state/tool onto the matching ps-observed row and
    // synthesize a `codex-app` row for any thread the process scan missed —
    // Swift's only Codex-app source, here a second opinion on top of the
    // observer. See bridge/src/codex-otel.ts.
    const observed = applyAwaitingOverlayToObserved(
      hookCodexSessions.applyTo(codexOtel.applyTo(passiveSessionObserver.collect(sessions))),
    )
      .map((s) => {
        // Steering feedback for observed Claude sessions: devices render
        // "stopping at next tool" / queued-directive badges from these.
        if (!s.id.startsWith('observed:claude:')) return { ...s, liveAnswerable: false };
        // Can this daemon type into the session's live prompt? Only observed
        // Claude routes select_option to the injector, and only with a host to
        // aim at. Sent in both polarities — decks read it to decide whether an
        // AskUserQuestion option is a button or an inert mirror of the terminal.
        const liveAnswerable = Boolean(s.tty || s.appName);
        const snap = steeringSnapshot(s.id.slice('observed:claude:'.length));
        return {
          ...s,
          liveAnswerable,
          ...(snap.stopRequested ? { stopRequested: true } : {}),
          ...(snap.queuedDirectives > 0 ? { queuedDirectives: snap.queuedDirectives } : {}),
        };
      });
    // Sessions that attached from another machine over the push channel. They
    // aren't in this daemon's sessions.json, so inject them here (dedup against
    // any id already present from the local registry).
    const localIds = new Set(sessions.map((s) => s.id));
    const remote = listRemoteEnriched().filter((s) => !localIds.has(s.id));
    // Derive per-session elapsed seconds from startedAt so NTP-less devices
    // (ESP32 IPS10 mosaic) render an elapsed value per cell without a wall clock.
    const now = Date.now();
    const enrichedSessions = [...sessions, ...observed, ...remote].map((s) => {
      // On-demand review badge (REVIEW tile verdict / REVIEWING state) —
      // applies to every session type, managed included.
      const review = reviewSnapshot(s.id);
      const withReview = Object.keys(review).length > 0 ? { ...s, ...review } : s;
      if (withReview.elapsedSec != null || !withReview.startedAt) return withReview;
      const sec = Math.round((now - Date.parse(withReview.startedAt)) / 1000);
      return Number.isFinite(sec) && sec >= 0 ? { ...withReview, elapsedSec: sec } : withReview;
    });
    // SSOT: inject iff Gateway is authenticated (gatewayConnected). Reachability
    // / adapter-liveness alone must not materialize a session — that kept a
    // phantom OpenClaw alive on devices after it was effectively off. Shared
    // injector with bridge/src/index.ts; mirror of Swift buildSessionsListEvent.
    //
    // State/project/model come from Gateway-LOCAL trackers, never the global
    // `core.stateMachine` snapshot: the daemon hub feeds that same snapshot from
    // every observed Claude/opencode hook, so borrowing it here reported OpenClaw
    // as active whenever any unrelated session was mid-turn. `projectName` is
    // pinned to 'OpenClaw' (Swift parity) rather than the global machine's
    // last-seen project for the same reason.
    return injectOpenClawSession(enrichedSessions, {
      gatewayConnected: core.cachedGatewayConnected,
      state: gatewaySessionState,
      projectName: 'OpenClaw',
      modelName: gatewayModelName,
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
          // `model_info` is deliberately NOT forwarded: the global machine holds
          // one modelName for the whole hub, fed by every observed hook session,
          // and its broadcasts are stamped with the user's focused session — so a
          // model written here by the Gateway is read as that session's own
          // (GLM on a Claude row). It lives in `gatewayModelName` instead, and
          // `gatewaySnapshot()` puts it back on the Gateway's own events.
          if (evt.event !== 'model_info') core.stateMachine.handleParserEvent(evt.event, evt.data);
          // Gateway-local activity state for the virtual session row (mirror of
          // Swift `gatewaySessionState`). Kept separate from the global
          // `core.stateMachine` above so the OpenClaw row reflects only the
          // Gateway's own turn lifecycle, not unrelated observed sessions.
          if (evt.event === 'spinner_start') gatewaySessionState = 'processing';
          else if (evt.event === 'idle') gatewaySessionState = 'idle';
          else if (evt.event === 'permission_prompt') gatewaySessionState = 'awaiting_permission';
          // The OpenClaw adapter emits the real model via a model_info parser
          // event, but it only ever updated the display StateMachine — the APME
          // run was never told, so every openclaw run persisted model_id=NULL.
          if (evt.event === 'model_info') {
            const model = evt.data?.model as string | undefined;
            if (model) {
              gatewayModelName = model;
              if (apme && openclawApmeSessionId) apme.collector.updateModel(openclawApmeSessionId, model);
            }
          }
          break;
        case 'metadata':
          if (evt.event === 'model_catalog') {
            const models = evt.data?.models as ModelCatalogEntry[] | undefined;
            if (models) {
              core.cachedModelCatalog = models;
              const snap = core.stateMachine.getSnapshot();
              const stateEvent = attachGatewayEvent(core.buildStateEvent({
                agentType: 'openclaw',
                agentCapabilities: OPENCLAW_CAPABILITIES,
                snapshot: gatewaySnapshot(snap),
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
            gatewaySessionState = 'idle';
            bridgeLogStream.start();
            log('[agentdeck] OpenClaw Gateway connected');
            if (core.stateMachine.getSnapshot().state === 'disconnected') {
              core.stateMachine.handleHookEvent('SessionStart', {});
            }
            // Force full state broadcast
            const snap = core.stateMachine.getSnapshot();
            const gwStateEvent = attachGatewayEvent(core.buildStateEvent({
              agentType: 'openclaw',
              agentCapabilities: OPENCLAW_CAPABILITIES,
              snapshot: gatewaySnapshot(snap),
            }));
            lastStateEvent = gwStateEvent;
            core.wsServer.broadcast(gwStateEvent);
            core.broadcastUsage();
            core.broadcastSessionsList().catch(() => {});
          } else {
            core.cachedGatewayConnected = false;
            core.cachedGatewayAuthStatus = 'gateway_not_found';
            // Reset activity to idle; gatewayModelName is preserved across brief
            // disconnects (Swift parity) so a flap doesn't blank the model chip.
            gatewaySessionState = 'idle';
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
    gatewaySessionState = 'idle';
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
    voiceManager.probeSpeechHelper().catch((err) => {
      debug('daemon', `speech helper probe failed: ${err}`);
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
      // Remember what this socket said about itself BEFORE registration, which
      // is deliberately skipped when the same board is also live on USB serial
      // (single-path dedup). Anything keyed off the WiFi registry would then see
      // a board with no board string and no capabilities — that is what made a
      // dictation from a USB-attached board fail to arm its spoken reply.
      const selfBoard = typeof msg.board === 'string' ? msg.board : '';
      if (selfBoard) wsSelfBoard.set(sender, selfBoard);
      if (Array.isArray((msg as { capabilities?: unknown }).capabilities)) {
        wsSelfCaps.set(sender, (msg as { capabilities: unknown[] })
          .capabilities.filter((c): c is string => typeof c === 'string'));
      }
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
    if (msg.type === 'client_register'
        && (msg as { clientType?: unknown }).clientType === 'android-dashboard') {
      // Android dashboard app volunteering its identity (tablet / e-ink
      // launcher on Wi-Fi) so the topology can show an Android row even when
      // the device is not ADB-bridged; drops on socket close.
      const devices = Array.isArray((msg as { devices?: unknown }).devices)
        ? (msg as { devices: unknown[] }).devices : [];
      androidDashboardRegistrations.set(sender, { devices, updatedAt: Date.now() });
      debug('daemon', `client_register android-dashboard devices=${devices.length}`);
      if (lastStateEvent && (lastStateEvent as { type?: string }).type === 'state_update') {
        (lastStateEvent as unknown as Record<string, unknown>).moduleHealth = moduleHealthProvider();
        core.wsServer.broadcast(lastStateEvent);
      }
      return true;
    }
    if (msg.type === 'client_register'
        && (msg as { clientType?: unknown }).clientType === 'streamdeck-plugin') {
      // Elgato plugin volunteering the physical Stream Decks it drives — the
      // topology's Stream Deck rows. Swift-daemon parity; drops on socket close.
      const devices = Array.isArray((msg as { devices?: unknown }).devices)
        ? (msg as { devices: unknown[] }).devices : [];
      streamDeckRegistrations.set(sender, { devices, updatedAt: Date.now() });
      debug('daemon', `client_register streamdeck-plugin devices=${devices.length}`);
      if (lastStateEvent && (lastStateEvent as { type?: string }).type === 'state_update') {
        (lastStateEvent as unknown as Record<string, unknown>).moduleHealth = moduleHealthProvider();
        core.wsServer.broadcast(lastStateEvent);
      }
      return true;
    }
    if (handleEsp32OtaReply(msg)) {
      return true;
    }
    // Push-channel frames (session_push_register / session_push_state /
    // session_event_up) — extracted handler, integration-tested directly.
    if (handlePushChannelMessage(msg, sender)) {
      return true;
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
    if (msg.type === 'voice_begin') {
      deviceVoice.begin(sender, msg);
      return true; // consumed
    }
    if (msg.type === 'voice_end') {
      const captured = deviceVoice.end(sender, msg);
      if (captured) {
        void finishVoiceCapture(captured, stableSink(sender));
      } else if ((msg as { cancel?: unknown }).cancel !== true) {
        // Nothing was captured but the user did hold the button — answer
        // anyway, or the board's "Sending…" state has nothing to resolve it.
        try {
          sender.send(JSON.stringify({ type: 'voice_result', text: '', error: 'empty_capture' }));
        } catch { /* client disconnecting */ }
      }
      return true; // consumed
    }
    if (msg.type === 'voice_abort') {
      // The board tried to upload an utterance over HTTP and failed; the
      // reason would otherwise only exist on its serial console.
      log(`[agentdeck] voice: device upload aborted (${String((msg as { reason?: unknown }).reason ?? 'unknown')}, `
        + `${String((msg as { total?: unknown }).total ?? '?')} bytes)`);
      return true; // consumed
    }
    if (msg.type === 'photo_begin') {
      devicePhoto.begin(sender, msg);
      return true; // consumed
    }
    if (msg.type === 'photo_end') {
      const captured = devicePhoto.end(sender, msg);
      if (captured) {
        void finishPhotoCapture(captured, stableSink(sender));
      } else if ((msg as { cancel?: unknown }).cancel !== true) {
        // Unlike PCM, a JPEG that lost frames is undecodable — tell the board
        // instead of silently eating the shutter press.
        try {
          sender.send(JSON.stringify({ type: 'photo_result', delivered: false, error: 'empty_or_corrupt_capture' }));
        } catch { /* client disconnecting */ }
      }
      return true; // consumed
    }
    if (msg.type === 'query_session_timeline') {
      // Reply to THIS requester only with the session's recent timeline so a
      // device that connected mid-session can fill its Detail view on demand
      // (the live timeline_event stream is forward-only). Useful for any
      // reconnecting surface, not just the XTeink X3.
      const sessionId = resolveDeviceSessionId((msg as { sessionId?: unknown }).sessionId);
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

  // Device clients with narrow id buffers (ESP32 SessionInfo.id[32]) echo back
  // session ids truncated by prepareForSerial's 31-char cap. Observed ids
  // (`observed:claude:<uuid>`, 52 chars) always exceed that, so an exact-match
  // lookup silently dropped their commands — worse, the observed-steering
  // branch queued state under a truncated uuid no hook ever reads. Restore the
  // full id by unique-prefix match against the known roster before routing.
  function resolveDeviceSessionId(raw: unknown): string {
    if (typeof raw !== 'string' || !raw) return '';
    const known: string[] = ['openclaw-gateway'];
    for (const s of listActiveSessions()) known.push(s.id);
    const last = core.getLastSessionsListEvent() as { sessions?: Array<{ id?: unknown }> } | null;
    if (Array.isArray(last?.sessions)) {
      for (const s of last.sessions) if (typeof s?.id === 'string') known.push(s.id);
    }
    return resolveSessionIdPrefix(raw, known);
  }

  // Steering commands for observed (hook-only, no PTY) Claude sessions —
  // shared by the session_command route and the bare-command fallback below.
  // Semantics differ from managed PTY on purpose:
  //   interrupt/escape → soft STOP (deny at the next tool call)
  //   send_prompt      → queued, delivered when the current turn ends
  //   respond/select_option → resolve an open device-approval gate
  function handleObservedClaudeCommand(uuid: string, command: Record<string, unknown>): void {
    const type = typeof command?.type === 'string' ? command.type : '';
    if (type === 'interrupt' || type === 'escape') {
      requestStop(uuid);
      core.broadcastSessionsList().catch(() => {});
      return;
    }
    if (type === 'send_prompt' && typeof command.text === 'string') {
      if (queueDirective(uuid, command.text)) core.broadcastSessionsList().catch(() => {});
      return;
    }
    if (type === 'respond' || type === 'select_option') {
      const ov = getAwaitingOverlay(uuid);
      if (ov?.requestId) {
        const allow = type === 'select_option'
          ? command.index === 0
          : command.value === 'y' || command.value === 'yes';
        resolvePending(ov.requestId, allow ? 'allow' : 'deny');
        return;
      }
      // No held gate — a live TUI prompt (AskUserQuestion / selector) is on
      // the user's screen. Type the selection into the terminal itself
      // (tmux/iTerm2 by tty) — no hold, no timeout, no auto-proceed: if the
      // terminal isn't reachable the prompt simply stays for the user.
      if (type === 'select_option' && typeof command.index === 'number') {
        const idx = command.index as number;
        const obs = passiveSessionObserver.collect([])
          .find((s) => s.id === `observed:claude:${uuid}`) as
            { tty?: string; appName?: string } | undefined;
        // The option's visible label lets app-hosted prompts press the matching
        // native button instead of guessing cursor movement.
        const label = ov?.options?.[idx]?.label;
        injectObservedSelection(
          { tty: obs?.tty, appName: obs?.appName, label }, idx,
        ).then((r) => {
          debug('daemon', r.ok
            ? `observed selection injected via ${r.via} (idx ${idx}, ${uuid.slice(0, 8)})`
            : `observed selection NOT injected: ${r.reason} (${uuid.slice(0, 8)})`);
        }).catch(() => {});
      }
      return;
    }
    debug('daemon', `observed steering: unsupported command ${type} for ${uuid}`);
  }

  const handleDeviceCommand = (cmd: PluginCommand): void => {
    debug('daemon', `cmd: ${cmd.type}`);
    // Host push-to-talk is the daemon's own capability (host mic + speakers),
    // so claim it ahead of the gateway-first-dibs routing below — it must not
    // depend on what any adapter chooses to do with the legacy `voice` shape.
    if (cmd.type === 'voice') {
      handleHostVoicePtt(cmd);
      return;
    }
    // Session-scoped commands are NEVER OpenClaw's to consume: a device
    // answering a named session (select_option{sessionId}) must reach the
    // session routing below — the gateway swallowing it as an exec-approval
    // ate the Focus Strip's tap-to-approve.
    const sessionScopedCmd = typeof (cmd as any).sessionId === 'string'
      && (cmd as any).sessionId
      && (cmd as any).sessionId !== 'openclaw-gateway';
    if (!sessionScopedCmd && gatewayAdapter?.isAlive() && gatewayAdapter.handleCommand(cmd)) {
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
        const gwStateEvent = attachGatewayEvent(core.buildStateEvent({
          agentType: 'openclaw',
          agentCapabilities: OPENCLAW_CAPABILITIES,
          snapshot: gatewaySnapshot(snap),
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
      const sessionId = resolveDeviceSessionId((cmd as any).sessionId);
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
    // Independent on-demand review (REVIEW deck button): judge the session's
    // working-tree delta with an independent model. Valid for every session
    // type — no agent control involved. Result: WS events + badge fields +
    // HTML report opened in the browser (this daemon's "popup" tier).
    if (cmd.type === 'review_run') {
      const sessionId = resolveDeviceSessionId((cmd as any).sessionId);
      if (!sessionId) return;
      const managed = listActiveSessions().find(s => s.id === sessionId);
      const observed = managed ? undefined
        : passiveSessionObserver.collect([]).find(s => s.id === sessionId);
      const target = (managed ?? observed) as (Record<string, unknown> & { projectName?: string }) | undefined;
      // cwd sources: observed rows carry it from the process scan; managed
      // registry rows don't — fall back to the session's APME run projectPath.
      const cwd = (typeof target?.cwd === 'string' && target.cwd) ? target.cwd as string
        : (apme ? (() => {
          const runId = apme.collector.getRunId(sessionId);
          return runId ? apme.store.getRun(runId)?.projectPath ?? undefined : undefined;
        })() : undefined);
      // Recent request↔response lines so the judge evaluates the diff
      // against what the user actually asked (not just code in isolation).
      const recentActivity = core.bridgeTimeline.getHistoryForSession(sessionId, undefined, 16)
        .filter((e) => e.type === 'chat_start' || e.type === 'chat_response')
        .map((e) => `${e.type === 'chat_start' ? 'USER' : 'AGENT'}: ${e.raw}`)
        .join('\n');
      void runSessionReview({
        sessionId,
        cwd,
        projectName: target?.projectName ?? cwd?.split('/').filter(Boolean).pop() ?? 'unknown',
        recentActivity,
        onEvent: (event) => {
          core.wsServer.broadcast(event as any);
          core.broadcastSessionsList().catch(() => {}); // badge refresh
        },
        recordEval: apme ? (record) => {
          // Record into the same eval store as the automatic pipeline,
          // flagged `manual_review`, on the session's active task (if any).
          const runId = apme.collector.getRunId(sessionId);
          const taskId = apme.collector.getActiveTaskId(sessionId);
          if (!runId || !taskId) return;
          apme.store.insertEvalForTask({
            runId, taskId, layer: 'manual_review', metric: 'risk',
            score: record.score, raw: record.raw,
            judgeModel: record.judgeModel, createdAt: Date.now(),
          });
        } : undefined,
      });
      core.broadcastSessionsList().catch(() => {}); // REVIEWING tile
      return;
    }
    // Device approval for a gated PreToolUse permission request (observed session).
    // Resolves the held hook HTTP response → Claude allows/denies the tool.
    if (cmd.type === 'permission_decision') {
      const { requestId, decision } = cmd as any;
      if (typeof requestId !== 'string' || (decision !== 'allow' && decision !== 'deny')) return;
      // OpenCode permission (requestId = "ocperm:<rawSid>:<permissionID>"):
      // route through the observer-plugin queue; the plugin resolves it via
      // POST /session/{id}/permissions/{permissionID}.
      if (requestId.startsWith('ocperm:')) {
        const rest = requestId.slice('ocperm:'.length);
        const sep = rest.indexOf(':');
        if (sep > 0) {
          enqueueOpenCodeCommand(rest.slice(0, sep), {
            type: 'permission_respond', permissionId: rest.slice(sep + 1), response: decision,
          });
        }
        return;
      }
      // resolvePending → onResolved clears the overlay + rebroadcasts (sessions_list
      // + focused state), so all surfaces drop the gate. No-op if already resolved.
      resolvePending(requestId, decision);
      return;
    }
    // Session-scoped command: forward inner command to a specific session's bridge
    if (cmd.type === 'session_command') {
      const { sessionId: rawSessionId, command } = cmd as any;
      if (!rawSessionId || !command) return;
      const sessionId = resolveDeviceSessionId(rawSessionId);
      // The gateway session has no bridge port — the focus-relay path below
      // would connect to nothing and silently drop the command. Hand it to
      // the adapter, the same way the wake-word assistant does.
      if (sessionId === 'openclaw-gateway') {
        if (gatewayAdapter?.isAlive()) gatewayAdapter.handleCommand(command);
        else debug('daemon', 'session_command for openclaw-gateway but gateway not alive');
        return;
      }
      // Observed Claude sessions have no bridge/PTY — route to the hook-based
      // steering primitives instead (soft STOP, turn-end directive queue,
      // gate approval). This replaces the old silent drop.
      if (typeof sessionId === 'string' && sessionId.startsWith('observed:claude:')) {
        handleObservedClaudeCommand(sessionId.slice('observed:claude:'.length), command);
        return;
      }
      // Observed OpenCode sessions steer directly through the observer
      // plugin's command queue (immediate abort / prompt injection).
      if (typeof sessionId === 'string' && (sessionId.startsWith('opencode:') || sessionId.startsWith('observed:opencode:'))) {
        const rawSid = sessionId.replace(/^(?:observed:)?opencode:/, '');
        const type = typeof command?.type === 'string' ? command.type : '';
        if (type === 'interrupt' || type === 'escape') {
          enqueueOpenCodeCommand(rawSid, { type: 'interrupt' });
        } else if (type === 'send_prompt' && typeof command.text === 'string') {
          enqueueOpenCodeCommand(rawSid, { type: 'send_prompt', text: command.text });
        }
        return;
      }
      const sessions = listActiveSessions();
      const target = sessions.find(s => s.id === sessionId) ?? getRemoteSession(sessionId);
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
      const sessionId = resolveDeviceSessionId((cmd as any).sessionId);
      // Session-scoped answering of an OBSERVED session's gate — the same
      // steering primitive the session_command route uses. Without this, a
      // device answering an observed awaiting cell fell through to the
      // focused-session relay and was dropped.
      if (sessionId.startsWith('observed:claude:')) {
        handleObservedClaudeCommand(sessionId.slice('observed:claude:'.length), cmd as any);
        return;
      }
      const target = listActiveSessions().find(s => s.id === sessionId) ?? getRemoteSession(sessionId);
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
    // Bare-command fallback for an observed-focused session: older device
    // clients send unwrapped commands after focus_session. The focus relay
    // can't route them (no bridge), so map them to the steering primitives
    // instead of dropping them silently.
    if (
      userFocusedSessionId?.startsWith('observed:claude:')
      && ['interrupt', 'escape', 'send_prompt', 'respond', 'select_option'].includes(cmd.type)
    ) {
      handleObservedClaudeCommand(
        userFocusedSessionId.slice('observed:claude:'.length),
        cmd as unknown as Record<string, unknown>,
      );
      return;
    }
    // Peripheral primitive from a sensor-bearing board (t_embed NFC etc.):
    // log + relay to dashboard clients. Boards never receive it back
    // (peripheral_event is not serial-forwardable), and command mapping
    // (tag → focus/approve) comes later as daemon-side config.
    if ((cmd.type as string) === 'peripheral_event') {
      const p = cmd as any;
      const label = p.uid ?? p.code ?? '';
      debug('daemon', `peripheral_event: ${p.kind} ${label} (${p.board ?? 'esp32'})`);
      core.wsServer.broadcast(cmd as any);
      // Meaning is user configuration, never firmware policy: a mapped tag /
      // code becomes one of the steering commands the daemon already speaks.
      try {
        const mappings = parsePeripheralMappings(loadDaemonSettings());
        if (mappings.length > 0) {
          const roster = (core.getLastSessionsListEvent() as
            { sessions?: Array<Record<string, unknown>> } | null)?.sessions ?? [];
          const view = roster.map((r) => ({
            id: String(r.id ?? ''),
            projectName: typeof r.projectName === 'string' ? r.projectName : undefined,
            state: typeof r.state === 'string' ? r.state : undefined,
            requestId: typeof r.requestId === 'string' ? r.requestId : undefined,
          })).filter((r) => r.id);
          const resolved = resolvePeripheralAction(
            { kind: String(p.kind ?? ''), uid: p.uid, code: p.code }, mappings, view);
          if (!resolved) {
            debug('daemon', `peripheral_event: no mapping for ${label} (add one in settings.json peripheralMappings)`);
          } else {
            const mapped = commandForAction(resolved);
            if (mapped) {
              debug('daemon', `peripheral_event ${label} → ${resolved.action} on ${resolved.session.id.slice(0, 20)}`);
              handleDeviceCommand(mapped as unknown as PluginCommand);
            }
          }
        }
      } catch (err) {
        debug('daemon', `peripheral mapping failed: ${String(err).slice(0, 120)}`);
      }
      return;
    }
    if (cmd.type === 'query_usage') {
      fetchUsageRelayed(port).then((usage) => {
        if (usage) core.updateApiUsage(usage);
        else if (core.cachedApiUsage) core.apiUsageStale = true;
      });
    }
  };
  // ── Device-sourced voice ──────────────────────────────────────────────
  // A board streams PCM16 while its push-to-talk key is held; the daemon
  // transcribes with Apple's on-device recognizer (bundled Swift helper) and
  // turns the text into a prompt for the session the board was pointing at.
  const deviceVoice = new DeviceVoiceCollector();
  // A board sends a one-shot JPEG after its shutter press; the daemon saves it
  // and routes a prompt referencing the file path to the target session.
  const devicePhoto = new DevicePhotoCollector();
  /**
   * Reply router. The resolver lets a queued reply reach a board over whatever
   * transport is live *now*: a board plugged in over USB parks its radio and
   * drops the WebSocket it dictated over, and the answer must still arrive.
   * Serial first, mirroring the single-path dedup policy used elsewhere.
   */
  /**
   * Replies staged for `audio_http_pull` boards, keyed by device (board id) —
   * the board fetches via GET /esp32/voice-reply at its own pace. Swept by
   * TTL: a board that reboots before fetching must not hear a stale answer
   * minutes later.
   */
  const stagedVoiceReplies = new Map<string, { pcm: Buffer; sampleRate: number; ts: number }>();
  const STAGED_REPLY_TTL_MS = 2 * 60_000;
  const stagedReplySweep = setInterval(() => {
    const cutoff = Date.now() - STAGED_REPLY_TTL_MS;
    for (const [key, entry] of stagedVoiceReplies) {
      if (entry.ts < cutoff) stagedVoiceReplies.delete(key);
    }
  }, 30_000);
  stagedReplySweep.unref?.();

  const voiceReply = new DeviceVoiceReplyRouter(
    () => Date.now(),
    (ms) => new Promise((r) => setTimeout(r, ms)),
    (deviceKey) => {
      // This resolver serves the spoken-reply router only, so unlike the
      // general serial-first dedup it prefers whichever live transport can
      // actually PLAY audio (advertises audio_out): a CH340 serial link
      // physically cannot carry PCM even when it is the primary state path.
      const candidates: ReplySink[] = [];
      const serialPort = liveSerialPortForBoard(deviceKey);
      if (serialPort) candidates.push(serialSinkFor(serialPort));
      for (const [key, sock] of wifiEsp32Sockets) {
        if (sock.readyState !== WebSocket.OPEN) continue;
        const board = wifiEsp32Devices.get(key)?.board;
        if (board === deviceKey || key === deviceKey) candidates.push(stableSink(sock));
      }
      const pick = candidates.find((s) => {
        const caps = s.capabilities();
        return caps.includes('audio_out') || caps.includes('audio_http_pull');
      }) ?? candidates[0];
      if (pick) {
        log(`[agentdeck] voice: routing reply for ${deviceKey} via ${pick.describe()}`
          + ` (caps=${pick.capabilities().join('|') || 'none'})`);
        return pick;
      }
      log(`[agentdeck] voice: no live transport for ${deviceKey}`
        + ` (serial boards: ${serialBoardsAttached().join(',') || 'none'})`);
      return null;
    },
  );

  /**
   * Wrap a board's socket as a reply sink. Capabilities come from the device
   * registry rather than being assumed: only a board that advertised
   * `audio_out` gets audio, so the same voice path degrades to text-only on
   * boards without an amplifier instead of streaming into nothing.
   */
  const replySinkFor = (ws: WebSocket): ReplySink => ({
    send: (data) => { try { ws.send(data); } catch { /* closing */ } },
    sendBinary: (data) => { try { ws.send(data, { binary: true }); } catch { /* closing */ } },
    isOpen: () => ws.readyState === WebSocket.OPEN,
    describe: () => 'ws',
    deviceKey: () => {
      const self = wsSelfBoard.get(ws);
      if (self) return self;
      for (const [key, registered] of wifiEsp32Sockets) {
        if (registered !== ws) continue;
        return wifiEsp32Devices.get(key)?.board ?? key;
      }
      return 'ws';
    },
    capabilities: () => {
      const self = wsSelfCaps.get(ws);
      if (self) return self;
      for (const [key, registered] of wifiEsp32Sockets) {
        if (registered !== ws) continue;
        return wifiEsp32Devices.get(key)?.capabilities ?? [];
      }
      return [];
    },
  });

  /**
   * The other half of the voice round trip. A dictated prompt arms the board
   * that sent it; when that session's turn completes, the reply is synthesized
   * on the host and streamed to the board's amplifier. `chat_response` is the
   * one chokepoint every agent's completion reaches — managed sessions relay it
   * from their bridge, hook-observed ones get it from the Stop handler above —
   * so one listener covers all of them.
   */
  /** Speak `text` to every board waiting on `sessionId`, or tell them there was
   *  nothing to read. Shared by both completion shapes below. */
  const speakReplyTo = (sessionId: string, text: string): void => {
    const targets = voiceReply.targetsFor(sessionId);
    if (targets.length === 0) return;
    log(`[agentdeck] voice: reply ready for ${sessionId.slice(0, 32)}`
      + ` -> ${targets.length} board(s)`);
    const voiceCfg = loadDaemonSettings().voice as
      { locale?: unknown; speakReplies?: unknown; speakFullReply?: unknown } | undefined;
    if (voiceCfg?.speakReplies === false) return;  // opt-out, default on
    // Speech gets the lead, not the transcript: an explicit summary line if the
    // answer has one, else its first sentence. The full answer is already on the
    // screen the user is sitting at, where it can be skimmed — read aloud it is
    // a minute of monologue nobody can skip. `voice.speakFullReply` opts back in.
    const full = voiceCfg?.speakFullReply === true;
    const spoken = spokenDigest(text, { full });
    if (!full) {
      const readable = speakableReply(text, Number.MAX_SAFE_INTEGER);
      if (spoken && readable.length > spoken.length) {
        log(`[agentdeck] voice: reply digested ${readable.length} -> ${spoken.length} chars`);
      }
    }
    if (!spoken) {
      // A code-only answer has nothing worth reading aloud; say that instead of
      // spelling out punctuation, so the user still knows the turn finished.
      log('[agentdeck] voice: reply held nothing speakable — skipped');
      for (const sink of targets) {
        try { sink.send(JSON.stringify({ type: 'voice_reply_skipped' })); } catch { /* closing */ }
        // Consume the arming either way: the dictation was answered, and
        // leaving it armed would read out the session's *next* turn instead.
        voiceReply.disarm(sink);
      }
      return;
    }
    const locale = typeof voiceCfg?.locale === 'string' && voiceCfg.locale
      ? voiceCfg.locale : undefined;
    // Host-armed dictations (deck push-to-talk) play through the host's own
    // speakers — AVSpeechSynthesizer speaks directly, no WAV/PCM streaming
    // detour. Split them out before synthesis so a host-only reply skips the
    // file round trip entirely.
    const hostTargets = targets.filter((s) => s.capabilities().includes('audio_host'));
    const boardTargets = targets.filter((s) => !s.capabilities().includes('audio_host'));
    if (hostTargets.length > 0) {
      for (const sink of hostTargets) voiceReply.disarm(sink);
      void (async () => {
        try {
          await speakWithHelper(spoken, locale ? { locale } : {});
          log(`[agentdeck] voice: spoke reply on host speakers (${spoken.length} chars)`);
        } catch (err) {
          log(`[agentdeck] voice: host speak failed: ${String(err).slice(0, 140)}`);
        }
      })();
    }
    if (boardTargets.length === 0) return;
    void (async () => {
      const out = join(tmpdir(), `agentdeck-reply-${process.pid}-${Date.now()}.wav`);
      try {
        await synthesizeWavWithHelper(spoken, out, locale ? { locale } : {});
        const wav = await readFile(out);
        for (const sink of boardTargets) {
          // Pull-capable boards fetch the audio themselves over HTTP — the WS
          // push stream both stuttered and could crash the hosted-link RX
          // path (pkt_rxbuff assert). Stage the PCM, send a tiny notify
          // frame, and let TCP flow control pace the transfer.
          if (sink.capabilities().includes('audio_http_pull')) {
            const parsed = pcmFromWav(wav);
            if (parsed) {
              stagedVoiceReplies.set(sink.deviceKey(), {
                pcm: parsed.pcm, sampleRate: parsed.sampleRate, ts: Date.now(),
              });
              try {
                sink.send(JSON.stringify({
                  type: 'audio_reply_ready',
                  bytes: parsed.pcm.length,
                  sampleRate: parsed.sampleRate,
                  durationMs: Math.round((parsed.pcm.length / 2) / parsed.sampleRate * 1000),
                  text: spoken.slice(0, 120),
                }));
                log(`[agentdeck] voice: staged reply for ${sink.deviceKey()}`
                  + ` (${parsed.pcm.length}B pull, ${spoken.length} chars)`);
              } catch { /* sink closing — TTL sweep reclaims the staging */ }
              voiceReply.disarm(sink);
              continue;
            }
          }
          const ok = await voiceReply.stream(sink, wav, spoken);
          log(`[agentdeck] voice: ${ok ? 'spoke' : 'FAILED to speak'} reply`
            + ` (${wav.length}B, ${spoken.length} chars)`);
        }
      } catch (err) {
        log(`[agentdeck] voice: reply synthesis failed: ${String(err).slice(0, 140)}`);
      } finally {
        await rm(out, { force: true }).catch(() => {});
      }
    })();
  };

  /**
   * Turn completion for an armed session. Two shapes reach here:
   *
   * `chat_response` carries the text and speaks immediately. `chat_end` means
   * the turn closed with nothing extractable — which routinely happens because
   * the agent's own record hadn't flushed when the Stop hook fired, not because
   * the turn was silent. (Measured: a Codex turn closed as "Completed · 5s" and
   * its rollout held the full answer seconds later.) So a chat_end retries from
   * that record before giving up, and only then tells the board there was
   * nothing to read.
   */
  const REPLY_RECOVER_DELAY_MS = 2500;
  core.bridgeTimeline.onEntry((entry, upsert) => {
    // Upserts re-fire for rows that already spoke; only a new row is a new turn.
    if (upsert || !entry.sessionId) return;
    if (entry.type !== 'chat_response' && entry.type !== 'chat_end') return;
    const sessionId = String(entry.sessionId);
    if (voiceReply.targetsFor(sessionId).length === 0) {
      // Only noisy while something is actually waiting — and this is exactly the
      // case that used to fail silently: a completion row arrived, nothing
      // matched it, and there was no way to tell a lost arming from a listener
      // that never ran.
      if (voiceReply.armedCount() > 0) {
        log(`[agentdeck] voice: ${entry.type} for ${sessionId.slice(0, 32)} matched no`
          + ` arming (armed: ${voiceReply.describeArmed()})`);
      }
      return;
    }

    if (entry.type === 'chat_response') {
      const detail = typeof entry.detail === 'string' ? entry.detail : '';
      speakReplyTo(sessionId, detail || String(entry.raw ?? ''));
      return;
    }
    const agentType = String(entry.agentType ?? '');
    setTimeout(() => {
      if (voiceReply.targetsFor(sessionId).length === 0) return;
      const recovered = agentType.startsWith('codex')
        ? lastAgentMessageFromCodexRollout(rawSessionId(sessionId))
        : lastAssistantTextForSession(sessionId);
      log(`[agentdeck] voice: chat_end recovery for ${sessionId.slice(0, 32)}`
        + ` (${agentType || 'unknown'}): ${recovered ? `${recovered.length} chars` : 'nothing'}`);
      speakReplyTo(sessionId, recovered || '');
    }, REPLY_RECOVER_DELAY_MS).unref?.();
  });

  const sinkByWs = new Map<WebSocket, ReplySink>();
  const stableSink = (ws: WebSocket): ReplySink => {
    // The router keys arming by sink identity, so the same socket must map to
    // the same object every time — a fresh wrapper per call would arm one
    // object and look up another.
    let sink = sinkByWs.get(ws);
    if (!sink) { sink = replySinkFor(ws); sinkByWs.set(ws, sink); }
    return sink;
  };

  // Serial-attached boards get the same sink shape. Audio rides base64 inside
  // JSON lines because this transport is line-delimited and raw PCM would tear
  // the framing; the encoding cost is invisible on native-USB CDC.
  const serialSinks = new Map<string, ReplySink>();
  const serialSinkFor = (port: string): ReplySink => {
    let sink = serialSinks.get(port);
    if (sink) return sink;
    sink = {
      send: (data) => { sendSerialJson(port, data); },
      sendBinary: (data) => {
        sendSerialJson(port, { type: 'audio_play_chunk', d: data.toString('base64') });
      },
      isOpen: () => serialPortConnected(port),
      describe: () => `serial:${port.replace('/dev/cu.', '')}`,
      deviceKey: () => serialPortBoard(port) ?? port,
      capabilities: () => serialPortCapabilities(port),
    };
    serialSinks.set(port, sink);
    return sink;
  };

  /**
   * Back the `POST /voice/speak` bench test now that both sink flavours exist.
   * Same transport policy as the reply router — serial first, WiFi second — so
   * what this proves is what the real reply path will do.
   */
  speakToBoard = async (board, text, opts) => {
    const spoken = speakableReply(text);
    if (!spoken) return { ok: false, detail: 'nothing speakable in text' };

    const serialPort = liveSerialPortForBoard(board);
    let sink: ReplySink | null = serialPort ? serialSinkFor(serialPort) : null;
    if (!sink) {
      for (const [key, sock] of wifiEsp32Sockets) {
        if (sock.readyState !== WebSocket.OPEN) continue;
        if (wifiEsp32Devices.get(key)?.board === board || key === board) {
          sink = stableSink(sock);
          break;
        }
      }
    }
    if (!sink) {
      const wifi = [...wifiEsp32Devices.values()].map((d) => d.board).filter(Boolean);
      return {
        ok: false,
        detail: `no live transport for "${board}"`
          + ` (serial: ${serialBoardsAttached().join(',') || 'none'};`
          + ` wifi: ${wifi.join(',') || 'none'})`,
      };
    }

    // A board that never initialized its amplifier drops the frames on the
    // floor, which is indistinguishable from a wiring fault at the listening
    // end. Say so instead, and let --force stream anyway when the question is
    // whether the advertisement itself is wrong.
    const caps = sink.capabilities();
    if (!caps.includes('audio_out') && !opts.force) {
      return {
        ok: false,
        detail: `${sink.describe()} does not advertise audio_out`
          + ` (capabilities: ${caps.join(',') || 'none'}) — pass force to stream anyway`,
      };
    }

    const voiceCfg = loadDaemonSettings().voice as { locale?: unknown } | undefined;
    const locale = opts.locale
      ?? (typeof voiceCfg?.locale === 'string' && voiceCfg.locale ? voiceCfg.locale : undefined);
    const out = join(tmpdir(), `agentdeck-speak-${process.pid}-${Date.now()}.wav`);
    try {
      await synthesizeWavWithHelper(spoken, out, locale ? { locale } : {});
      const wav = await readFile(out);
      // Note: stream() consumes any arming held by this sink, so a bench test
      // run while a board is genuinely waiting on a reply eats that reply.
      const ok = await voiceReply.stream(sink, wav, spoken);
      log(`[agentdeck] voice: bench ${ok ? 'spoke' : 'FAILED to speak'} on ${sink.describe()}`
        + ` (${wav.length}B, ${spoken.length} chars)`);
      return {
        ok,
        detail: ok
          ? `${sink.describe()} · ${wav.length}B · ${spoken.length} chars`
          : `stream rejected by ${sink.describe()} (transport closed or already speaking)`,
      };
    } finally {
      await rm(out, { force: true }).catch(() => {});
    }
  };

  // Voice from a USB-attached board. Without this the mic worked only while the
  // board was on WiFi — and attaching USB parks WiFi, so plugging in to charge
  // silently removed the feature.
  // Half-duplex guard: hold daemon→board serial writes while that port has an
  // open photo capture (see flushNextWrite — full-duplex CDC drops blocks).
  setSerialQuiesceCheck((port) => devicePhoto.isOpen(port));

  /**
   * Where a photo_result goes for an HTTP-uploaded photo: the request carries
   * no socket to answer on, so resolve the board's live transport the same
   * way a queued voice reply does (serial first, then its WiFi socket).
   */
  const boardResultSinkFor = (board: string): ReplySink => {
    const port = liveSerialPortForBoard(board);
    if (port) return serialSinkFor(port);
    for (const [key, sock] of wifiEsp32Sockets) {
      if (sock.readyState !== WebSocket.OPEN) continue;
      if (wifiEsp32Devices.get(key)?.board === board || key === board) {
        return stableSink(sock);
      }
    }
    return {
      send: () => {},
      sendBinary: () => {},
      isOpen: () => false,
      capabilities: () => [],
      describe: () => `http:${board}(no live transport)`,
      deviceKey: () => board,
    };
  };

  setSerialVoiceSink((port, msg) => {
    if (msg.type === 'voice_begin') {
      deviceVoice.begin(port, msg);
    } else if (msg.type === 'audio_chunk') {
      const b64 = typeof msg.d === 'string' ? msg.d : '';
      if (b64) deviceVoice.append(port, Buffer.from(b64, 'base64'));
    } else if (msg.type === 'voice_end') {
      const captured = deviceVoice.end(port, msg);
      if (captured) {
        void finishVoiceCapture(captured, serialSinkFor(port));
      } else if ((msg as { cancel?: unknown }).cancel !== true) {
        try {
          serialSinkFor(port).send(JSON.stringify(
            { type: 'voice_result', text: '', error: 'empty_capture' }));
        } catch { /* port closing */ }
      }
    } else if (msg.type === 'voice_abort') {
      log(`[agentdeck] voice: device upload aborted (${String((msg as { reason?: unknown }).reason ?? 'unknown')}, `
        + `${String((msg as { total?: unknown }).total ?? '?')} bytes) [serial ${port}]`);
    } else if (msg.type === 'photo_begin') {
      // Photo over USB: the strip is a desk fixture and usually powered from
      // the host, which parks its radio — the camera must not go dead just
      // because the board is on the cable it lives on.
      devicePhoto.begin(port, msg);
    } else if (msg.type === 'photo_chunk') {
      const b64 = typeof msg.d === 'string' ? msg.d : '';
      if (b64 && !devicePhoto.append(port, Buffer.from(b64, 'base64'))) {
        // A chunk with no open capture means photo_begin was lost (torn
        // serial line, board reset) — say so, or the drop is undiagnosable.
        debug('photo', `orphan serial photo_chunk from ${port} (no open capture)`);
      }
    } else if (msg.type === 'photo_end') {
      const captured = devicePhoto.end(port, msg);
      if (captured) {
        void finishPhotoCapture(captured, serialSinkFor(port));
      } else if ((msg as { cancel?: unknown }).cancel !== true) {
        try {
          serialSinkFor(port).send(JSON.stringify(
            { type: 'photo_result', delivered: false, error: 'empty_or_corrupt_capture' }));
        } catch { /* port closing */ }
      }
    }
  });
  /**
   * Finish one captured utterance: transcribe, route the text to the session,
   * tell the board what happened, and arm it for the spoken reply. Shared by
   * the WS and serial paths — a board attached over USB must behave exactly
   * like the same board on WiFi, which is only true if there is one
   * implementation.
   */
  /**
   * The sink to ARM for the spoken reply, which is not always the sink the
   * result JSON goes to: an HTTP-uploaded utterance resolves its result sink
   * serial-first (guaranteed delivery), but the ips10 advertises `audio_out`
   * on its WiFi device_info only — its 115200-baud serial physically cannot
   * carry PCM, so arming the serial sink would make voiceReply.arm() decline
   * and the reply silently never play. Prefer the sink itself when it can
   * play audio; otherwise find the board's live WS socket that can.
   */
  const canPlayReply = (s: ReplySink): boolean => {
    const caps = s.capabilities();
    return caps.includes('audio_out') || caps.includes('audio_http_pull');
  };
  const audioArmSinkFor = (sink: ReplySink, board: string): ReplySink => {
    if (canPlayReply(sink)) return sink;
    for (const [key, sock] of wifiEsp32Sockets) {
      if (sock.readyState !== WebSocket.OPEN) continue;
      if (wifiEsp32Devices.get(key)?.board === board || key === board) {
        const s = stableSink(sock);
        if (canPlayReply(s)) return s;
      }
    }
    return sink;
  };

  const finishVoiceCapture = async (
    captured: {
      wavPath: string;
      sessionId: string;
      board: string;
      integrityError?: string;
      cleanup: () => void;
    },
    sink: ReplySink,
  ): Promise<void> => {
        try {
          if (captured.integrityError) {
            throw new Error(captured.integrityError);
          }
          // Locale matters: the recognizer falls back to the system locale,
          // which mangles speech in another language. settings.json
          // `voice.locale` (BCP-47, e.g. "en-US") overrides it.
          const voiceCfg = loadDaemonSettings().voice as { locale?: unknown } | undefined;
          const locale = typeof voiceCfg?.locale === 'string' && voiceCfg.locale
            ? voiceCfg.locale : undefined;
          const text = await transcribeWithHelper(captured.wavPath, locale);
          const sessionId = resolveDeviceSessionId(captured.sessionId);
          debug('voice', `transcript "${text.slice(0, 60)}" → ${sessionId.slice(0, 20) || '(no session)'}`);
          // Always tell the board what was heard, even when it is empty or
          // unroutable — a device that shows nothing is indistinguishable
          // from a broken mic.
          let delivered = false;
          let via: string | undefined;
          let deliverReason: string | undefined;
          if (text && sessionId) {
            if (sessionId === 'openclaw-gateway') {
              // The gateway session has no bridge port: the generic
              // session_command path focuses a relay that can never connect
              // and silently drops the prompt while this function reported
              // delivered=true (observed 2026-07-31 — "transcript showed,
              // nothing answered"). Route straight to the adapter and report
              // what actually happened.
              delivered = !!(gatewayAdapter?.isAlive()
                && gatewayAdapter.handleCommand({ type: 'send_prompt', text }));
              via = 'gateway';
              if (!delivered) deliverReason = 'gateway_unavailable';
            } else if (sessionId.startsWith('observed:')) {
              // Any observed agent (claude, codex, …): type the dictated line
              // into the terminal that owns the session. session_command only
              // knew how to route observed *Claude*, so a Codex target was
              // silently dropped — the board said "sent" and nothing arrived.
              const obs = passiveSessionObserver.collect([])
                .find((s) => s.id === sessionId) as
                  { tty?: string; appName?: string } | undefined;
              const r = await injectObservedText(
                { tty: obs?.tty, appName: obs?.appName }, text);
              delivered = r.ok;
              via = r.via;
              deliverReason = r.reason;
            } else {
              handleDeviceCommand({
                type: 'session_command',
                sessionId,
                command: { type: 'send_prompt', text },
              } as unknown as PluginCommand);
              delivered = true;
              via = 'session-bridge';
            }
            // Only a delivered prompt earns a spoken reply: arming on a
            // dropped one would read out whatever that session happened to
            // answer someone else. Armed on an audio-capable sink, which may
            // differ from the result sink — see audioArmSinkFor.
            const armSink = audioArmSinkFor(sink, captured.board);
            const armed = delivered ? voiceReply.arm(armSink, sessionId) : false;
            // Logged at info level rather than debug: these are rare,
            // user-initiated events, and the silence made "the board said sent
            // but nothing happened" undiagnosable without a rebuild.
            log(`[agentdeck] voice: "${text.slice(0, 40)}" -> ${sessionId.slice(0, 32)}`
              + ` delivered=${delivered}${via ? ` via ${via}` : ''}`
              + `${deliverReason ? ` (${deliverReason})` : ''}`
              + ` spokenReply=${armed ? `armed(${armSink.describe()})` : 'no'}`
              + ` [${sink.describe()} key=${sink.deviceKey()}`
              + ` caps=${sink.capabilities().join('|') || 'none'}]`);
          }
          try {
            sink.send(JSON.stringify({
              type: 'voice_result', text, sessionId, delivered,
              ...(via ? { via } : {}),
              ...(deliverReason ? { deliverReason } : {}),
            }));
          } catch { /* client disconnecting */ }
        } catch (err) {
          const reason = String(err).slice(0, 300);
          // Voice turns are rare and user-initiated. Keep failures at info
          // level so a board's short "Voice error" banner can always be
          // diagnosed after the temporary WAV has been cleaned up.
          log(`[agentdeck] voice: transcription failed on ${sink.describe()}: ${reason}`);
          // The board renders `error` on a one-line banner at glance distance —
          // a short stable code it can translate beats 160 chars of
          // NSError soup. The full reason still ships as `detail` and lives in
          // the log above.
          const code = /No speech detected|kAFAssistantErrorDomain Code=1110/.test(reason)
            ? 'no_speech'
            : /audio_transport_overflow/.test(reason) ? 'audio_lost'
            : /audio_transport_incomplete/.test(reason) ? 'audio_incomplete'
            : 'voice_failed';
          try {
            sink.send(JSON.stringify({
              type: 'voice_result', text: '', error: code, detail: reason.slice(0, 160),
            }));
          } catch { /* client disconnecting */ }
        } finally {
          captured.cleanup();
        }
  };

  // ── Host push-to-talk (deck surfaces: Stream Deck, D200H) ────────────────
  // A deck key contributes only a button; the host contributes the mic, the
  // recognizer and the speakers. This restores the capability of the retired
  // Voice dial (pulled pre-Marketplace because capture meant borrowing
  // iTerm2's mic grant via AppleScript + Homebrew sox + a whisper model) on a
  // dependency-free stack: capture, STT and TTS all live in the bundled Swift
  // helper, and delivery/reply reuse the device-voice pipeline unchanged.
  const HOST_SPEAKER_KEY = 'host-speaker';

  const broadcastVoiceState = (
    state: 'idle' | 'recording' | 'transcribing' | 'error',
    extra: { text?: string; error?: string; sessionId?: string } = {},
  ): void => {
    core.broadcast({ type: 'voice_state', state, ...extra } as BridgeEvent);
  };

  /**
   * ReplySink whose "board" is the host itself. `voice_result` frames become
   * broadcast `voice_state` events so every deck surface can render the
   * outcome; the spoken reply is played by the audio_host branch in
   * speakReplyTo rather than streamed as PCM frames.
   */
  const hostSpeakerSink: ReplySink = {
    send: (data) => {
      try {
        const msg = JSON.parse(data) as
          { type?: string; text?: string; error?: string; sessionId?: string };
        if (msg.type === 'voice_result') {
          broadcastVoiceState(msg.error ? 'error' : 'idle', {
            ...(msg.text ? { text: msg.text } : {}),
            ...(msg.error ? { error: msg.error } : {}),
            ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
          });
        }
      } catch { /* nothing renderable */ }
    },
    sendBinary: () => {},
    isOpen: () => true,
    capabilities: () => ['audio_out', 'audio_host'],
    describe: () => 'host:speaker',
    deviceKey: () => HOST_SPEAKER_KEY,
  };

  /** One capture at a time — PTT models a single held key. */
  let hostPttBusy = false;

  function handleHostVoicePtt(cmd: Extract<PluginCommand, { type: 'voice' }>): void {
    if (process.platform !== 'darwin') {
      broadcastVoiceState('error', { error: 'host voice capture requires macOS' });
      return;
    }
    if (cmd.action === 'stop' || cmd.action === 'cancel') {
      if (!hostPttBusy) return;
      // Resolves the in-flight recordWithHelper below; a release that races
      // the max-duration stop is a harmless no-op.
      void stopHelperRecording({ cancel: cmd.action === 'cancel' }).catch(() => {});
      return;
    }
    if (hostPttBusy) return;
    hostPttBusy = true;
    const sessionId = resolveDeviceSessionId(cmd.sessionId) || userFocusedSessionId || '';
    const sessionExtra = sessionId ? { sessionId } : {};
    const wavPath = join(tmpdir(), `agentdeck-ptt-${process.pid}-${Date.now()}.wav`);
    broadcastVoiceState('recording', sessionExtra);
    void (async () => {
      try {
        const rec = await recordWithHelper(wavPath);
        broadcastVoiceState('transcribing', sessionExtra);
        await finishVoiceCapture({
          wavPath: rec.wav,
          sessionId,
          board: HOST_SPEAKER_KEY,
          cleanup: () => { void rm(rec.wav, { force: true }).catch(() => {}); },
        }, hostSpeakerSink);
      } catch (err) {
        const reason = String(err);
        if (/record_cancelled/.test(reason)) {
          broadcastVoiceState('idle', sessionExtra);
        } else {
          log(`[agentdeck] voice: host PTT failed: ${reason.slice(0, 200)}`);
          broadcastVoiceState('error', { error: reason.slice(0, 160), ...sessionExtra });
        }
      } finally {
        hostPttBusy = false;
      }
    })();
  }

  /**
   * Finish one captured photo: build the prompt that points the target session
   * at the saved file, deliver it through the same ladder as dictated text
   * (observed → terminal injection, managed → send_prompt), and tell the board
   * what happened. Shared by the WS and serial paths for the same reason as
   * finishVoiceCapture: one implementation or the transports drift.
   */
  const finishPhotoCapture = async (
    captured: { path: string; sessionId: string; board: string; bytes: number },
    sink: ReplySink,
  ): Promise<void> => {
    try {
      // The strip aims at its own focus pick; when it sends none, fall back to
      // the daemon's explicitly focused session rather than dropping the shot.
      let sessionId = resolveDeviceSessionId(captured.sessionId);
      if (!sessionId && userFocusedSessionId) sessionId = userFocusedSessionId;
      const photoCfg = loadDaemonSettings().photo as { promptTemplate?: unknown } | undefined;
      const template = typeof photoCfg?.promptTemplate === 'string'
          && photoCfg.promptTemplate.includes('{path}')
        ? photoCfg.promptTemplate
        : 'Look at the photo I just captured for you on the AgentDeck device and respond: {path}';
      const text = template.replace('{path}', captured.path);
      let delivered = false;
      let via: string | undefined;
      let deliverReason: string | undefined;
      if (sessionId) {
        if (sessionId.startsWith('observed:')) {
          // Any observed agent: type the prompt into the terminal that owns the
          // session — the same ladder dictated text uses.
          const obs = passiveSessionObserver.collect([])
            .find((s) => s.id === sessionId) as
              { tty?: string; appName?: string } | undefined;
          const r = await injectObservedText(
            { tty: obs?.tty, appName: obs?.appName }, text);
          delivered = r.ok;
          via = r.via;
          deliverReason = r.reason;
        } else {
          handleDeviceCommand({
            type: 'session_command',
            sessionId,
            command: { type: 'send_prompt', text },
          } as unknown as PluginCommand);
          delivered = true;
          via = 'session-bridge';
        }
      } else {
        deliverReason = 'no_target_session';
      }
      // Info level, like voice: rare user-initiated events whose silence made
      // "the board said sent but nothing happened" undiagnosable.
      log(`[agentdeck] photo: ${captured.bytes}B -> ${sessionId.slice(0, 32) || '(no session)'}`
        + ` delivered=${delivered}${via ? ` via ${via}` : ''}`
        + `${deliverReason ? ` (${deliverReason})` : ''} [${captured.path}]`);
      try {
        sink.send(JSON.stringify({
          type: 'photo_result', delivered, sessionId, bytes: captured.bytes,
          ...(via ? { via } : {}),
          ...(deliverReason ? { deliverReason } : {}),
        }));
      } catch { /* client disconnecting */ }
    } catch (err) {
      const reason = String(err).slice(0, 160);
      debug('photo', `delivery failed: ${reason}`);
      try {
        sink.send(JSON.stringify({ type: 'photo_result', delivered: false, error: reason }));
      } catch { /* client disconnecting */ }
    }
  };

  core.wsServer.onBinary((data, sender) => {
    // A connection holds an open voice utterance OR an open photo, never both
    // (protocol contract) — offer the unenveloped frame to each in turn.
    if (deviceVoice.append(sender, data)) return;
    if (devicePhoto.append(sender, data)) return;
    debug('voice', `binary frame with no open utterance/capture (${data.length} bytes) — ignored`);
  });
  setInterval(() => {
    deviceVoice.sweep();
    for (const conn of devicePhoto.sweep()) {
      // Tell the board its capture died (lost photo_end): the strip otherwise
      // has no way to distinguish "delivered" from "evaporated in transit".
      try {
        const sink = typeof conn === 'string' ? serialSinkFor(conn) : stableSink(conn as WebSocket);
        sink.send(JSON.stringify({ type: 'photo_result', delivered: false, error: 'capture_timeout' }));
      } catch { /* transport gone too */ }
    }
    // Keep armings alive while their session is still working: a dictated
    // question that starts a long task must still get its answer read out when
    // the task finally finishes, and the TTL alone would have expired first.
    void core.buildSessionsSnapshot().then((sessions) => {
      voiceReply.refresh(sessions
        .filter((s) => s.state === 'processing' || s.state === 'awaiting_input')
        .map((s) => String(s.id)));
    }).catch(() => {});
    voiceReply.sweep();
    for (const ws of sinkByWs.keys()) {
      if (ws.readyState !== WebSocket.OPEN) sinkByWs.delete(ws);
    }
    for (const ws of wsSelfBoard.keys()) {
      if (ws.readyState === WebSocket.CLOSED) { wsSelfBoard.delete(ws); wsSelfCaps.delete(ws); }
    }
  }, 30_000).unref?.();

  core.wsServer.onCommand(handleDeviceCommand);
  // Idle display-only boards send no messages — their protocol pongs are the
  // only liveness signal. Without this, every healthy quiet XTeink read as
  // "stale" in /devices and the roster aged it toward eviction.
  core.wsServer.onPong((ws) => touchWifiEsp32Socket(ws));
  // Serial-attached boards get the SAME command pipeline: their steering taps
  // arrive over USB when WiFi is parked (serial-primary), and used to be
  // silently dropped by the device_info-only serial parser.
  setSerialCommandSink((c) => handleDeviceCommand(c as unknown as PluginCommand));

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
      // 5. Reap ABANDONED runs — the ones step 4 cannot see. A daemon restart
      //    (or crash) drops the in-memory session→run map, so every run that
      //    was mid-session is left with ended_at NULL forever. Those carry real
      //    prompts and turns, so they fail step 4's empty-shell predicate, and
      //    because their TASK also never closes they are never evaluated: the
      //    store had accumulated 65 open tasks against 9 closed ones.
      //    Closing the run makes step 1 pick it up next tick; the task eval has
      //    to be enqueued here, since its normal trigger (`onTaskClosed`) fires
      //    from the collector's in-memory close path, which is exactly what
      //    went missing.
      //    Batched small: `enqueueTask` dispatches immediately with no
      //    concurrency cap, so a backlog is drained a few per tick rather than
      //    fired at the judge all at once.
      const abandoned = apme!.store.listAbandonedRuns(APME_ABANDONED_RUN_STALE_SEC, 5);
      for (const run of abandoned) {
        if (apme!.collector.isLiveRun(run.id)) continue; // still owned by us
        const closedTasks = apme!.store.reapAbandonedRun(run.id, run.lastActivity);
        for (const task of closedTasks) {
          // Judge only what there is something to judge. The backlog this
          // reaper drains predates the response-capture fix, so most of those
          // tasks hold prompts and tool calls but no reply — scoring them would
          // push hundreds of "judged against silence" rows into the scorecard,
          // the same noise `response_kind` exists to keep out. Closing the row
          // is the data-hygiene win; the eval is a bonus when it can be earned.
          const hasReply = apme!.store.listTurnsForTask(task.id)
            .some((t) => typeof t.response === 'string' && t.response.trim().length > 0);
          if (!hasReply) continue;
          apme!.runner.enqueueTask({
            runId: run.id, taskId: task.id,
            ...(task.category ? { category: task.category } : {}),
            boundarySignal: 'orphaned',
          });
        }
        debug('APME', `reaped abandoned run ${run.id.slice(0, 8)} — ${closedTasks.length} task(s) closed`);
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
    clearInterval(daemonInfoHealTimer);
    drainAllPending();
    removeDaemonInfo();
    focusRelay.stop();
    timelineRelay.stop();
    voiceAssistant?.stop();
    bridgeLogStream.stop();
    // Flush synchronously — the process exits a few lines below and a pending
    // debounce timer would take the last turn's entries with it.
    core.bridgeTimeline.stopPersistence();
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
