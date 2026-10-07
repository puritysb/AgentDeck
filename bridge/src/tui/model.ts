/**
 * TUI view model — pure functions from dashboard state to what the screen shows.
 *
 * Every rule here is borrowed from a shared helper so the terminal says what the
 * deck, Android and the Mac app say: session order and #N names
 * (`sortSessions`/`assignDisplayNames`), state words and tones, CI waits
 * (`ciWaitPhaseId`/`ciWaitDetail`), the "now" card (`sessionNowSummary`), quota
 * credits/reserve selection (`selectedCodexCredits`/`selectedLunaReserve`),
 * snapshot ageing (`codexUsageFootnote`), plan tiers (`usageSubscriptionTier`)
 * and the bounded-collection bands (DESIGN.md §5.11). Rendering lives in
 * renderer.ts; nothing in this file emits escape codes.
 */
import type {
  SessionInfo, TimelineEntry, UsageEvent, CodexRateLimitWindow, CiWaitStatus,
} from '@agentdeck/shared';
import {
  sortSessions, assignDisplayNames, sessionTone, sessionStateWords,
  ciWaitPhaseId, ciWaitDetail, CI_WAIT_VISUAL, sessionNowSummary,
  selectedCodexCredits, selectedLunaReserve, formatCreditBalance,
  usageSubscriptionTier, usageSubscriptionProvider, USAGE_PRESENTATION,
  codexUsageFootnote, formatChatGptPlanName, formatZaiPlanName,
  timelineShouldRenderTaskRow, timelineTaskHeaderDisplay, rawSessionId,
  type SessionTone,
} from '@agentdeck/shared';
import type { DashboardState } from './dashboard.js';

// ===== HUD entries (shared ordering with macOS / iOS / Android) =====

export interface HudEntry {
  id: string;
  /** projectName + optional " #N" suffix from assignDisplayNames */
  displayName: string;
  projectName: string;
  agentType: string | undefined;
  state: string;
  modelName: string | undefined;
  startedAt: string | undefined;
  port: number | undefined;
  controlMode: 'managed' | 'observed' | undefined;
  currentTask: string | undefined;
  contextPercent: number | undefined;
  totalTokens: number | undefined;
  /** Self entry promoted from a sibling, or appended synthetic primary. */
  isPrimary: boolean;
  /** Gateway placeholder when sessions list lacks an OpenClaw entry. */
  isVirtualOpenClaw: boolean;
  /** The wire row behind this entry, when there is one. */
  session?: SessionInfo;
}

/**
 * Build the unified HUD entry list shared with macOS / iOS / Android.
 *
 * Collapses primary + siblings + virtual OpenClaw into one array, sorts via
 * the shared sortSessions (agentType → projectName → startedAt → id), and
 * applies #N suffix via assignDisplayNames so the display order and #N
 * numbering match every other surface.
 *
 * Primary handling mirrors apple/AgentDeck/UI/Monitor/SessionListPanel.swift:
 *   - if a sibling matches our connected port, that sibling becomes the
 *     primary anchor (its startedAt anchors the sort position)
 *   - otherwise primary is appended only when no sibling shares its
 *     agentType (duplicatePrimaryWithoutId guard)
 *   - daemon / openclaw primaries are never appended (they're virtual)
 */
