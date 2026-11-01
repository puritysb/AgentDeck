// GENERATED from shared/src/daemon-relay-policy.ts.
#if os(macOS)
enum DaemonRelayPolicy {
    static let RELAY_PROTOCOL_VERSION = 1
    static let RELAY_SNAPSHOT_HEARTBEAT_MS = 15000
    static let RELAY_ROW_TTL_MS = 45000
    static let RELAY_MAX_ROWS = 64
    static let RELAY_POLL_MS = 2000
    static let RELAY_PONG_TIMEOUT_MS = 45000
    static let RELAY_ACK_TIMEOUT_MS = 10000
    static let RELAY_REFUSED_RETRY_MS = 60000
    static let RELAY_MAX_STRING = 4000
    static let RELAY_MAX_OPTIONS = 16
    static let RELAY_STRING_FIELDS = ["displayName","projectName","agentType","state","modelName","effortLevel","permissionMode","startedAt","currentTool","cwd","currentTask","activity","goal","question","questionDetail","requestId","reviewStatus","reviewRisk","promptType","lastEventText","lastEventTask","lastEventHm"]
    static let RELAY_NUMBER_FIELDS = ["groupSize","contextPercent","totalTokens","queuedDirectives","reviewFindings","askGroupIndex","askGroupCount","backgroundTaskCount","backgroundStandbyCount"]
    static let RELAY_BOOLEAN_FIELDS = ["stopRequested","liveAnswerable","controllerInput"]
    static let RELAY_OBJECT_FIELDS = ["subagents","coordination"]
    static let RELAY_VOLATILE_FIELDS = ["elapsedSec"]
    static let RELAY_MAX_WORKERS = 64
    static let RELAY_MAX_MESSAGE_BYTES = 2097152
    static let RELAY_HEALTH_TIMEOUT_MS = 3000
    static let RELAY_SEND_TIMEOUT_MS = 5000
    static let RELAY_CONNECT_TIMEOUT_MS = 5000
    static let RELAY_RECONNECT_INITIAL_MS = 2000
    static let RELAY_RECONNECT_MAX_MS = 30000
    static let RELAY_SWEEP_MS = 5000
}
#endif
