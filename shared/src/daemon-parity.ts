/** Pure policies shared by the Node and native Swift daemons. */
export const DAEMON_HANDOVER = {
  exitWaitMs: 12_000,
  bindableWaitMs: 30_000,
  preferredPortReclaimMs: 20_000,
  darwinPortReclaimMs: 90_000,
  startupMarginMs: 15_000,
} as const;

/** Cover negotiation, the macOS bind retry and startup before Swift reclaims. */
export const DAEMON_TAKEOVER_YIELD_MS = DAEMON_HANDOVER.exitWaitMs
  + DAEMON_HANDOVER.bindableWaitMs + DAEMON_HANDOVER.darwinPortReclaimMs
  + DAEMON_HANDOVER.startupMarginMs;

export const KIRO_OBSERVATION_WINDOW_MS = 30 * 60 * 1000;
export const KIRO_TURN_BOUNDARIES = { turn_start: 'processing', turn_end: 'idle' } as const;

/** Silence and late message records do not synthesize a turn boundary. */
export function kiroTurnState(state: 'processing' | 'idle', event: string): 'processing' | 'idle' {
  return Object.hasOwn(KIRO_TURN_BOUNDARIES, event)
    ? KIRO_TURN_BOUNDARIES[event as keyof typeof KIRO_TURN_BOUNDARIES] : state;
}

/** Missing legacy identity is unknown; only an explicit runtime conflicts. */
export function acceptsDaemonRuntime(isSwift: boolean | undefined, expectingNode: boolean): boolean {
  return !expectingNode || isSwift !== true;
}

export const KIRO_LEGACY_BOUNDARIES = {
  Prompt: 'processing', ToolResult: 'processing', ToolResults: 'processing', TurnEnd: 'idle',
} as const;
export function kiroLegacyTurnState(state: 'processing' | 'idle', event: string, hasToolUse: boolean): 'processing' | 'idle' {
  if (event === 'AssistantMessage') return hasToolUse ? 'processing' : 'idle';
  return Object.hasOwn(KIRO_LEGACY_BOUNDARIES, event)
    ? KIRO_LEGACY_BOUNDARIES[event as keyof typeof KIRO_LEGACY_BOUNDARIES] : state;
}
