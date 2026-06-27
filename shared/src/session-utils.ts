/**
 * session-utils.ts — Shared session ordering, numbering, and tier grouping.
 * Single source of truth used by: TUI renderer, Plugin, Android, Apple, MenuBarExtra.
 */

// ===== State Ranking =====

/**
 * Rank agent states by priority (lower = higher priority).
 * processing=0, awaiting=1, idle=2, disconnected=3, unknown=4.
 */
export function stateRank(state: string | undefined): number {
  switch (state) {
    case 'processing': return 0;
    case 'awaiting_permission':
    case 'awaiting_option':
    case 'awaiting_diff': return 1;
    case 'idle': return 2;
    case 'disconnected': return 3;
    default: return 4;
  }
}

// ===== Session Tier =====

export type SessionTier = 'attention' | 'active' | 'idle';

export function sessionTier(state: string | undefined): SessionTier {
  switch (state) {
    case 'awaiting_permission':
    case 'awaiting_option':
    case 'awaiting_diff':
      return 'attention';
    case 'processing':
      return 'active';
    default:
      return 'idle';
  }
}

// ===== Agent Type Ranking (stable ordering by agent kind) =====

/**
 * Rank agent types for stable ordering.
 * openclaw=0 (always first), claude-code=1, codex-cli=2, codex-app=3, opencode=4, others=5.
 */
export function agentTypeRank(agentType: string | undefined): number {
  switch (agentType) {
    case 'openclaw': return 0;
    case 'claude-code': return 1;
    case 'codex-cli': return 2;
    case 'codex-app': return 3;
    case 'opencode': return 4;
    default: return 5;
  }
}

export function naturalLabelCompare(a: string | undefined, b: string | undefined): number {
  return (a || '').localeCompare(b || '', undefined, { numeric: true, sensitivity: 'base' });
}

// ===== OpenClaw / Gateway Visibility (SSOT) =====

export interface GatewayVisibilityFlags {
  /** TCP port 18789 reachable — a topology hint only, NOT proof commands route. */
  gatewayAvailable?: boolean;
  /** Gateway WS handshake + auth succeeded — proof commands can route. */
  gatewayConnected?: boolean;
  /** `openclaw doctor`/health reports an error. */
  gatewayHasError?: boolean;
}

/**
 * SSOT: the daemon injects the virtual `openclaw` session iff this holds.
 *
 * "Active" = authenticated / can-route = the Gateway WS handshake+auth
 * succeeded (`gatewayConnected`). Reachability (`gatewayAvailable`) and health
 * (`gatewayHasError`) are topology/status hints only and MUST NOT materialize a
 * session — surfacing them as a session is what made OpenClaw "stick" on
 * devices after it was effectively off.
 *
 * Hand-mirrored in Swift `DashboardDataRules.isOpenClawSessionActive`
 * (apple/AgentDeck/Model/Protocol.swift) and Kotlin `isOpenClawSessionActive`
 * (android/.../ui/eink/EinkFormatUtils.kt) — keep all three in lockstep.
 */
export function isOpenClawSessionActive(flags: GatewayVisibilityFlags): boolean {
  return flags.gatewayConnected === true;
}

/**
 * Consumer SSOT: render OpenClaw iff the daemon actually emitted the session.
 * Consumers must NOT re-derive OpenClaw visibility from raw gateway flags;
 * the daemon source is the single authority. Hand-mirrored in Swift/Kotlin.
 */
export function hasOpenClawSession<T extends { agentType?: string }>(sessions: readonly T[]): boolean {
  return sessions.some(s => s.agentType === 'openclaw');
}

// ===== Sorting =====

/**
 * Sort sessions with stable ordering that does NOT jump on state changes.
 *
 * Order: agentType (openclaw first → claude-code → codex → opencode)
 *   → projectName alphabetically
 *   → startedAt ascending (oldest first) for stability
 *   → id as final tiebreaker
 *
 * Returns a new array (never mutates input).
 */
export function sortSessions<T extends { state?: string; projectName?: string; agentType?: string; startedAt?: string; id?: string }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    // 1. Agent type group (openclaw first, then by agent kind)
    const typeRank = agentTypeRank(a.agentType) - agentTypeRank(b.agentType);
    if (typeRank !== 0) return typeRank;

    // 2. Project name alphabetically with numeric chunks (Agent 2 before
    // Agent 10). Must match Swift DashboardDataRules.naturalLabelCompare
    // and Android naturalLabelCompare, otherwise numbered sessions render
    // in different order on Stream Deck vs. Apple/Android.
    const nameCompare = naturalLabelCompare(a.projectName, b.projectName);
    if (nameCompare !== 0) return nameCompare;

    // 3. Start time ascending (oldest first = stable position)
    if (a.startedAt && b.startedAt) {
      const diff = new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
      if (diff !== 0) return diff;
    }

    // 4. Session ID as final tiebreaker
    return naturalLabelCompare(a.id, b.id);
  });
}

