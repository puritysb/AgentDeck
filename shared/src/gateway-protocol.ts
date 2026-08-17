/**
 * OpenClaw Gateway WebSocket protocol — single source of truth.
 *
 * Wire shape: JSON-encoded frames with a `type` discriminator (`req`/`res`/`event`).
 * Auth: Ed25519 device signature over
 * `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`.
 * Bridge implementation: `bridge/src/adapters/openclaw.ts` (Node) / `apple/AgentDeck/Daemon/Modules/OpenClawAdapter.swift` (Swift).
 *
 * This file is used by `scripts/generate-protocol.sh` to emit Swift/Kotlin bindings
 * under `generated/protocol/`, ensuring protocol parity across the three implementations.
 */

import type {
  ExecApprovalDecision,
  ExecApprovalRequestedPayload,
  ExecApprovalResolvedPayload,
} from './openclaw-approval.js';

// ===== Protocol version =====

/** Protocol major version. Bridge rejects mismatched Gateway versions. */
export const GATEWAY_PROTOCOL_VERSION = 4;

/** Default Gateway port (OpenClaw backend). */
export const GATEWAY_DEFAULT_PORT = 18789;

/** Ed25519 SPKI DER prefix length (bytes before the raw 32-byte key). */
export const ED25519_SPKI_PREFIX_LEN = 12;

// ===== Frame envelopes =====

/** Client → Gateway: RPC request. */
export interface GatewayRequestFrame {
  type: 'req';
  id: string;
  method: GatewayMethodName;
  params: GatewayMethodParams;
}

/** Gateway → Client: RPC response (ok=true) or error (ok=false). */
export interface GatewayResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: GatewayMethodResult;
  error?: GatewayError;
}

/** Gateway → Client: unsolicited event. */
export interface GatewayEventFrame {
  type: 'event';
  event: GatewayEventName;
  payload: GatewayEventPayload;
  /** Monotonic sequence number (optional, used for ordering on reconnect). */
  seq?: string;
  /** Server-side state version for dedup on replay. */
  stateVersion?: string;
}

export type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewayEventFrame;

export interface GatewayError {
  code: string;
  message: string;
  details?: unknown;
}

// ===== Method catalog =====

export type GatewayMethodName =
  | 'connect'
  | 'health'
  | 'models.list'
  | 'logs.tail'
  | 'chat.send'
  | 'chat.abort'
  | 'exec.approval.resolve'
  | 'exec.approval.list'
  | 'sessions.list'
  | 'sessions.subscribe'
  | 'sessions.messages.subscribe'
  | 'system-presence';

export type GatewayMethodParams =
  | ConnectParams
  | HealthParams
  | ModelsListParams
  | LogsTailParams
  | ChatSendParams
  | ChatAbortParams
  | ExecApprovalResolveParams
  | ExecApprovalListParams
  | SessionsListParams
  | SessionsSubscribeParams
  | SessionsMessagesSubscribeParams
  | SystemPresenceParams;

export type GatewayMethodResult =
  | ConnectResult
  | HealthResult
  | ModelsListResult
  | LogsTailResult
  | ChatSendResult
  | ChatAbortResult
  | ExecApprovalResolveResult
  | ExecApprovalListResult
  | SessionsListResult
  | SessionsSubscribeResult
  | SessionsMessagesSubscribeResult
  | SystemPresenceResult;

// connect — signed handshake response to connect.challenge.
// Wire shape matches OpenClaw 2026.4.14 `buildDeviceAuthPayloadV3`.
export interface ConnectParams {
  /** Lower bound of protocol versions this client supports. */
  minProtocol: number;
  /** Upper bound of protocol versions this client supports. */
  maxProtocol: number;
  client: {
    id: string;
    displayName: string;
    version: string;
    platform: string;
    deviceFamily?: string;
    mode: 'backend' | 'frontend' | 'operator' | 'node';
    instanceId?: string;
  };
  role: string;
  scopes: string[];
  caps: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  locale?: string;
  userAgent?: string;
  /** Ed25519 device signature over `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`. */
  device?: DeviceAuth;
  /** Bearer token issued during device pairing. */
  auth?: {
    token?: string;
    bootstrapToken?: string;
    deviceToken?: string;
    password?: string;
  };
}

