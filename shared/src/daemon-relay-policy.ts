// Canonical Node/Swift relay v1 bounds and row allow-list.
export const RELAY_POLICY = {
  "RELAY_PROTOCOL_VERSION": 1,
  "RELAY_SNAPSHOT_HEARTBEAT_MS": 15000,
  "RELAY_ROW_TTL_MS": 45000,
  "RELAY_MAX_ROWS": 64,
  "RELAY_POLL_MS": 2000,
  "RELAY_PONG_TIMEOUT_MS": 45000,
  "RELAY_ACK_TIMEOUT_MS": 10000,
  "RELAY_REFUSED_RETRY_MS": 60000,
  "RELAY_MAX_STRING": 4000,
  "RELAY_MAX_OPTIONS": 16,
  "RELAY_STRING_FIELDS": [
    "displayName",
    "projectName",
    "agentType",
    "state",
    "modelName",
    "effortLevel",
    "permissionMode",
    "startedAt",
    "currentTool",
    "cwd",
    "currentTask",
    "activity",
    "goal",
    "question",
    "questionDetail",
    "requestId",
    "reviewStatus",
    "reviewRisk",
    "promptType",
    "lastEventText",
    "lastEventTask",
    "lastEventHm"
  ],
  "RELAY_NUMBER_FIELDS": [
    "groupSize",
    "contextPercent",
    "totalTokens",
    "queuedDirectives",
    "reviewFindings",
    "askGroupIndex",
    "askGroupCount",
    "backgroundTaskCount",
    "backgroundStandbyCount"
  ],
  "RELAY_BOOLEAN_FIELDS": [
    "stopRequested",
    "liveAnswerable",
    "controllerInput"
  ],
  "RELAY_OBJECT_FIELDS": [
    "subagents",
    "coordination"
  ],
  "RELAY_VOLATILE_FIELDS": [
    "elapsedSec"
  ],
  "RELAY_MAX_WORKERS": 64,
  "RELAY_MAX_MESSAGE_BYTES": 2097152,
  "RELAY_HEALTH_TIMEOUT_MS": 3000,
  "RELAY_SEND_TIMEOUT_MS": 5000,
  "RELAY_CONNECT_TIMEOUT_MS": 5000,
  "RELAY_RECONNECT_INITIAL_MS": 2000,
  "RELAY_RECONNECT_MAX_MS": 30000,
  "RELAY_SWEEP_MS": 5000
} as const;
