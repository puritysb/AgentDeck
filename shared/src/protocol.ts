import { State, PermissionMode, PromptOption } from './states.js';
import type { AgentType, AgentCapabilities } from './adapter.js';
import type { TimelineEntry } from './timeline.js';

// ===== Billing Type =====

export type BillingType = 'subscription' | 'api' | 'unknown';

// ===== Model Catalog (OpenClaw) =====

export interface ModelCatalogEntry {
  key: string;
  name: string;
  role: 'default' | `fallback-${number}` | 'configured';
  available: boolean;
}

// ===== OpenClaw Session Status =====

export interface OcSessionStatus {
  model?: string;
  contextTokens?: number;
  messageCount?: number;
  uptime?: string;
  sessionId?: string;
  [key: string]: unknown;
}

// ===== Button State (Bridge → Android) =====

export interface ButtonSlotState {
  slot: number;           // 0-7
  title: string;
  subtitle?: string;
  bgColor: string;        // hex
  textColor: string;      // hex
  enabled: boolean;
  icon?: string;
  badge?: string;         // "★", "1/3"
  action?: string;        // "switch_mode" | "command:go on" | "respond:y" | "select_option:2" | "interrupt" | "escape" | "expand_options"
  dim?: boolean;
}

export interface ButtonStateEvent {
  type: 'button_state';
  buttons: ButtonSlotState[];
}

// ===== Encoder LCD State (Bridge → Plugin/Android) =====

export interface EncoderSlotState {
  slot: number; // 0-3 (E1~E4)
  encoderType: 'utility' | 'action' | 'usage' | 'voice';
  header: string;         // "VOLUME", "PROMPT", "SESSION", "VOICE"
  value?: string;         // "65%", "go on", session name, "Ready"
  icon?: string;          // emoji
  accentColor: string;    // hex — bottom indicator bar color
  progress?: number;      // 0-1, indicator bar fill
  counter?: string;       // "1/4" format
  detail?: string;        // additional text (option description, error msg, etc.)
  // Voice specific
  voiceState?: 'idle' | 'recording' | 'transcribing' | 'error' | 'review';
  recordingMs?: number;
  transcription?: string;
}

export interface EncoderStateEvent {
  type: 'encoder_state';
  encoders: EncoderSlotState[];
  takeoverActive: boolean; // AWAITING states: all encoders show options
}

// ===== Deck Slot Map (Plugin → Bridge → Android) =====

export interface DeckSlotConfig {
  slot: number;
  actionType: string; // 'mode-button' | 'session-button' | 'usage-button' | 'response-button' | 'stop-button' | 'utility-dial' | 'option-dial' | 'iterm-dial' | 'voice-dial'
  settings?: Record<string, unknown>;
}

export interface DeckSlotMapEvent {
  type: 'deck_slot_map';
  buttons: DeckSlotConfig[];
  encoders: DeckSlotConfig[];
}

// ===== Ollama Status =====

export interface OllamaModel {
  name: string;
  size: number;
  sizeVram: number;
}

export interface OllamaStatus {
  available: boolean;
  models: OllamaModel[];
}

export interface SubscriptionInfo {
  name: string;
  until?: string;
}

export interface AntigravityStatusInfo {
  planName?: string;
  availableCredits?: number;
  minimumCreditAmountForUsage?: number;
  subscriptionActiveUntil?: string;
}

/** One Codex (ChatGPT) rate-limit window, mirroring the Claude 5h/7d shape.
 *  Sourced from the user's own local Codex session rollout files — Codex CLI
 *  writes these snapshots itself, so this is local-file data, not an API call. */
export interface CodexRateLimitWindow {
  usedPercent: number;
  /** Rolling window length in minutes (primary ≈ 300 = 5h, secondary ≈ 10080 = 7d). */
  windowMinutes: number;
  /** ISO-8601 reset instant (converted from the rollout's unix `resets_at`). */
  resetsAt?: string;
  /** True when this window's snapshot has expired (its `resets_at` slid into the
   *  past with no fresher Codex activity). The passive rollout read is frozen, so
   *  the percent is last-known-only — renderers should dim the gauge and show a
   *  "stale" marker instead of a misleading "now" countdown. Set centrally in
   *  `buildUsageEvent`; `resetsAt` is cleared at the same time so no formatter
   *  prints "now". */
  stale?: boolean;
}

/** Codex credits balance, the metering Codex reports for credit-based plans
 *  (e.g. `limit_id: "premium"`) where the rolling 5h/7d windows are null.
 *  Mirrors the rollout's `rate_limits.credits` block. */
export interface CodexCredits {
  /** Whether the plan has any credit allowance configured. */
  hasCredits: boolean;
  /** Unlimited credits (no balance ceiling). */
  unlimited: boolean;
  /** Remaining balance — Codex reports this as a string (e.g. "0"). */
  balance?: string;
}

/** Codex usage limits parsed from local rollout files. `primary` is the short
 *  (5h-style) window, `secondary` the long (weekly) window — same idea as the
 *  Claude 5h/7d gauges. Credit-based plans report `primary`/`secondary` as null
 *  and convey usage via `credits` + `limitId` instead. */
export interface CodexRateLimits {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  /** Plan tier reported alongside the limits (e.g. "plus", "pro"). */
  planType?: string;
  /** Limit identifier reported by Codex (e.g. "premium" for credit-based plans). */
  limitId?: string;
  /** Credit balance for credit-based plans (present when windows are null). */
  credits?: CodexCredits;
  /** ISO-8601 mtime of the rollout file this snapshot was read from. A secondary
   *  freshness anchor — the per-window `stale` flag is the authoritative signal. */
  capturedAt?: string;
}

