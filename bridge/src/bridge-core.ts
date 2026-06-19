import type { Server } from 'http';
import type WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { UsageTracker } from './usage-tracker.js';
import { StateMachine } from './state-machine.js';
import { WsServer } from './ws-server.js';
import { OllamaProbe, type OllamaStatus } from './ollama-probe.js';
import { DisplayMonitor } from './display-monitor.js';
import { BridgeTimelineStore } from './timeline-store.js';
import type { BridgeLogStream } from './log-stream.js';
import { readAntigravityLocalStatus } from './antigravity-local.js';
import { buildSubscriptions, buildUsageEvent } from './usage-event.js';
import { readCodexAuthStatus } from './codex-auth.js';
import { fetchMlxModels } from './mlx-probe.js';
import { buildDisplayStateEvent } from './display-dim.js';
import { loadMlxSettings } from '@agentdeck/shared';
import { probeGateway, checkGatewayHealth } from './gateway-probe.js';
import { fetchUsageFromApi, hasOAuthToken, getTokenStatus, type ApiUsageData } from './usage-api.js';
import { buildEnrichedSessionsList } from './session-aggregator.js';
import {
  register as registerSession,
  deregister as deregisterSession,
} from './session-registry.js';
import type { ApmeModule } from './apme/index.js';
import { getOrCreateToken, getWsUrl } from './auth.js';
import { log, logError, debug } from './logger.js';
import { invalidateMdnsInstance, triggerMdnsRecovery, isNonFatalMdnsError } from './mdns.js';
import {
  State,
  type BridgeEvent,
  type StateSnapshot,
  type AgentType,
  type AgentCapabilities,
  type ModelCatalogEntry,
  type PluginCommand,
  type VoiceAssistantState,
} from './types.js';

// log(), logError(), debug() imported from logger.ts
// - log(): suppressed in PTY mode (after setPtyMode(true))
// - logError(): always shown (critical errors requiring user action)
// - debug(): file-only (when --debug enabled)

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

// ===== Options =====

export interface BridgeCoreOptions {
  port: number;
  sessionId?: string;
  projectName: string;
  httpServer: Server;
}

// ===== BridgeCore =====

/**
 * Shared infrastructure extracted from index.ts and daemon-server.ts.
 *
 * Manages: StateMachine, WsServer, UsageTracker, DisplayMonitor, OllamaProbe,
 * BridgeTimelineStore, auth, session registry, probes, polling, shutdown.
 *
 * Callers (startSession / startDaemon) wire adapters, voice, utility, etc.
 */
export class BridgeCore {
  // Core components
  readonly port: number;
  readonly sessionId: string;
  readonly projectName: string;
  readonly stateMachine: StateMachine;
  readonly usageTracker: UsageTracker;
  readonly wsServer: WsServer;
  readonly bridgeTimeline: BridgeTimelineStore;
  readonly displayMonitor: DisplayMonitor;
  readonly ollamaProbe: OllamaProbe;

  // Auth
  readonly authToken: string;
  readonly wsUrl: string;

  // State caches (public for caller access)
  cachedApiUsage: ApiUsageData | null = null;
  lastApiFetchTime = 0;
  oauthConnected: boolean;
  apiUsageStale = false;
  /** True when cachedApiUsage was synced from relay's already-adjusted values */
  apiUsagePreAdjusted = false;
  cachedOllamaStatus: OllamaStatus | null = null;
  cachedMlxModels: string[] | null = null;
  cachedAntigravityStatus = readAntigravityLocalStatus() ?? null;
  cachedGatewayAvailable = false;
  cachedGatewayConnected = false;
  cachedGatewayAuthStatus: 'gateway_not_found' | 'gateway_reachable' | 'gateway_token_missing' | 'pairing_required' | 'approval_pending' | 'connected' | 'auth_failed' | 'token_mismatch' | 'device_auth_invalid' | 'unsupported_protocol' = 'gateway_not_found';
  cachedGatewayHasError = false;
  cachedModelCatalog: ModelCatalogEntry[] | null = null;

  // Voice assistant state (for piggybacking on state_update)
  cachedVoiceAssistantState: VoiceAssistantState = 'disabled';
  cachedVoiceAssistantText: string | undefined;
  cachedVoiceAssistantResponseText: string | undefined;