export function buildHudEntries(state: DashboardState): HudEntry[] {
  const items: Array<Omit<HudEntry, 'displayName'>> = [];
  const portToItem = new Map<number, Omit<HudEntry, 'displayName'>>();

  for (const s of state.sessions) {
    const item: Omit<HudEntry, 'displayName'> = {
      id: s.id,
      projectName: s.projectName ?? 'unknown',
      agentType: s.agentType ?? undefined,
      state: s.state ?? 'idle',
      modelName: s.modelName ?? undefined,
      startedAt: s.startedAt ?? undefined,
      port: s.port ?? undefined,
      controlMode: s.controlMode,
      currentTask: s.currentTask,
      contextPercent: s.contextPercent,
      totalTokens: s.totalTokens,
      isPrimary: false,
      isVirtualOpenClaw: false,
      session: s,
    };
    items.push(item);
    if (item.port !== undefined) portToItem.set(item.port, item);
  }

  if (state.agentType && state.agentType !== 'daemon' && state.agentType !== 'openclaw' && state.state) {
    const anchor = state.currentPort != null ? portToItem.get(state.currentPort) : undefined;
    if (anchor) {
      // Patch anchor with primary's live fields. macOS / Android compose
      // SessionEntry from primary state and only borrow the anchor sibling's
      // startedAt; leaving the sibling's snapshot in place would render stale
      // modelName / state / currentTask whenever the sibling payload lagged.
      anchor.isPrimary = true;
      anchor.projectName = state.projectName ?? anchor.projectName;
      anchor.agentType = state.agentType;
      anchor.state = state.state;
      anchor.modelName = state.modelName ?? undefined;
      anchor.currentTask = state.currentTool ?? undefined;
    } else if (!state.sessions.some(s => s.agentType === state.agentType)) {
      items.push({
        id: '__self__',
        projectName: state.projectName ?? 'unknown',
        agentType: state.agentType,
        state: state.state,
        modelName: state.modelName ?? undefined,
        startedAt: undefined,
        port: state.currentPort ?? undefined,
        controlMode: undefined,
        currentTask: state.currentTool ?? undefined,
        contextPercent: undefined,
        totalTokens: undefined,
        isPrimary: true,
        isVirtualOpenClaw: false,
      });
    }
  }

  const hasOpenClaw = items.some(it => it.agentType === 'openclaw' || it.agentType === 'gateway');
  if (state.gatewayAvailable && !hasOpenClaw) {
    items.push({
      id: '__virtual_openclaw__',
      projectName: 'OpenClaw',
      agentType: 'openclaw',
      state: state.crayfishRouting ? 'processing' : 'idle',
      modelName: undefined,
      startedAt: undefined,
      port: undefined,
      controlMode: undefined,
      currentTask: undefined,
      contextPercent: undefined,
      totalTokens: undefined,
      isPrimary: false,
      isVirtualOpenClaw: true,
    });
  }

  const sorted = sortSessions(items.map(it => ({ ...it, weight: it.session?.weight })));
  const named = assignDisplayNames(sorted.map(it => ({
    id: it.id, projectName: it.projectName, agentType: it.agentType, state: it.state,
  })));
  return sorted.map(({ weight: _weight, ...it }, i) => ({ ...it, displayName: named[i]!.displayName }));
}

/** Only managed sessions with their own bridge port can be switched to. */
export function isSwitchable(entry: HudEntry): boolean {
  return !entry.isPrimary && !entry.isVirtualOpenClaw && entry.port !== undefined && entry.port > 0
    && entry.controlMode !== 'observed';
}

// ===== Roster cards =====

export interface CiCue {
  label: string;
  phase: CiWaitStatus['phase'];
  /** Pending and the agent is actually blocked on it. */
  waiting: boolean;
}

export interface RosterCard extends HudEntry {
  tone: SessionTone;
  /** 1-based hotkey for switchable sessions (≤9), else null. */
  hotkey: number | null;
  /** model · effort · permission — the agent's own words (#463). */
  meta: string[];
  /** The one line that says what this session is about right now. */
  focus?: { kind: 'question' | 'ci' | 'activity' | 'goal'; text: string };
  ci?: CiCue;
  subagents: number;
  /** Context fill 0..100; absent when unknown or out of range. */
  context?: number;
  review?: string;
}

function text(value: string | undefined | null): string | undefined {
  const t = value?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
}

export function ciCue(wait: CiWaitStatus | null | undefined): CiCue | undefined {
  const phase = ciWaitPhaseId(wait);
  if (!wait || phase === CI_WAIT_VISUAL.none) return undefined;
  const label = ciWaitDetail(wait);
  if (!label) return undefined;
  return { label, phase: wait.phase, waiting: wait.phase !== 'passed' && wait.phase !== 'failed' };
}