// ===== Bridge → Plugin (State Updates) =====

export interface StateUpdateEvent {
  type: 'state_update';
  state: State;
  permissionMode: PermissionMode;
  agentType?: AgentType;
  /** Session ID associated with this state payload; may move with hook activity. */
  sessionId?: string;
  /** Session explicitly focused by the user; visual selection should use this. */
  focusedSessionId?: string;
  agentCapabilities?: AgentCapabilities;
  currentTool?: string;
  toolInput?: string;
  toolProgress?: string;
  projectName?: string;
  modelName?: string;
  effortLevel?: string;
  billingType?: BillingType;
  options?: PromptOption[];
  promptType?: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review';
  question?: string;
  navigable?: boolean;
  cursorIndex?: number;
  /** Set when the focused session has a gated PreToolUse permission pending
   *  device approval — clients reply with `permission_decision { requestId }`
   *  instead of `select_option`. See bridge/src/permission-resolver.ts. */
  requestId?: string;
  suggestedPrompt?: string;
  modelCatalog?: ModelCatalogEntry[];
  sessionStatus?: OcSessionStatus;
  remoteUrl?: string;
  /** Authenticated WS URL for remote pairing (ws://ip:port?token=hex) */
  pairingUrl?: string;
  /** Number of OpenClaw backend worker sessions (multi-agent) */
  workerSessionCount?: number;
  /** Ollama process status + running models */
  ollamaStatus?: OllamaStatus;
  /** MLX local server model list */
  mlxModels?: string[];
  /** Subscription-backed authenticated services */
  subscriptions?: SubscriptionInfo[];
  /** Local Antigravity IDE quota summary, when available */
  antigravityStatus?: AntigravityStatusInfo;
  /** OpenClaw Gateway reachability (port 18789) */
  gatewayAvailable?: boolean;
  /** OpenClaw Gateway authenticated adapter connection */
  gatewayConnected?: boolean;
  /** OpenClaw Gateway has doctor warnings/errors */
  gatewayHasError?: boolean;
  /** OpenClaw Gateway auth/pairing state */
  gatewayAuthStatus?: 'gateway_not_found' | 'gateway_reachable' | 'gateway_token_missing' | 'pairing_required' | 'approval_pending' | 'connected' | 'auth_failed' | 'token_mismatch' | 'device_auth_invalid' | 'unsupported_protocol';
  /** OpenClaw device pairing request id, when Gateway requires approval */
  gatewayAuthRequestId?: string;
  /** Human-readable OpenClaw auth/pairing diagnostic */
  gatewayAuthMessage?: string;
  /** Daemon-owned hardware/module health, intentionally loose for cross-version clients */
  moduleHealth?: Record<string, unknown>;
  /** Voice assistant pipeline state (wake word → STT → LLM → TTS) */
  voiceAssistantState?: VoiceAssistantState;
  /** Transcribed user speech (processing/speaking) */
  voiceAssistantText?: string;
  /** LLM response text (speaking) */
  voiceAssistantResponseText?: string;
}

export interface PromptOptionsEvent {
  type: 'prompt_options';
  /** Session that produced these options. Required for safe device actions. */
  sessionId?: string;
  /** Session explicitly focused when the daemon relayed this event. */
  focusedSessionId?: string;
  promptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review';
  question?: string;
  options: PromptOption[];
}

export interface UsageEvent {
  type: 'usage_update';
  sessionDurationSec: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  estimatedCostUsd?: number;
  // Legacy PTY-parsed fields (kept for backward compat)
  sessionPercent?: number;
  costSpent?: number;
  costLimit?: number;
  resetTime?: string;
  resetDate?: string;
  // API-sourced global usage
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
  // Extra usage (pay-per-use beyond plan limits)
  extraUsageEnabled?: boolean;
  extraUsageMonthlyLimit?: number;
  extraUsageUsedCredits?: number;
  extraUsageUtilization?: number;
  // OAuth connection status
  oauthConnected?: boolean;
  // Ollama process status + running models (piggyback on usage polling)
  ollamaStatus?: OllamaStatus;
  // True when displaying cached data after a fetch failure
  usageStale?: boolean;
  // OAuth token status: valid/expired/missing/unknown
  tokenStatus?: 'valid' | 'expired' | 'missing' | 'unknown';
  // Codex / ChatGPT web-auth metadata
  codexAuthMode?: string;
  codexWebAuthConnected?: boolean;
  codexPlanType?: string;
  codexAccountId?: string;
  codexSubscriptionActiveUntil?: string;
  codexLastRefreshAt?: string;
  // Codex usage limits (5h/7d-style) parsed from local rollout files
  codexRateLimits?: CodexRateLimits;
  // Local model/runtime summaries
  modelCatalog?: ModelCatalogEntry[];
  mlxModels?: string[];
  subscriptions?: SubscriptionInfo[];
  antigravityStatus?: AntigravityStatusInfo;
}

export interface ConnectionEvent {
  type: 'connection';
  status: 'connected' | 'reconnecting' | 'disconnected';
  sessionId?: string;
}

export interface UserPromptEvent {
  type: 'user_prompt';
  text: string;
}

