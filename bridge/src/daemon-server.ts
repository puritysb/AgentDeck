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
import WebSocket from 'ws';
import { BridgeCore } from './bridge-core.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import { BridgeLogStream } from './log-stream.js';
import { PassiveSessionObserver } from './passive-observer.js';
import { SessionTimelineRelay } from './session-timeline-relay.js';
import { SessionFocusRelay } from './session-focus-relay.js';
import { updatePushState } from './session-aggregator.js';
import { VoiceManager } from './voice.js';
import { VoiceAssistantManager } from './voice-assistant.js';
import {
  listActive as listActiveSessions,
  findAvailablePort,
  findExistingDaemon,
  DAEMON_DEFAULT_PORT,
  probeDaemonHealth,
  writeDaemonInfo,
  removeDaemonInfo,
  readDaemonInfo,
} from './session-registry.js';
import { fetchUsageFromApi, hasOAuthToken, resetConsecutiveFailures, type ApiUsageData } from './usage-api.js';
import { isLocalConnection, validateToken } from './auth.js';
import { getLastFrame, renderPreviewFrame, onFrameRendered, offFrameRendered } from './pixoo/pixoo-bridge.js';
import { handlePixooWake } from './pixoo/pixoo-client.js';
import { triggerMdnsRecovery } from './mdns.js';
import { rgbToBmp, pixooLiveHtml } from './hook-server.js';
import { enableDebugLog, debug } from './logger.js';
import { initApme, type ApmeModule } from './apme/index.js';
import { handleApmeRequest } from './apme/http.js';
import {
  initModules,
  stopModules,
  createDefaultModules,
  type DeviceModule,
} from './modules/index.js';
import { SerialModule } from './modules/serial-module.js';
import { esp32ConnectionCount, getESP32DeviceInfo, onESP32Message, sendWifiProvisionToAll, handleESP32Wake } from './esp32-serial.js';
import { loadWifiConfig } from './wifi-config.js';
import { getConnectedAdbDevices, hasAdb } from './adb-reverse.js';
import { getPixooDeviceDetails, pixooDeviceCount } from './pixoo/pixoo-bridge.js';
import { getLanIp } from '@agentdeck/shared';
import { readFileSync } from 'fs';
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

function loadDaemonSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.agentdeck', 'settings.json'), 'utf-8'));
  } catch {
    return {};
  }
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

  if (started.has('serial')) {
    const connections = getESP32DeviceInfo().map((info) => ({
      port: info.port,
      connected: true,
      deviceInfo: {
        board: info.board,
        version: info.version,
        wifiConfigured: info.wifiConfigured,
        wifiConnected: info.wifiConnected,
      },
    }));
    modules.serial = {
      connectedPorts: connections.map((c) => c.port),
      connections,
      lastError: null,
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
    log(`[agentdeck] Daemon already running on port ${existingInfo.port} (PID ${existingInfo.pid}).`);
    process.exit(0);
  }
  const existingSession = findExistingDaemon();
  if (existingSession) {
    log(`[agentdeck] Daemon already running on port ${existingSession.port} (PID ${existingSession.pid}).`);
    process.exit(0);
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
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

    // Health check is public (no auth) — used by iOS/Android for pairing token discovery
    if (req.method === 'GET' && pathname === '/health') {
      const snap = core.stateMachine.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', mode: 'daemon', state: snap.state,
        gateway: gatewayAdapter?.isAlive() ? 'connected' : 'disconnected',
        uptime: process.uptime(), port,
        pairingToken: core.authToken,
        modules: moduleHealthProvider(),
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
      res.end(JSON.stringify({ devices: [], modules: moduleHealthProvider() }));
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
      const rgb = getLastFrame() ?? renderPreviewFrame();
      const bmp = rgbToBmp(rgb, 64, 64);
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
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
      return;
    }

    if (req.method === 'POST' && pathname === '/shutdown') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting_down' }));
      core.shutdown();
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
    // Handle race condition: port became unavailable after probe
    if (err.message.startsWith('EADDRINUSE:') && port === requestedPort) {
      port = await findAvailablePort();
      log(`[agentdeck] Port ${requestedPort} grabbed, retrying on ${port}...`);
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
  });

  // Timeline
  const bridgeLogStream = new BridgeLogStream();
  core.wireTimeline(bridgeLogStream);
  core.wireDisplayMonitor();

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
      const stateEvent = core.buildStateEvent({
        agentType: gatewayAdapter?.isAlive() ? 'openclaw' : 'daemon' as any,
        agentCapabilities: gatewayAdapter?.isAlive() ? OPENCLAW_CAPABILITIES : undefined,
        snapshot: snap,
      });
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
      // Merge daemon metadata into the session's state_update
      const merged: any = {
        ...evt,
        sessionId: focusRelay.getFocusedSessionId(),
        modelCatalog: (evt as any).modelCatalog ?? core.cachedModelCatalog,
        gatewayAvailable: core.cachedGatewayAvailable,
        gatewayConnected: core.cachedGatewayConnected,
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
    { mdns: true, adb: 'auto', serial: 'auto', pixoo: 'auto', d200h: 'auto' },
    { port, authToken: core.authToken, projectName: 'AgentDeck', wsServer: core.wsServer },
  );

  moduleHealthProvider = () => buildNodeModuleHealth(startedModules);
  core.setModuleHealthProvider(moduleHealthProvider);

  // Serial module state provider (heartbeat needs cached state)
  let lastStateEvent: BridgeEvent | null = null;
  const serialModule = startedModules.find(m => m.name === 'serial') as SerialModule | undefined;
  if (serialModule) {
    serialModule.setStateProvider(() => lastStateEvent);
    serialModule.setUsageProvider(() => core.buildUsage());
    // Send full state (state + usage + sessions) when new ESP32 device connects
    serialModule.setInitialStateProvider(() => {
      const events: BridgeEvent[] = [];
      if (lastStateEvent) events.push(lastStateEvent);
      events.push(core.buildUsage());
      events.push({ type: 'display_state', displayOn: core.displayMonitor.isDisplayOn() } as BridgeEvent);
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
          sendWifiProvisionToAll({
            type: 'wifi_provision' as const,
            ssid: wifiConfig.ssid,
            password: wifiConfig.password,
            bridgeIp: lanIp,
            bridgePort: port,
            authToken: core.authToken,
          });
          log(`[agentdeck] WiFi provision sent to ESP32 on ${portPath}`);
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
  apme = await initApme();
  if (apme) {
    core.setApme(apme);
    log('[agentdeck] APME enabled — /apme/* routes active');
  }

  // Register session
  core.registerSession('daemon' as any);
  const passiveSessionObserver = new PassiveSessionObserver();

  // ===== Gateway adapter lifecycle =====
  // (gatewayAdapter + gatewayConnecting declared earlier, before HTTP server)

  // Inject OpenClaw virtual session only after Gateway authentication succeeds.
  // Reachability alone is a topology signal, not proof that commands can route.
  core.setSessionsEnricher((sessions) => {
    const enrichedSessions = [...sessions, ...passiveSessionObserver.collect(sessions)];
    const adapterAlive = gatewayAdapter?.isAlive() ?? false;
    if (!adapterAlive && !core.cachedGatewayConnected) return enrichedSessions;
    if (enrichedSessions.some(s => s.agentType === 'openclaw')) return enrichedSessions;
    const snap = core.stateMachine.getSnapshot();
    return [...enrichedSessions, {
      id: 'openclaw-gateway',
      port: 18789,
      projectName: adapterAlive ? (snap.projectName ?? 'OpenClaw') : 'OpenClaw',
      agentType: 'openclaw' as const,
      alive: true,
      state: adapterAlive ? snap.state : 'idle',
      modelName: adapterAlive ? (snap.modelName ?? undefined) : undefined,
      controlMode: 'managed' as const,
    }];
  });

  function connectGatewayAdapter(): void {
    if (gatewayAdapter || gatewayConnecting) return;
    gatewayConnecting = true;
    log('[agentdeck] OpenClaw Gateway detected, connecting...');

    const adapter = new OpenClawAdapter({ autoReconnect: false });

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
              const stateEvent = core.buildStateEvent({
                agentType: 'openclaw',
                agentCapabilities: OPENCLAW_CAPABILITIES,
                snapshot: snap,
              });
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
            if (evt.upsert) core.bridgeTimeline.upsertEntry(evt.entry);
            else core.bridgeTimeline.addEntry(evt.entry);
            if (evt.entry.type === 'tool_request') bridgeLogStream.trackToolRequest(evt.entry.raw);
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
            bridgeLogStream.start();
            log('[agentdeck] OpenClaw Gateway connected');
            if (core.stateMachine.getSnapshot().state === 'disconnected') {
              core.stateMachine.handleHookEvent('SessionStart', {});
            }
            // Force full state broadcast
            const snap = core.stateMachine.getSnapshot();
            const gwStateEvent = core.buildStateEvent({
              agentType: 'openclaw',
              agentCapabilities: OPENCLAW_CAPABILITIES,
              snapshot: snap,
            });
            lastStateEvent = gwStateEvent;
            core.wsServer.broadcast(gwStateEvent);
            core.broadcastUsage();
            core.broadcastSessionsList().catch(() => {});
          } else {
            core.cachedGatewayConnected = false;
            bridgeLogStream.stop();
            log('[agentdeck] OpenClaw Gateway disconnected');
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
      core.stateMachine.emit('state_changed', core.stateMachine.getSnapshot());
    });
  }

  function disconnectGatewayAdapter(): void {
    if (!gatewayAdapter) return;
    log('[agentdeck] OpenClaw Gateway lost, cleaning up...');
    const wasAlive = gatewayAdapter.isAlive();
    gatewayAdapter.shutdown().catch(() => {});
    gatewayAdapter = null;
    core.cachedGatewayConnected = false;
    core.cachedModelCatalog = null;
    if (wasAlive) core.stateMachine.handleHookEvent('SessionEnd', {});
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
    const stateEvent = core.buildStateEvent({
      agentType: gwAlive ? 'openclaw' : 'daemon' as any,
      agentCapabilities: gwAlive ? OPENCLAW_CAPABILITIES : undefined,
      snapshot,
    });
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
      focusRelay.unfocus(); // Clear session focus on agent switch
      const target = (cmd as any).agent as string;
      if (target === 'openclaw' && gatewayAdapter?.isAlive()) {
        // Force broadcast OpenClaw state to all clients
        const snap = core.stateMachine.getSnapshot();
        const gwStateEvent = core.buildStateEvent({
          agentType: 'openclaw',
          agentCapabilities: OPENCLAW_CAPABILITIES,
          snapshot: snap,
        });
        lastStateEvent = gwStateEvent;
        core.wsServer.broadcast(gwStateEvent);
      } else if (target === 'claude-code') {
        // Broadcast daemon/claude-code state — clients reconnect to session bridges independently
        const snap = core.stateMachine.getSnapshot();
        const stateEvent = core.buildStateEvent({
          agentType: 'daemon' as any,
          snapshot: snap,
        });
        lastStateEvent = stateEvent;
        core.wsServer.broadcast(stateEvent);
      }
      return;
    }
    if (cmd.type === 'focus_session') {
      const sessionId = (cmd as any).sessionId as string;
      if (!sessionId) return;
      focusRelay.focus(sessionId);
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
      focusRelay.focus(sessionId);
      // Small delay to let focus take effect, then route
      setTimeout(() => focusRelay.routeCommand(command), 100);
      return;
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
    apme.runner.onResult(({ runId, turnId }) => {
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
        const pct = Math.round(overall.score * 100);
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
        // Change 8: include axis scores + judge reasoning in turn eval detail
        const turnAxes = turnEvals.filter(e => e.metric !== 'overall');
        const turnAxisStr = turnAxes.map(e => `${e.metric}=${Math.round(e.score * 100)}%`).join(' ');
        let turnDetail = turnAxisStr
          ? `${turnAxisStr}\n${run.taskPrompt?.slice(0, 80) ?? ''}`
          : `Turn eval · ${run.taskPrompt?.slice(0, 80) ?? ''}`;
        if (overall.raw) {
          try {
            const parsed = JSON.parse(overall.raw as string);
            const done = (parsed.done as string[] | undefined)?.slice(0, 2).join(', ') || '';
            const missed = (parsed.missed as string[] | undefined)?.slice(0, 2).join(', ') || '';
            if (done) turnDetail += `\n✓ ${done}`;
            if (missed) turnDetail += `\n✗ ${missed}`;
          } catch { /* ignore */ }
        }
        core.bridgeTimeline.addEntry({
          ts: Date.now(), type: 'eval_result',
          raw: `★ turn ${pct}% [${run.taskCategory ?? '?'}]`,
          detail: turnDetail,
          agentType: run.agentType,
        });
        return;
      }
      const run = apme!.store.getRun(runId);
      if (!run) return;
      const evals = apme!.store.listEvalsForRun(runId);
      const overallScore = aggregateOverall(evals);
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

      // Change 9: separate deterministic layer timeline entry (lint/build/test)
      const detEvals = evals.filter(e => e.layer === 'deterministic');
      if (detEvals.length > 0) {
        const detResults = detEvals.map(e => `${e.metric}=${e.score ? '✓' : '✗'}`).join(' ');
        core.bridgeTimeline.addEntry({
          ts: Date.now(), type: 'eval_result',
          raw: `⚡ ${detResults}`,
          detail: `Deterministic eval · ${run.projectName ?? ''}`,
          agentType: run.agentType,
        });
      }

      // Change 7: enriched run-level eval_result with axis scores + deterministic summary
      const pct = Math.round((overallScore ?? run.compositeScore ?? 0) * 100);
      const judgeEvals = evals.filter(e => e.layer === 'llm_judge' && e.metric !== 'overall');
      const axisStr = judgeEvals.map(e => `${e.metric}=${Math.round(e.score * 100)}%`).join(' ');
      const detStr = detEvals.length > 0
        ? detEvals.map(e => `${e.metric}=${e.score ? '✓' : '✗'}`).join(' ') + ' · '
        : '';
      const enrichedDetail = axisStr
        ? `${detStr}${axisStr}\n${run.projectName ?? ''} · ${run.taskPrompt?.slice(0, 100) ?? ''}`
        : `${run.projectName ?? ''} · ${run.taskPrompt?.slice(0, 100) ?? ''}`;
      core.bridgeTimeline.addEntry({
        ts: Date.now(),
        type: 'eval_result',
        raw: `★ [${run.taskCategory ?? '?'}] ${pct}% · ${run.outcome ?? 'pending'}`,
        detail: enrichedDetail,
        agentType: run.agentType,
      });
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

  // ===== Shutdown =====
  core.onShutdown(async () => {
    removeDaemonInfo();
    focusRelay.stop();
    timelineRelay.stop();
    voiceAssistant?.stop();
    voiceManager?.disconnectFromServer();
    bridgeLogStream.stop();
    await Promise.all([
      gatewayAdapter ? gatewayAdapter.shutdown().catch(() => {}) : Promise.resolve(),
      stopModules(startedModules)
    ]);
    gatewayAdapter = null;
    httpServer.close(() => process.exit(0));
    // Force exit if httpServer.close() hangs on CLOSE_WAIT connections
    setTimeout(() => process.exit(0), 5000).unref();
  });

  core.registerProcessHandlers('agentdeck');

  log(`[agentdeck] Daemon running. Gateway probe active.`);
}
