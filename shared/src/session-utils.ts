/**
 * session-utils.ts — Shared session ordering, numbering, and tier grouping.
 * Single source of truth used by: TUI renderer, Plugin, Android, Apple, MenuBarExtra.
 */

// ===== State Ranking =====

/**
 * Rank agent states by priority (lower = higher priority).
 * processing=0, awaiting=1, idle=2, disconnected=3, unknown=4.
 */
/**
 * Observed-session id prefixes. A passively-observed session is keyed
 * `observed:<agent>:<uuid>` in `sessions_list` and on devices, but timeline
 * entries, transcripts and hook payloads are keyed by the bare uuid — so any
 * code matching one against the other must normalize first.
 *
 * This exists because the same regex was inlined in four places with three
 * different agent lists (one omitted `antigravity`, another `codex-app`), and a
 * fifth site that skipped stripping altogether silently never matched: a spoken
 * reply was armed under the prefixed id and looked up under the bare one, so the
 * reply was synthesized for nobody. Add agents here, not at the call sites.
 */
export const OBSERVED_SESSION_PREFIX_RE =
  /^observed:(?:claude|codex|codex-app|opencode|antigravity):/;

/** Bare uuid form of a session id — unchanged when it has no observed prefix. */
export function rawSessionId(sessionId: string): string {
  return sessionId.replace(OBSERVED_SESSION_PREFIX_RE, '');
}

/** True when the two ids denote the same session in either keying form. */
export function sameSession(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a === b || rawSessionId(a) === rawSessionId(b);
}

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
 * openclaw=0 (always first), claude-code=1, codex-cli=2, codex-app=3, opencode=4, antigravity=5, others=6.
 */
export function agentTypeRank(agentType: string | undefined): number {
  switch (agentType) {
    case 'openclaw': return 0;
    case 'claude-code': return 1;
    case 'codex-cli': return 2;
    case 'codex-app': return 3;
    case 'opencode': return 4;
    case 'antigravity': return 5;
    default: return 6;
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
 * Documented cross-platform session-weight range. `--weight` is a deck/tab
 * order pin, so the range is deliberately small — and it must fit every
 * consumer's integer type (Kotlin `Int`, Swift `Int`, JSON double) with room
 * to spare so no platform can overflow while comparing or decoding.
 *
 * SSOT: these constants are emitted to Swift/Kotlin by
 * `scripts/generate-session-weight-rules.mjs` (drift-gated in vitest) — edit
 * here, then run `pnpm generate-session-weight-rules`.
 */
export const SESSION_WEIGHT_MIN = -9999;
export const SESSION_WEIGHT_MAX = 9999;

/**
 * Normalize a session weight to a finite integer inside the documented range.
 * A missing / null / non-finite weight collapses to 0, so unweighted sessions
 * all share the same "neutral" band and sort among themselves exactly as they
 * did before weights existed. Finite values are integer-truncated and clamped
 * so every platform (TS/Swift/Kotlin) computes the identical band even for a
 * rogue out-of-range or fractional wire value.
 */
export function sessionWeight(weight: number | undefined | null): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return 0;
  const n = Math.trunc(weight);
  if (n < SESSION_WEIGHT_MIN) return SESSION_WEIGHT_MIN;
  if (n > SESSION_WEIGHT_MAX) return SESSION_WEIGHT_MAX;
  return n;
}

/**
 * Sanitize a weight for daemon ingestion/emission: `undefined` for anything
 * that is not a finite in-range integer signal (so the wire simply omits it),
 * otherwise the truncated+clamped integer. This keeps out-of-range values out
 * of `sessions_list` entirely — Kotlin decodes `weight` as `Int?` and an
 * unrepresentable JSON number would abort the whole event decode, freezing the
 * Android dashboard, long before any client-side clamp could run.
 */
export function sanitizeWeightForWire(weight: unknown): number | undefined {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return undefined;
  return sessionWeight(weight);
}

/**
 * Sort sessions with stable ordering that does NOT jump on state changes.
 *
 * Order: weight ascending (negatives first, then unweighted/0, then positives)
 *   → agentType (openclaw first → claude-code → codex → opencode → antigravity)
 *   → projectName alphabetically
 *   → startedAt ascending (oldest first) for stability
 *   → id as final tiebreaker
 *
 * `weight` (default 0) is an explicit user override for deck/tab order — e.g.
 * running `agentdeck claude --weight 1 … --weight 5` across terminal tabs pins
 * each tab to a fixed slot. Sessions sharing a weight keep the existing stable
 * ordering, so leaving every weight at 0 reproduces the pre-weight behavior.
 *
 * Returns a new array (never mutates input).
 */
export function sortSessions<T extends { state?: string; projectName?: string; agentType?: string; startedAt?: string; id?: string; weight?: number }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    // 0. Explicit weight override (ascending). Unweighted === 0. Three-way
    // comparison, never subtraction — the Swift/Kotlin mirrors compare
    // user-controlled fixed-width ints where subtraction can trap or wrap.
    const wa = sessionWeight(a.weight);
    const wb = sessionWeight(b.weight);
    if (wa !== wb) return wa < wb ? -1 : 1;

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
  weight?: number;
}

