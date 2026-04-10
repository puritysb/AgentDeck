/**
 * AgentDeck Bridge — session entry point.
 *
 * Exports `startSession()` called by cli.ts.
 * Uses BridgeCore for shared infrastructure.
 */

import { BridgeCore } from './bridge-core.js';
import { VoiceManager } from './voice.js';
import { checkDependencies } from './check-deps.js';
import { enableDebugLog, log, logError, debug, setPtyMode } from './logger.js';
import { EventJournal } from './event-journal.js';
import { PtyRingBuffer } from './pty-ringbuffer.js';
import { createDiagDump } from './diag-analyzer.js';
import { createAdapter, ClaudeCodeAdapter, CodexCliAdapter, OpenCodeAdapter } from './adapters/index.js';
import { MonitorAdapter } from './adapters/monitor.js';
import { UtilityProxy } from './utility-proxy.js';
import { BridgeLogStream } from './log-stream.js';
import { extractTopicHint, summarizeResponse } from './timeline-summarizer.js';
import { cleanDetailText } from '@agentdeck/shared';
import { VoiceAssistantManager } from './voice-assistant.js';
import { TerminalStatus } from './terminal-status.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  listActive as listActiveSessions,
  findAvailablePort,
  detectTmuxSession,
} from './session-registry.js';
import { fetchUsageFromApi, hasOAuthToken } from './usage-api.js';
import { buildUsageEvent } from './usage-event.js';
import { getLanIp } from '@agentdeck/shared';
import { buildEnrichedSessionsList } from './session-aggregator.js';
import {
  initModules,
  stopModules,
  createDefaultModules,
  SerialModule,
} from './modules/index.js';
import type { ModuleConfigs } from './modules/types.js';
import type { HookServer } from './hook-server.js';
import {
  onESP32Message,
  sendWifiProvisionToAll,
} from './esp32-serial.js';
import { loadWifiConfig } from './wifi-config.js';
import { getAdbDeviceCount } from './adb-reverse.js';
import { esp32ConnectionCount, getESP32Ports } from './esp32-serial.js';
import { getPixooDeviceDetails, getLastFrame, renderPreviewFrame } from './pixoo/pixoo-bridge.js';
import {
  BRIDGE_WS_PORT,
  State,
  type PluginCommand,
  type BridgeEvent,
  type StateSnapshot,
  type AdapterEvent,
  type AgentType,
  type ModelCatalogEntry,
  type EncoderSlotState,
  type EncoderStateEvent,
  type ButtonSlotState,
  type ButtonStateEvent,
  type DeckSlotMapEvent,
  type UtilityCommand,
} from './types.js';

// ===== Prompt templates =====

interface PromptTemplate {
  label: string;
  prompt: string;
}

function loadTemplates(): PromptTemplate[] {
  try {
    const candidates = [
      resolve(dirname(fileURLToPath(import.meta.url)), '../../config/prompt-templates.json'),
      resolve(process.cwd(), 'config/prompt-templates.json'),
    ];
    for (const p of candidates) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf-8'));
        if (Array.isArray(data?.templates)) {
          debug('agentdeck', `Loaded ${data.templates.length} templates from ${p}`);
          return data.templates;
        }
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  return [];
}

const promptTemplates = loadTemplates();

// log(), logError(), debug() imported from logger.ts
// log() is suppressed after setPtyMode(true) — startup messages still shown

/** Extract tool input for timeline display */
function formatToolInputForTimeline(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const keyMap: Record<string, string> = {
    Bash: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path',
    Glob: 'pattern', Grep: 'pattern', WebFetch: 'url', WebSearch: 'query', Task: 'prompt',
  };
  const key = keyMap[toolName];
  if (key && typeof input[key] === 'string') {
    const line = (input[key] as string).split('\n')[0];
    return line.length > 120 ? line.slice(0, 119) + '\u2026' : line;
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 200) {
      const line = v.split('\n')[0];
      return line.length > 120 ? line.slice(0, 119) + '\u2026' : line;
    }
  }
  return null;
}

// ===== Session options =====

export interface SessionOptions {
  agentType: AgentType;
  port?: number;
  command?: string;
  gatewayUrl?: string;
  debug?: boolean;
  noUpdateCheck?: boolean;
  wakeWord?: boolean;
  postit?: boolean;
  modules?: ModuleConfigs;
}

// ===== startSession =====