export function buildRoster(state: DashboardState): RosterCard[] {
  let hotkey = 0;
  return buildHudEntries(state).map((e) => {
    const s = e.session;
    const hk = isSwitchable(e) && hotkey < 9 ? ++hotkey : null;
    const meta = [text(e.modelName), text(s?.effortLevel), text(s?.permissionMode)]
      .filter((m): m is string => !!m);
    if (e.controlMode === 'observed') meta.push('observed');
    const ci = ciCue(s?.waitingOn);
    const tone = sessionTone(e.state);
    const now = sessionNowSummary(s, tone === 'working');
    let focus: RosterCard['focus'];
    if (tone === 'awaiting') {
      focus = { kind: 'question', text: text(s?.question) ?? sessionStateWords(e.state).label };
    } else if (ci) {
      focus = { kind: 'ci', text: ci.label };
    } else if (tone === 'working') {
      const what = text(s?.activity) ?? text(e.currentTask) ?? text(s?.currentTool) ?? now?.subtitle;
      if (what) focus = { kind: 'activity', text: what };
    } else {
      const what = now?.subtitle ?? text(s?.goal);
      if (what) focus = { kind: 'goal', text: what };
    }
    // A reading above 100% is a producer accounting fault, not a full window:
    // treat it as unknown rather than painting every card "ctx 100%".
    const ctx = typeof e.contextPercent === 'number' && Number.isFinite(e.contextPercent)
      && e.contextPercent >= 0 && e.contextPercent <= 100 ? Math.round(e.contextPercent) : undefined;
    const review = s?.reviewStatus === 'running' ? 'review running'
      : s?.reviewStatus === 'done'
        ? `review ${s.reviewRisk ?? 'done'}${typeof s.reviewFindings === 'number' ? ` · ${s.reviewFindings}` : ''}`
        : s?.reviewStatus === 'error' ? 'review failed' : undefined;
    return {
      ...e, tone, hotkey: hk, meta, focus, ci,
      subagents: Math.max(0, s?.subagents?.active ?? 0),
      context: ctx, review,
    };
  });
}

export interface RosterCounts {
  total: number;
  working: number;
  awaiting: number;
  idle: number;
  offline: number;
  ci: number;
}

export function rosterCounts(cards: readonly RosterCard[]): RosterCounts {
  const c: RosterCounts = { total: cards.length, working: 0, awaiting: 0, idle: 0, offline: 0, ci: 0 };
  for (const card of cards) {
    if (card.tone === 'working') c.working++;
    else if (card.tone === 'awaiting') c.awaiting++;
    else if (card.tone === 'offline') c.offline++;
    else c.idle++;
    if (card.ci?.waiting) c.ci++;
  }
  return c;
}

/** DESIGN.md §5.11 bands: detailed ≤6, grouped 7–15, summarized ≥16. */
export type RosterDensity = 'detailed' | 'grouped' | 'summarized';
export function rosterDensity(count: number): RosterDensity {
  if (count <= 6) return 'detailed';
  if (count <= 15) return 'grouped';
  return 'summarized';
}

/**
 * Rows a summarized roster keeps explicit: urgent, working, CI-blocked and the
 * selected card. Everything else collapses into a named count.
 */
export function summarizeRoster(cards: readonly RosterCard[], selectedId?: string): {
  shown: RosterCard[]; hiddenIdle: number; hiddenOffline: number;
} {
  const shown: RosterCard[] = [];
  let hiddenIdle = 0;
  let hiddenOffline = 0;
  for (const c of cards) {
    if (c.tone === 'awaiting' || c.tone === 'working' || c.ci || c.id === selectedId) shown.push(c);
    else if (c.tone === 'offline') hiddenOffline++;
    else hiddenIdle++;
  }
  return { shown, hiddenIdle, hiddenOffline };
}

// ===== Usage groups =====

export type ProviderId = (typeof USAGE_PRESENTATION.providers)[number]['id'];

export interface UsageRowVM {
  label: string;
  /** Consumed percent of the window; absent for text-only rows. */
  used?: number;
  /** Text instead of a gauge (credits balance). */
  value?: string;
  /** Neutral right-hand footnote: reset countdown or snapshot age. */
  note?: string;
  muted: boolean;
  inactive?: boolean;
}

export interface UsageGroupVM {
  id: ProviderId;
  title: string;
  /** Agent type whose brand colour marks the provider (z.ai has its own). */
  brand: string;
  tier?: string;
  until?: string;
  alert?: { text: string; level: 'error' | 'warn' | 'quiet' };
  rows: UsageRowVM[];
}

