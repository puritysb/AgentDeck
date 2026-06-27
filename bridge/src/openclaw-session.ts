/**
 * openclaw-session.ts — single injector for the virtual OpenClaw Gateway
 * session. Shared by the CLI session bridge (index.ts) and the daemon hub
 * (daemon-server.ts) so both apply the SSOT predicate identically and can never
 * drift. Mirror of Swift `buildSessionsListEvent`.
 */
import { isOpenClawSessionActive, hasOpenClawSession } from '@agentdeck/shared';
import type { EnrichedSession } from './session-aggregator.js';

export interface InjectOpenClawOptions {
  /** SSOT gate — inject only when the Gateway is authenticated. */
  gatewayConnected: boolean;
  /** Daemon-hub extras (the CLI bridge omits these → a minimal session row). */
  state?: string;
  projectName?: string;
  modelName?: string;
  controlMode?: 'managed';
}

/**
 * Append the virtual `openclaw` session iff the Gateway is authenticated
 * (`gatewayConnected`) and one isn't already present. Reachability
 * (`gatewayAvailable`) and health alone must NEVER materialize a session — that
 * kept a phantom OpenClaw alive on devices after it was off.
 */
export function injectOpenClawSession(
  sessions: EnrichedSession[],
  opts: InjectOpenClawOptions,
): EnrichedSession[] {
  if (!isOpenClawSessionActive({ gatewayConnected: opts.gatewayConnected })) return sessions;
  if (hasOpenClawSession(sessions)) return sessions;
  const injected: EnrichedSession = {
    id: 'openclaw-gateway',
    port: 18789,
    projectName: opts.projectName ?? 'OpenClaw',
    agentType: 'openclaw',
    alive: true,
  };
  if (opts.state !== undefined) injected.state = opts.state;
  if (opts.modelName !== undefined) injected.modelName = opts.modelName;
  if (opts.controlMode !== undefined) injected.controlMode = opts.controlMode;
  return [...sessions, injected];
}
