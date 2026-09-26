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
import { buildSubscriptions, buildUsageEvent, normalizeZaiRateLimits } from './usage-event.js';
import { readCodexAuthStatus } from './codex-auth.js';
import { readCodexRateLimits } from './codex-rate-limits.js';
import {
  codexLiveFamilyAuthorityExpiry,
  codexRateLimitsWithLiveRefresh,
  getLiveCodexRateLimits,
} from './codex-rate-limits-live.js';
import { fetchMlxModels, fetchMlxResidency } from './mlx-probe.js';
import { buildDisplayStateEvent } from './display-dim.js';
import { foldCodexSessionsForDisplay, loadMlxSettings, sortSessions } from '@agentdeck/shared';
import { probeGateway, checkGatewayHealth } from './gateway-probe.js';
import { fetchUsageFromApi, hasOAuthToken, getTokenStatus, type ApiUsageData, type UsageFetchResult } from './usage-api.js';
import { fetchZaiQuota, type ZaiUsageFetchResult } from './zai-usage.js';
import { buildEnrichedSessionsList } from './session-aggregator.js';
import { activityFor } from './session-activity.js';
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
  type CodexRateLimits,
  type StateSnapshot,
  type AgentType,
  type AgentCapabilities,
  type ModelCatalogEntry,
  type PluginCommand,
  type VoiceAssistantState,
  type TimelineEntry,
} from './types.js';

// log(), logError(), debug() imported from logger.ts
// - log(): suppressed in PTY mode (after setPtyMode(true))
// - logError(): always shown (critical errors requiring user action)
// - debug(): file-only (when --debug enabled)

// links2004/WebSockets, used by the ESP32-C3 e-ink firmware, closes inbound
// frames above 15KB with 1009 before the firmware parser can see them. Keep the
// initial replay comfortably below that library cap; Detail views can request a
// scoped session replay later via query_session_timeline.
export const INITIAL_TIMELINE_HISTORY_MAX_BYTES = 12 * 1024;
/** Board-class WS clients (`?clientType=esp32`) get the serial-path frame
 *  invariant applied to the initial burst too: any frame bound for a board
 *  must stay under 4096 bytes — a no-PSRAM board handed a 12KB frame right
 *  after connect can OOM, drop the socket, and flap. Envelope margin included. */
export const ESP32_INITIAL_TIMELINE_HISTORY_MAX_BYTES = 3584;

/** Attach host-local "HH:MM" to a timeline entry. Devices have no timezone
 * (their NTP runs UTC), so rendering `ts` directly shows a 9-hour-off clock
 * in KST. Stamped at the SOURCE (broadcast + history) so both the serial and
 * WS transports carry it; native apps simply ignore the extra field. */