export function windowLabel(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return '?';
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** `↻1h23m`, `↻2d5h`; empty when unknown. */
export function resetIn(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - now;
  if (diff <= 0) return '↻now';
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `↻${days}d${hours % 24}h`;
  if (hours > 0) return `↻${hours}h${mins % 60}m`;
  return `↻${mins}m`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function untilLabel(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `until ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function subscriptionFor(u: UsageEvent, provider: ProviderId) {
  const index = USAGE_PRESENTATION.providers.findIndex(p => p.id === provider);
  return (u.subscriptions ?? []).find(s => usageSubscriptionProvider(s.name) === index);
}

function tierOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const tier = usageSubscriptionTier(name);
  return tier || undefined;
}

function claudeGroup(u: UsageEvent, now: number): UsageGroupVM | undefined {
  const muted = u.usageStale === true;
  const rows: UsageRowVM[] = [];
  if (u.fiveHourPercent !== undefined) {
    rows.push({ label: '5h', used: u.fiveHourPercent, note: resetIn(u.fiveHourResetsAt, now), muted });
  }
  if (u.sevenDayPercent !== undefined) {
    rows.push({ label: '7d', used: u.sevenDayPercent, note: resetIn(u.sevenDayResetsAt, now), muted });
  }
  for (const cap of u.scopedLimits ?? []) {
    rows.push({
      label: text(cap.label) ?? 'model', used: cap.percent, note: resetIn(cap.resetsAt, now),
      muted, inactive: !cap.active,
    });
  }
  const sub = subscriptionFor(u, 'claude');
  let alert: UsageGroupVM['alert'];
  if (u.tokenStatus === 'expired' || u.tokenStatus === 'missing') {
    alert = { text: u.tokenStatus === 'expired' ? 'sign-in expired' : 'not signed in', level: 'error' };
  } else if (rows.length === 0 && u.oauthConnected) {
    alert = { text: muted ? 'reading unavailable' : 'waiting for usage', level: 'quiet' };
  } else if (muted) {
    alert = { text: 'last known reading', level: 'quiet' };
  }
  if (rows.length === 0 && !alert && !sub) return undefined;
  return { id: 'claude', title: 'Claude', brand: 'claude-code', tier: tierOf(sub?.name), until: untilLabel(sub?.until), alert, rows };
}

function codexRow(win: CodexRateLimitWindow, capturedAt: string | undefined, now: number): UsageRowVM {
  const foot = codexUsageFootnote(win, capturedAt, now);
  return {
    label: windowLabel(win.windowMinutes), used: win.usedPercent,
    note: foot?.text ?? resetIn(win.resetsAt, now), muted: !!foot,
  };
}

function codexGroup(u: UsageEvent, now: number): UsageGroupVM | undefined {
  const cx = u.codexRateLimits;
  const rows: UsageRowVM[] = [];
  // Labelled by duration, never by slot: a Pro account can report its only
  // weekly window in `primary`.
  for (const win of [cx?.primary, cx?.secondary]) if (win) rows.push(codexRow(win, cx?.capturedAt, now));
  const credits = selectedCodexCredits(cx, now);
  if (credits) {
    rows.push({ label: 'credits', value: `${formatCreditBalance(credits.balance)} left`, note: resetIn(credits.regularResetsAt, now), muted: false });
  }
  const luna = selectedLunaReserve(cx, now);
  if (luna) rows.push({ label: 'Luna', used: luna.usedPercent, note: resetIn(luna.resetsAt, now), muted: false });
  const sub = subscriptionFor(u, 'codex');
  const planName = sub?.name ?? formatChatGptPlanName(cx?.planType ?? u.codexPlanType);
  if (rows.length === 0 && !planName) return undefined;
  return {
    id: 'codex', title: 'Codex', brand: 'codex-cli',
    tier: tierOf(planName), until: untilLabel(sub?.until ?? u.codexSubscriptionActiveUntil), rows,
  };
}

function zaiGroup(u: UsageEvent, now: number): UsageGroupVM | undefined {
  const z = u.zaiRateLimits;
  const sub = subscriptionFor(u, 'zai');
  if (!z && !sub) return undefined;
  const rows: UsageRowVM[] = [];
  if (z?.primary) rows.push({ ...codexRow(z.primary, z.capturedAt, now), label: windowLabel(z.primary.windowMinutes) });
  if (z?.secondary) {
    // The secondary window is labelled by its QUANTITY ("MCP" = tool calls).
    const row = codexRow(z.secondary, z.capturedAt, now);
    rows.push({ ...row, label: z.secondary.quantity === 'mcp' ? 'MCP' : row.label });
  }
  const alert: UsageGroupVM['alert'] = z?.authFailed ? { text: 'API key rejected', level: 'error' } : undefined;
  return {
    id: 'zai', title: 'z.ai', brand: 'zai',
    tier: formatZaiPlanName(z?.planType) ?? tierOf(sub?.name), until: untilLabel(sub?.until), alert, rows,
  };
}

function antigravityGroup(u: UsageEvent): UsageGroupVM | undefined {
  // A subscription card with no percentage or credit counter (DESIGN.md §2.8).
  const sub = subscriptionFor(u, 'antigravity');
  const plan = u.antigravityStatus?.planName ?? sub?.name;
  if (!plan) return undefined;
  return {
    id: 'antigravity', title: 'Antigravity', brand: 'antigravity',
    tier: tierOf(plan), until: untilLabel(u.antigravityStatus?.subscriptionActiveUntil ?? sub?.until), rows: [],
  };
}

/** Provider blocks in the shared USAGE order: Claude, Codex, z.ai, Antigravity. */
export function buildUsageGroups(u: UsageEvent | null, now = Date.now()): UsageGroupVM[] {
  if (!u) return [];
  return [claudeGroup(u, now), codexGroup(u, now), zaiGroup(u, now), antigravityGroup(u)]
    .filter((g): g is UsageGroupVM => !!g);
}

// ===== Timeline =====

export interface TimelineRowVM {
  entry: TimelineEntry;
  text: string;
  pending: boolean;
}

export function sameSession(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a === b || rawSessionId(a) === rawSessionId(b);
}

/**
 * Timeline rows under the one-row-per-task contract, optionally narrowed to one
 * session. Task headers fold their closure label and judge verdict.
 */
export function buildTimelineRows(
  timeline: readonly TimelineEntry[],
  follow?: string | { id: string; agentType?: string },
): TimelineRowVM[] {
  const all = timeline as TimelineEntry[];
  const target = typeof follow === 'string' ? { id: follow } : follow;
  const visible = all.filter(e => timelineShouldRenderTaskRow(e, all));
  let rows = target ? visible.filter(e => sameSession(e.sessionId, target.id)) : visible;
  // Roster and timeline can key one session differently (the OpenClaw roster
  // row is `openclaw-gateway`, its rows `openclaw:agent:…`). With no id match,
  // follow the agent rather than show an empty feed — only for OpenClaw,
  // which has a single roster row, so two Claude sessions never merge.
  if (target && rows.length === 0 && target.agentType === 'openclaw') {
    rows = visible.filter(e => e.agentType === 'openclaw');
  }
  return rows
    .map((e) => {
      let line = e.raw;
      if (e.type === 'task_start') {
        const d = timelineTaskHeaderDisplay(e, all);
        line = d.closureText ? `${d.title} · ${d.closureText}` : d.title;
        if (d.taskOutcome) line += formatTaskEvalSuffix(d.taskScore, d.taskOutcome);
      }
      return { entry: e, text: line.replace(/\s+/g, ' ').trim(), pending: e.status === 'pending' };
    });
}

export function formatTaskEvalSuffix(score: number | undefined, outcome: string | undefined): string {
  // `abandoned` flows from the manual `agentdeck task cancel` path and must
  // render as its own glyph — not '' (looks pending) and not the fail glyph
  // (reads as agent failure rather than a user-initiated stop).
  const glyph = outcome === 'success' ? '✓'
    : outcome === 'fail' ? '✗'
    : outcome === 'partial' ? '△'
    : outcome === 'abandoned' ? '⊘'
    : '';
  if (!glyph) return '';
  const scoreText = typeof score === 'number' ? score.toFixed(2) : '?';
  return ` · ${scoreText} ${glyph}`;
}
