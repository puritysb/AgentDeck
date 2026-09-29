/**
 * Who the daemon hub's global `state_update` frame is about.
 *
 * The hub has ONE `core.stateMachine`, and two unrelated things drive it: every
 * observed Claude hook (`UserPromptSubmit` → processing, `PreToolUse` → the
 * tool, `Stop` → idle) and the OpenClaw Gateway adapter's own parser events.
 * The frame built from that machine used to be labelled by *who was alive*
 * (`agentType: gwAlive ? 'openclaw' : 'daemon'`, `projectName` left at the
 * Gateway's `OpenClaw`), not by *who moved it*. So while the Gateway sat idle,
 * every surface received "OpenClaw · processing · Bash `cd …`" carrying a Claude
 * session's command — Android applied it to the OpenClaw aggregate, the macOS
 * HUD printed it, ESP32 boards copied it into their main screen. The 2026-07-24
 * fix moved the `sessions_list` row onto `gatewaySessionState`; this frame kept
 * the old label (2026-09-11).
 *
 * Rule: the frame is stamped by its DRIVER.
 *   - a hook session drove it   → `daemon` (aggregate, no creature identity),
 *                                   that session's id and project;
 *   - the Gateway drove it       → `openclaw`, `openclaw-gateway`, the Gateway's
 *                                   own snapshot overlay;
 *   - nothing has driven it yet  → `openclaw` while the Gateway is alive (its own
 *                                   snapshot), else `daemon`.
 * `daemon` and `openclaw` are both aggregate types on every consumer
 * (Android `AGGREGATE_AGENT_TYPES`, Apple/Kotlin `isDaemonLike`, ESP32
 * `isDaemon`), so creatures keep coming from `sessions_list`; only the OpenClaw
 * label stops riding on foreign activity. Swift mirror: `DaemonServer.hubFrameAgentType`.
 */
import type { AgentCapabilities, AgentType } from '@agentdeck/shared';

export const OPENCLAW_GATEWAY_SESSION_ID = 'openclaw-gateway';

export type HubStateDriver =
  | { kind: 'hook'; sessionId?: string; agentType: AgentType; projectName?: string }
  | { kind: 'gateway' };

export interface HubFrameIdentity {
  agentType: AgentType | 'daemon';
  agentCapabilities?: AgentCapabilities;
  sessionId?: string;
  projectName?: string;
  /** The Gateway's own snapshot overlay (`gatewaySnapshot`) applies. */
  gatewayOwned: boolean;
}

/** Remembers the most recent driver of the hub's global state machine. */
export class HubStateDriverTracker {
  private driver: HubStateDriver | null = null;

  noteHook(input: { sessionId?: string; agentType: AgentType; projectName?: string }): void {
    this.driver = {
      kind: 'hook',
      sessionId: input.sessionId || undefined,
      agentType: input.agentType,
      projectName: input.projectName || undefined,
    };
  }

  noteGateway(): void {
    this.driver = { kind: 'gateway' };
  }

  /** The hook session ended (or fell silent): its identity must not outlive
   *  it on the frame. `undefined` names the anonymous driver — a hook that
   *  carried no session id. */
  noteSessionEnd(sessionId: string | undefined): void {
    if (this.driver?.kind === 'hook' && this.driver.sessionId === sessionId) this.driver = null;
  }

  noteGatewayGone(): void {
    if (this.driver?.kind === 'gateway') this.driver = null;
  }

  current(): HubStateDriver | null {
    return this.driver;
  }
}

/** The Gateway's own activity, tracked next to the global machine. */
export interface GatewayActivity {
  state: string;
  modelName?: string | null;
}

/** Fields that describe the global machine's current turn, not the Gateway's. */
const TURN_FIELDS = [
  'currentTool', 'toolInput', 'toolProgress', 'options', 'question',
  'promptType', 'navigable', 'cursorIndex', 'suggestedPrompt',
] as const;

/**
 * Apply an identity to a frame built from the global machine. A Gateway-owned
 * frame carries the Gateway's OWN state and model and drops the machine's turn
 * fields unless the Gateway itself is waiting — the Gateway-connect broadcast
 * used to ship the machine's `processing` + a Claude session's tool under the
 * `openclaw` label (the original bug, re-created on every reconnect).
 */
export function shapeHubFrame(
  frame: Record<string, unknown>,
  identity: HubFrameIdentity,
  gateway: GatewayActivity,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...frame };
  if (identity.gatewayOwned) {
    out.state = gateway.state;
    if (gateway.modelName) out.modelName = gateway.modelName; else delete out.modelName;
    if (!gateway.state.startsWith('awaiting')) {
      for (const key of TURN_FIELDS) delete out[key];
    }
  }
  if (identity.sessionId) out.sessionId = identity.sessionId;
  if (identity.projectName) {
    out.projectName = identity.projectName;
  } else if (!identity.gatewayOwned && out.projectName === 'OpenClaw') {
    // The global machine's projectName was last written by the Gateway's
    // `project_info` parser event; a hook-driven frame must not carry it.
    delete out.projectName;
  }
  return out;
}

export function resolveHubFrameIdentity(
  driver: HubStateDriver | null,
  gatewayAlive: boolean,
  openclawCapabilities: AgentCapabilities,
): HubFrameIdentity {
  if (driver?.kind === 'hook') {
    return {
      agentType: 'daemon',
      sessionId: driver.sessionId,
      projectName: driver.projectName,
      gatewayOwned: false,
    };
  }
  if (gatewayAlive) {
    return {
      agentType: 'openclaw',
      agentCapabilities: openclawCapabilities,
      sessionId: driver?.kind === 'gateway' ? OPENCLAW_GATEWAY_SESSION_ID : undefined,
      projectName: 'OpenClaw',
      gatewayOwned: true,
    };
  }
  return { agentType: 'daemon', gatewayOwned: false };
}