export interface VoiceStateEvent {
  type: 'voice_state';
  state: 'idle' | 'recording' | 'transcribing' | 'error';
  text?: string;
  error?: string;
}

// ===== Voice Assistant (Wake Word) =====

export type VoiceAssistantState =
  | 'idle'        // listening for wake word
  | 'listening'   // wake word detected, recording user speech
  | 'processing'  // STT + LLM in progress
  | 'speaking'    // TTS playback
  | 'disabled';   // wake word listener off

export interface VoiceAssistantStateEvent {
  type: 'voice_assistant_state';
  state: VoiceAssistantState;
  deviceId?: string;
  /** Transcribed user speech */
  text?: string;
  /** LLM response text */
  responseText?: string;
}

export interface WakeWordDetectedEvent {
  type: 'wake_word_detected';
  deviceId: string;
  timestamp: number;
}

/**
 * Per-broadcast instruction telling downstream devices HOW to dim when the
 * host display sleeps. Resolved by the daemon from the `displaySleepDim`
 * settings.json key and embedded in every `display_state` event so that
 * Pixoo / D200H / ESP32 dumb-apply a single consistent snapshot.
 * Absent ⇒ legacy behavior (full-off when displayOn=false).
 */
export interface DisplayDimInstruction {
  /** Master toggle. false ⇒ leave devices at their normal brightness. */
  enabled: boolean;
  /**
   * 'off' ⇒ the panel must read as dark; 'min' ⇒ dim to `level` but stay
   * readable.
   *
   * Consumers must branch on this rather than inferring intent from the
   * resulting brightness number: a device whose hardware floor is 5 cannot
   * distinguish "off" from "min at level 5" by value alone. Where a floor
   * makes brightness unable to express dark — the iDotMatrix firmware accepts
   * 5-100, and there is no screen-off command — 'off' means pushing black
   * pixels, not the lowest brightness.
   */
  mode: 'off' | 'min';
  /**
   * Minimum-brightness percent (1-100). Ignored when mode='off'.
   *
   * This is the requested level, not a promise. Consumers clamp it up to their
   * own hardware floor (Pixoo 1, iDotMatrix 5, Timebox 0 because brightness is
   * baked into the frame), so the same `level` legitimately renders differently
   * across panels. Do not "fix" that divergence by forcing a shared floor — it
   * would push devices below what their firmware accepts.
   */
  level: number;
}

export interface DisplayStateEvent {
  type: 'display_state';
  displayOn: boolean;
  /** How to dim on sleep. Absent ⇒ legacy full-off. */
  dim?: DisplayDimInstruction;
}

// ===== Multi-session Discovery =====

export interface SessionInfo {
  id: string;
  port: number;
  pid?: number;
  projectName: string;
  agentType?: AgentType;
  alive: boolean;
  state?: string;  // sibling's current state from /health query
  modelName?: string;  // sibling's current model from /health query
  effortLevel?: string;  // sibling's current effort (max/xhigh/high/medium/low/default/fast)
  startedAt?: string;  // ISO 8601 session start time
  currentTool?: string;
  groupSize?: number;
  foldedSessionIds?: string[];
  controlMode?: 'managed' | 'observed';
  cwd?: string;
  currentTask?: string;
  /** Daemon-synthesized "what is this agent doing right now" one-liner — a shared
   *  source so glance surfaces (XTeink X3 rows, TRMNL list) render the same text. */
  activity?: string;
  goal?: string;  // one-line gist of the session's purpose (first user prompt) — observed sessions
  contextPercent?: number;
  totalTokens?: number;
  question?: string;  // awaiting prompt question text (hook/observed sessions: from Notification message; managed PTY: parsed header)
  requestId?: string;  // present when a gated PreToolUse permission is pending device approval; devices render Allow/Deny + send permission_decision
  /** Observed sessions: a device requested a soft STOP (deny at the next tool call) — render "stopping…" instead of an active STOP. */
  stopRequested?: boolean;
  /** Observed sessions: deck prompts queued for delivery at the current turn's end (Stop-hook directive queue). */
  queuedDirectives?: number;
  /** On-demand review lifecycle for the REVIEW badge tile ('running' while the judge works). */
  reviewStatus?: 'running' | 'done' | 'error';
  /** Last review verdict (with reviewFindings) — devices render "risk: low · 2" on the REVIEW tile. */
  reviewRisk?: 'low' | 'medium' | 'high';
  reviewFindings?: number;
  /** Observed sessions: this daemon can answer the session's LIVE on-screen
   *  prompt by typing into its terminal/app host (`observed-inject.ts`), so a
   *  deck may render its `options` as pressable instead of inert. Absent/false
   *  means no reachable host was found, or the daemon cannot inject at all
   *  (App Store Swift daemon — no subprocess). Emitted explicitly in BOTH
   *  polarities: a flag only ever sent when true latches one-way under
   *  retain-on-absent merging. */
  liveAnswerable?: boolean;
  promptType?: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review';  // shape of the awaiting prompt (per-session, for inline approve/deny + option buttons on rich panels)
  options?: PromptOption[];  // per-session awaiting options (multi_select) — lets a 10-up panel render inline choices for any session, not just the focused one
  elapsedSec?: number;  // derived seconds since startedAt — devices without reliable NTP render elapsed without recomputing from a wall clock
}

export interface SessionsListEvent {
  type: 'sessions_list';
  sessions: SessionInfo[];
}

