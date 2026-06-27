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
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { BridgeCore } from './bridge-core.js';
import { buildDisplayStateEvent } from './display-dim.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import { BridgeLogStream } from './log-stream.js';
import { PassiveSessionObserver } from './passive-observer.js';
import { SessionTimelineRelay } from './session-timeline-relay.js';
import { SessionFocusRelay } from './session-focus-relay.js';
import { updatePushState } from './session-aggregator.js';
import { setAwaitingOverlay, getAwaitingOverlay, clearAwaitingOverlay, isPermissionNotification, shouldGatePreToolUse, applyAwaitingOverlayToObserved } from './awaiting-overlay.js';
import { registerPending, resolvePending, abandonPending, sweepStalePending, drainAllPending } from './permission-resolver.js';
import { VoiceManager } from './voice.js';
import { VoiceAssistantManager } from './voice-assistant.js';
import {
  listActive as listActiveSessions,
  findAvailablePort,
  findExistingDaemon,
  DAEMON_DEFAULT_PORT,
  probeDaemonHealth,
  shouldConcedePortToOccupant,
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
import { handleApmeRequest } from './apme/http.js';
import {
  handleTrmnlSetup,
  handleTrmnlDisplay,
  handleTrmnlImage,
  handleTrmnlLog,
  isTrmnlImagePath,
} from './trmnl/byos-server.js';
import {
  initModules,
  stopModules,
  createDefaultModules,
  type DeviceModule,
} from './modules/index.js';
import { SerialModule } from './modules/serial-module.js';
import { esp32ConnectionCount, getESP32DeviceInfo, onESP32Message, sendWifiProvisionToAll, handleESP32Wake, getESP32Ports, getSerialConnectionStatus, getSerialLastError } from './esp32-serial.js';
import { loadWifiConfig } from './wifi-config.js';
import { getConnectedAdbDevices, hasAdb, getAdbDeviceCount } from './adb-reverse.js';
import { getPixooDeviceDetails, pixooDeviceCount } from './pixoo/pixoo-bridge.js';
import { loadTimeboxDevices } from './timebox/timebox-settings.js';
import { getLanIp } from '@agentdeck/shared';
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

// ===== Device approvals (observed-session PreToolUse gating) =====

interface DeviceApprovalsConfig {
  enabled: boolean;
  gatedTools: string[];
  timeoutMs: number;
}
const DEFAULT_GATED_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
let cachedApprovals: { cfg: DeviceApprovalsConfig; at: number } | null = null;

/** Read deviceApprovals settings with a 3s cache — the gate is checked on every
 *  PreToolUse (every tool call), so re-reading settings.json each time would add
 *  an fs hit per tool. Cache keeps "OFF = zero added latency" honest. */
function getDeviceApprovalsConfig(): DeviceApprovalsConfig {
  const now = Date.now();
  if (cachedApprovals && now - cachedApprovals.at < 3000) return cachedApprovals.cfg;
  const raw = (loadDaemonSettings().deviceApprovals ?? {}) as Record<string, unknown>;
  const cfg: DeviceApprovalsConfig = {
    // Default ON: observed-session approval is the only way a device popup can
    // actually drive a no-PTY session forward, so absent config opts in. Only
    // an explicit `enabled: false` keeps the gate off.
    enabled: raw.enabled !== false,
    gatedTools: Array.isArray(raw.gatedTools)
      ? raw.gatedTools.filter((t): t is string => typeof t === 'string')
      : DEFAULT_GATED_TOOLS,
    timeoutMs: typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : 45_000,
  };
  cachedApprovals = { cfg, at: now };
  return cfg;
}

function isToolGated(toolName: string, gatedTools: string[]): boolean {
  return !!toolName && gatedTools.includes(toolName);
}

/** Human-readable approval question from a PreToolUse payload, e.g.
 *  "Allow Bash: npm test?" / "Allow Write: src/app.ts?". */
function formatApprovalQuestion(toolName: string, toolInput: unknown): string {
  const inp = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  let detail = '';
  for (const k of ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url']) {
    if (typeof inp[k] === 'string') { detail = inp[k] as string; break; }
  }
  const base = toolName ? `Allow ${toolName}` : 'Allow tool';
  const q = detail ? `${base}: ${detail}?` : `${base}?`;
  return q.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function log(msg: string): void {
  process.stderr.write(msg + '\n');
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

  const d200h = startedModules.find((m) => m.name === 'd200h') as DeviceModule & {
    statusSnapshot?: () => Record<string, unknown>;
  };
  if (d200h?.statusSnapshot) {
    modules.d200h = d200h.statusSnapshot();
  }

  const trmnl = startedModules.find((m) => m.name === 'trmnl') as DeviceModule & {
    statusSnapshot?: () => Record<string, unknown>;
  };
  if (trmnl?.statusSnapshot) {
    modules.trmnl = trmnl.statusSnapshot();
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
        wifiConfigured: status.wifiConfigured,
        wifiConnected: status.wifiConnected,
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
    enableDebugLog('/tmp/agentdeck-debug.log');
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
      log(`[agentdeck] Daemon already running on port ${existingInfo.port} (PID ${existingInfo.pid}).`);
      process.exit(0);
    }
    log(`[agentdeck] Ignoring stale daemon entry on port ${existingInfo.port} (PID ${existingInfo.pid}; /health did not respond).`);
    removeDaemonInfo();
  }
  const existingSession = findExistingDaemon();
  if (existingSession) {
    const health = await probeDaemonHealth(existingSession.port);
    if (health?.mode === 'daemon') {
      log(`[agentdeck] Daemon already running on port ${existingSession.port} (PID ${existingSession.pid}).`);
      process.exit(0);
    }
    log(`[agentdeck] Ignoring stale daemon session on port ${existingSession.port} (PID ${existingSession.pid}; /health did not respond).`);
    removeDaemonSession(existingSession);
  }

  // 2. Determine port — try default first, fallback if occupied by non-daemon
  const requestedPort = opts.port ?? DAEMON_DEFAULT_PORT;
  let port = requestedPort;

  // If using default port, check if it's available
  if (requestedPort === DAEMON_DEFAULT_PORT) {
    const health = await probeDaemonHealth(requestedPort);
    if (health) {
      if (health.mode === 'daemon') {
        // Daemon alive but not in our registry — race condition or stale state
        log(`[agentdeck] Daemon already running on port ${requestedPort} (detected via /health).`);
        process.exit(0);
      }
      // Port occupied by non-daemon (e.g. session bridge) — find alternative
      log(`[agentdeck] Port ${requestedPort} occupied (${health.mode ?? 'unknown'}), finding alternative...`);
      port = await findAvailablePort();
    }
  }

  log(`[agentdeck] Starting daemon on port ${port}...`);

  // ===== APME (lazy — may be null if better-sqlite3 isn't installed) =====
  let apme: ApmeModule | null = null;

  // Declare early — HTTP /health handler references this in its closure.
  // Must be declared before the HTTP server so it's initialized (not in TDZ)
  // when the first /health request arrives.
  let gatewayAdapter: OpenClawAdapter | null = null;
  let gatewayConnecting = false;
  let moduleHealthProvider: () => Record<string, unknown> = () => ({});

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
      const d200hModule = typeof startedModules !== 'undefined' ? startedModules.find((m) => m.name === 'd200h') as any : undefined;
      const d200hStatus = d200hModule?.statusSnapshot ? d200hModule.statusSnapshot() : { connected: false };
      res.end(JSON.stringify({
        devices: [
          { type: 'websocket', count: core.wsServer.getClientCount() },
          { type: 'esp32', count: esp32ConnectionCount(), ports: getESP32Ports() },
          { type: 'pixoo', details: getPixooDeviceDetails() },
          { type: 'timebox', devices: loadTimeboxDevices() },
          { type: 'idotmatrix', devices: loadIDotMatrixDevices() },
          { type: 'adb', count: getAdbDeviceCount() },
          {
            type: 'd200h',
            connected: d200hStatus.connected,
            writeOK: d200hStatus.writeOK,
            writeFail: d200hStatus.writeFail,
          },
        ],
        modules: moduleHealthProvider(),
      }));
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
    // --- TRMNL BYOS (e-ink panel pulls rendered dashboard over WiFi) ---
    if (req.method === 'GET' && pathname === '/api/setup') {
      handleTrmnlSetup(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/display') {
      handleTrmnlDisplay(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/log') {
      handleTrmnlLog(req, res);
      return;
    }
    if (req.method === 'GET' && isTrmnlImagePath(pathname)) {
      handleTrmnlImage(req, res);
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
      // Set when this PreToolUse response is held open awaiting device approval,
      // so a client disconnect (Claude killed the hook) can drop the pending entry.
      let heldRequestId: string | null = null;
      req.on('data', (c: Buffer) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on('close', () => { if (heldRequestId) abandonPending(heldRequestId); });
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
        // Per-session awaiting overlay (observed/direct-`claude` sessions).
        // The single aggregate state machine above can't attribute awaiting to
        // a specific session (all direct-`claude` hooks share `daemon-hook`),
        // so we key the overlay by Claude's own session_id and merge it into
        // the observed-session list at enrich time. See awaiting-overlay.ts.
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
        // APME collector
        if (apme) {
          // Use a stable "hook session" for the daemon — hooks from direct `claude` runs
          // don't have AGENTDECK_PORT, so they all come here.
          const hookSessionId = 'daemon-hook';
          if (mapped === 'session_start') {
            // Extract prompt source from message.content (Claude v2.1+) or prompt field
            apme.collector.openRun({
              sessionId: hookSessionId,
              agentType: 'claude-code',
              projectName: (json.project_name as string) ?? undefined,
              projectPath: (json.project_path as string) ?? undefined,
            });
          }
          apme.collector.ingestHook(hookSessionId, mapped, json);
          if (mapped === 'session_end') {
            apme.collector.closeRun(hookSessionId);
          }
        }

        // ── Response ──
        // PreToolUse may be held open for device approval (observed sessions);
        // every other event acks immediately. The eager response that used to
        // live after this callback was moved here so the hold is possible.
        if (eventName === 'PreToolUse') {
          const cfg = getDeviceApprovalsConfig();
          const toolName = typeof json.tool_name === 'string' ? json.tool_name : '';
          // PreToolUse fires for every tool call regardless of permission mode;
          // only hold when Claude itself could prompt, else we nag for a
          // decision the agent never asked for. See shouldGatePreToolUse.
          const permissionMode = typeof json.permission_mode === 'string' ? json.permission_mode : undefined;
          if (cfg.enabled && claudeSid && isToolGated(toolName, cfg.gatedTools) && shouldGatePreToolUse(permissionMode, toolName)) {
            const requestId = randomUUID();
            heldRequestId = requestId;
            // Overlay carries the requestId → devices render Allow/Deny and reply
            // with permission_decision. This runs after the tool_start overlay-clear
            // above, so it wins (sets the actionable gate for THIS tool).
            setAwaitingOverlay(claudeSid, formatApprovalQuestion(toolName, json.tool_input), requestId);
            registerPending(requestId, res, {
              sessionId: claudeSid,
              tool: toolName,
              timeoutMs: cfg.timeoutMs,
              // Fires on ANY resolution (device decision, timeout, sweep, drain) so
              // the awaiting UI clears consistently across every surface.
              onResolved: () => {
                clearAwaitingOverlay(claudeSid);
                core.broadcastSessionsList().catch(() => {});
                broadcastFocusedState();
              },
            });
            core.broadcastSessionsList().catch(() => {});
            // If this session is already focused, refresh the focused state_update
            // so encoder/HUD surfaces that read state_update show Allow/Deny live.
            if (userFocusedSessionId && userFocusedSessionId.replace(/^observed:(?:claude|codex):/, '') === claudeSid) {
              broadcastFocusedState();
            }
            // Response intentionally held — resolved by permission_decision or timeout.
          } else {
            // Not gated / disabled: empty body → hook echoes nothing → Claude's
            // normal permission flow, zero added latency.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('');
          }
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

  // Timeline
  const bridgeLogStream = new BridgeLogStream();
  core.wireTimeline(bridgeLogStream);
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
    // Synthesize an awaiting-permission state for a focused observed session
    // with a pending PreToolUse gate. Observed sessions have no bridge for the
    // focus relay to stream from, so without this the encoder/HUD that read
    // `state_update` would show the aggregate (idle/processing) instead of the
    // gate. Reuses every client's existing AWAITING_PERMISSION rendering; the
    // requestId tells them to reply with permission_decision, not select_option.
    if (userFocusedSessionId) {
      const uuid = userFocusedSessionId.replace(/^observed:(?:claude|codex):/, '');
      const gate = getAwaitingOverlay(uuid);
      if (gate?.requestId) {
        const ev = stateEvent as unknown as Record<string, unknown>;
        ev.state = 'awaiting_permission';
        ev.options = [
          { index: 0, label: 'Allow', shortcut: 'y', recommended: true },
          { index: 1, label: 'Deny', shortcut: 'n' },
        ];
        ev.question = gate.question;
        ev.requestId = gate.requestId;
        ev.navigable = false;
      }
    }
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
  const startedModules = await initModules(
    deviceModules,
    // TRMNL stays on so its frame cache tracks live state and a freshly-enrolled
    // panel works without a daemon restart; rendering is internally gated on a
    // device being registered, so it's cheap when no panel is present.
    // d200h: false — direct-HID fallback retired. The D200H is driven exclusively
    // by the Ulanzi Studio plugin (`ulanzi-plugin`); the daemon never opens it over HID.
    { mdns: true, adb: 'auto', serial: 'auto', pixoo: 'auto', timebox: 'auto', idotmatrix: 'auto', d200h: false, trmnl: true },
    { port, authToken: core.authToken, projectName: 'AgentDeck', wsServer: core.wsServer },
  );

  moduleHealthProvider = () => buildNodeModuleHealth(startedModules);
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
      // Sessions list (async enrichment runs synchronously from cache here)
      core.broadcastSessionsList().catch(() => {});
      return events;
    });
    // Include ESP32 serial connections in client count for polling guards
    core.setExternalClientCountProvider(() => esp32ConnectionCount());

    // WiFi auto-provisioning for ESP32 (enables independent WiFi operation)
    const wifiConfig = loadWifiConfig();
    if (wifiConfig?.autoProvision) {
      const lanIp = getLanIp();
      onESP32Message((portPath, msg) => {
        if (msg.type === 'device_info' && !msg.wifiConnected) {
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
    // Overlay hook-driven awaiting state onto observed (direct-`claude`) sessions.
    // Done here in the synchronous enricher (runs on every broadcast) rather than
    // inside the 5s-throttled observer, so a Notification arriving mid-window
    // still surfaces within one frame. Key = the Claude session UUID embedded
    // in `observed:claude:<uuid>`.
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