  // Internal lifecycle tracking
  private intervals: ReturnType<typeof setInterval>[] = [];
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  private lastSessionsListBroadcast = 0;
  private shutdownInProgress = false;
  private shutdownCallbacks: (() => void | Promise<void>)[] = [];
  private sseBroadcast?: (evt: BridgeEvent) => void;

  /** Optional callback to enrich sessions_list (e.g., daemon injects Gateway virtual session) */
  private sessionsEnricher?: (sessions: import('./session-aggregator.js').EnrichedSession[]) => import('./session-aggregator.js').EnrichedSession[];

  /** Optional callback to expose daemon-owned device/module health on state_update. */
  private moduleHealthProvider?: () => Record<string, unknown>;

  /** External client count provider (e.g., ESP32 serial connections) */
  private externalClientCount: () => number = () => 0;

  /** Optional APME subsystem — set via setApme() after initApme() resolves. */
  private apme: ApmeModule | null = null;
  private apmeAgentType: AgentType | null = null;
  private apmeCwd: string | undefined;

  private static readonly USAGE_STALE_TTL = 10 * 60 * 1000; // 10 minutes

  constructor(opts: BridgeCoreOptions) {
    this.port = opts.port;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.projectName = opts.projectName;

    // Core components
    this.usageTracker = new UsageTracker();
    this.stateMachine = new StateMachine(this.usageTracker);
    this.ollamaProbe = new OllamaProbe();
    this.displayMonitor = new DisplayMonitor();
    this.bridgeTimeline = new BridgeTimelineStore();
    this.oauthConnected = hasOAuthToken();

    // Auth
    this.authToken = getOrCreateToken();
    this.wsUrl = getWsUrl(opts.port);

    // WebSocket server
    this.wsServer = new WsServer(opts.httpServer);
  }

  /** Set optional SSE broadcast callback (for HookServer-based sessions) */
  setSseBroadcast(cb: (evt: BridgeEvent) => void): void {
    this.sseBroadcast = cb;
  }

  /** Broadcast to WS + optional SSE */
  broadcast(evt: BridgeEvent): void {
    this.wsServer.broadcast(evt);
    this.sseBroadcast?.(evt);
  }

  // ===== Timeline wiring =====

  wireTimeline(logStream?: BridgeLogStream): void {
    // Attribute every entry to this session at *storage time* so history
    // replay (`timeline_history`) carries the same task/run/session metadata
    // as live `timeline_event` broadcasts. taskId/runId pull from live APME
    // state — turn rows inherit the active task header without each emitter
    // having to thread the task id through.
    //
    // Idempotent: caller-set fields take precedence. This means relayed
    // entries (e.g. timeline_event from session bridges into the daemon)
    // keep their original sessionId/taskId; only entries emitted on this
    // BridgeCore's own session get filled in.
    this.bridgeTimeline.setAttributor((entry) => {
      const apme = this.apme;
      const sessionId = entry.sessionId ?? this.sessionId;
      const taskId = entry.taskId ?? (apme ? apme.collector.getActiveTaskId(this.sessionId) ?? undefined : undefined);
      const runId = entry.runId ?? (apme ? apme.collector.getRunId(this.sessionId) ?? undefined : undefined);
      return {
        ...entry,
        projectName: entry.projectName ?? this.projectName,
        sessionId,
        ...(taskId ? { taskId } : {}),
        ...(runId ? { runId } : {}),
      };
    });

    if (logStream) {
      logStream.on('entry', (entry) => {
        this.bridgeTimeline.addEntry(entry);
      });
    }
    this.bridgeTimeline.onEntry((entry, upsert) => {
      // Entry is already attributed by the storage-time attributor above;
      // forward as-is. Doing the attribution here too would be redundant
      // (idempotent but wasteful) and risks divergence if the rule changes.
      const evt: BridgeEvent = { type: 'timeline_event', entry, ...(upsert ? { upsert: true } : {}) };
      this.broadcast(evt);
    });
  }

  // ===== Display monitor =====

  private _previousDisplayOn = true;
  private _wakeHandler: (() => void) | null = null;

