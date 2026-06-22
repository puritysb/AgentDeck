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
  /** 'off' ⇒ brightness 0; 'min' ⇒ dim to `level`. */
  mode: 'off' | 'min';
  /** Minimum-brightness percent (1-100). Ignored when mode='off'. */
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
  goal?: string;  // one-line gist of the session's purpose (first user prompt) — observed sessions
  contextPercent?: number;
  totalTokens?: number;
  question?: string;  // awaiting prompt question text (hook/observed sessions: from Notification message; managed PTY: parsed header)
  requestId?: string;  // present when a gated PreToolUse permission is pending device approval; devices render Allow/Deny + send permission_decision
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
}

// ===== APME (Agent Performance Monitoring & Evaluation) =====

/** A single evaluation score on a completed run. */
export interface ApmeEvalRow {
  layer: 'deterministic' | 'llm_judge' | 'vibe' | 'turn_judge' | 'task_judge' | 'trajectory';
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
  board: string;         // "86box" | "round_amoled" | "ips_35" | "ips_10"
  version: string;       // firmware version
  wifiConfigured: boolean;
  wifiConnected: boolean;
  ip?: string;
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

export type ESP32ToHostMessage =
  | DeviceInfoMessage
  | WifiProvisionAckMessage
  | WifiStatusMessage;

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
  | ApmeRecommendationEvent;

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
  | DiagCommand
  | UtilityCommand
  | SwitchAgentCommand
  | FocusSessionCommand
  | ClearSessionFocusCommand
  | SessionCommand
  | ClientRegisterCommand
  | ApmeVibeFeedbackCommand
  | ApmeRecommendCommand
  | PermissionDecisionCommand;

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
