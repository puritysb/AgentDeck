// Re-export all shared types
export {
  State,
  PermissionMode,
  type TransitionSource,
  type StateTransition,
  transitions,
  type PromptOption,
  type StateSnapshot,
  type BillingType,
  type AgentType,
  type AgentCapabilities,
  type AgentAdapter,
  type AgentAdapterEvents,
  type AdapterStartOptions,
  type AdapterEvent,
  type AdapterHookEvent,
  type AdapterParserEvent,
  type AdapterMetadataEvent,
  type AdapterActivityEvent,
  type AdapterConnectionEvent,
  type AdapterTimelineEvent,
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CLI_CAPABILITIES,
  CODEX_APP_CAPABILITIES,
  OPENCLAW_CAPABILITIES,
  OPENCODE_CAPABILITIES,
  MONITOR_CAPABILITIES,
  OPENCLAW_GATEWAY_PORT,
  OPENCODE_DEFAULT_PORT,
} from '@agentdeck/shared';

export {
  type ModelCatalogEntry,
  type AntigravityStatusInfo,
  type SubscriptionInfo,
  type EncoderSlotState,
  type EncoderStateEvent,
  type ButtonSlotState,
  type ButtonStateEvent,
  type DeckSlotConfig,
  type DeckSlotMapEvent,
  type StateUpdateEvent,
  type PromptOptionsEvent,
  type UsageEvent,
  type ConnectionEvent,
  type UserPromptEvent,
  type VoiceStateEvent,
  type VoiceAssistantState,
  type TimelineEventMsg,
  type TimelineHistoryMsg,
  type BridgeEvent,
  type ResponseCommand,
  type SelectOptionCommand,
  type NavigateOptionCommand,
  type SendPromptCommand,
  type SwitchModeCommand,
  type InterruptCommand,
  type VoiceCommand,
  type QueryUsageCommand,
  type UtilityCommand,
  type PluginCommand,
  type HookEvent,
  BRIDGE_WS_PORT,
  BRIDGE_HTTP_PORT,
  RECONNECT_INTERVAL_MS,
  STUCK_TIMEOUT_MS,
  AWAITING_STUCK_TIMEOUT_MS,
} from '@agentdeck/shared/protocol';

export {
  type TimelineEntry,
  type TimelineEntryType,
  parseLogLine,
} from '@agentdeck/shared';

export {
  type GatewayFrame,
  type GatewayRequestFrame,
  type GatewayResponseFrame,
  type GatewayEventFrame,
  type GatewayError,
  type GatewayMethodMap,
  type GatewaySession,
  type DeviceIdentity,
  type DeviceAuthToken,
} from '@agentdeck/shared';
// ===== Bridge-specific types =====

export interface VoiceState {
  recording: boolean;
  transcribing: boolean;
  lastTranscription: string | null;
  error: string | null;
}

export interface SessionInfo {
  sessionId: string;
  startedAt: number;
  pid: number | null;
  port: number;
  workingDirectory: string;
}

export interface UsageSnapshot {
  sessionDurationSec: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  estimatedCostUsd: number | null;
  sessionPercent: number | null;
  costSpent: number | null;
  costLimit: number | null;
  resetTime: string | null;
  resetDate: string | null;
}