// ===== Codex Display Folding =====

export interface FoldableSession {
  id: string;
  projectName?: string;
  agentType?: string;
  state?: string;
  startedAt?: string;
  currentTool?: string;
  groupSize?: number;
  foldedSessionIds?: string[];
}

/**
 * Collapse Codex companion-task rows for the same project into one display
 * session. Raw rows remain authoritative inside the daemon; every user-facing
 * surface should count this folded shape so completed one-turn Codex threads do
 * not look like simultaneously running sessions.
 */
export function foldCodexSessionsForDisplay<T extends FoldableSession>(sessions: T[]): T[] {
  const passthrough: T[] = [];
  const codexByProject = new Map<string, T[]>();

  for (const session of sessions) {
    const project = session.projectName?.trim();
    if (!isCodexSession(session) || !project) {
      passthrough.push(session);
      continue;
    }
    const key = `${codexDisplayKind(session)}:${project.toLocaleLowerCase()}`;
    const group = codexByProject.get(key);
    if (group) group.push(session);
    else codexByProject.set(key, [session]);
  }

  for (const group of codexByProject.values()) {
    passthrough.push(foldCodexProjectGroup(group));
  }

  return passthrough;
}

function isCodexSession(session: FoldableSession): boolean {
  return session.agentType === 'codex-cli' || session.agentType === 'codex-app' || session.id.startsWith('codex:');
}

function codexDisplayKind(session: FoldableSession): 'codex-cli' | 'codex-app' {
  return session.agentType === 'codex-app' ? 'codex-app' : 'codex-cli';
}

function foldCodexProjectGroup<T extends FoldableSession>(group: T[]): T {
  if (group.length <= 1) return group[0];

  const ranked = [...group].sort((a, b) => {
    const rankDiff = stateRank(a.state) - stateRank(b.state);
    if (rankDiff !== 0) return rankDiff;

    const aStarted = a.startedAt ? new Date(a.startedAt).getTime() : Number.NEGATIVE_INFINITY;
    const bStarted = b.startedAt ? new Date(b.startedAt).getTime() : Number.NEGATIVE_INFINITY;
    if (aStarted !== bStarted) return bStarted - aStarted;

    return a.id.localeCompare(b.id);
  });

  const representative = ranked[0];
  const foldedIds = group.flatMap(s => s.foldedSessionIds ?? [s.id]);
  const groupSize = group.reduce((total, s) => total + (s.groupSize ?? 1), 0);
  const currentTool = ranked.find(s => stateRank(s.state) === 0 && s.currentTool?.trim())?.currentTool;

  const folded = {
    ...representative,
    state: ranked[0].state,
    groupSize,
    foldedSessionIds: foldedIds,
  } as T;
  if (currentTool) {
    folded.currentTool = currentTool;
  } else {
    delete folded.currentTool;
  }
  return folded;
}

// ===== Display Name Assignment =====

export interface SessionDisplayInfo {
  /** Original session (unmodified) */
  session: { id: string; projectName: string; agentType?: string; state?: string; [key: string]: unknown };
  /** Display name with optional #N suffix */
  displayName: string;
  /** Session tier for UI grouping */
  tier: SessionTier;
}

/**
 * Assign display names with #N suffixes for duplicate (projectName, agentType) tuples.
 * Input is NOT mutated. Returns new display info objects.
 *
 * @param sessions - Already-sorted sessions array
 */
export function assignDisplayNames<T extends { id: string; projectName: string; agentType?: string; state?: string }>(
  sessions: T[],
): (SessionDisplayInfo & { session: T })[] {
  // Count occurrences of each (projectName, agentType) pair
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const key = `${s.projectName}:${s.agentType || ''}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  // Assign sequential numbers
  const seq = new Map<string, number>();
  return sessions.map(s => {
    const key = `${s.projectName}:${s.agentType || ''}`;
    const n = (seq.get(key) || 0) + 1;
    seq.set(key, n);
    const needsSuffix = (counts.get(key) || 1) > 1;
    const displayName = needsSuffix ? `${s.projectName} #${n}` : s.projectName;
    return {
      session: s,
      displayName,
      tier: sessionTier(s.state),
    };
  });
}