export interface TimelineEventMsg {
  type: 'timeline_event';
  entry: TimelineEntry;
  upsert?: boolean;
}

export interface TimelineHistoryMsg {
  type: 'timeline_history';
  entries: TimelineEntry[];
  /** Set when this history is a reply to `query_session_timeline` — scopes the
   *  entries to one session so reconnecting glance devices (XTeink X3) can fill a
   *  per-session Detail view on demand instead of waiting for live events. */
  sessionId?: string;
}

// ===== APME (Agent Performance Monitoring & Evaluation) =====

/** A single evaluation score on a completed run. */
export interface ApmeEvalRow {
  layer: 'deterministic' | 'llm_judge' | 'vibe' | 'turn_judge' | 'task_judge' | 'trajectory' | 'manual_review';
  metric: string;           // e.g. 'build_ok', 'tests_pass', 'intent', 'overall'
  score: number;            // 0.0 - 1.0
  rubricVer?: number;
  judgeModel?: string;
  createdAt: number;
}

/** A run that has finished evaluation. */
export interface ApmeRunSummary {
  runId: string;
  sessionId: string;
  agentType: AgentType;
  modelId?: string;
  projectName?: string;
  taskPrompt?: string;
  taskCategory?: string;
  outcome?: 'committed' | 'abandoned' | 'iterated' | 'ab_winner' | 'ab_loser' | 'interrupted' | 'exploratory' | 'pending';
  compositeScore?: number;
  startedAt: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  exitCode?: number;
  overallScore?: number;    // cached aggregate of evals.overall
  evals: ApmeEvalRow[];
}

/** Bridge → clients — fires when a run completes evaluation (layer 1 or 2). */
export interface ApmeEvalEvent {
  type: 'apme_eval';
  run: ApmeRunSummary;
}

export interface ApmeModelScorecard {
  agentType: AgentType;
  modelId: string;
  runs: number;
  avgOverall?: number;
  avgTestsPass?: number;
  totalCost?: number;
  costPerQuality?: number;
}

/** Bridge → clients — scorecard refresh (broadcast after eval completes or on demand). */
export interface ApmeScorecardEvent {
  type: 'apme_scorecard';
  scorecards: ApmeModelScorecard[];
}

export interface ApmeRecommendation {
  modelId: string;
  agentType: AgentType;
  expectedScore: number;    // 0-1
  expectedCostUsd: number;
  confidence: number;       // 0-1
  rationale: string;
}

/** Bridge → clients — model recommendation for the next task (on-demand / context-aware). */
export interface ApmeRecommendationEvent {
  type: 'apme_recommendation';
  taskKind?: string;
  candidates: ApmeRecommendation[];
}

// ===== WiFi Provisioning (Bridge → ESP32 Serial) =====

export interface WifiProvisionMessage {
  type: 'wifi_provision';
  ssid: string;
  password: string;
  bridgeIp: string;
  bridgePort: number;
  authToken: string;
}

// ===== ESP32 Serial → Bridge =====

export interface DeviceInfoMessage {
  type: 'device_info';
  // "86box" | "round_amoled" | "ips_35" | "ips_10" | "ttgo_t_display"
  // | "ulanzi_tc001" | "inkdeck" | "t_embed" (wire strings — see esp32/src/net/protocol.cpp)
  // | "xteink_x3" | "xteink_x4" (external CrossPoint fork; see docs/esp32-client-contract.md)
  board: string;
  version: string;       // firmware version (FIRMWARE_VERSION — bumped rarely)
  buildHash?: string;    // git short-hash of the flashed source (GIT_SHA); "unknown" on non-git builds. Optional: pre-0.1.2 firmware omits it.
  buildEpoch?: number;   // unix seconds the firmware was compiled (BUILD_EPOCH)
  wifiConfigured: boolean;
  wifiConnected: boolean;
  /** True when firmware intentionally powered WiFi down because USB serial is primary. */
  wifiRadioParked?: boolean;
  /** Board uptime in seconds at the moment the info frame was emitted. */
  uptimeSec?: number;
  /** ESP-IDF reset reason as a stable diagnostic string, e.g. "brownout" or "panic". */
  resetReason?: string;
  /** Raw esp_reset_reason_t numeric code for cases not covered by resetReason. */
  resetReasonCode?: number;
  ip?: string;
  otaSupported?: boolean;
  otaSlotCount?: number;
  otaSlotSize?: number;
  otaFreeSketchSpace?: number;
  otaReason?: string;
  /**
   * Peripheral capability advertisement (docs/esp32-companion-concepts.md
   * § Peripheral primitives) — what this board can sense/actuate beyond its
   * panel, e.g. "battery" | "nfc" | "ir_rx" | "ir_tx" | "subghz_rx" | "audio".
   * Absent on boards that predate the field.
   */
  capabilities?: string[];
  /** Battery state of charge 0-100 (boards with a fuel gauge, e.g. t_embed). */
  batteryPercent?: number;
  /** Measured cell voltage for charger-only boards without a fuel-gauge SOC. */
  batteryVoltageMv?: number;
  /** Charger reports active charging. */
  batteryCharging?: boolean;
  /** Charger reports external (USB) power good. */
  usbPowered?: boolean;
  /** Gauge-read failure diagnostic (Wire error code) when battery fields are absent. */
  batteryDiag?: number;
}