export interface ConnectResult {
  type?: 'hello-ok';
  accepted?: boolean;
  protocol?: number;
  server?: {
    version: string;
    connId: string;
  };
  features?: {
    methods: string[];
    events: string[];
  };
  auth?: {
    deviceToken: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
    deviceTokens?: Array<{
      deviceToken: string;
      role: string;
      scopes: string[];
      issuedAtMs?: number;
    }>;
  };
  policy?: {
    tickIntervalMs?: number;
    maxPayload?: number;
  };
  sessionToken?: string;
  expiresAt?: number;
}

export interface DeviceAuth {
  id: string;
  publicKey: string;  // base64url raw Ed25519 key (32 bytes)
  signature: string;  // base64url Ed25519 signature
  signedAt: number;   // ms since epoch
  nonce: string;      // from connect.challenge
}

// health — gateway health snapshot
export interface HealthParams {
  probe?: boolean;
}

export interface HealthResult {
  ok?: boolean;
  ts?: number;
  durationMs?: number;
  status?: string;
  checks?: Array<{ id?: string; name?: string; status?: string; message?: string }>;
  [key: string]: unknown;
}

// models.list — runtime-allowed model catalog
export interface ModelsListParams {}

export interface ModelsListResult {
  models: OpenClawModel[];
}

export interface OpenClawModel {
  key?: string;
  id?: string;
  name?: string;
  provider?: string;
  title?: string;
  available?: boolean;
  missing?: boolean;
  tags?: string[];
  [key: string]: unknown;
}

// logs.tail — bounded gateway log tail
export interface LogsTailParams {
  cursor?: number;
  limit?: number;
  maxBytes?: number;
}

export interface LogsTailResult {
  file?: string;
  cursor?: number;
  size?: number;
  lines: string[];
  truncated?: boolean;
  reset?: boolean;
}

// chat.send — dispatch user message to active session
export interface ChatSendParams {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}

export interface ChatSendResult {
  runId?: string;
  accepted: boolean;
}

// chat.abort — cancel in-flight run
export interface ChatAbortParams {
  sessionKey: string;
  runId?: string;
}

export interface ChatAbortResult {
  aborted: boolean;
}

// exec.approval.resolve — resolve a pending tool execution approval.
//
// `decision` is NOT free-form: the Gateway validates it against
// `isApprovalDecision` BEFORE it looks the id up, so an unsupported spelling
// (notably the plain `'allow'` this type used to declare) is rejected with
// INVALID_REQUEST and the approval stays pending forever. The vocabulary lives
// in `openclaw-approval.ts` and is derived from OpenClaw's own bundle.
export interface ExecApprovalResolveParams {
  id: string;
  decision: ExecApprovalDecision;
}

/** The Gateway answers `{ ok: true }`; `resolved` is kept for older builds. */
export interface ExecApprovalResolveResult {
  ok?: boolean;
  resolved?: boolean;
}

// exec.approval.list — the approvals currently waiting for a decision.
//
// `exec.approval.requested` is a broadcast, never replayed: a client that
// connects while an approval is already outstanding hears nothing about it. So
// a daemon restart or a Gateway reconnect used to leave the agent blocked with
// an empty deck and no way to find out. This is the catch-up read.
export interface ExecApprovalListParams {}

/** Same element shape as the requested event, minus the envelope. */
export type ExecApprovalListResult = ExecApprovalRequestedPayload[];

// sessions.list — enumerate active Gateway sessions
export interface SessionsListParams {
  kind?: string;
}

export interface SessionsListResult {
  sessions: GatewaySession[];
}

export interface SessionsSubscribeParams {}

export interface SessionsSubscribeResult {
  subscribed: boolean;
}

export interface SessionsMessagesSubscribeParams {
  key: string;
}

export interface SessionsMessagesSubscribeResult {
  subscribed: boolean;
  key: string;
}

export interface SystemPresenceParams {}

export interface SystemPresenceResult {
  entries?: GatewayPresenceEntry[];
  devices?: GatewayPresenceEntry[];
  [key: string]: unknown;
}

export interface GatewaySession {
  key: string;
  kind?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  sessionId?: string;
}

/**
 * Method-name → params/result correlation. `rpcCall` in the Node adapter uses
 * this to enforce that callers pass the correct params shape for each method
 * and to infer the result type from the method name.
 *
 * When adding a new method: declare its ParamsType and ResultType above,
 * extend `GatewayMethodName`, and add the entry here. Build-time errors
 * pinpoint every call site that needs an update.
 */
