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

/** Discovery/fallback contract. Override only for an isolated daemon group. */
export const DEFAULT_DAEMON_PORT_WINDOW: readonly [number, number] = [9120, 9139];
export const DAEMON_PORT_WINDOW_LIMITS = { min: 1024, max: 65535 } as const;
/** ECMAScript whitespace, shared with the native parser. */
export const DAEMON_PORT_WINDOW_WHITESPACE = [9, 10, 11, 12, 13, 32, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279];
export function parseDaemonPortWindow(raw?: string): readonly [number, number] {
  const match = /^(\d{4,5})\s*-\s*(\d{4,5})$/.exec(raw?.trim() ?? '');
  if (!match) return DEFAULT_DAEMON_PORT_WINDOW;
  const lo = Number(match[1]), hi = Number(match[2]);
  if (lo < DAEMON_PORT_WINDOW_LIMITS.min || hi > DAEMON_PORT_WINDOW_LIMITS.max || hi < lo) return DEFAULT_DAEMON_PORT_WINDOW;
  return [lo, hi];
}