/**
 * Raw peripheral sensing primitive (device → daemon). One frame shape for
 * everything a peripheral-rich board senses; the daemon maps events to
 * existing commands via user config rather than the firmware growing bespoke
 * features. Kinds: "nfc_tag" (uid), "ir_rx" (protocol/code),
 * "subghz_rx" (freq/rssi/code).
 */
export interface PeripheralEventMessage {
  type: 'peripheral_event';
  /** Board wire string, e.g. "t_embed" — lets the daemon attribute the sensor. */
  board?: string;
  kind: 'nfc_tag' | 'ir_rx' | 'subghz_rx';
  /** NFC tag UID as uppercase hex, e.g. "04A1B2C3". */
  uid?: string;
  /** IR protocol name / raw code (hex string). */
  protocol?: string;
  code?: string;
  /** Sub-GHz capture metadata. */
  freq?: number;
  rssi?: number;
}

/**
 * Device-sourced voice capture. Over WebSocket the PCM travels as binary frames
 * between `voice_begin` and `voice_end`; over serial — which is line-delimited
 * JSON — the same PCM is base64-encoded inside `audio_chunk`, because raw
 * samples contain newlines and would tear the framing for every other reader of
 * that port. A board must not mix the two on one connection.
 */
export interface VoiceBeginMessage {
  type: 'voice_begin';
  board?: string;
  /** Capture rate in Hz (16000 in every shipping firmware). */
  sampleRate?: number;
  /** Session the utterance is aimed at — the one the knob was pointing at.
   *  May be device-truncated; the daemon restores it by unique prefix. */
  sessionId?: string;
}

export interface VoiceEndMessage {
  type: 'voice_end';
  board?: string;
}

/** Base64 PCM16LE fragment; serial transport only. */
export interface AudioChunkMessage {
  type: 'audio_chunk';
  d: string;
}

/**
 * Device-sourced photo capture (T-Display-S3-Pro rear camera "show-and-tell").
 * Same transport split as voice: over WebSocket the JPEG travels as binary
 * frames between `photo_begin` and `photo_end`; over serial the same bytes
 * ride base64 inside `photo_chunk` lines. A board must not mix the two on one
 * connection, and must not interleave a photo with an open voice utterance.
 * The daemon assembles the JPEG, saves it, and routes a prompt referencing the
 * file path to the target session; it answers with a `photo_result` frame
 * (`{delivered, sessionId, bytes?, error?, via?, deliverReason?}`) on the same
 * transport, mirroring `voice_result`.
 */
export interface PhotoBeginMessage {
  type: 'photo_begin';
  board?: string;
  /** Only 'jpeg' ships today. */
  format?: string;
  width?: number;
  height?: number;
  /** Session the photo is aimed at — the strip's focus pick. May be
   *  device-truncated; the daemon restores it by unique prefix, and falls back
   *  to its own focused session when empty. */
  sessionId?: string;
}

export interface PhotoEndMessage {
  type: 'photo_end';
  board?: string;
  cancel?: boolean;
  /** Total JPEG bytes the board believes it sent (integrity cross-check). */
  bytes?: number;
}

/** Base64 JPEG fragment; serial transport only. */
export interface PhotoChunkMessage {
  type: 'photo_chunk';
  d: string;
}

export interface WifiProvisionAckMessage {
  type: 'wifi_provision_ack';
  success: boolean;
  ip?: string;           // assigned IP on success
  error?: string;        // reason on failure
}

export interface WifiStatusMessage {
  type: 'wifi_status';
  connected: boolean;
  ssid?: string;
  ip?: string;
}

// ===== ESP32 WiFi OTA (Daemon → ESP32) =====

export interface Esp32OtaBeginEvent {
  type: 'esp32_ota_begin';
  otaId: string;
  size: number;
  md5: string;
}

export interface Esp32OtaChunkEvent {
  type: 'esp32_ota_chunk';
  otaId: string;
  seq: number;
  offset: number;
  data: string; // base64-encoded firmware bytes
}

export interface Esp32OtaEndEvent {
  type: 'esp32_ota_end';
  otaId: string;
}

export interface Esp32OtaAbortEvent {
  type: 'esp32_ota_abort';
  otaId: string;
}

export interface Esp32OtaAckCommand {
  type: 'esp32_ota_ack';
  otaId: string;
  stage: 'begin' | 'chunk' | 'end' | 'abort';
  seq?: number;
  offset?: number;
  written?: number;
}

export interface Esp32OtaErrorCommand {
  type: 'esp32_ota_error';
  error: string;
  otaId?: string;
  stage?: string;
}

// ===== Card Feed Pull Sync (M6 — battery e-ink clients) =====
//
// HTTP pull counterpart to the WS live mode, for wake-sync-sleep clients
// (XTeink X3/X4 on battery). `GET /feed` returns the current card set;
// `POST /outbox` pushes decisions the device recorded while offline. Both are
// plain HTTP on the daemon port (9120) — no persistent socket, so a device can
// wake, sync, and deep-sleep in seconds. WS remains the docked live mode.
// Contract doc: docs/esp32-client-contract.md § Pull sync.

/**
 * Per-card offline-validity class. Decides what a *cached* card may do when
 * the daemon is unreachable (the fork's decision-card honesty rule):
 *
 * - `live` — must be answered against a live daemon (permission gates, PTY
 *   prompts). Cached copies grey out ("reconnect to act") and TTL-expire via
 *   `expiresAt`. An outbox decision for an expired live card is rejected, never
 *   silently applied.
 * - `day` — valid all day (M7 card modules: NUDGE / QUEST / INTERVAL / FORK).
 *   Decisions queue in the device outbox and apply on next sync. No daemon
 *   producer emits this class yet — it is in the schema so the device-side
 *   outbox grammar doesn't change when M7 lands.
 * - `info` — read-only status (session rows, digests). Always valid to
 *   display; shows sync age; never gains buttons offline.
 */