export function stampLocalHm<T extends { ts?: number; localHm?: string }>(entry: T): T {
  if (!entry || !Number.isFinite(entry.ts) || entry.localHm) return entry;
  const d = new Date(entry.ts as number);
  return {
    ...entry,
    localHm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

export function buildCappedTimelineHistory(
  entries: TimelineEntry[],
  maxBytes = INITIAL_TIMELINE_HISTORY_MAX_BYTES,
  extraFields: Record<string, unknown> = {},
): BridgeEvent | null {
  // Incremental byte accounting — newest-first until the budget is spent, then
  // stop. The previous version re-stringified the WHOLE candidate event for
  // every entry (O(n²) in serialized bytes) and kept testing entries after the
  // budget was full; with a day-long timeline that made every client CONNECT
  // cost tens of ms of synchronous CPU. A flapping board reconnecting every
  // couple of seconds turned that into a daemon-saturating resonance
  // (connect → heavy burst → client dies → reconnect). Per-entry sizes are
  // measured once; the envelope overhead is measured once.
  const envelope = Buffer.byteLength(
    JSON.stringify({ type: 'timeline_history', ...extraFields, entries: [] }), 'utf8');
  let budget = maxBytes - envelope;
  const kept: TimelineEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const stamped = stampLocalHm(entries[i]);
    const cost = Buffer.byteLength(JSON.stringify(stamped), 'utf8') + 1; // +1 comma
    if (cost > budget) break; // older entries only get us further over budget
    budget -= cost;
    kept.unshift(stamped);
  }
  return kept.length > 0 ? ({ type: 'timeline_history', ...extraFields, entries: kept } as BridgeEvent) : null;
}

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
  /**
   * True for the daemon hub. The hub aggregates many agents and has no single
   * session model, so it must always expose the account-level Claude subscription
   * quota in usage events rather than gating it on the (arbitrary) active model.
   */
  isDaemon?: boolean;
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
/** Interval of the wake-detector tick. */
export const WAKE_TICK_MS = 5_000;
/** A tick this much later than scheduled is a discontinuity worth classifying. */
export const WAKE_GAP_MS = 15_000;

/** Monotonic milliseconds — excludes suspend on Darwin/Linux, which is the
 *  property the wake detector depends on. */
export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Classify one wake-detector tick.
 *
 *  `wake`  — the wall clock advanced far more than the monotonic clock: the
 *            machine was suspended (or, on win32 where the monotonic clock
 *            keeps counting through sleep, a large gap on either clock).
 *  `lag`   — both clocks advanced together past the gap: the event loop was
 *            starved. Not a wake, and running the wake recovery here is what
 *            starves the NEXT tick.
 *  `normal` — on schedule.
 *
 *  Pure, so the two cases that look identical to a gap-only rule can be
 *  driven side by side. */
export function classifyClockTick(t: { wallDeltaMs: number; monoDeltaMs: number; platform: NodeJS.Platform }): 'wake' | 'lag' | 'normal' {
  const gap = t.wallDeltaMs > WAKE_GAP_MS;
  if (!gap) return 'normal';
  if (t.platform === 'win32') return 'wake';
  const drift = t.wallDeltaMs - t.monoDeltaMs;
  return drift > WAKE_GAP_MS ? 'wake' : 'lag';
}

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

  /** z.ai GLM Coding Plan quota — an independent provider-account reading
   *  (never gated on Claude/Codex state). Null until the first fetch, so a
   *  machine with no key configured omits the wire block entirely. */
  cachedZaiQuota: import('./types.js').ZaiRateLimits | null = null;
  lastZaiFetchTime = 0;
  oauthConnected: boolean;
  apiUsageStale = false;
  /** True when cachedApiUsage was synced from relay's already-adjusted values */
  apiUsagePreAdjusted = false;
  cachedOllamaStatus: OllamaStatus | null = null;
  cachedMlxModels: string[] | null = null;
  cachedMlxResidency = { known: false, models: [] as string[] };
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
  private sessionsListTrailingTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSessionsListEvent: BridgeEvent | null = null;
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

  /** True when this core backs the daemon hub (see BridgeCoreOptions.isDaemon). */
  readonly isDaemon: boolean;

  constructor(opts: BridgeCoreOptions) {
    this.port = opts.port;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.projectName = opts.projectName;
    this.isDaemon = opts.isDaemon ?? false;

    // Core components
    this.usageTracker = new UsageTracker();
    // The daemon hub's machine multiplexes EVERY observed session's hooks, so
    // one session's tool activity must never dismiss another's AWAITING
    // prompt (e.g. a held OpenClaw approval) or reopen IDLE.
    this.stateMachine = new StateMachine(this.usageTracker, {
      toolActivityRecovery: !this.isDaemon,
    });
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
      // agentType backfill — the single place every timeline row acquires its
      // brand. Priority: caller-set → per-session collector run (authoritative
      // for observed hook sessions, where this BridgeCore's own agentType is
      // 'daemon') → this bridge's own session agent (managed session bridges
      // whose collector run may not exist yet). 'daemon' is never stamped: it
      // would mislabel every observed session's rows with the hub's identity.
      const ownAgent = this.apmeAgentType && this.apmeAgentType !== ('daemon' as AgentType)
        ? this.apmeAgentType : undefined;
      const runAgent = apme ? apme.collector.getRunAgentType(sessionId) : null;
      const agentType: string | undefined =
        entry.agentType ?? runAgent ?? ownAgent ?? undefined;
      return {
        ...entry,
        projectName: entry.projectName ?? this.projectName,
        sessionId,
        ...(agentType ? { agentType } : {}),
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
      // forward as-is (plus the device-local HH:MM stamp). Doing the
      // attribution here too would be redundant and risks divergence.
      const evt: BridgeEvent = { type: 'timeline_event', entry: stampLocalHm(entry), ...(upsert ? { upsert: true } : {}) };
      this.broadcast(evt);
    });
  }

  // ===== Display monitor =====

  private _previousDisplayOn = true;
  private _wakeHandler: (() => void) | null = null;

  wireDisplayMonitor(): void {
    this.displayMonitor.on('display_state_changed', (displayOn: boolean) => {
      // Detect wake transition (asleep → awake)
      if (displayOn && !this._previousDisplayOn) {
        this._wakeHandler?.();
      }
      this._previousDisplayOn = displayOn;
      const evt: BridgeEvent = buildDisplayStateEvent(displayOn) as BridgeEvent;
      this.broadcast(evt);
    });
    this.displayMonitor.start();

    // Time-discontinuity safety net (python3 process may die during deep sleep).
    //
    // A late timer is NOT a wake. This used to fire the wake handler whenever
    // a 5 s tick landed more than 15 s after the previous one — which is what
    // an event loop starved by load does routinely, sleep or no sleep. On
    // 2026-09-10 (load average 13–17, `pmset -g log` showing ZERO sleep events
    // all day) it fired 123 times, every one to four minutes, and each firing
    // ran the whole device-recovery storm: mDNS republish, pairing re-arm on
    // every ESP32 board, BLE workers restarted, a usage refetch. That work is
    // what blocked the loop for the NEXT tick, so the detector fed itself —
    // and each storm left `/health` unanswered long enough for the macOS app
    // to read the daemon as gone, promote to a fallback port, and stand down
    // again a minute later, three times in five minutes.
    //
    // The distinction that separates the two is which clocks advanced. Across
    // a real sleep the wall clock jumps while the monotonic clock does not
    // (Darwin and Linux CLOCK_MONOTONIC exclude suspend); under load both
    // advance together. So the wake signal is the DRIFT between them, never
    // the gap alone. Windows' monotonic clock keeps counting through sleep, so
    // there the gap rule stays, documented as the weaker instrument it is.
    let lastWall = Date.now();
    let lastMono = monotonicNowMs();
    setInterval(() => {
      const wall = Date.now();
      const mono = monotonicNowMs();
      const verdict = classifyClockTick({ wallDeltaMs: wall - lastWall, monoDeltaMs: mono - lastMono, platform: process.platform });
      if (verdict === 'wake') {
        debug('core', `Time discontinuity (wall +${wall - lastWall}ms, monotonic +${Math.round(mono - lastMono)}ms) — system wake`);
        this._wakeHandler?.();
      } else if (verdict === 'lag') {
        debug('core', `Timer lag (${wall - lastWall}ms for a ${WAKE_TICK_MS}ms tick) — the loop is starved, not a wake`);
      }
      lastWall = wall;
      lastMono = mono;
    }, WAKE_TICK_MS);
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
    const subscriptions = buildSubscriptions(codexAuth, this.cachedApiUsage, snapshot.billingType, this.cachedAntigravityStatus, this.claudeUsageStale, this.zaiQuotaForWire());

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
      mlxModels: this.cachedMlxModels ?? [],
      mlxResidency: this.cachedMlxResidency,
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

  /**
   * The `codexRateLimits` block this core last PUT ON THE WIRE — the normalized,
   * plan-reconciled output of the most recent `buildUsage()`, not one of its
   * inputs. Remembered so the daemon's relayed-`usage_update` path can reconcile
   * a session bridge's weaker block against it without calling `buildUsage()`,
   * which arms the throttled `codex app-server` spawn (issue #253). Null until
   * the first build.
   */
  lastBuiltCodexRateLimits: CodexRateLimits | null = null;

  /**
   * Whether a live `codex app-server` answer stands behind that block's limit
   * FAMILY — not whether the live snapshot itself was published. It is the
   * difference between a reading that KNOWS which family it describes and one
   * that only claims to, and the relay path needs it: a daemon whose PATH has no
   * `codex` binary holds nothing but a rollout read, and letting that arbitrate
   * a cross-family disagreement against a session bridge would decide it by
   * which process is holding the block — able to invert the very fix the family
   * guard delivers. See `codexLiveFamilyAuthorityExpiry`.
   *
   * An INSTANT rather than a flag: the relay path consumes this later, on its
   * own clock, and a boolean frozen at build time would let the authority
   * outlive the age bound that granted it.
   */
  lastBuiltCodexLiveFamilyAuthorityExpiresAtMs: number | null = null;

  /** Read-time expiry also covers reconnects before the next usage tick. */
  private get claudeUsageStale(): boolean {
    return this.apiUsageStale ||
      (this.lastApiFetchTime > 0 && Date.now() - this.lastApiFetchTime > BridgeCore.USAGE_STALE_TTL);
  }

  /** The z.ai block for the wire, with display retirement applied at read time
   *  (the Claude-quota rule, scoped to this block: an expired reading hides
   *  its windows rather than reading as live — the plan/family axes survive so
   *  surfaces can still name the provider row). Null means "never fetched /
   *  not configured" and omits the block: no information. */
  zaiQuotaForWire(): import('./types.js').ZaiRateLimits | null {
    if (!this.cachedZaiQuota) return null;
    if (this.lastZaiFetchTime <= 0 || Date.now() - this.lastZaiFetchTime > BridgeCore.USAGE_STALE_TTL) {
      return { planType: this.cachedZaiQuota.planType, limitId: this.cachedZaiQuota.limitId };
    }
    return normalizeZaiRateLimits(this.cachedZaiQuota) ?? null;
  }

  /** Build and return a usage event */
  buildUsage(): BridgeEvent {
    const snapshot = this.stateMachine.getSnapshot();
    // Read the account tier ONCE and hand the same value to every consumer: the
    // rollout picker, the live-query gate and the void rule all reconcile against
    // it, and two reads a moment apart could straddle a token refresh and
    // disagree about which plan this build belongs to.
    const codexAuth = readCodexAuthStatus();
    const codexAccountPlan = codexAuth?.planType;
    const codexRateLimits = this.isDaemon
      ? codexRateLimitsWithLiveRefresh(
          readCodexRateLimits(undefined, codexAccountPlan),
          codexAccountPlan,
        )
      : readCodexRateLimits(undefined, codexAccountPlan);
    const event = buildUsageEvent(
      snapshot,
      this.cachedApiUsage,
      this.oauthConnected,
      this.cachedOllamaStatus,
      this.cachedMlxModels,
      this.claudeUsageStale,
      codexAuth,
      snapshot.billingType,
      this.cachedModelCatalog,
      this.cachedAntigravityStatus,
      this.apiUsagePreAdjusted,
      this.isDaemon,
      // The passive rollout read freezes the moment Codex stops completing turns
      // — including the moment it hits the wall — so the daemon backs it with a
      // throttled live query against the user's own `codex app-server`. Session
      // bridges keep the passive read only (no host-side processes there).
      // The account tier rides into both readers: a rollout stamped with a plan
      // the account no longer holds is voided downstream, so it must not win the
      // selection on recency (a Codex session left open across a plan change
      // keeps minting exactly such snapshots), and its freshness must not
      // suppress the live query that carries the only usable number.
      codexRateLimits,
      this.zaiQuotaForWire(),
    );
    event.mlxModels = this.cachedMlxModels ?? [];
    event.mlxResidency = this.cachedMlxResidency;
    this.lastBuiltCodexRateLimits = event.codexRateLimits ?? null;
    // "Is this block backed by a live answer", not "did the live answer win the
    // pick" — when the two agree on family the picker keeps the fresher rollout,
    // which is every build while Codex is working, and reading that as "no live
    // reading" switched the relay guard off precisely when it was needed.
    //
    // Computed from the PUBLISHED block, not the pick it came from: the flag
    // travels with `lastBuiltCodexRateLimits`, and normalization can void or
    // strip that value. A flag describing a different object than the one it
    // rides with is one normalization change away from lying.
    this.lastBuiltCodexLiveFamilyAuthorityExpiresAtMs = codexLiveFamilyAuthorityExpiry(
      this.lastBuiltCodexRateLimits,
      getLiveCodexRateLimits(),
    );
    return event;
  }

  /** Broadcast current usage to all clients */
  broadcastUsage(): void {
    this.broadcast(this.buildUsage());
  }

  // ===== API Usage helpers =====

  /**
   * Update cached API usage and broadcast.
   * Handles billingType inference.
   *
   * `fresh` decides whether this counts as a LIVE reading. A false value still
   * retains the cache for diagnostics, but must NOT push
   * `lastApiFetchTime` forward or clear `apiUsageStale` — doing so is what made
   * a failed fetch indistinguishable from a successful one, disarming both the
   * `usageStale` wire flag and the `USAGE_STALE_TTL` backstop that exists to
   * catch exactly this. See `UsageFetchResult`.
   */
  updateApiUsage(usage: ApiUsageData, fresh = true): void {
    this.cachedApiUsage = usage;
    this.apiUsagePreAdjusted = false; // raw data from API, needs adjustment
    if (fresh) {
      this.lastApiFetchTime = Date.now();
      this.oauthConnected = true;
      this.apiUsageStale = false;
    } else {
      // Numbers survive; the claim that they are current does not.
      this.oauthConnected = hasOAuthToken();
      this.apiUsageStale = true;
    }
    if (usage.inferredBillingType) {
      this.stateMachine.inferBillingType(usage.inferredBillingType);
    }
    this.broadcastUsage();
  }

  /**
   * Apply the outcome of a usage fetch — the single place that turns a
   * `UsageFetchResult | null` into cache + staleness state.
   *
   * Five call sites in the daemon each hand-rolled this three-line branch; they
   * agreed only by luck, and every one of them was reachable-in-theory dead code
   * because the fetch never returned null. One function so a new caller cannot
   * reintroduce the divergence.
   */
  applyUsageResult(result: UsageFetchResult | null): boolean {
    if (result) {
      this.updateApiUsage(result.data, result.fresh);
      // Token status check — if expired, mark stale even though we got numbers
      const tokenStatus = getTokenStatus();
      if (tokenStatus === 'expired' || tokenStatus === 'missing') {
        this.apiUsageStale = true;
      }
      return result.fresh;
    }
    this.oauthConnected = hasOAuthToken();
    if (this.cachedApiUsage) this.apiUsageStale = true;
    return false;
  }

  /** Fetch usage from API and update cache. Returns true on a LIVE reading. */
  async fetchAndUpdateUsage(): Promise<boolean> {
    return this.applyUsageResult(await fetchUsageFromApi());
  }

  /**
   * Apply a z.ai quota fetch — the provider-account counterpart of
   * `applyUsageResult`. The reading's original capture time owns display
   * validity, including disk-cache hits and failed-poll fallbacks; applying
   * a result never restamps a frozen reading as live. Credential removal clears the old
   * account explicitly so retain-on-absent consumers retire their gauges.
   */
  applyZaiUsageResult(result: ZaiUsageFetchResult): boolean {
    if (result.data) {
      this.cachedZaiQuota = result.data;
      const capturedAt = Date.parse(result.data.capturedAt ?? '');
      this.lastZaiFetchTime = Number.isFinite(capturedAt) && capturedAt <= Date.now() ? capturedAt : 0;
    } else if (this.cachedZaiQuota) {
      this.cachedZaiQuota = {};
      this.lastZaiFetchTime = 0;
    }
    this.broadcastUsage();
    return result.fresh;
  }

  async refreshZaiUsage(): Promise<void> {
    this.applyZaiUsageResult(await fetchZaiQuota());
  }

  /** Start the z.ai provider-account poll. Daemon-side only — a session bridge
   *  has no reason to hold a second provider credential. */
  startZaiUsagePolling(intervalMs = 60_000): void {
    // One immediate fetch so a freshly started daemon paints the provider row
    // without waiting a full interval; subsequent ticks share the file cache.
    void this.refreshZaiUsage().catch(() => {});
    this.addInterval(setInterval(() => {
      if (!this.hasClients()) return;
      void this.refreshZaiUsage().catch(() => {});
    }, intervalMs));
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
      Promise.all([fetchMlxModels(pin), fetchMlxResidency()]).then(([models, residency]) => {
        const success = Array.isArray(models) && models.length > 0;
        if (success) {
          failureCount = 0;
          nextFireAt = 0;
        } else {
          failureCount += 1;
          const wait = Math.min(intervalMs * 2 ** failureCount, MAX_INTERVAL);
          nextFireAt = Date.now() + wait;
        }
        const changed = JSON.stringify(this.cachedMlxModels) !== JSON.stringify(models) || JSON.stringify(this.cachedMlxResidency) !== JSON.stringify(residency);
        this.cachedMlxResidency = residency;
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

  /**
   * `onAvailable` fires on EVERY tick the Gateway port answers, not only on the
   * rising edge: the port stays open while a Gateway WS dies (a restart racing
   * its own boot, a dropped link), and an edge-only callback never fired again —
   * the daemon sat on a dead adapter for 16 h (2026-09-16) and again 2026-09-26.
   * The callee must be idempotent. `onDisappeared` stays falling-edge.
   */
  startGatewayProbe(
    intervalMs: number,
    onAvailable?: () => void,
    onDisappeared?: () => void,
  ): void {
    const poll = async () => {
      const status = await probeGateway();
      const wasAvailable = this.cachedGatewayAvailable;
      this.cachedGatewayAvailable = status.available;

      if (status.available) {
        onAvailable?.();
      } else if (wasAvailable) {
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

  /**
   * `openclaw doctor` costs 8-9 s per run and opens its own Gateway connection,
   * so the old 30 s cadence left the CLI running ~30% of the time and made this
   * one check 99.5% of all Gateway RPC traffic (measured 2026-09-12: 9,958
   * `channels.status` calls over four days, each on a fresh connection).
   * OpenClaw's own health monitor runs on 300 s; match it.
   */
  startGatewayHealthCheck(intervalMs = 300_000, delayMs = 5000): void {
    const check = () => {
      if (!this.cachedGatewayAvailable) return;
      checkGatewayHealth().then((verdict) => {
        // "I could not look" is neither healthy nor broken — retain.
        if (!verdict.known) return;
        const changed = verdict.hasError !== this.cachedGatewayHasError;
        this.cachedGatewayHasError = verdict.hasError;
        if (changed) {
          debug('BridgeCore', `gatewayHasError -> ${verdict.hasError} (${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''})`);
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
   * Also retires displayed quota after USAGE_STALE_TTL.
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
  startApiUsagePolling(intervalMs: number, fetchFn?: () => Promise<UsageFetchResult | null>): void {
    const fetch = fetchFn ?? (() => fetchUsageFromApi());
    this.addInterval(setInterval(() => {
      if (!this.hasClients()) return;
      fetch().then((result) => this.applyUsageResult(result)).catch(() => {});
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

  /** Build the current enriched sessions roster — the same pipeline the
   *  sessions_list broadcast uses, without broadcasting. Serves the HTTP pull
   *  surfaces (`GET /feed`) so a wake-sync-sleep client sees exactly what a
   *  WS client would. */
  async buildSessionsSnapshot(): Promise<import('./session-aggregator.js').EnrichedSession[]> {
    const snapshot = this.stateMachine.getSnapshot();
    let sessions = await buildEnrichedSessionsList(
      this.sessionId,
      snapshot.state,
      snapshot.modelName ?? undefined,
      snapshot.effortLevel ?? undefined,
    );
    if (this.sessionsEnricher) sessions = this.sessionsEnricher(sessions);
    // Canonical user-facing projection. The Swift daemon already folds here;
    // doing the same in Node keeps ESP32/native dashboards aligned with the
    // Stream Deck and Pixoo consumers that otherwise had to fold locally.
    // The raw registry remains untouched for routing and diagnostics.
    sessions = sortSessions(foldCodexSessionsForDisplay(sessions));
    // Attach the shared per-session activity one-liner to the FINAL list (covers
    // managed + observed sessions). Heuristic is immediate; a Foundation Models
    // summary, when available, lands on a later periodic broadcast via the cache.
    for (const s of sessions) {
      const a = activityFor(s);
      if (a) s.activity = a;
    }
    this.attachLastEventFields(sessions);
    return sessions;
  }

  /** Broadcast enriched sessions list (debounced 2s from state_changed) */
  async broadcastSessionsList(): Promise<void> {
    const sessions = await this.buildSessionsSnapshot();
    const event = { type: 'sessions_list', sessions } as BridgeEvent;
    // Cache for the serial heartbeat re-sync (like display_state): a board that
    // reconnects across a daemon handoff during a quiet window otherwise sits
    // on an empty roster until the next unrelated session change broadcasts.
    this.lastSessionsListEvent = event;
    this.wsServer.broadcast(event);
  }

  /** The most recent sessions_list event, for the ESP32 serial heartbeat
   *  re-sync. Null until the first broadcast. */
  getLastSessionsListEvent(): BridgeEvent | null {
    return this.lastSessionsListEvent;
  }

  /**
   * Attach each session's latest MILESTONE timeline row (TIMELINE parity for
   * glance devices): `lastEventText` (row text), `lastEventTask` (resolved
   * enclosing-task label) and `lastEventHm` (host-local HH:MM). Display boards
   * (IPS10 cards) render these instead of depending on their tiny on-device
   * timeline ring, which starts empty after every board reboot. Dashboards
   * carry the full timeline and ignore the fields. Swift daemon mirror:
   * DaemonServer.noteTimelineEntryForBoards / buildSessionsListEvent.
   */
  private attachLastEventFields(sessions: import('./session-aggregator.js').EnrichedSession[]): void {
    // Task hierarchy rows (task_start/task_end) are data-only markers under
    // the one-row-per-task render contract (shared/src/timeline-task-display.ts)
    // — a reaper-synthesized "Interrupted · ~6h" must never become a card's
    // "latest event". task_start labels are still harvested as task CONTEXT
    // for turn rows. Swift daemon mirror: DaemonServer.cardMilestoneTypes.
    const MILESTONES = new Set(['chat_start', 'chat_response', 'chat_end']);
    const history = this.bridgeTimeline.getHistory();  // oldest → newest
    const taskLabels = new Map<string, string>();
    const latestBySession = new Map<string, { text: string; taskId?: string; ts: number }>();
    for (const e of history) {
      const raw = (e.raw ?? '').trim();
      if (e.type === 'task_start' && e.taskId && raw) taskLabels.set(e.taskId, raw);
      if (!e.sessionId || !MILESTONES.has(e.type)) continue;
      if (!raw || raw.startsWith('{') || raw.startsWith('[')) continue;
      latestBySession.set(e.sessionId, {
        text: raw,
        taskId: e.taskId,
        ts: e.ts,
      });
    }
    for (const s of sessions) {
      const m = latestBySession.get(s.id);
      if (!m) continue;
      s.lastEventText = m.text;
      if (m.taskId) {
        const label = taskLabels.get(m.taskId);
        if (label) s.lastEventTask = label;
      }
      if (Number.isFinite(m.ts)) {
        const d = new Date(m.ts);
        s.lastEventHm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
    }
  }

  /** Debounced sessions list broadcast (for state_changed handler) */
  maybeBroadcastSessionsList(): void {
    if (this.shutdownInProgress || !this.hasClients()) return;
    const now = Date.now();
    const remaining = 2000 - (now - this.lastSessionsListBroadcast);
    if (remaining <= 0) {
      clearTimeout(this.sessionsListTrailingTimer);
      this.sessionsListTrailingTimer = undefined;
      this.lastSessionsListBroadcast = now;
      this.broadcastSessionsList().catch(() => {});
    } else if (!this.sessionsListTrailingTimer) {
      this.sessionsListTrailingTimer = setTimeout(() => {
        this.sessionsListTrailingTimer = undefined;
        this.maybeBroadcastSessionsList();
      }, remaining);
      this.sessionsListTrailingTimer.unref?.();
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
      /** A caller-built first frame (the daemon hub stamps its own identity). */
      stateEvent?: BridgeEvent;
    },
  ): void {
    const snapshot = this.stateMachine.getSnapshot();

    // State update (with capabilities for initial connect)
    const stateEvent = opts.stateEvent ?? this.buildStateEvent({
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
    // Always send a timeline_history on connect — an EMPTY one when the store
    // is empty. Clients replace (not merge) their timeline on this event, so a
    // freshly-restarted daemon must send `entries: []` to wipe the client's
    // stale rows; suppressing it (the old `if (historyEvent)`) left old logs
    // frozen on Android/ESP32 across a daemon restart.
    //
    // Two robustness gates on the burst (2026-07-26 flap resonance):
    //  - board-class sockets get the ≤4096B frame invariant, not the 12KB cap;
    //  - a FLAPPING client (see WsServer connect guard) gets no history at all
    //    this connect — keeping its last rows beats feeding a marginal link a
    //    burst that kills it again. It re-syncs on its first stable connect
    //    (or via query_session_timeline).
    if (!this.wsServer.isFlappingClient(ws)) {
      const historyCap = this.wsServer.isEsp32Client(ws)
        ? ESP32_INITIAL_TIMELINE_HISTORY_MAX_BYTES
        : INITIAL_TIMELINE_HISTORY_MAX_BYTES;
      const historyEvent = buildCappedTimelineHistory(history, historyCap)
        ?? ({ type: 'timeline_history', entries: [] } as BridgeEvent);
      this.wsServer.sendTo(ws, historyEvent);
    }

    // Sessions list
    this.buildSessionsSnapshot().then((sessions) => {
      this.wsServer.sendTo(ws, { type: 'sessions_list', sessions } as BridgeEvent);
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
    clearTimeout(this.sessionsListTrailingTimer);
    this.sessionsListTrailingTimer = undefined;

    log('Shutting down...');
    const hardExitTimer = setTimeout(() => {
      logError('Shutdown timeout — forcing exit.');
      exitProcessNow(0);
    }, 7000);

    // Clear all timers
    for (const iv of this.intervals) clearInterval(iv);
    for (const to of this.timeouts) clearTimeout(to);

    // Deregister session
    this.deregisterSession();

    // Stop display monitor
    this.displayMonitor.stop();

    // Run shutdown callbacks (best-effort, 5s total budget). Budget covers the
    // BLE stateful-panel farewell: device modules (iDotMatrix/Timebox) await
    // their Python sync child painting a final OFFLINE/blank frame over BLE
    // (~1-3s) so the panel doesn't freeze on its last dashboard frame.
    const callbacksDone = Promise.all(
      this.shutdownCallbacks.map(cb =>
        Promise.resolve().then(cb).catch(() => {}),
      ),
    );
    await Promise.race([callbacksDone, new Promise(r => { const t = setTimeout(r, 5000); t.unref(); })]);

    // Close WS
    this.wsServer.close();

    // Exit immediately — all cleanup is done or timed out
    clearTimeout(hardExitTimer);
    exitProcessNow(0);
  }
}