export interface GatewayMethodMap {
  connect: { params: ConnectParams; result: ConnectResult };
  health: { params: HealthParams; result: HealthResult };
  'models.list': { params: ModelsListParams; result: ModelsListResult };
  'logs.tail': { params: LogsTailParams; result: LogsTailResult };
  'chat.send': { params: ChatSendParams; result: ChatSendResult };
  'chat.abort': { params: ChatAbortParams; result: ChatAbortResult };
  'exec.approval.resolve': { params: ExecApprovalResolveParams; result: ExecApprovalResolveResult };
  'exec.approval.list': { params: ExecApprovalListParams; result: ExecApprovalListResult };
  'sessions.list': { params: SessionsListParams; result: SessionsListResult };
  'sessions.subscribe': { params: SessionsSubscribeParams; result: SessionsSubscribeResult };
  'sessions.messages.subscribe': { params: SessionsMessagesSubscribeParams; result: SessionsMessagesSubscribeResult };
  'system-presence': { params: SystemPresenceParams; result: SystemPresenceResult };
}

// ===== Event catalog =====

export type GatewayEventName =
  | 'connect.challenge'
  | 'chat'
  | 'health'
  | 'session.message'
  | 'session.tool'
  | 'sessions.changed'
  | 'exec.approval.requested'
  | 'exec.approval.resolved'
  | 'presence'
  | 'system-presence'
  | 'tick'
  | 'shutdown';

export type GatewayEventPayload =
  | ConnectChallengePayload
  | ChatEventPayload
  | HealthResult
  | SessionMessagePayload
  | SessionToolPayload
  | SessionsChangedPayload
  | ExecApprovalRequestedPayload
  | ExecApprovalResolvedPayload
  | PresencePayload
  | SystemPresenceResult
  | TickPayload
  | ShutdownPayload;

export interface ConnectChallengePayload {
  nonce: string;
  expiresAt?: number;
}

export interface ChatEventPayload {
  state: 'delta' | 'final' | 'aborted' | 'error';
  runId?: string;
  sessionKey?: string;
  /** Incremental text chunk (delta state). */
  delta?: string;
  /** Full assembled response (final state). */
  response?: string;
  /** Tool invocations observed in this turn. */
  tools?: ChatToolInvocation[];
  /** User prompt text, as echoed by Gateway on first delta. */
  prompt?: string;
  /** Error message (error state). */
  error?: string;
  /** Model identifier used for this turn. */
  modelId?: string;
  /** Token accounting (final state). */
  inputTokens?: number;
  outputTokens?: number;
  /** Session identifier when Gateway creates a new session mid-chat. */
  newSessionId?: string;
}

export interface ChatToolInvocation {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: 'pending' | 'success' | 'error';
}

// `ExecApprovalRequestedPayload` / `ExecApprovalResolvedPayload` are defined in
// `openclaw-approval.ts` alongside the parser that normalizes them. They used to
// be declared here from an assumed shape (`tool`, `reason`, a flat `command`,
// `options:[{key,label}]`) — none of which the Gateway sends — which is why the
// approval prompt reached every device with no command text on it.
export type { ExecApprovalRequestedPayload, ExecApprovalResolvedPayload };

export interface GatewayPresenceEntry {
  connected: boolean;
  clientId?: string;
  deviceId?: string;
  roles?: string[];
  scopes?: string[];
  displayName?: string;
  [key: string]: unknown;
}

export interface PresencePayload {
  connected?: boolean;
  clientId?: string;
  deviceId?: string;
  entries?: GatewayPresenceEntry[];
  devices?: GatewayPresenceEntry[];
  [key: string]: unknown;
}

export interface SessionsChangedPayload {
  sessions?: GatewaySession[];
  key?: string;
  sessionKey?: string;
  reason?: string;
}

export interface SessionMessagePayload {
  key?: string;
  sessionKey?: string;
  role?: string;
  text?: string;
  content?: string;
  message?: unknown;
  ts?: number;
  [key: string]: unknown;
}

export interface SessionToolPayload {
  key?: string;
  sessionKey?: string;
  name?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  ts?: number;
  [key: string]: unknown;
}

export interface TickPayload {
  serverTime: number;
}

export interface ShutdownPayload {
  reason?: string;
  restartAt?: number;
}

// ===== Device identity =====

/** On-disk identity, loaded from `~/.openclaw/identity/device.json`. */
export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Loaded from `~/.openclaw/identity/device-auth.json` → `tokens.operator`. */
export interface DeviceAuthToken {
  token: string;
  role: string;
  scopes: string[];
}