export type CardActionClass = 'live' | 'day' | 'info';

// ===== Card modules (M7) — the non-session card producers =====
//
// M6 cards are all projections of a live session. A module card is authored by
// the daemon instead: a checkpoint, a digest, a nudge, a commitment. It carries
// its own body because there is no session row to render.
//
// The device grammar does not change: one screen, one question, at most four
// choices, one press. Slot 1 of the four front buttons is always **Later** and
// is supplied by the device, so a module binds at most three — `CARD_MAX_CHOICES`
// is that rule as a number, clamped at the daemon's build chokepoint so a
// device never has to decide what to do with a fifth.

/** Which daemon module authored a card. Session-derived cards carry none.
 *
 * - `thread` — work checkpoint: where each open thread stopped.
 * - `pulse`  — periodic digest of what happened.
 * - `nudge`  — a question the user agreed to be asked ("still on this?").
 * - `quest`  — a standing commitment tracked across days.
 *
 * `thread`/`pulse` are read-only (`info`); `nudge`/`quest` are the first `day`
 * class producers — answerable offline, queued in the device outbox. */
export type CardModuleId = 'thread' | 'pulse' | 'nudge' | 'quest';

/** Max choices a module card may bind (slot 1 is the device's own **Later**).
 *  Producers clamp; they never grow a fifth button. */
export const CARD_MAX_CHOICES = 3;
/** Max supporting lines under the question. The panel is small and the rule is
 *  one screen — a module that needs more is really two cards. */
export const CARD_MAX_CONTEXT_LINES = 4;

export interface CardChoice {
  /** Echoed back as the outbox decision's `choiceId`. Must be a stable
   *  meaning, never a position: a card answered from an hour-old cache has to
   *  select the same thing it displayed, even if the order has since changed. */
  id: string;
  /** Button label. The e-ink hint bar budgets by UTF-8 bytes, so CJK labels
   *  must stay short (see the device's card text caps). */
  label: string;
  /** Rendering hint only — it never affects routing. */
  intent?: 'affirm' | 'deny' | 'neutral';
}

/** Body of a module-authored card. */
export interface ModuleCard {
  module: CardModuleId;
  /** Card header — the module's own name in the device's voice ("THREAD"). */
  title: string;
  /** The one question or headline. */
  question: string;
  /** Supporting lines, at most `CARD_MAX_CONTEXT_LINES`. */
  context?: string[];
  /** At most `CARD_MAX_CHOICES`. Absent/empty = read-only card. */
  choices?: CardChoice[];
  /** The session this card is *about*, when it has one, so the device can
   *  offer Detail without inventing a link. */
  sessionId?: string;
}

/** One card in the pull feed. Exactly one body is present: `session` for the
 *  M6 session projections, `module` for an M7 module card. A client that
 *  predates modules skips bodies it doesn't recognise rather than rendering a
 *  blank card. */
export interface FeedCard {
  /** Stable id for outbox correlation — `session:<sessionId>` for
   *  session-derived cards, `module:<moduleId>:<key>` for module cards. */
  cardId: string;
  actionClass: CardActionClass;
  /** Epoch-ms after which a `live` card is no longer answerable. Absent on
   *  `day`/`info` cards. */
  expiresAt?: number;
  /** Session-derived card body (M6). */
  session?: SessionInfo;
  /** Module-authored card body (M7). */
  module?: ModuleCard;
}

export interface CardFeedResponse {
  type: 'card_feed';
  /** Contract revision — bump on breaking shape changes. */
  rev: 1;
  /** Daemon wall clock, epoch-ms. A drifty-RTC device re-anchors its clock
   *  estimate from this on every pull (the M5.5 "as of" age source). */
  serverTime: number;
  /** Daemon host-local "HH:MM" (same convention as timeline `localHm`) so an
   *  RTC-less client renders wall time without timezone math. */
  serverHm: string;
  /** Suggested seconds until the next pull — the daemon's half of the power
   *  ladder. Devices may clamp but should not poll faster than this while on
   *  battery. */
  nextPullSec: number;
  cards: FeedCard[];
}

/** One decision recorded on-device, replayed via `POST /outbox`. The fields
 *  mirror the equivalent WS command so the daemon can route through the same
 *  dispatch path. */
export interface OutboxDecision {
  /** Feed card the decision answers. */
  cardId: string;
  /** Session the card was derived from (echo of `FeedCard.session.id`). */
  sessionId?: string;
  /** Permission gate correlation — required when action=`permission_decision`;
   *  the gate must still be pending or the decision is rejected as expired. */
  requestId?: string;
  action: 'permission_decision' | 'select_option' | 'respond' | 'send_prompt' | 'dismiss' | 'card_choice';
  /** action=card_choice — the `CardChoice.id` the user pressed on a module
   *  card. Routed back to the authoring module, which owns what it means. */
  choiceId?: string;
  /** action=permission_decision */
  decision?: 'allow' | 'deny';
  /** action=select_option — wire option index. */
  index?: number;
  /** action=respond — option shortcut/value. */
  value?: string;
  /** action=send_prompt — prompt text. */
  text?: string;
  /** Prompt-content echo (the card's `question` at record time). The daemon
   *  refuses to apply an option decision when the session's *current* question
   *  no longer matches — an hour-old index must never press a different,
   *  newer prompt. */
  question?: string;
  /** Seconds elapsed on-device between recording and pushing. Drift-free age
   *  for validity checks — device epoch clocks are not trusted. */
  ageSec?: number;
}