  wireDisplayMonitor(): void {
    this.displayMonitor.start();
    this.displayMonitor.on('display_state_changed', (displayOn: boolean) => {
      // Detect wake transition (asleep → awake)
      if (displayOn && !this._previousDisplayOn) {
        this._wakeHandler?.();
      }
      this._previousDisplayOn = displayOn;
      const evt: BridgeEvent = buildDisplayStateEvent(displayOn) as BridgeEvent;
      this.broadcast(evt);
    });

    // Time-discontinuity safety net (python3 process may die during deep sleep)
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      if (now - lastTick > 15_000) {
        debug('core', `Time discontinuity (${now - lastTick}ms) — likely system wake`);
        this._wakeHandler?.();
      }
      lastTick = now;
    }, 5000);
  }

  /** Register a callback for system wake recovery. */
  onSystemWake(handler: () => void): void {
    this._wakeHandler = handler;
  }

  // ===== State event building =====

  /**
   * Build a state_update BridgeEvent.
   * Session mode passes full snapshot extras; daemon uses minimal fields.
   */
  buildStateEvent(opts: {
    agentType: AgentType;
    agentCapabilities?: AgentCapabilities;
    snapshot?: StateSnapshot;
  }): BridgeEvent {
    const snapshot = opts.snapshot ?? this.stateMachine.getSnapshot();
    const codexAuth = readCodexAuthStatus();
    const subscriptions = buildSubscriptions(codexAuth, this.cachedApiUsage, snapshot.billingType);

    // Compute promptType
    let promptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' | undefined;
    if (snapshot.options.length > 0) {
      promptType = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        promptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        promptType = 'diff_review';
      }
    }

    return {
      type: 'state_update',
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      agentType: opts.agentType,
      agentCapabilities: opts.agentCapabilities,
      currentTool: snapshot.currentTool ?? undefined,
      toolInput: snapshot.toolInput ?? undefined,
      toolProgress: snapshot.toolProgress ?? undefined,
      projectName: snapshot.projectName ?? this.projectName,
      modelName: snapshot.modelName ?? undefined,
      effortLevel: snapshot.effortLevel ?? undefined,
      billingType: snapshot.billingType,
      options: snapshot.options.length > 0 ? snapshot.options : undefined,
      promptType,
      question: snapshot.question ?? undefined,
      navigable: snapshot.navigable || undefined,
      cursorIndex: (snapshot.state === State.AWAITING_OPTION ||
                   snapshot.state === State.AWAITING_PERMISSION ||
                   snapshot.state === State.AWAITING_DIFF)
                   ? snapshot.cursorIndex : undefined,
      suggestedPrompt: snapshot.suggestedPrompt ?? undefined,
      modelCatalog: this.cachedModelCatalog ?? undefined,
      remoteUrl: snapshot.remoteUrl ?? undefined,
      pairingUrl: this.wsUrl,
      ollamaStatus: this.cachedOllamaStatus ?? undefined,
      mlxModels: this.cachedMlxModels ?? undefined,
      subscriptions: subscriptions ?? undefined,
      antigravityStatus: this.cachedAntigravityStatus ?? undefined,
      gatewayAvailable: this.cachedGatewayAvailable,
      gatewayConnected: this.cachedGatewayConnected,
      gatewayAuthStatus: this.cachedGatewayAuthStatus,
      gatewayHasError: this.cachedGatewayHasError,
      moduleHealth: this.moduleHealthProvider?.(),
      voiceAssistantState: this.cachedVoiceAssistantState !== 'disabled' ? this.cachedVoiceAssistantState : undefined,
      voiceAssistantText: this.cachedVoiceAssistantText,
      voiceAssistantResponseText: this.cachedVoiceAssistantResponseText,
    };
  }

  /** Update cached voice assistant state and trigger a state broadcast */
  updateVoiceAssistantState(
    vaState: VoiceAssistantState,
    text?: string,
    responseText?: string,
  ): void {
    this.cachedVoiceAssistantState = vaState;
    this.cachedVoiceAssistantText = text;
    this.cachedVoiceAssistantResponseText = responseText;
    // Trigger state_changed so callers rebuild and broadcast state_update
    this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
  }

  /** Build and return a usage event */
  buildUsage(): BridgeEvent {
    const snapshot = this.stateMachine.getSnapshot();
    return buildUsageEvent(
      snapshot,
      this.cachedApiUsage,
      this.oauthConnected,
      this.cachedOllamaStatus,
      this.cachedMlxModels,
      this.apiUsageStale,
      readCodexAuthStatus(),
      snapshot.billingType,
      this.cachedModelCatalog,
      this.cachedAntigravityStatus,
      this.apiUsagePreAdjusted,
    );
  }

  /** Broadcast current usage to all clients */
  broadcastUsage(): void {
    this.broadcast(this.buildUsage());
  }

  // ===== API Usage helpers =====

  /**
   * Update cached API usage and broadcast.
   * Handles billingType inference.
   */
  updateApiUsage(usage: ApiUsageData): void {
    this.cachedApiUsage = usage;
    this.lastApiFetchTime = Date.now();
    this.oauthConnected = true;
    this.apiUsageStale = false;
    this.apiUsagePreAdjusted = false; // raw data from API, needs adjustment
    if (usage.inferredBillingType) {
      this.stateMachine.inferBillingType(usage.inferredBillingType);
    }
    this.broadcastUsage();
  }

  /** Fetch usage from API and update cache. Returns true if successful. */
  async fetchAndUpdateUsage(): Promise<boolean> {
    const usage = await fetchUsageFromApi();
    if (usage) {
      this.updateApiUsage(usage);
      // Token status check — if expired, mark stale even though we got cached data
      const tokenStatus = getTokenStatus();
      if (tokenStatus === 'expired' || tokenStatus === 'missing') {
        this.apiUsageStale = true;
      }
      return true;
    }
    this.oauthConnected = hasOAuthToken();
    if (this.cachedApiUsage) this.apiUsageStale = true;
    return false;
  }

  /** Fetch usage if cache is stale or empty (best-effort, no throw) */
  async fetchUsageIfStale(): Promise<void> {
    const cacheAge = Date.now() - this.lastApiFetchTime;
    const cacheStale = this.lastApiFetchTime > 0 && cacheAge > 5 * 60 * 1000;
    if (!this.cachedApiUsage || cacheStale) {
      await this.fetchAndUpdateUsage().catch(() => {});
    }
  }

  // ===== Probes =====

  startOllamaProbe(intervalMs = 5000): void {
    this.ollamaProbe.getStatus().then((s) => {
      this.cachedOllamaStatus = s;
    }).catch(() => {});
    this.addInterval(setInterval(() => {
      this.ollamaProbe.getStatus().then((s) => {
        const changed = JSON.stringify(this.cachedOllamaStatus) !== JSON.stringify(s);
        this.cachedOllamaStatus = s;
        if (changed) this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
      }).catch(() => {});
    }, intervalMs));
  }

  startMlxProbe(intervalMs = 5000): void {
    // Exponential backoff when the MLX server is absent — mirrors Swift
    // DaemonServer.probeMLX (5s base, 2× grow, 30s cap). See
    // memory/bug_local_llm_probe_no_backoff.md for the original issue.
    const MAX_INTERVAL = 30_000;
    let failureCount = 0;
    let nextFireAt = 0;

    const probe = (): void => {
      const pin = loadMlxSettings().model;
      fetchMlxModels(pin).then((models) => {
        const success = Array.isArray(models) && models.length > 0;
        if (success) {
          failureCount = 0;
          nextFireAt = 0;
        } else {
          failureCount += 1;
          const wait = Math.min(intervalMs * 2 ** failureCount, MAX_INTERVAL);
          nextFireAt = Date.now() + wait;
        }
        const changed = JSON.stringify(this.cachedMlxModels) !== JSON.stringify(models);
        this.cachedMlxModels = models;
        if (changed) this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
      }).catch(() => {
        failureCount += 1;
        const wait = Math.min(intervalMs * 2 ** failureCount, MAX_INTERVAL);
        nextFireAt = Date.now() + wait;
      });
    };

    probe();
    this.addInterval(setInterval(() => {
      if (nextFireAt > 0 && Date.now() < nextFireAt) return;
      probe();
    }, intervalMs));
  }

  startAntigravityProbe(intervalMs = 15_000): void {
    this.cachedAntigravityStatus = readAntigravityLocalStatus() ?? null;
    this.addInterval(setInterval(() => {
      const next = readAntigravityLocalStatus() ?? null;
      const changed = JSON.stringify(this.cachedAntigravityStatus) !== JSON.stringify(next);
      this.cachedAntigravityStatus = next;
      if (changed) this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
    }, intervalMs));
  }

  startGatewayProbe(
    intervalMs: number,
    onAppeared?: () => void,
    onDisappeared?: () => void,
  ): void {
    const poll = async () => {
      const status = await probeGateway();
      const wasAvailable = this.cachedGatewayAvailable;
      this.cachedGatewayAvailable = status.available;

      if (status.available && !wasAvailable) {
        onAppeared?.();
      } else if (!status.available && wasAvailable) {
        this.cachedGatewayConnected = false;
        this.cachedGatewayAuthStatus = 'gateway_not_found';
        this.cachedGatewayHasError = false;
        onDisappeared?.();
      }
      if (status.available !== wasAvailable) {
        this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
      }
    };

    poll().catch(() => {});
    this.addInterval(setInterval(() => { poll().catch(() => {}); }, intervalMs));
  }

  startGatewayHealthCheck(intervalMs = 30_000, delayMs = 5000): void {
    const check = () => {
      if (!this.cachedGatewayAvailable) return;
      checkGatewayHealth().then((hasError) => {
        const changed = hasError !== this.cachedGatewayHasError;
        this.cachedGatewayHasError = hasError;
        if (changed) {
          this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
        }
      }).catch(() => {});
    };
    this.addTimeout(setTimeout(check, delayMs));
    this.addInterval(setInterval(check, intervalMs));
  }

  // ===== Polling =====

  /**
   * Start periodic usage tick (session timer on displays).
   * Also clears stale cache after USAGE_STALE_TTL.
   */
  startUsageTick(intervalMs = 5000): void {
    this.addInterval(setInterval(() => {
      if (!this.hasClients()) return;
      // TTL: keep last good cache, but mark it stale
      if (this.cachedApiUsage && this.lastApiFetchTime > 0 &&
          (Date.now() - this.lastApiFetchTime) > BridgeCore.USAGE_STALE_TTL) {
        this.apiUsageStale = true;
      }
      this.broadcastUsage();
    }, intervalMs));
  }

  /**
   * Start periodic API usage refresh.
   * @param fetchFn Custom fetch function (for daemon relay). Defaults to direct API.
   */
  startApiUsagePolling(intervalMs: number, fetchFn?: () => Promise<ApiUsageData | null>): void {
    const fetch = fetchFn ?? (() => fetchUsageFromApi());
    this.addInterval(setInterval(() => {
      if (!this.hasClients()) return;
      fetch().then((usage) => {
        if (usage) {
          this.updateApiUsage(usage);
        } else {
          this.oauthConnected = hasOAuthToken();
          if (this.cachedApiUsage) this.apiUsageStale = true;
        }
      }).catch(() => {});
    }, intervalMs));
  }

  /** Start periodic sessions_list broadcast */
  startSessionsListPolling(intervalMs = 10_000): void {
    this.addInterval(setInterval(() => {
      if (!this.hasClients()) return;
      this.broadcastSessionsList().catch(() => {});
    }, intervalMs));
  }

  /** Register a callback to enrich the sessions list before broadcast */
  setSessionsEnricher(fn: (sessions: import('./session-aggregator.js').EnrichedSession[]) => import('./session-aggregator.js').EnrichedSession[]): void {
    this.sessionsEnricher = fn;
  }

  /** Register daemon module-health provider for dashboard diagnostics. */
  setModuleHealthProvider(fn: () => Record<string, unknown>): void {
    this.moduleHealthProvider = fn;
  }

  /** Register a provider for non-WS client count (e.g., ESP32 serial connections).
   *  Used to keep sessions_list polling alive even without WebSocket clients. */
  setExternalClientCountProvider(fn: () => number): void {
    this.externalClientCount = fn;
  }

  /** Check if any client (WS or external serial) is connected */
  private hasClients(): boolean {
    return this.wsServer.getClientCount() > 0 || this.externalClientCount() > 0;
  }

  /** Broadcast enriched sessions list (debounced 2s from state_changed) */
  async broadcastSessionsList(): Promise<void> {
    const snapshot = this.stateMachine.getSnapshot();
    let sessions = await buildEnrichedSessionsList(
      this.sessionId,
      snapshot.state,
      snapshot.modelName ?? undefined,
      snapshot.effortLevel ?? undefined,
    );
    if (this.sessionsEnricher) sessions = this.sessionsEnricher(sessions);
    this.wsServer.broadcast({ type: 'sessions_list', sessions } as BridgeEvent);
  }

  /** Debounced sessions list broadcast (for state_changed handler) */
  maybeBroadcastSessionsList(): void {
    const now = Date.now();
    if (now - this.lastSessionsListBroadcast > 2000 && this.hasClients()) {
      this.lastSessionsListBroadcast = now;
      this.broadcastSessionsList().catch(() => {});
    }
  }

  // ===== Client connect: send initial state =====

  /**
   * Send initial state to a newly connected WebSocket client.
   * Callers can extend by providing extra events to send.
   */
  sendInitialState(
    ws: WebSocket,
    opts: {
      agentType: AgentType;
      agentCapabilities?: AgentCapabilities;
      isAlive: boolean;
      extraEvents?: BridgeEvent[];
    },
  ): void {
    const snapshot = this.stateMachine.getSnapshot();

    // State update (with capabilities for initial connect)
    const stateEvent = this.buildStateEvent({
      agentType: opts.agentType,
      agentCapabilities: opts.agentCapabilities,
      snapshot,
    });
    this.wsServer.sendTo(ws, stateEvent);

    // Usage
    this.wsServer.sendTo(ws, this.buildUsage());

    // Connection
    this.wsServer.sendTo(ws, {
      type: 'connection',
      status: opts.isAlive ? 'connected' : 'disconnected',
      sessionId: this.sessionId,
    } as BridgeEvent);

    // Display state
    this.wsServer.sendTo(ws, buildDisplayStateEvent(this.displayMonitor.isDisplayOn()) as BridgeEvent);

    // Timeline history — entries were already attributed at storage time by
    // the attributor installed in `wireTimeline`, so they ship with taskId /
    // runId / sessionId / projectName intact. The `??` fallbacks below
    // protect entries that landed before `wireTimeline` ran (e.g. very early
    // boot logStream events) so we never broadcast bare entries.
    const history = this.bridgeTimeline.getHistory().map((entry) => ({
      ...entry,
      projectName: entry.projectName ?? this.projectName,
      sessionId: entry.sessionId ?? this.sessionId,
    }));
    if (history.length > 0) {
      this.wsServer.sendTo(ws, { type: 'timeline_history', entries: history } as BridgeEvent);
    }

    // Sessions list
    buildEnrichedSessionsList(
      this.sessionId,
      snapshot.state,
      snapshot.modelName ?? undefined,
      snapshot.effortLevel ?? undefined,
    ).then((sessions) => {
      const enriched = this.sessionsEnricher ? this.sessionsEnricher(sessions) : sessions;
      this.wsServer.sendTo(ws, { type: 'sessions_list', sessions: enriched } as BridgeEvent);
    }).catch(() => {});

    // Extra events from caller
    if (opts.extraEvents) {
      for (const evt of opts.extraEvents) {
        this.wsServer.sendTo(ws, evt);
      }
    }

    // Fetch usage if stale
    this.fetchUsageIfStale().catch(() => {});
  }

  // ===== Session registry =====

  registerSession(agentType: AgentType, extra?: Record<string, unknown>): void {
    registerSession({
      id: this.sessionId,
      port: this.port,
      pid: process.pid,
      projectName: this.projectName,
      agentType,
      startedAt: new Date().toISOString(),
      ...extra,
    });
    // APME: open a run for real agent sessions (not the daemon meta-session).
    this.apmeAgentType = agentType;
    if (this.apme && agentType !== ('daemon' as AgentType)) {
      try {
        this.apme.collector.openRun({
          sessionId: this.sessionId,
          agentType,
          projectName: this.projectName,
          projectPath: this.apmeCwd ?? process.cwd(),
          modelId: this.stateMachine.getSnapshot().modelName ?? undefined,
        });
      } catch (err) {
        debug('APME', `openRun from registerSession failed: ${String(err)}`);
      }
    }
  }

  deregisterSession(): void {
    // APME: finalize the run data. Evaluation is NOT enqueued here because
    // this session process exits shortly after (2s shutdown budget). The
    // long-lived daemon process picks up unevaluated runs instead.
    if (this.apme && this.apmeAgentType && this.apmeAgentType !== ('daemon' as AgentType)) {
      try {
        this.apme.collector.closeRun(
          this.sessionId,
          undefined,
          this.apmeCwd ?? process.cwd(),
        );
      } catch (err) {
        debug('APME', `closeRun from deregisterSession failed: ${String(err)}`);
      }
    }
    deregisterSession(this.sessionId);
  }

  /** Attach the APME subsystem. Optional — bridges boot fine without it. */
  setApme(apme: ApmeModule | null, cwd?: string): void {
    this.apme = apme;
    this.apmeCwd = cwd;
  }

  /** Expose APME for callers that need to ingest hooks / update usage. */
  getApme(): ApmeModule | null {
    return this.apme;
  }

  // ===== Lifecycle =====

  addInterval(iv: ReturnType<typeof setInterval>): void {
    this.intervals.push(iv);
  }

  addTimeout(to: ReturnType<typeof setTimeout>): void {
    this.timeouts.push(to);
  }

  /** Register a callback to run during shutdown (before process exit). */
  onShutdown(cb: () => void | Promise<void>): void {
    this.shutdownCallbacks.push(cb);
  }

  /** Register process-level signal handlers for graceful shutdown. */
  registerProcessHandlers(label: string): void {
    const handler = () => this.shutdown();

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    process.on('uncaughtException', (err) => {
      const msg = err?.message ?? '';
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      // mDNS errors are non-critical — network interface changes (sleep/wake,
      // WiFi reconnect, VPN toggle) and unroutable virtual interfaces (Windows
      // WSL/Hyper-V — EHOSTUNREACH to 224.0.0.251:5353) cause transient
      // multicast failures. Null out the mDNS instance so the recovery timer
      // can re-publish.
      if (isNonFatalMdnsError(msg, code)) {
        debug('mDNS', `error (ignored): ${code || msg}`);
        invalidateMdnsInstance();
        return;
      }
      // Stream/network errors are non-critical — client disconnects can cause
      // EPIPE, ECONNRESET, or stream-destroyed errors asynchronously.
      // Log and continue rather than killing the daemon.
      if (
        code === 'EPIPE' || code === 'ECONNRESET' || code === 'ENOTCONN' ||
        code === 'ENXIO' || code === 'EIO' || code === 'EBADF' ||
        msg.includes('ERR_STREAM_DESTROYED') || msg.includes('ERR_STREAM_WRITE_AFTER_END') ||
        msg.includes('write after end') || msg.includes('This socket has been ended')
      ) {
        debug('core', `Stream/network error (ignored): ${code || msg}`);
        return;
      }
      // Log full stack trace to stderr AND append to crash log
      const stack = err instanceof Error ? err.stack : String(err);
      const crashMsg = `[${new Date().toISOString()}] Uncaught exception: ${stack}\n`;
      logError(crashMsg);
      try {
        const { appendFileSync } = require('fs');
        const { join } = require('path');
        const crashLog = join(process.env.HOME || '/tmp', '.agentdeck', 'daemon-crash.log');
        appendFileSync(crashLog, crashMsg);
      } catch { /* best effort */ }
      handler();
    });
    process.on('unhandledRejection', (reason) => {
      debug('core', `Unhandled rejection: ${reason}`);
      debug('core', `Unhandled rejection stack: ${reason instanceof Error ? reason.stack : reason}`);
      // Non-fatal — don't shutdown
    });

    // Diagnostic: log unexpected exits (SIGKILL can't be caught, but everything else is logged)
    process.on('exit', (code) => {
      if (!this.shutdownInProgress) {
        const msg = `[${new Date().toISOString()}] Process exit without shutdown (code=${code})\n`;
        try {
          const { appendFileSync } = require('fs');
          const { join } = require('path');
          appendFileSync(join(process.env.HOME || '/tmp', '.agentdeck', 'daemon-crash.log'), msg);
        } catch { /* best effort */ }
      }
    });
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    if (this.shutdownInProgress) {
      exitProcessNow(0);
      return;
    }
    this.shutdownInProgress = true;

    log('Shutting down...');
    const hardExitTimer = setTimeout(() => {
      logError('Shutdown timeout — forcing exit.');
      exitProcessNow(0);
    }, 5000);

    // Clear all timers
    for (const iv of this.intervals) clearInterval(iv);
    for (const to of this.timeouts) clearTimeout(to);

    // Deregister session
    this.deregisterSession();

    // Stop display monitor
    this.displayMonitor.stop();

    // Run shutdown callbacks (best-effort, 2s total budget)
    const callbacksDone = Promise.all(
      this.shutdownCallbacks.map(cb =>
        Promise.resolve().then(cb).catch(() => {}),
      ),
    );
    await Promise.race([callbacksDone, new Promise(r => { const t = setTimeout(r, 2000); t.unref(); })]);

    // Close WS
    this.wsServer.close();

    // Exit immediately — all cleanup is done or timed out
    clearTimeout(hardExitTimer);
    exitProcessNow(0);
  }
}