/**
 * Collapse Codex companion-task rows for the same project into one display
 * session. Raw rows remain authoritative inside the daemon; every user-facing
 * surface should count this folded shape so completed one-turn Codex threads do
 * not look like simultaneously running sessions.
 *
 * The fold key includes the normalized weight band: two same-project Codex
 * tabs pinned to *different* slots (`--weight 1` / `--weight 2`) must never
 * collapse into one representative — folding happens before sorting, so a
 * weight-blind key would silently discard one of the pinned tabs. Unweighted
 * sessions all share band 0 and fold exactly as before.
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
    const key = `${codexDisplayKind(session)}:${project.toLocaleLowerCase()}:${sessionWeight(session.weight)}`;
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

// ===== Project-Prefix Grouping (IPS10 office huddle port) =====
//
// The IPS10 terrarium (esp32/src/ui/terrarium/office.cpp — normProject /
// sameProjectGroup) clusters sessions whose project names share a long
// delimiter-aligned prefix into one "work huddle": worktree/task folders like
// `xteink-x3-x4-japanese-broken-claude-glm` / `…-broken-codex` read as one
// unit of work, not N unrelated sessions. This is the SSOT port so the other
// dashboards' session lists (Android tablet SessionListPanel.kt, Apple
// SessionListPanel.swift — hand-mirrored, keep in lockstep) group the same way.

function isProjectDelim(c: string): boolean {
  return c === '-' || c === '_' || c === ' ' || c === '.';
}

function trimProjectTail(s: string): string {
  let n = s.length;
  while (n > 0 && (isProjectDelim(s[n - 1]) || s[n - 1] === '#')) n--;
  return s.slice(0, n);
}

function projectDelimCount(s: string, len: number): number {
  let count = 0;
  for (let i = 0; i < len && i < s.length; i++) if (isProjectDelim(s[i])) count++;
  return count;
}

/**
 * Normalize a project name for grouping: strip any path to the basename and
 * drop a trailing " #N" duplicate suffix so "Foo #1" / "Foo #2" compare equal.
 * Mirrors office.cpp `normProject`.
 */
export function normalizeProjectForGrouping(project: string | undefined): string {
  const raw = (project || '').trim();
  const base = raw.split('/').filter(Boolean).pop() || raw;
  const m = base.match(/^(.*?)\s*#\d+$/);
  return trimProjectTail(m ? m[1] : base);
}

/**
 * When two normalized project names belong to the same work group, return the
 * shared group key (the common stem); otherwise null. Mirrors office.cpp
 * `sameProjectGroup`:
 *   - exact (case-insensitive) match → group
 *   - one extends the other at a delimiter ("foo-bar" + "foo-bar-1") or they
 *     diverge after a shared delimiter-aligned stem ("…-broken-a" + "…-broken-b")
 *   - conservative: only long multi-token stems fuse (stem ≥ 14 chars with
 *     ≥ 2 delimiters on both sides), so short siblings like "agentdeck-ios" /
 *     "agentdeck-android" stay separate.
 */
export function projectGroupKey(a: string, b: string): string | null {
  let i = 0;
  let lastDelim = -1;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i].toLowerCase() === b[i].toLowerCase()) {
    if (isProjectDelim(a[i])) lastDelim = i;
    i++;
  }
  if (i === a.length && i === b.length) return a;

  let stemLen = -1;
  if (i === a.length && i < b.length && isProjectDelim(b[i])) stemLen = i;
  else if (i === b.length && i < a.length && isProjectDelim(a[i])) stemLen = i;
  else if (lastDelim > 0) stemLen = lastDelim;

  if (stemLen < 14 || projectDelimCount(a, stemLen) < 2 || projectDelimCount(b, stemLen) < 2) {
    return null;
  }
  const key = trimProjectTail(a.slice(0, stemLen));
  return key.length > 0 ? key : null;
}

export interface ProjectGroup<T> {
  /** Group label — the shared stem, or the (normalized) project name for singletons. */
  key: string;
  /** True when ≥2 members fused (render a group header); singletons render flat. */
  grouped: boolean;
  members: T[];
}

/**
 * Cluster an ordered session list into project groups, preserving the input
 * order (first member's position anchors the group; members keep relative
 * order). Greedy pairwise fusion with a growing group key, exactly like the
 * office.cpp huddle builder.
 */
export function groupSessionsByProject<T>(
  items: readonly T[],
  projectOf: (item: T) => string | undefined,
): ProjectGroup<T>[] {
  const groups: ProjectGroup<T>[] = [];
  const done = new Array(items.length).fill(false);
  for (let a = 0; a < items.length; a++) {
    if (done[a]) continue;
    const na = normalizeProjectForGrouping(projectOf(items[a]));
    let key = na;
    const members: T[] = [items[a]];
    done[a] = true;
    for (let b = a + 1; b < items.length; b++) {
      if (done[b]) continue;
      const nb = normalizeProjectForGrouping(projectOf(items[b]));
      const nextKey = projectGroupKey(key, nb) ?? projectGroupKey(na, nb);
      if (nextKey) {
        key = nextKey;
        members.push(items[b]);
        done[b] = true;
      }
    }
    groups.push({ key, grouped: members.length > 1, members });
  }
  return groups;
}