export interface OutboxPushRequest {
  /** Device wire identity, e.g. "xteink_x4" — attribution/diagnostics. */
  board?: string;
  decisions: OutboxDecision[];
}

export type OutboxDecisionStatus = 'applied' | 'expired' | 'unknown_card' | 'rejected' | 'error';

/** Per-decision outcome. Order matches the request array. The device deletes
 *  every acknowledged decision from its outbox regardless of status — a
 *  rejection is terminal, not retryable. */
export interface OutboxDecisionResult {
  cardId: string;
  status: OutboxDecisionStatus;
  reason?: string;
}

export interface OutboxPushResponse {
  ok: boolean;
  results: OutboxDecisionResult[];
}

/** HTTP paths on the daemon port (BRIDGE_HTTP_PORT). */
export const CARD_FEED_PATH = '/feed';
export const CARD_OUTBOX_PATH = '/outbox';
/** Pull cadence hints (`nextPullSec`): idle default vs. when any session is
 *  mid-turn / awaiting. Hourly idle matches what a drifty RTC can honour. */
export const CARD_FEED_IDLE_PULL_SEC = 3600;
export const CARD_FEED_ACTIVE_PULL_SEC = 900;

export type ESP32ToHostMessage =
  | DeviceInfoMessage
  | WifiProvisionAckMessage
  | WifiStatusMessage
  | Esp32OtaAckCommand
  | Esp32OtaErrorCommand
  | PeripheralEventMessage
  | VoiceBeginMessage
  | VoiceEndMessage
  | AudioChunkMessage
  | PhotoBeginMessage
  | PhotoEndMessage
  | PhotoChunkMessage;

/**
 * On-demand independent review lifecycle. Triggered by the REVIEW deck button
 * (ReviewRunCommand) — the daemon reviews the session's latest work with an
 * independent judge model (Node: working-tree diff; Swift: APME trajectory)
 * and reports risk findings. Needs no agent control, so it works for every
 * session type including observed codex.
 */
export interface ReviewStatusEvent {
  type: 'review_status';
  sessionId: string;
  status: 'running' | 'error';
  message?: string;
}

export interface ReviewResultEvent {
  type: 'review_result';
  sessionId: string;
  risk: 'low' | 'medium' | 'high';
  findings: number;
  summary: string;
  /** Local HTML report path (Node daemon writes + opens it in a browser). */
  reportPath?: string;
}

export type BridgeEvent =
  | StateUpdateEvent
  | PromptOptionsEvent
  | UsageEvent
  | ConnectionEvent
  | UserPromptEvent
  | VoiceStateEvent
  | VoiceAssistantStateEvent
  | WakeWordDetectedEvent
  | DisplayStateEvent
  | SessionsListEvent
  | EncoderStateEvent
  | DeckSlotMapEvent
  | ButtonStateEvent
  | TimelineEventMsg
  | TimelineHistoryMsg
  | ApmeEvalEvent
  | ApmeScorecardEvent
  | ApmeRecommendationEvent
  | ReviewStatusEvent
  | ReviewResultEvent
  | Esp32OtaBeginEvent
  | Esp32OtaChunkEvent
  | Esp32OtaEndEvent
  | Esp32OtaAbortEvent;

// ===== Plugin → Bridge (Commands) =====

export interface ResponseCommand {
  type: 'respond';
  value: string; // 'y' | 'n' | 'a' or option text
}

export interface SelectOptionCommand {
  type: 'select_option';
  index: number; // 0-based option index
  sessionId?: string; // route to a specific session's awaiting prompt; omitted ⇒ focused session (legacy)
}

export interface NavigateOptionCommand {
  type: 'navigate_option';
  direction: 'up' | 'down';
}

export interface SendPromptCommand {
  type: 'send_prompt';
  text: string;
}

export interface SwitchModeCommand {
  type: 'switch_mode';
  mode?: 'plan' | 'acceptEdits' | 'default';
}

export interface InterruptCommand {
  type: 'interrupt'; // Ctrl+C
}

export interface EscapeCommand {
  type: 'escape'; // Esc key — cancel prompt/selection
}

export interface VoiceCommand {
  type: 'voice';
  action: 'start' | 'stop' | 'cancel';
}

export interface QueryUsageCommand {
  type: 'query_usage';
}

/** Request a session's recent timeline. The daemon replies (to the requester
 *  only) with a `timeline_history` carrying that session's entries. Lets a
 *  device that connects mid-session fill its per-session Detail view. */
export interface QuerySessionTimelineCommand {
  type: 'query_session_timeline';
  sessionId: string;
  /** Optional epoch-ms lower bound; omit for the full retained history. */
  since?: number;
}

export interface DiagCommand {
  type: 'diag';
  action: 'dump' | 'analyze';
}

export interface UtilityCommand {
  type: 'utility';
  action: 'adjust_volume' | 'toggle_mute' | 'adjust_brightness'
        | 'media_play_pause' | 'media_next' | 'media_prev';
  value?: number; // delta ticks (for adjust commands)
}