export async function startSession(opts: SessionOptions): Promise<void> {
  const agentType = opts.agentType;

  if (opts.debug) {
    enableDebugLog();
    log('Debug logging enabled');
  }

  // Dependency check (skip for monitor — no PTY needed)
  if (agentType !== 'monitor') {
    const deps = checkDependencies(agentType);
    if (!deps.ok) process.exit(1);
    for (const w of deps.warnings) log(`WARNING: ${w}`);

    // Version compatibility check (Claude Code only — uses npm registry + compatibleClaudeCode range)
    if (agentType === 'claude-code' && !opts.noUpdateCheck) {
      const { checkVersionCompatibility } = await import('./version-check.js');
      const versionResult = await checkVersionCompatibility({
        skipCheck: false,
        claudeCodeVersion: deps.agentVersion,
      });
      for (const w of versionResult.warnings) log(`WARNING: ${w}`);
      if (versionResult.restartNeeded) {
        log('AgentDeck updated. Please restart.');
        process.exit(0);
      }
    }
  }

  // Multi-session port allocation
  const requestedPort = opts.port ?? BRIDGE_WS_PORT;
  let port = requestedPort === BRIDGE_WS_PORT ? await findAvailablePort() : requestedPort;
  if (port !== requestedPort) {
    log(`Port ${requestedPort} in use, using ${port}`);
  }

  // Auto-migrate hooks (Claude Code mode only)
  if (agentType === 'claude-code') {
    migrateHooksIfNeeded();
  }

  const tmuxSession = detectTmuxSession();
  const parentTty = (() => {
    try { return execSync('tty', { stdio: ['inherit', 'pipe', 'pipe'] }).toString().trim(); }
    catch { return undefined; }
  })();
  const projectName = process.cwd().split('/').pop() || 'unknown';

  // Warn if same project is already running
  const existingSessions = listActiveSessions();
  const sameProject = existingSessions.filter((s) => s.projectName === projectName);
  if (sameProject.length > 0) {
    const ports = sameProject.map((s) => s.port).join(', ');
    log(`\u26A0 Session "${projectName}" already running on port ${ports}. Starting new session on port ${port}.`);
  }

  log(`Starting AgentDeck bridge on port ${port} (agent: ${agentType})...`);

  // ===== Create adapter =====
  const adapter = createAdapter(agentType, opts.gatewayUrl);

  // ===== Start adapter (creates HTTP server, spawns process) =====
  try {
    await adapter.start({ port, command: opts.command, gatewayUrl: opts.gatewayUrl });
    log(`Adapter started: ${adapter.capabilities.displayName}`);
  } catch (err) {
    log(`Failed to start adapter: ${err}`);
    process.exit(1);
  }

  // Suppress stderr logging once PTY is active (PTY adapters share terminal)
  // Non-PTY adapters (Monitor, OpenClaw) keep logs visible
  if (adapter.capabilities.hasTerminal) {
    setPtyMode(true);
  }

  // ===== BridgeCore =====
  const core = new BridgeCore({
    port,
    projectName: adapter.getProjectName() || projectName,
    httpServer: adapter.getHttpServer(),
  });

  // ===== Session-specific components =====
  const voiceManager = new VoiceManager();
  const utilityProxy = new UtilityProxy();
  const journal = new EventJournal();
  const ptyRingBuffer = new PtyRingBuffer();
  let cachedSlotMap: DeckSlotMapEvent | null = null;
  let previousBridgeState: State = State.IDLE;

  // Timeline log stream (OpenClaw/Claude Code)
  const bridgeLogStream = agentType === 'openclaw' ? new BridgeLogStream() : null;

  // Voice server (non-blocking)
  voiceManager.connectToServer().catch((err) => {
    debug('agentdeck', `whisper-server connection failed: ${err}`);
  });

  // Voice assistant (wake word → STT → LLM → TTS)
  let voiceAssistant: VoiceAssistantManager | null = null;
  if (opts.wakeWord) {
    voiceAssistant = new VoiceAssistantManager({
      sendPrompt: (text) => {
        if (adapter.handleCommand({ type: 'send_prompt', text })) {
          core.stateMachine.handleUserAction('send_prompt');
        } else {
          // Fallback for PTY-based adapters
          adapter.writeInput(text);
          setTimeout(() => adapter.writeInput('\r'), 50);
          core.stateMachine.handleUserAction('send_prompt');
        }
      },
      transcribeFile: (filePath) => voiceManager.transcribeFile(filePath),
      isPttRecording: () => voiceManager.isRecording(),
    });

    // Wire state broadcasts
    voiceAssistant.on('state_change', (info: { state: string; text?: string; responseText?: string }) => {
      // Broadcast dedicated event (for plugin FORWARDED_EVENTS)
      core.broadcast({
        type: 'voice_assistant_state',
        state: info.state,
        deviceId: 'mac-builtin',
        text: info.text,
        responseText: info.responseText,
      } as BridgeEvent);
      // Piggyback on state_update so all clients get it automatically
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

    // Start (non-blocking)
    voiceAssistant.start().then((ok) => {
      if (ok) log('Wake word voice assistant active ("오픈클로")');
      else log('Wake word not available (missing model or access key)');
    }).catch((err) => {
      log(`Wake word start failed: ${err}`);
    });
  }

  // SSE broadcast (ClaudeCodeAdapter / MonitorAdapter have HookServer)
  let hookServer: HookServer | null = null;
  if (adapter instanceof ClaudeCodeAdapter) {
    hookServer = adapter.getClaudeHookServer();
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.onApiUsage(() => ({ usage: core.cachedApiUsage, fetchedAt: core.lastApiFetchTime }));
    hookServer.pairingToken = core.authToken;
  } else if (adapter instanceof CodexCliAdapter) {
    hookServer = adapter.getCodexHookServer();
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.pairingToken = core.authToken;
  } else if (adapter instanceof OpenCodeAdapter) {
    hookServer = adapter.getHookServer();
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.pairingToken = core.authToken;
  } else if (adapter instanceof MonitorAdapter) {
    hookServer = adapter.getHookServer();
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.onApiUsage(() => ({ usage: core.cachedApiUsage, fetchedAt: core.lastApiFetchTime }));
    hookServer.pairingToken = core.authToken;
  }
  const broadcastSse = (event: BridgeEvent) => hookServer?.broadcastSse(event);
  core.setSseBroadcast(broadcastSse);

  // ===== Display monitor =====
  core.wireDisplayMonitor();

  // ===== Terminal status (tab title + user vars) =====
  const postit = opts.postit !== false && adapter.capabilities.hasTerminal
    ? new TerminalStatus(process.stdout)
    : null;

  // Register process handlers early (before module init) so uncaughtException
  // handler is active before mDNS module starts — suppresses "already in use" errors
  core.registerProcessHandlers('agentdeck');

  // Override unhandledRejection to not shutdown (index.ts original behavior)
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => {
    debug('Bridge', `Unhandled rejection: ${reason}`);
    debug('Bridge', `Unhandled rejection stack: ${reason instanceof Error ? reason.stack : reason}`);
    // Don't shutdown — non-fatal
  });

  // ===== Device modules =====
  const moduleConfigs: ModuleConfigs = opts.modules ?? {
    mdns: false,   // daemon-only — session bridges never advertise mDNS
    adb: 'auto',
    serial: false, // daemon-only — session bridges never talk to ESP32
    pixoo: false,  // daemon-only — session bridges never talk to Pixoo
  };
  const deviceModules = createDefaultModules(agentType);

  // Set up ESP32 state provider before module init
  let lastStateEvent: BridgeEvent | null = null;
  const serialModule = deviceModules.find(m => m.name === 'serial') as SerialModule | undefined;
  if (serialModule) {
    serialModule.setStateProvider(() => lastStateEvent);
    serialModule.setUsageProvider(() => core.buildUsage());
    serialModule.setInitialStateProvider(() => {
      const events: BridgeEvent[] = [];
      if (lastStateEvent) events.push(lastStateEvent);
      events.push(core.buildUsage());
      events.push({ type: 'display_state', displayOn: core.displayMonitor.isDisplayOn() } as BridgeEvent);
      core.broadcastSessionsList().catch(() => {});
      return events;
    });
    // Include ESP32 serial connections in client count for polling guards
    core.setExternalClientCountProvider(() => esp32ConnectionCount());
  }

  const startedModules = await initModules(deviceModules, moduleConfigs, {
    port,
    authToken: core.authToken,
    projectName,
    wsServer: core.wsServer,
    broadcastSse,
  });

  // WiFi auto-provisioning for ESP32
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
        log(`WiFi provision sent to ESP32 on ${portPath}`);
      } else if (msg.type === 'wifi_provision_ack') {
        log(msg.success ? `ESP32 WiFi connected: ${msg.ip} \u2713` : `ESP32 WiFi failed: ${msg.error || 'unknown'}`);
      }
    });
  }

  log(`WebSocket server ready on port ${port}`);
  log(`Auth token ready. Pairing URL: ${core.wsUrl}`);

  // Device info getter for GET /devices
  hookServer?.setDeviceInfoGetter(() => ({
    devices: [
      { type: 'websocket', count: core.wsServer.getClientCount() },
      { type: 'esp32', count: esp32ConnectionCount(), ports: getESP32Ports() },
      { type: 'pixoo', details: getPixooDeviceDetails() },
      { type: 'adb', count: getAdbDeviceCount() },
    ],
  }));

  // Pixoo live preview frame getter for GET /pixoo/frame
  hookServer?.setPixooFrameGetter(() => getLastFrame() ?? renderPreviewFrame());

  // ===== Diagnostics =====
  adapter.onDiag((tail) => createDiagDump(core.stateMachine, core.wsServer, journal, ptyRingBuffer, tail));
  adapter.onRawData((data: string) => {
    ptyRingBuffer.push(data);
    const preview = data.replace(/[\x00-\x1f\x1b]/g, '').slice(0, 200);
    journal.write('pty_chunk', 'pty', { size: data.length, preview });
  });

  // Voice errors
  voiceManager.on('error', (err: Error) => {
    debug('agentdeck', `Voice error: ${err.message}`);
    core.wsServer.broadcast({ type: 'voice_state', state: 'error', error: err.message } as any);
  });

  // ===== Timeline wiring =====
  core.wireTimeline(bridgeLogStream ?? undefined);

  // Claude Code hook events → timeline entries
  if (agentType === 'claude-code') {
    wireClaudeCodeTimeline(adapter, core, journal);
  }

  // ===== Wire adapter events → StateMachine + journal =====
  adapter.on('event', (evt: AdapterEvent) => {
    switch (evt.source) {
      case 'hook':
        journal.write('hook', 'hook', { event: evt.event, data: evt.data });
        if (evt.event === 'shutdown') {
          shutdown();
          return;
        }
        core.stateMachine.handleHookEvent(evt.event, evt.data);
        break;

      case 'parser':
        journal.write('parser_emit', 'pty', { event: evt.event, ...evt.data });
        core.stateMachine.handleParserEvent(evt.event, evt.data);
        break;

      case 'metadata':
        switch (evt.event) {
          case 'cursor_update':
            core.stateMachine.updateCursorIndex((evt.data?.cursorIndex as number) ?? 0, 'pty');
            break;
          case 'usage_info':
            core.usageTracker.setUsageInfo(evt.data);
            core.broadcastUsage();
            break;
          case 'user_prompt': {
            const text = evt.data?.text as string | undefined;
            if (text) core.broadcast({ type: 'user_prompt', text } as BridgeEvent);
            break;
          }
          case 'model_catalog': {
            const models = evt.data?.models as ModelCatalogEntry[] | undefined;
            if (models) {
              core.cachedModelCatalog = models;
              debug('agentdeck', `Model catalog updated: ${models.length} models`);
              const snap = core.stateMachine.getSnapshot();
              const stateEvent = core.buildStateEvent({
                agentType: adapter.capabilities.type,
                snapshot: snap,
              });
              core.broadcast(stateEvent);
              lastStateEvent = stateEvent;
              core.broadcastUsage();
            }
            break;
          }
        }
        break;

      case 'activity':
        core.stateMachine.onPtyActivity();
        break;

      case 'connection': {
        const connEvt: BridgeEvent = { type: 'connection', status: evt.status };
        core.broadcast(connEvt);
        if (evt.status === 'connected' && bridgeLogStream) bridgeLogStream.start();
        else if (evt.status === 'disconnected' && bridgeLogStream) bridgeLogStream.stop();
        break;
      }

      case 'timeline': {
        if (evt.upsert) {
          core.bridgeTimeline.upsertEntry(evt.entry);
        } else {
          core.bridgeTimeline.addEntry(evt.entry);
        }
        if (evt.entry.type === 'tool_request' && bridgeLogStream) {
          bridgeLogStream.trackToolRequest(evt.entry.raw);
        }
        break;
      }
    }
  });

  // Adapter exit — always shutdown (shutdownInProgress guard prevents double-shutdown)
  adapter.on('exit', (code, signal) => {
    log(`Agent process exited (code=${code}, signal=${signal})`);
    shutdown();
  });

  // Default idle button config
  const DEFAULT_IDLE_BUTTONS: { label: string; action: string }[] = [
    { label: 'GO ON', action: 'continue' },
    { label: 'REVIEW', action: '/review' },
    { label: 'COMMIT', action: '/commit' },
    { label: 'CLEAR', action: '/clear' },
  ];

  // ===== State changed → broadcast =====
  core.stateMachine.on('state_changed', (snapshot: StateSnapshot) => {
    postit?.update(snapshot);
    // Voice assistant: reset timeout on any activity during processing
    if (snapshot.state === State.PROCESSING && voiceAssistant?.getState() === 'processing') {
      voiceAssistant.resetResponseTimeout();
    }

    // PROCESSING→IDLE: fetch fresh usage + voice assistant TTS
    const wasActive = previousBridgeState === State.PROCESSING;
    previousBridgeState = snapshot.state;
    if (wasActive && snapshot.state === State.IDLE) {
      if (core.wsServer.getClientCount() > 0 && Date.now() - core.lastApiFetchTime > 10_000) {
        core.fetchAndUpdateUsage().catch(() => {});
      }

      // Voice assistant: if processing a wake-word prompt, speak the response
      if (voiceAssistant?.getState() === 'processing') {
        const lastEntry = core.bridgeTimeline.getLastEntry('chat_end');
        const responseText = lastEntry?.detail;
        if (responseText) {
          voiceAssistant.handleResponse(responseText).catch((err) => {
            debug('agentdeck', `Voice assistant TTS error: ${err}`);
          });
        } else {
          // No response text available, return to idle
          voiceAssistant.handleResponse('완료했습니다.').catch(() => {});
        }
      }
    }

    hookServer?.setMeta({ state: snapshot.state, modelName: snapshot.modelName ?? undefined });
    journal.write('state_change', 'internal', { state: snapshot.state, permissionMode: snapshot.permissionMode, suggestedPrompt: snapshot.suggestedPrompt });

    const stateEvent = core.buildStateEvent({
      agentType: adapter.capabilities.type,
      snapshot,
    });
    core.broadcast(stateEvent);
    lastStateEvent = stateEvent;

    core.maybeBroadcastSessionsList();

    // Backward-compat prompt_options
    if (snapshot.options.length > 0) {
      let promptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        promptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        promptType = 'diff_review';
      }
      core.broadcast({
        type: 'prompt_options',
        promptType,
        question: snapshot.question ?? undefined,
        options: snapshot.options,
      } as BridgeEvent);
    }

    core.broadcastUsage();

    // Encoder + button state
    const encEvt = computeEncoderState();
    core.broadcast(encEvt);
    const btnEvt = computeButtonState();
    core.broadcast(btnEvt);
  });

  // ===== Commands from WS clients =====
  core.wsServer.onCommand((cmd: PluginCommand) => {
    debug('agentdeck', `pluginCmd: ${cmd.type}`);

    // Adapter-owned commands
    if (adapter.handleCommand(cmd)) {
      switch (cmd.type) {
        case 'respond': core.stateMachine.handleUserAction('respond'); break;
        case 'interrupt': core.stateMachine.handleUserAction('interrupt'); break;
        case 'escape': core.stateMachine.handleUserAction('interrupt'); break;
        case 'select_option': core.stateMachine.handleUserAction('select_option'); break;
        case 'send_prompt': core.stateMachine.handleUserAction('send_prompt'); break;
      }
      return;
    }

    // Bridge-coordinated commands
    switch (cmd.type) {
      case 'select_option': {
        const snapshot = core.stateMachine.getSnapshot();
        if (snapshot.navigable) {
          const delta = cmd.index - snapshot.cursorIndex;
          if (delta !== 0) {
            const arrow = delta > 0 ? '\x1b[B' : '\x1b[A';
            adapter.writeInput(arrow.repeat(Math.abs(delta)));
          }
          setTimeout(() => adapter.writeInput('\r'), 50 + Math.abs(delta) * 20);
        } else {
          adapter.writeInput(String(cmd.index + 1) + '\r');
        }
        core.stateMachine.handleUserAction('select_option');
        break;
      }

      case 'navigate_option': {
        const total = core.stateMachine.getOptionsCount();
        const cur = core.stateMachine.getCursorIndex();
        const newIdx = total > 0
          ? (cmd.direction === 'up' ? Math.max(cur - 1, 0) : Math.min(cur + 1, total - 1))
          : cur;
        core.stateMachine.updateCursorIndex(newIdx, 'optimistic');
        adapter.prepareForNavigation?.();
        adapter.writeInput(cmd.direction === 'up' ? '\x1b[A' : '\x1b[B');
        break;
      }

      case 'send_prompt': {
        let text = cmd.text;
        const templateMatch = text.match(/^__template:(\d+)$/);
        if (templateMatch) {
          const idx = parseInt(templateMatch[1], 10);
          if (idx >= 0 && idx < promptTemplates.length) {
            text = promptTemplates[idx].prompt;
          } else break;
        }
        if (text) {
          adapter.writeInput(text);
          setTimeout(() => adapter.writeInput('\r'), 50);
          core.stateMachine.handleUserAction('send_prompt');
        }
        break;
      }

      case 'utility':
        utilityProxy.handleCommand(cmd as UtilityCommand);
        core.broadcast(computeEncoderState());
        break;

      case 'voice':
        handleVoiceCommand(cmd.action, voiceManager, core);
        break;

      case 'query_usage':
        core.fetchAndUpdateUsage().catch(() => {});
        break;
    }
  });

  // Deck slot map relay
  core.wsServer.onRawMessage((msg, sender) => {
    if (msg.type === 'deck_slot_map') {
      cachedSlotMap = msg as unknown as DeckSlotMapEvent;
      core.wsServer.broadcastExcept(cachedSlotMap, sender);
      broadcastSse(cachedSlotMap);
      core.broadcast(computeButtonState());
      // Re-send sessions_list so slot buttons populate after plugin startup race
      core.broadcastSessionsList().catch(() => {});
      return true;
    }
    return false;
  });

  // WS connect/disconnect journal
  core.wsServer.onClientDisconnect(() => {
    journal.write('ws_event', 'ws', { action: 'disconnect', clients: core.wsServer.getClientCount() });
    hookServer?.setMeta({ clientCount: core.wsServer.getClientCount() });
  });

  // Kick initial state
  if (adapter.isAlive()) {
    core.stateMachine.handleHookEvent('SessionStart', {});
  }

  // Register session
  core.registerSession(agentType, {
    tmuxSession,
    parentTty,
    tty: adapter.getTtyPath(),
  });

  // ===== Client connect =====
  core.wsServer.onClientConnect((ws) => {
    journal.write('ws_event', 'ws', { action: 'connect', clients: core.wsServer.getClientCount() });
    hookServer?.setMeta({ clientCount: core.wsServer.getClientCount() });

    const snapshot = core.stateMachine.getSnapshot();

    // Restore suggested prompt on reconnect
    let reconnectSuggestion: string | null = snapshot.suggestedPrompt;
    if (!reconnectSuggestion && snapshot.state === State.IDLE) {
      reconnectSuggestion = core.stateMachine.getLastValidSuggestedPrompt();
    }

    // Build state event with capabilities for initial connect
    const stateEvent = core.buildStateEvent({
      agentType: adapter.capabilities.type,
      agentCapabilities: adapter.capabilities,
      snapshot,
    });
    // Override suggestedPrompt with reconnect value
    if (reconnectSuggestion) {
      (stateEvent as any).suggestedPrompt = reconnectSuggestion;
    }

    // Extra events for initial state
    const extraEvents: BridgeEvent[] = [];

    // Backward-compat prompt_options
    if (snapshot.options.length > 0) {
      let initPromptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        initPromptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        initPromptType = 'diff_review';
      }
      extraEvents.push({
        type: 'prompt_options',
        promptType: initPromptType,
        question: snapshot.question ?? undefined,
        options: snapshot.options,
      } as BridgeEvent);
    }

    // Encoder + button state
    extraEvents.push(computeEncoderState());
    extraEvents.push(computeButtonState());

    // Slot map
    if (cachedSlotMap) extraEvents.push(cachedSlotMap);

    core.sendInitialState(ws, {
      agentType: adapter.capabilities.type,
      agentCapabilities: adapter.capabilities,
      isAlive: adapter.isAlive(),
      extraEvents,
    });
  });

  // ===== Terminal attachment =====
  if (adapter.capabilities.hasTerminal) {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    adapter.attachTerminal(process.stdin, process.stdout);
  }

  // ===== Polling =====
  core.startUsageTick();
  core.startApiUsagePolling(90_000);
  core.startOllamaProbe();
  core.startMlxProbe();
  core.startAntigravityProbe();
  core.startGatewayProbe(800);
  core.startGatewayHealthCheck();
  core.startSessionsListPolling();

  // Inject virtual OpenClaw session when Gateway is detected (same as daemon-server.ts)
  core.setSessionsEnricher((sessions) => {
    if (!core.cachedGatewayAvailable) return sessions;
    if (sessions.some(s => s.agentType === 'openclaw')) return sessions;
    return [...sessions, {
      id: 'openclaw-gateway',
      port: 18789,
      projectName: 'OpenClaw',
      agentType: 'openclaw' as const,
      alive: true,
    }];
  });

  // ===== Encoder state computation =====
  function computeEncoderState(): EncoderStateEvent {
    const snapshot = core.stateMachine.getSnapshot();
    const isInteractive = snapshot.state === State.AWAITING_OPTION ||
      snapshot.state === State.AWAITING_PERMISSION ||
      snapshot.state === State.AWAITING_DIFF;

    const utilState = utilityProxy.getState();
    const e1: EncoderSlotState = {
      slot: 0, encoderType: 'utility',
      header: utilState.mode.toUpperCase(),
      value: utilState.value, icon: utilState.icon,
      accentColor: '#3b82f6', progress: utilState.level,
    };

    const e2: EncoderSlotState = {
      slot: 1, encoderType: 'action',
      header: 'ACTION', accentColor: '#f59e0b',
    };
    if (isInteractive && snapshot.options.length > 0) {
      const opt = snapshot.options[snapshot.cursorIndex];
      e2.header = 'OPTION';
      e2.value = opt?.label ?? '';
      e2.counter = `${snapshot.cursorIndex + 1}/${snapshot.options.length}`;
      e2.detail = opt?.label;
    } else if (snapshot.suggestedPrompt) {
      e2.header = 'PROMPT';
      e2.value = snapshot.suggestedPrompt;
    }

    const pct5 = core.cachedApiUsage?.fiveHourPercent ?? null;
    const pct7 = core.cachedApiUsage?.sevenDayPercent ?? null;
    const worstPct = Math.max(pct5 ?? 0, pct7 ?? 0);
    const usageColor = worstPct > 80 ? '#ef4444' : worstPct > 50 ? '#eab308' : '#22c55e';
    const e3: EncoderSlotState = {
      slot: 2, encoderType: 'usage',
      header: 'USAGE',
      value: pct5 != null ? `${Math.round(pct5)}% / ${Math.round(pct7 ?? 0)}%` : '\u2014',
      accentColor: usageColor,
      progress: worstPct / 100,
    };

    const isRec = voiceManager.isRecording();
    const e4: EncoderSlotState = {
      slot: 3, encoderType: 'voice',
      header: 'VOICE', value: isRec ? 'Recording...' : 'Ready',
      icon: isRec ? '\uD83D\uDD34' : '\uD83C\uDFA4',
      accentColor: isRec ? '#ef4444' : '#8b5cf6',
      voiceState: isRec ? 'recording' : 'idle',
    };

    return {
      type: 'encoder_state',
      encoders: [e1, e2, e3, e4],
      takeoverActive: isInteractive && snapshot.options.length > 0,
    };
  }

  // ===== Button state computation =====
  function computeButtonState(): ButtonStateEvent {
    const snapshot = core.stateMachine.getSnapshot();
    const st = snapshot.state;
    const mode = snapshot.permissionMode;
    const options = snapshot.options;
    const isInteractive = st === State.AWAITING_OPTION ||
      st === State.AWAITING_PERMISSION ||
      st === State.AWAITING_DIFF;

    const DIM: ButtonSlotState = {
      slot: 0, title: '', bgColor: '#1a1a1a', textColor: '#444444',
      enabled: false, dim: true,
    };

    function getIdleButtons(): { label: string; action: string }[] {
      if (!cachedSlotMap) return DEFAULT_IDLE_BUTTONS;
      const responseSlots = cachedSlotMap.buttons
        .filter(s => s.actionType === 'response-button')
        .sort((a, b) => a.slot - b.slot);
      if (responseSlots.length === 0) return DEFAULT_IDLE_BUTTONS;
      return responseSlots.map((s, i) => ({
        label: (s.settings?.label as string) ?? DEFAULT_IDLE_BUTTONS[i]?.label ?? '',
        action: (s.settings?.action as string) ?? DEFAULT_IDLE_BUTTONS[i]?.action ?? '',
      }));
    }

    function colorForOption(opt: import('./types.js').PromptOption): { bg: string; text: string } {
      const shortcut = (opt.shortcut ?? '').toLowerCase();
      const lower = opt.label.toLowerCase();
      if (lower.startsWith('always')) return { bg: '#1e40af', text: '#ffffff' };
      if (/don[''\u2019]t\s+ask\s+again/i.test(lower)) return { bg: '#1e40af', text: '#ffffff' };
      if (/allow\s+all\s+sessions/i.test(lower)) return { bg: '#1e40af', text: '#ffffff' };
      if (shortcut === 'n' || shortcut === 'd' || lower.startsWith('no') || lower.startsWith('deny')) return { bg: '#991b1b', text: '#ffffff' };
      if (shortcut === 'y' || shortcut === 'a') return { bg: '#166534', text: '#ffffff' };
      if (opt.recommended) return { bg: '#1e4d2b', text: '#86efac' };
      return { bg: '#1e3a5f', text: '#93c5fd' };
    }

    function uppercaseShort(label: string): string {
      return label.length <= 12 ? label.toUpperCase() : label;
    }

    const buttons: ButtonSlotState[] = [];

    // Slot 0: Mode
    const modeColors: Record<string, string> = {
      default: '#2a2a2a', plan: '#7c3aed', acceptEdits: '#2563eb',
      dontAsk: '#0e7490', bypassPermissions: '#991b1b',
    };
    const modeLabels: Record<string, string> = {
      default: 'DEFAULT', plan: 'PLAN', acceptEdits: 'ACCEPT',
      dontAsk: "DON'T ASK", bypassPermissions: 'BYPASS',
    };
    const modeEnabled = st === State.IDLE;
    buttons.push({
      slot: 0,
      title: modeLabels[mode] ?? 'DEFAULT',
      subtitle: 'Mode',
      bgColor: modeEnabled ? (modeColors[mode] ?? '#2a2a2a') : '#1a1a1a',
      textColor: modeEnabled ? '#ffffff' : '#444444',
      enabled: modeEnabled,
      action: modeEnabled ? 'switch_mode' : undefined,
      dim: !modeEnabled,
    });

    // Slot 1: Session/Status
    if (st === State.IDLE) {
      const effortSuffix = snapshot.effortLevel && snapshot.effortLevel !== 'medium' ? snapshot.effortLevel : null;
      const sessionSubtitle = effortSuffix && snapshot.modelName
        ? `${snapshot.modelName} \u00B7 ${effortSuffix}` : snapshot.modelName ?? undefined;
      buttons.push({
        slot: 1, title: snapshot.projectName ?? '\u2014',
        subtitle: sessionSubtitle, bgColor: '#1e293b', textColor: '#ffffff', enabled: false,
      });
    } else if (st === State.PROCESSING) {
      buttons.push({
        slot: 1, title: snapshot.currentTool ?? '...',
        subtitle: snapshot.toolProgress ?? undefined,
        bgColor: '#1e3a5f', textColor: '#93c5fd', enabled: false,
      });
    } else if (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF) {
      buttons.push({ slot: 1, title: 'PERMIT?', bgColor: '#b45309', textColor: '#ffffff', enabled: false });
    } else if (st === State.AWAITING_OPTION) {
      buttons.push({ slot: 1, title: 'SELECT', bgColor: '#b45309', textColor: '#ffffff', enabled: false });
    } else {
      buttons.push({ ...DIM, slot: 1 });
    }

    // Slot 2: Usage
    const pct = core.cachedApiUsage?.fiveHourPercent ?? null;
    const usageText = pct != null ? `${Math.round(pct)}%` : '\u2014';
    const usageBg = pct == null ? '#1e293b' : pct >= 90 ? '#991b1b' : pct >= 70 ? '#92400e' : '#166534';
    buttons.push({ slot: 2, title: usageText, subtitle: '5h', bgColor: usageBg, textColor: '#ffffff', enabled: false });

    // Slots 3-6: Response buttons
    if (st === State.IDLE) {
      const idleBtns = getIdleButtons();
      for (let i = 0; i < 4; i++) {
        const btn = idleBtns[i];
        if (btn) {
          const isGoOn = btn.action === 'continue' || btn.label.toLowerCase() === 'go on';
          buttons.push({
            slot: 3 + i, title: btn.label,
            bgColor: isGoOn ? '#1e3a2f' : '#1e293b',
            textColor: isGoOn ? '#22c55e' : '#ffffff',
            enabled: true, action: `command:${btn.action === 'continue' ? 'go on' : btn.action}`,
          });
        } else {
          buttons.push({ ...DIM, slot: 3 + i });
        }
      }
    } else if (st === State.PROCESSING) {
      for (let i = 0; i < 4; i++) buttons.push({ ...DIM, slot: 3 + i });
    } else if (isInteractive) {
      if (options.length === 0 && st === State.AWAITING_PERMISSION) {
        buttons.push({ slot: 3, title: 'YES', bgColor: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:y' });
        buttons.push({ slot: 4, title: 'NO', bgColor: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:n' });
        buttons.push({ slot: 5, title: 'ALWAYS', bgColor: '#1e40af', textColor: '#ffffff', enabled: true, action: 'respond:a' });
        buttons.push({ ...DIM, slot: 6 });
      } else if (options.length === 0 && st === State.AWAITING_DIFF) {
        buttons.push({ slot: 3, title: 'APPLY', bgColor: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:a' });
        buttons.push({ slot: 4, title: 'DENY', bgColor: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:d' });
        buttons.push({ slot: 5, title: 'VIEW', bgColor: '#1e3a5f', textColor: '#93c5fd', enabled: true, action: 'respond:v' });
        buttons.push({ ...DIM, slot: 6 });
      } else if (options.length <= 4) {
        for (let i = 0; i < 4; i++) {
          if (i < options.length) {
            const opt = options[i];
            const colors = (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF)
              ? colorForOption(opt) : opt.recommended ? { bg: '#1e4d2b', text: '#86efac' } : { bg: '#1e3a5f', text: '#93c5fd' };
            const action = snapshot.navigable
              ? `select_option:${opt.index}` : `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`;
            buttons.push({
              slot: 3 + i, title: uppercaseShort(opt.label),
              bgColor: colors.bg, textColor: colors.text,
              enabled: true, badge: opt.recommended ? '\u2605' : opt.selected ? '\u2713' : undefined,
              action,
            });
          } else {
            buttons.push({ ...DIM, slot: 3 + i });
          }
        }
      } else {
        for (let i = 0; i < 3; i++) {
          const opt = options[i];
          const colors = (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF)
            ? colorForOption(opt) : opt.recommended ? { bg: '#1e4d2b', text: '#86efac' } : { bg: '#1e3a5f', text: '#93c5fd' };
          const action = snapshot.navigable
            ? `select_option:${opt.index}` : `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`;
          buttons.push({
            slot: 3 + i, title: uppercaseShort(opt.label),
            bgColor: colors.bg, textColor: colors.text, enabled: true, action,
          });
        }
        buttons.push({ slot: 6, title: 'MORE \u25BC', bgColor: '#334155', textColor: '#94a3b8', enabled: true, action: 'expand_options' });
      }
    } else {
      for (let i = 0; i < 4; i++) buttons.push({ ...DIM, slot: 3 + i });
    }

    // Slot 7: Stop/ESC
    if (st === State.PROCESSING) {
      buttons.push({ slot: 7, title: 'STOP', bgColor: '#cc0000', textColor: '#ffffff', enabled: true, action: 'interrupt' });
    } else if (isInteractive) {
      buttons.push({ slot: 7, title: 'ESC', bgColor: '#b45309', textColor: '#ffffff', enabled: true, action: 'escape' });
    } else if (st === State.IDLE) {
      buttons.push({ slot: 7, title: 'ESC', bgColor: '#3d2607', textColor: '#ffb347', enabled: true, action: 'escape', dim: false });
    } else {
      buttons.push({ ...DIM, slot: 7 });
    }

    return { type: 'button_state', buttons };
  }

  // ===== Shutdown =====

  let shutdownInProgress = false;

  function shutdown(): void {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    // Hard failsafe — exit no matter what after 3s
    setTimeout(() => process.exit(0), 3000).unref();

    log('Shutting down...');

    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners();

    postit?.cleanup();
    utilityProxy.cleanup();
    voiceAssistant?.stop();
    voiceManager.disconnectFromServer();
    bridgeLogStream?.stop();
    journal.close();

    core.onShutdown(async () => {
      await Promise.all([
        adapter.shutdown(),
        stopModules(startedModules).catch(() => {}),
      ]);
      process.exit(0);
    });
    core.shutdown();
  }

}

// ===== Claude Code timeline wiring =====

function wireClaudeCodeTimeline(
  adapter: import('./types.js').AgentAdapter,
  core: BridgeCore,
  journal: EventJournal,
): void {
  let ccLastState: string | null = null;
  let ccChatStart: number | null = null;
  let ccPendingChatStart = false;
  let ccPendingChatStartTimer: ReturnType<typeof setTimeout> | null = null;
  let ccLastPromptText: string | null = null;

  const emitChatStart = (text: string) => {
    if (ccPendingChatStartTimer) {
      clearTimeout(ccPendingChatStartTimer);
      ccPendingChatStartTimer = null;
    }
    ccPendingChatStart = false;
    ccLastPromptText = text || null;
    const snippet = text.length > 500 ? text.slice(0, 497) + '...' : text;
    const detail = text.length > 100 ? (text.length > 1000 ? text.slice(0, 1000) + '...' : text) : undefined;
    core.bridgeTimeline.addEntry({
      ts: ccChatStart ?? Date.now(), type: 'chat_start',
      raw: snippet || 'Prompt sent',
      ...(detail ? { detail } : {}),
      agentType: 'claude-code',
    });
  };

  adapter.on('event', (evt: AdapterEvent) => {
    if (evt.source === 'metadata' && evt.event === 'user_prompt' && ccPendingChatStart) {
      emitChatStart((evt.data?.text as string) || '');
    }
  });

  adapter.on('event', (evt: AdapterEvent) => {
    if (evt.source !== 'hook') return;
    const now = Date.now();
    switch (evt.event) {
      case 'UserPromptSubmit': {
        ccChatStart = now;
        core.usageTracker.resetToolCounts();
        ccPendingChatStart = true;
        const hookText = (evt.data?.prompt as string) || (evt.data?.text as string) || (evt.data?.message as string) || '';
        ccPendingChatStartTimer = setTimeout(() => {
          if (ccPendingChatStart) emitChatStart(hookText);
        }, 500);
        break;
      }
      case 'PreToolUse': {
        const toolName = (evt.data?.tool_name as string) || 'tool';
        const formatted = formatToolInputForTimeline(toolName, evt.data?.tool_input as Record<string, unknown> | undefined);
        core.bridgeTimeline.addEntry({
          ts: now, type: 'tool_request',
          raw: formatted ? `${toolName} ${formatted}` : toolName,
          agentType: 'claude-code',
        });
        break;
      }
      case 'PostToolUse':
        core.bridgeTimeline.addEntry({ ts: now, type: 'tool_resolved', raw: 'Approved', agentType: 'claude-code' });
        break;
      case 'Stop': {
        if (ccPendingChatStart) emitChatStart('');
        const duration = ccChatStart ? Math.round((now - ccChatStart) / 1000) : null;
        const toolSummary = core.usageTracker.getToolSummary();
        const lastAssistantMsg = (evt.data?.last_assistant_message as string) || '';
        const responseTopic = lastAssistantMsg ? extractTopicHint(lastAssistantMsg) : null;
        const promptTopic = ccLastPromptText ? extractTopicHint(ccLastPromptText) : null;
        const completedLabel = responseTopic || promptTopic || 'Completed';
        let summary = duration != null ? `${completedLabel} \u00B7 ${duration}s` : completedLabel;
        if (toolSummary) summary += ` \u00B7 ${toolSummary}`;
        let chatEndDetail: string | undefined;
        if (lastAssistantMsg) {
          const cleaned = cleanDetailText(lastAssistantMsg);
          chatEndDetail = cleaned ? (cleaned.length > 1000 ? cleaned.slice(0, 1000) + '...' : cleaned) : undefined;
        } else if (ccLastPromptText) {
          chatEndDetail = `Prompt: ${ccLastPromptText.length > 200 ? ccLastPromptText.slice(0, 200) + '...' : ccLastPromptText}`;
        }
        const chatEndTs = now;
        ccChatStart = null;
        ccLastPromptText = null;
        core.bridgeTimeline.addEntry({
          ts: chatEndTs, type: 'chat_end', raw: summary,
          ...(chatEndDetail ? { detail: chatEndDetail } : {}),
          agentType: 'claude-code',
        });

        // Async LLM summarization — fire-and-forget, upsert chat_end when ready
        if (lastAssistantMsg && lastAssistantMsg.length > 30) {
          const savedDuration = duration;
          const savedToolSummary = toolSummary;
          const savedDetail = chatEndDetail;
          summarizeResponse(lastAssistantMsg).then((llmSummary) => {
            if (llmSummary) {
              const enrichedParts = [llmSummary];
              if (savedDuration != null) enrichedParts.push(`${savedDuration}s`);
              if (savedToolSummary) enrichedParts.push(savedToolSummary);
              debug('timeline', `CC LLM summary: ${llmSummary}`);
              core.bridgeTimeline.upsertEntry({
                ts: chatEndTs, type: 'chat_end',
                raw: enrichedParts.join(' \u00B7 '),
                ...(savedDetail ? { detail: savedDetail } : {}),
                agentType: 'claude-code',
              });
            }
          }).catch(() => { /* summarization failed — keep heuristic */ });
        }
        break;
      }
    }
  });
}

// ===== Voice command handler =====

function handleVoiceCommand(
  action: 'start' | 'stop' | 'cancel',
  voiceManager: VoiceManager,
  core: BridgeCore,
): void {
  switch (action) {
    case 'start':
      voiceManager.startRecording();
      core.wsServer.broadcast({ type: 'voice_state', state: 'recording' } as any);
      break;
    case 'stop':
      core.wsServer.broadcast({ type: 'voice_state', state: 'transcribing' } as any);
      voiceManager.stopRecording().then((text) => {
        core.wsServer.broadcast({ type: 'voice_state', state: 'idle', text: text || '' } as any);
      }).catch((err) => {
        core.wsServer.broadcast({ type: 'voice_state', state: 'error', error: String(err) } as any);
      });
      break;
    case 'cancel':
      voiceManager.cancel();
      core.wsServer.broadcast({ type: 'voice_state', state: 'idle' } as any);
      break;
  }
}

// ===== Hook migration =====

import { migrateHooksIfNeeded } from '@agentdeck/hooks';