export interface SwitchAgentCommand {
  type: 'switch_agent';
  agent: 'openclaw' | 'claude-code';
}

export interface FocusSessionCommand {
  type: 'focus_session';
  sessionId: string;
}

export interface ClearSessionFocusCommand {
  type: 'clear_session_focus';
}

/** APME vibe check — user approves or rejects a completed run's output quality. */
export interface ApmeVibeFeedbackCommand {
  type: 'apme_vibe';
  runId: string;
  verdict: 'approve' | 'reject' | 'neutral';
  note?: string;
}

/** Ask bridge/daemon for model recommendation given a task context. */
export interface ApmeRecommendCommand {
  type: 'apme_recommend';
  taskKind?: string;
  budgetUsd?: number;
  latencyBudgetMs?: number;
  preferLocal?: boolean;
}

/**
 * Self-announcement from a rich UI client (Elgato Stream Deck plugin, a
 * future Android companion app, etc.) so the daemon can surface the
 * hardware under its rightful Downstream row instead of treating every
 * WS connection as an anonymous dashboard viewer. Sent once per connect,
 * immediately after the WebSocket opens. Daemon wipes the cached entry
 * when the WS connection closes.
 */
export interface ClientRegisterCommand {
  type: 'client_register';
  /** Short stable id — "streamdeck-plugin", "android-companion", etc. */
  clientType: string;
  /** Human-readable label for the surface (appears verbatim in diagnostics). */
  clientLabel?: string;
  /** Physical device roster this client is driving, if any. */
  devices?: Array<{
    id: string;
    name: string;
    /** "streamdeck" | "streamdeckplus" | "streamdeckmini" | ... — free-form. */
    family?: string;
    columns?: number;
    rows?: number;
  }>;
}

/**
 * Session-scoped command — daemon forwards the inner command to the specified session's bridge.
 * Enables direct control of a specific session from any client (MenuBarExtra, Dashboard, etc.)
 */
export interface SessionCommand {
  type: 'session_command';
  sessionId: string;
  command: {
    type: string;
    [key: string]: unknown;
  };
}

/**
 * Trigger an independent on-demand review of a session's latest work (the
 * REVIEW deck button). Daemon-side eval with an independent judge model —
 * no agent control involved, so every session type qualifies. Results flow
 * back as review_status / review_result events plus SessionInfo badge fields.
 */
export interface ReviewRunCommand {
  type: 'review_run';
  sessionId: string;
}

/**
 * Device approval decision for a gated PreToolUse permission request (observed
 * sessions). The daemon holds the hook's HTTP response open keyed by
 * `requestId`; this command resolves it into a Claude Code permission decision.
 * See bridge/src/permission-resolver.ts.
 */
export interface PermissionDecisionCommand {
  type: 'permission_decision';
  requestId: string;
  decision: 'allow' | 'deny';
}

export type PluginCommand =
  | ResponseCommand
  | SelectOptionCommand
  | NavigateOptionCommand
  | SendPromptCommand
  | SwitchModeCommand
  | InterruptCommand
  | EscapeCommand
  | VoiceCommand
  | QueryUsageCommand
  | QuerySessionTimelineCommand
  | DiagCommand
  | UtilityCommand
  | SwitchAgentCommand
  | FocusSessionCommand
  | ClearSessionFocusCommand
  | SessionCommand
  | ClientRegisterCommand
  | ApmeVibeFeedbackCommand
  | ApmeRecommendCommand
  | PermissionDecisionCommand
  | ReviewRunCommand
  | Esp32OtaAckCommand
  | Esp32OtaErrorCommand;

// ===== Hook Event Types =====

export interface HookEvent {
  event: string;
  data: Record<string, unknown>;
}

// ===== Constants =====

/** Events forwarded to display-only devices (Pixoo64) */
export const DISPLAY_FORWARDED_EVENTS = new Set([
  'state_update',
  'usage_update',
  'sessions_list',
  'connection',
  'display_state',
]);

/** Events forwarded to serial devices (ESP32) — display events + timeline */
export const SERIAL_FORWARDED_EVENTS = new Set([
  ...DISPLAY_FORWARDED_EVENTS,
  'timeline_event',
  'timeline_history',
  'set_orientation',
]);

export const BRIDGE_WS_PORT = 9120;
export const BRIDGE_HTTP_PORT = 9120; // Same port, different path
export const RECONNECT_INTERVAL_MS = 3000;
/** Plugin reconnect backoff ladder. Advances on each failed attempt, resets on `connected`. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000];
export const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (PROCESSING hang)
/** Backstop for AWAITING_* states. Longer than STUCK_TIMEOUT_MS because a user
 *  can legitimately leave a permission/option/diff prompt unanswered for a
 *  while; this only fires when a managed PTY session never sees the recovery
 *  spinner/idle (parser miss) and no follow-up hook arrives. */
export const AWAITING_STUCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const WS_PING_INTERVAL_MS = 15_000;
export const WS_ACTIVITY_TIMEOUT_MS = 30_000;
/** Soft-stale threshold: shorter than WS_ACTIVITY_TIMEOUT_MS so a client can dim
 *  its last-known render (and flag it as stale) before the hard disconnect. The
 *  daemon pings every WS_PING_INTERVAL_MS, so this only trips when the daemon
 *  genuinely stops responding. Mirrors the 20s stale window in the TUI/Apple. */
export const WS_STALE_TIMEOUT_MS = 20_000;
