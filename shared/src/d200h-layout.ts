/**
 * D200H / deck layout engine used by the Ulanzi Studio plugin
 * (plugin-ulanzi) and Apple device previews. Given the current agent state it
 * computes, for a 5×3 key
 * grid, what each key shows (SVG) and does (command) — reflowing dynamically:
 * idle → sessions; a focused awaiting session → its options + ESC; processing →
 * STOP; plus mode / model / usage / tokens / cost.
 *
 * Key position is addressed as `col_row` (e.g. "0_0", "3_2") — the same scheme
 * the D200H firmware and Ulanzi Studio both use for keys.
 */
import {
  renderSessionSlot,
  renderEmptySlot,
  renderOptionButton,
  renderStopButton,
  renderEscButton,
  renderDetailInfo,
  renderBackButton,
  renderNextPageButton,
  renderInfoSlot,
  svgFrame,
  escSvgText,
} from './svg-renderers/index.js';
import { State, type PromptOption } from './states.js';
import { sortSessions, foldCodexSessionsForDisplay } from './session-utils.js';
import type { SessionInfo, SubscriptionInfo, CodexRateLimits, ScopedUsageLimit } from './protocol.js';
import { Brand, UI } from './design-tokens.js';
import { PASSIVE_OFFLINE_LABEL, OPEN_AGENTDECK_LABEL } from './connection-status.js';
import { CLAUDE_LOGO_PATH, CODEX_LOGO_PATH } from './svg-renderers/agent-logos.js';
import { formatScopedLabel, codexUsageFootnote } from './format-utils.js';

/** Command dispatched when a key is pressed. `null` = inert tile (info/empty). */
export type ButtonCommand = { type: string; [k: string]: unknown };

export interface KeySlot {
  col: number;
  row: number;
  svg: string;
  label: string;
  /** What pressing this key does. Single source of truth for input. */
  command?: ButtonCommand | null;
}

/** 5 columns × 3 rows. Physical key index == row * GRID_COLS + col. */
export const GRID_COLS = 5;

/**
 * D200H usage placement: the three bottom-row keys immediately LEFT of the wide
 * bottom-right clock widget (0_2, 1_2, 2_2) — a single horizontal quota strip
 * along the bottom edge, so the whole upper grid stays session tiles.
 *
 * The strip is filled from its RIGHT end (see `buildList`), keeping the gauges
 * flush against the clock: with the usual three tiles (Claude 5H, Claude 7D,
 * Codex) it fills exactly; when a tile is absent — Codex now commonly reports
 * only its weekly window, and an unlinked Claude reports none — the LEFTMOST
 * key falls out of the strip and flows back to sessions instead of leaving a
 * hole in the middle of the row.
 *
 * Its length also caps usage at three keys: a fourth tile (Codex 5H *and* 7D)
 * drops, Claude prioritised by `buildUsageTiles` order. That cap is why the
 * scoped per-model caps contribute at most ONE tile — see `buildUsageTiles`.
 */
const USAGE_PREFERRED_POS = ['0_2', '1_2', '2_2'];

export interface DashState {
  state: string;
  projectName: string;
  modelName: string;
  mode: string;
  agentType: string;
  fiveHourPercent: number;
  sevenDayPercent: number;
  totalTokens: number;
  totalCost: number;
  options: PromptOption[];
  currentTool: string;
  allSessions: SessionInfo[];
  /** Question the live `options` belong to. Echoed back on a press so the
   *  daemon can reject an answer aimed at a question the prompt has moved past
   *  (a multi-question AskUserQuestion advances between its groups). */
  question?: string;
  /** Live PTY option cursor is navigable (❯) — drives select_option vs respond. */
  navigable?: boolean;
  /**
   * True when the 5H/7D quota is actually known (subscription data present), so a
   * read-only surface can distinguish "0% used" from "no data" instead of drawing
   * a confident empty gauge. Absent/false on surfaces that don't supply it.
   */
  usageKnown?: boolean;
  /** ISO timestamp when the 5-hour quota window resets (for a countdown). */
  fiveHourResetsAt?: string;
  /** ISO timestamp when the 7-day quota window resets (for a countdown). */
  sevenDayResetsAt?: string;
  /**
   * Per-model scoped weekly caps (e.g. the "Fable" cap) — distinct from the
   * account-wide 5H/7D. Each renders as its own tile beneath 7D; an inactive cap
   * is shown muted (never the critical ramp).
   */
  scopedLimits?: ScopedUsageLimit[];
  /** Active subscriptions (Claude / ChatGPT plan) with optional expiry. */
  subscriptions?: SubscriptionInfo[];
  /**
   * Codex (ChatGPT) rolling-window usage parsed from local rollout files.
   * `primary` ≈ the 5h window, `secondary` ≈ the weekly window — mirrors the
   * Claude 5H/7D gauges. Absent when the user runs no Codex session.
   */
  codexRateLimits?: CodexRateLimits;
}

export function parseState(evt: any): DashState {
  return {
    state: evt?.state ?? 'DISCONNECTED',
    projectName: evt?.projectName ?? '',
    modelName: evt?.modelName ?? '',
    mode: evt?.mode ?? 'default',
    agentType: evt?.agentType ?? 'claude-code',
    fiveHourPercent: evt?.fiveHourPercent ?? 0,
    sevenDayPercent: evt?.sevenDayPercent ?? 0,
    totalTokens: evt?.totalTokens ?? 0,
    totalCost: evt?.totalCost ?? 0,
    // Keep the server-assigned `index`: it is what a press must send back, and
    // it is not always the array position (the PTY parser can drop entries).
    options: (evt?.options ?? []).map((o: any, i: number) =>
      typeof o === 'string'
        ? { index: i, label: o }
        : { index: typeof o?.index === 'number' ? o.index : i, label: o?.label ?? '', shortcut: o?.shortcut ?? '' },
    ),
    currentTool: evt?.currentTool ?? '',
    question: typeof evt?.question === 'string' && evt.question ? evt.question : undefined,
    allSessions: Array.isArray(evt?.allSessions) ? evt.allSessions : [],
    navigable: Boolean(evt?.navigable),
    // Prefer an explicit flag; otherwise infer from the presence of a real percent.
    usageKnown:
      typeof evt?.usageKnown === 'boolean'
        ? evt.usageKnown
        : evt?.fiveHourPercent != null || evt?.sevenDayPercent != null,
    fiveHourResetsAt: typeof evt?.fiveHourResetsAt === 'string' ? evt.fiveHourResetsAt : undefined,
    sevenDayResetsAt: typeof evt?.sevenDayResetsAt === 'string' ? evt.sevenDayResetsAt : undefined,
    scopedLimits: Array.isArray(evt?.scopedLimits) ? (evt.scopedLimits as ScopedUsageLimit[]) : undefined,
    subscriptions: Array.isArray(evt?.subscriptions) ? evt.subscriptions : undefined,
    codexRateLimits:
      evt?.codexRateLimits && typeof evt.codexRateLimits === 'object'
        ? (evt.codexRateLimits as CodexRateLimits)
        : undefined,
  };
}

// --- SVG helpers for info / usage / mode / offline tiles ---

// Shared sanitizer: strips ANSI/control chars (resvg rejects the whole SVG on
// any raw control char → blank tile) before entity-escaping.
const escXml = escSvgText;

function gaugeBar(pct: number, width = 8): string {
  const filled = Math.round(Math.min(pct, 100) / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function gaugeColor(pct: number): string {
  return pct > 80 ? '#ef4444' : pct > 50 ? '#eab308' : '#22c55e';
}

export function renderUsageButton(label: string, percent: number, color: string, known = true): string {
  // When the subscription quota is unknown (no OAuth data / stale hub), draw a
  // muted "—" instead of a confident 0% that would read as "fully available".
  if (!known) {
    const dim = '#475569';
    const elements = [
      `<text x="72" y="36" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#94a3b8">${escXml(label)}</text>`,
      `<text x="72" y="60" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="14" fill="${dim}">${escXml('░'.repeat(8))}</text>`,
      `<text x="72" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${dim}">—</text>`,
      `<rect x="16" y="110" width="112" height="2" rx="1" fill="#1e293b"/>`,
    ].join('');
    return svgFrame('#0f172a', elements);
  }
  const gBar = gaugeBar(percent, 8);
  const elements = [
    `<text x="72" y="36" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#94a3b8">${escXml(label)}</text>`,
    `<text x="72" y="60" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="14" fill="${color}">${escXml(gBar)}</text>`,
    `<text x="72" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="#ffffff">${Math.round(percent)}%</text>`,
    `<rect x="16" y="110" width="112" height="2" rx="1" fill="#1e293b"/>`,
    `<rect x="16" y="110" width="${Math.round(112 * Math.min(percent, 100) / 100)}" height="2" rx="1" fill="${color}"/>`,
  ].join('');
  return svgFrame('#0f172a', elements);
}

/** Wide merged slot (3_2) — 288×144 SVG. Two columns: 5H | 7D. Direct-HID only. */
export function renderUsageWideSlot(fiveHourPct: number, sevenDayPct: number, known = true): string {
  const c5 = gaugeColor(fiveHourPct);
  const c7 = gaugeColor(sevenDayPct);
  // Unknown quota → "—" instead of a confident 0% (mirrors renderUsageButton).
  const pct5 = known ? `${Math.round(fiveHourPct)}%` : '—';
  const pct7 = known ? `${Math.round(sevenDayPct)}%` : '—';
  const w5 = known ? Math.round(120 * Math.min(fiveHourPct, 100) / 100) : 0;
  const w7 = known ? Math.round(120 * Math.min(sevenDayPct, 100) / 100) : 0;
  const valColor = known ? '#ffffff' : '#475569';
  const elements = [
    `<rect x="0" y="0" width="144" height="144" fill="#0f172a"/>`,
    `<rect x="144" y="0" width="144" height="144" fill="#0f172a"/>`,
    `<rect x="8" y="8" width="128" height="128" rx="8" fill="#1e293b" opacity="0.3"/>`,
    `<rect x="152" y="8" width="128" height="128" rx="8" fill="#1e293b" opacity="0.3"/>`,
    `<text x="72" y="26" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#94a3b8">5H</text>`,
    `<text x="216" y="26" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#94a3b8">7D</text>`,
    `<text x="72" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="${valColor}">${pct5}</text>`,
    `<text x="216" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="${valColor}">${pct7}</text>`,
    `<rect x="12" y="132" width="120" height="2" rx="1" fill="#1e293b"/>`,
    `<rect x="156" y="132" width="120" height="2" rx="1" fill="#1e293b"/>`,
    `<rect x="12" y="132" width="${w5}" height="2" rx="1" fill="${c5}"/>`,
    `<rect x="156" y="132" width="${w7}" height="2" rx="1" fill="${c7}"/>`,
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="144" viewBox="0 0 288 144">${elements}</svg>`;
}

// --- Full-bleed level-fill usage gauge (canonical D200H/Ulanzi usage tile) -----
// Mirrors the Stream Deck redesign (plugin/src/renderers/usage-gauge.ts)
// replicated here so shared has no plugin/ dependency. The ENTIRE tile is the
// gauge: a full-width band rises from the bottom by `usedPercent` so the tile
// fills as the agent burns its window. The fill colour is a vivid SEVERITY ramp
// (green → amber → red); agent identity rides the provider's BRAND LOGO (Claude
// terracotta / Codex blue) in the top-right corner, NOT the fill colour. The
// headline used% + reset countdown sit on a solid dark chip (painted over the
// fill) so they stay legible at any fill height — no reliance on a halo.

/** Reset countdown ("2h13m" / "6d4h") from an ISO instant; "" when unknown. */
function formatResetCountdown(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = t - Date.now();
  if (diff <= 0) return 'now';
  const totalH = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (totalH >= 24) {
    const days = Math.floor(totalH / 24);
    const remainH = totalH % 24;
    return remainH > 0 ? `${days}d${remainH}h` : `${days}d`;
  }
  return totalH > 0 ? `${totalH}h${m}m` : `${m}m`;
}

/** Agent brand colours (Brand tokens) used to tint the provider logo. */
const USAGE_BRAND_COLOR: Record<'claude' | 'codex', string> = {
  claude: Brand.claudeCode,
  codex: Brand.codex,
};

/** Canonical provider brand mark (viewBox 0 0 24 24) per agent. */
const USAGE_BRAND_LOGO: Record<'claude' | 'codex', string> = {
  claude: CLAUDE_LOGO_PATH,
  codex: CODEX_LOGO_PATH,
};

/**
 * Provider brand mark for the top-right corner (the agent identity). 24-unit
 * path scaled to `size`, centred on (cx,cy), filled with the brand colour, over
 * a subtle dark scrim circle so it survives a ~100% fill. `dim` greys it.
 */
function usageBrandLogo(agent: 'claude' | 'codex', cx: number, cy: number, size: number, dim: boolean): string {
  const s = size / 24;
  const color = dim ? '#64748b' : USAGE_BRAND_COLOR[agent];
  return `<circle cx="${cx}" cy="${cy}" r="${(size / 2 + 3).toFixed(1)}" fill="#0b1220" opacity="0.55"/>`
    + `<g transform="translate(${cx},${cy}) scale(${s.toFixed(3)}) translate(-12,-12)">`
    + `<path d="${USAGE_BRAND_LOGO[agent]}" fill="${color}" fill-rule="evenodd"/></g>`;
}

/** Severity ramp by USED percent: <=50 green, 50–80 amber, >80 red. */
function usageRampColor(used: number, stale = false, inactive = false): { fill: string; hi: string } {
  if (stale) return { fill: '#64748b', hi: '#64748b' };
  // Inactive per-model scoped cap: informational cyan (distinct from stale slate),
  // never the critical ramp regardless of percent (issue #99).
  if (inactive) return { fill: UI.cyan, hi: UI.cyan };
  if (used > 80) return { fill: '#ef4444', hi: '#fca5a5' };
  if (used > 50) return { fill: '#eab308', hi: '#fde047' };
  return { fill: '#22c55e', hi: '#86efac' };
}

/**
 * Compact label for a rolling-window length in minutes, mirroring the Swift
 * `TopologyRail.windowLabel`: whole days → "Nd" (10080 → "7D"), whole hours →
 * "Nh" (300 → "5H"), else "Nm". Codex now sometimes reports the weekly window
 * in the `primary` slot with `secondary` null, so usage gauges MUST label by a
 * window's own length, never by its slot position — otherwise the 7D gauge
 * silently vanishes and the weekly window is mislabelled "5H".
 */
export function usageWindowLabel(windowMinutes: number | undefined): string {
  if (!windowMinutes || windowMinutes <= 0) return '';
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}D`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}H`;
  return `${windowMinutes}M`;
}

/**
 * Which gauge bucket ('5h' short vs '7d' long) a rolling window belongs to,
 * derived from its length (≥ a day → long) so the clip id / styling is right
 * regardless of whether the window arrived in the primary or secondary slot.
 */
export function usageWindowKind(windowMinutes: number | undefined): '5h' | '7d' {
  return (windowMinutes ?? 0) >= 1440 ? '7d' : '5h';
}

export interface UsageTankData {
  agent: 'claude' | 'codex';
  /** Rolling window this tile represents (drives the clip id + label fallback). */
  window: '5h' | '7d';
  /** Tile label, e.g. "5H", "7D". Agent identity rides the brand dot, not a prefix. */
  label: string;
  /** Percent of the window already CONSUMED (0–100). Fill rises with this. */
  usedPercent: number;
  /** ISO-8601 reset instant for the countdown. */
  resetsAt?: string;
  /** False → no live quota: dark tile + dim label + "—" instead of a gauge. */
  known?: boolean;
  /** Codex snapshot expired: keep last-known % but desaturate the fill and show
   *  a "stale" marker instead of a (misleading) "now" countdown. */
  stale?: boolean;
  /** Replaces the countdown and dims the tile. Carries the Codex freshness note
   *  ("stale" for an ended window, "3h ago" for an aged-but-live snapshot) from
   *  `codexUsageFootnote`, so an old reading can't pass for a live one. */
  footnote?: string;
  /** Non-binding per-model scoped cap: fill drops to the informational cyan,
   *  never the critical ramp, regardless of percent (issue #99). */
  inactive?: boolean;
}

export function renderUsageGauge(data: UsageTankData): string {
  const W = 144, H = 144, RX = 12;
  const known = data.known !== false;
  const agent = data.agent === 'codex' ? 'codex' : 'claude';
  const label = data.label || data.window.toUpperCase();
  const BG = '#0f172a', LABEL_DIM = '#64748b', TEXT_DIM = '#475569';
  const HEADLINE = '#ffffff', COUNTDOWN = '#ffffff';
  const clipId = `ugauge-${agent}-${data.window}`;
  const clip = `<defs><clipPath id="${clipId}"><rect x="0" y="0" width="${W}" height="${H}" rx="${RX}"/></clipPath></defs>`;
  const bg = `<rect width="${W}" height="${H}" rx="${RX}" fill="${BG}"/>`;
  const logo = usageBrandLogo(agent, 124, 22, 26, !known);

  if (!known) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
      + clip + bg
      + `<text x="14" y="36" font-family="JetBrains Mono, monospace" font-size="26" font-weight="bold" fill="${LABEL_DIM}">${escXml(label)}</text>`
      + logo
      + `<text x="72" y="94" text-anchor="middle" font-family="Arial,sans-serif" font-size="44" font-weight="bold" fill="${TEXT_DIM}">—</text></svg>`;
  }

  const stale = data.stale === true;
  // An aged snapshot is dimmed exactly like an expired one — the number is not
  // current either way — but it keeps its own footnote ("3h ago") rather than
  // claiming the window ended, and it is never dropped by the caller.
  const dim = stale || (data.footnote != null && data.footnote !== '');
  const used = Math.max(0, Math.min(100, data.usedPercent));
  const ramp = usageRampColor(used, dim, data.inactive === true);
  const fillH = Math.round((H * used) / 100);
  const fillY = H - fillH;
  // Subtle level tint (low opacity) + crisp 3px level line — no dark overlay.
  // Stale = extra-faint tint so it reads as "not current".
  const fillOpacity = dim ? 0.22 : 0.38;
  const fill = fillH > 0
    ? `<g clip-path="url(#${clipId})">`
        + `<rect x="0" y="${fillY}" width="${W}" height="${fillH}" fill="${ramp.fill}" opacity="${fillOpacity}"/>`
        + `<rect x="0" y="${fillY}" width="${W}" height="3" fill="${ramp.fill}"/>`
      + `</g>`
    : '';
  // Expired window: muted "stale" marker instead of the (absent) countdown; the
  // % stays last-known but dims so it doesn't read as live.
  const reset = data.footnote || (stale ? 'stale' : formatResetCountdown(data.resetsAt));
  const pctColor = dim ? LABEL_DIM : HEADLINE;
  const resetColor = dim ? LABEL_DIM : COUNTDOWN;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + clip + bg + fill
    + `<text x="14" y="36" font-family="JetBrains Mono, monospace" font-size="26" font-weight="bold" fill="${dim ? LABEL_DIM : HEADLINE}">${escXml(label)}</text>`
    + logo
    + `<text x="72" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="46" font-weight="bold" fill="${pctColor}">${Math.round(used)}<tspan font-size="24">%</tspan></text>`
    + (reset ? `<text x="72" y="122" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" font-weight="bold" fill="${resetColor}">${escXml(reset)}</text>` : '')
    + `</svg>`;
}

/**
 * Codex credit-based plans (e.g. `limit_id: "premium"`) report null 5h/7d
 * windows and convey usage via a credits balance instead. Render a flat readout
 * tile — limit label + balance (or ∞ when unlimited) — matching the gauge frame
 * so it sits alongside the Claude gauges without a false "%" affordance.
 */
export function renderCreditsTile(data: { limitId?: string; balance?: string; unlimited?: boolean }): string {
  const W = 144, H = 144, RX = 12;
  const BG = '#0f172a', HEADLINE = '#ffffff';
  const label = (data.limitId || 'CREDITS').toUpperCase();
  const value = data.unlimited ? '∞' : (data.balance ?? '—');
  const valueSize = value.length > 5 ? 32 : value.length > 3 ? 40 : 50;
  const logo = usageBrandLogo('codex', 124, 22, 26, false);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" rx="${RX}" fill="${BG}"/>`
    + `<text x="14" y="36" font-family="JetBrains Mono, monospace" font-size="20" font-weight="bold" fill="${HEADLINE}">${escXml(label)}</text>`
    + logo
    + `<text x="72" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="${valueSize}" font-weight="bold" fill="${HEADLINE}">${escXml(value)}</text>`
    + `<text x="72" y="126" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">CREDITS</text>`
    + `</svg>`;
}

/**
 * Usage tiles for the session deck, in placement order. Every tile is
 * hide-if-absent: Claude 5H/7D appear only when that window's quota is actually
 * known, and each present Codex window (labelled by its own length, not its
 * primary/secondary slot) only when present in
 * `codexRateLimits`. An unlinked or partial usage state therefore emits fewer
 * (or zero) tiles, so `buildList` reserves fewer keys and the freed slots flow
 * to session tiles instead of leaving reserved "—" ghost gauges behind.
 * Credit-based plans (null windows) get a single credits readout tile instead.
 * Each tile re-fetches quota on press.
 */
function buildUsageTiles(state: DashState): SessionDeckCell[] {
  const action: DeckAction = { kind: 'command', command: { type: 'query_usage' } };
  const known = state.usageKnown !== false;
  const tiles: SessionDeckCell[] = [];
  if (known && state.fiveHourPercent != null) {
    tiles.push({ svg: renderUsageGauge({ agent: 'claude', window: '5h', label: '5H', usedPercent: state.fiveHourPercent, resetsAt: state.fiveHourResetsAt, known: true }), action });
  }
  if (known && state.sevenDayPercent != null) {
    tiles.push({ svg: renderUsageGauge({ agent: 'claude', window: '7d', label: '7D', usedPercent: state.sevenDayPercent, resetsAt: state.sevenDayResetsAt, known: true }), action });
  }
  // At most ONE scoped tile — the worst-sorted cap (active desc, then percent
  // desc), rendered muted when it isn't the binding one.
  //
  // The usage strip is three keys wide (USAGE_PREFERRED_POS) and `buildSessionDeck`
  // drops every tile past it, so scoped tiles never stack: only [0] could ever
  // reach a key, and building the rest is dead work. Paging through them lives on
  // the SD+ encoder, which has room for it.
  //
  // NOTE: a scoped tile does not stack onto the strip, it EVICTS Codex 5H from it
  // (5H + 7D + scoped fills all three keys). That trade is deliberate — the point
  // of issue #99 is that the per-model cap can be the limit that actually binds —
  // but it means a D200H with a scoped cap present shows no Codex usage at all.
  const worstScoped = known ? state.scopedLimits?.[0] : undefined;
  if (worstScoped) {
    tiles.push({ svg: renderUsageGauge({ agent: 'claude', window: '7d', label: formatScopedLabel(worstScoped.label, 6), usedPercent: worstScoped.percent, resetsAt: worstScoped.resetsAt, known: true, inactive: worstScoped.active !== true }), action });
  }
  const cx = state.codexRateLimits;
  // Codex windows carry the same short "5H"/"7D" labels — the brand dot conveys
  // the agent, not a "CX " prefix. Label each present window by its own length
  // (windowMinutes), never by slot: Codex now sometimes reports the weekly
  // (10080-min) window as `primary` with `secondary` null, so a slot-based "7D
  // = secondary" would drop the gauge entirely.
  for (const w of [cx?.primary, cx?.secondary]) {
    if (!w) continue;
    tiles.push({ svg: renderUsageGauge({ agent: 'codex', window: usageWindowKind(w.windowMinutes), label: usageWindowLabel(w.windowMinutes) || '5H', usedPercent: w.usedPercent, resetsAt: w.resetsAt, known: true, stale: w.stale === true, footnote: codexUsageFootnote(w, cx?.capturedAt)?.text }), action });
  }
  // Credit-based Codex plan: no windows, show the credits balance instead so the
  // Codex usage doesn't silently vanish.
  if (!cx?.primary && !cx?.secondary && (cx?.credits || cx?.limitId)) {
    tiles.push({ svg: renderCreditsTile({ limitId: cx.limitId, balance: cx.credits?.balance, unlimited: cx.credits?.unlimited }), action });
  }
  return tiles;
}

/**
 * Display-only readout tile (TOKENS / COST / MODEL). Deliberately FLAT — no
 * rounded button bezel/panel — so the user reads it as status, not a pressable
 * key. (These tiles carry `command: null`; the old bezeled `svgFrame` look gave
 * them a false "press me" affordance.) A thin baseline rule + small dim caption
 * mark it as a label.
 */
function renderInfoButton(title: string, value: string, titleColor = '#7c8596', valueColor = '#e5e7eb'): string {
  const valueFontSize = value.length > 8 ? 18 : value.length > 5 ? 22 : 26;
  const elements = [
    `<rect width="144" height="144" fill="#0b0c10"/>`,
    `<text x="72" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" letter-spacing="1.5" fill="${titleColor}">${escXml(title.toUpperCase())}</text>`,
    `<text x="72" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}">${escXml(value)}</text>`,
    `<rect x="44" y="108" width="56" height="2" rx="1" fill="#1e2330"/>`,
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${elements}</svg>`;
}

function renderModeButton(mode: string): string {
  const elements = [
    `<text x="72" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">MODE</text>`,
    `<text x="72" y="88" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#a78bfa">${escXml(mode.toUpperCase())}</text>`,
  ].join('');
  return svgFrame('#1C1C1E', elements);
}

function renderOfflineSlot(hero = false): string {
  // Route through the shared aquarium-tide OFFLINE card so the legacy single-page
  // D200H grid shows the same dome-over-deck brand mark as the session-deck path
  // and the native connection overlays.
  if (hero) return renderInfoSlot(PASSIVE_OFFLINE_LABEL, OPEN_AGENTDECK_LABEL, 'agentdeck', 'brand');
  return renderEmptySlot();
}

/**
 * Compute the dynamic 5×3 grid for the current state. Returns slots 0–12
 * (the merged wide usage slot 3_2 is rendered by the direct-HID consumer
 * separately; see `usageTileForGrid` for the per-key variant).
 *
 * `animFrame` advances the shared renderer's session-tile animation; pass a
 * fixed value (e.g. 0) for a static frame.
 */
/**
 * One row-of-actions key for the legacy single-page D200H layout. Renders the
 * i-th real option Claude reported (PTY-managed session). When there are no
 * options the slot stays empty — observed (hook-only) sessions can't expose the
 * real choices, so we never fabricate an Allow/Deny that doesn't match the
 * actual prompt.
 */
function awaitingActionSlot(state: DashState, isAwaiting: boolean, i: number, col: number, row: number): KeySlot {
  if (isAwaiting) {
    const opt = state.options[i];
    if (opt) {
      return { col, row, svg: renderOptionButton(opt, i), label: '', command: { type: 'select_option', index: i } };
    }
  }
  return { col, row, svg: renderEmptySlot(), label: '', command: null };
}

export function computeLayout(state: DashState, animFrame = 0, animated = false): KeySlot[] {
  const isDisconnected = state.state === 'DISCONNECTED' || state.state === 'disconnected';
  if (isDisconnected) {
    const slots: KeySlot[] = [];
    const heroCol = 2, heroRow = 1;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 5; col++) {
        slots.push({ col, row, svg: renderOfflineSlot(col === heroCol && row === heroRow), label: '', command: null });
      }
    }
    return slots;
  }

  const slots: KeySlot[] = [];
  const isAwaiting = state.state.startsWith('AWAITING') || state.state.startsWith('awaiting');
  const isProcessing = state.state === 'PROCESSING' || state.state === 'processing';

  const activeSession: SessionInfo = {
    id: 'local',
    agentType: state.agentType as any,
    projectName: state.projectName,
    modelName: state.modelName,
    state: state.state.toLowerCase(),
    alive: true,
    port: 0,
  };

  const sessionsToDisplay = state.allSessions.length > 0 ? state.allSessions.slice(0, 4) : [activeSession];
  const isMultiSession = sessionsToDisplay.length > 1;

  if (isMultiSession) {
    slots.push({ col: 0, row: 0, svg: renderModeButton(state.mode), label: '', command: { type: 'mode_toggle' } });
    for (let i = 0; i < 4; i++) {
      const col = i + 1;
      const sess = sessionsToDisplay[i];
      if (sess) {
        const isActive = sess.projectName === activeSession.projectName && sess.agentType === activeSession.agentType;
        slots.push({ col, row: 0, svg: renderSessionSlot(sess, isActive, animFrame, undefined, { animated }), label: '', command: { type: 'focus_session', sessionId: sess.id } });
      } else {
        slots.push({ col, row: 0, svg: renderEmptySlot(), label: '', command: null });
      }
    }
    for (let i = 0; i < 4; i++) {
      const col = i;
      slots.push(awaitingActionSlot(state, isAwaiting, i, col, 1));
    }
    slots.push({ col: 4, row: 1, svg: renderInfoButton('MODEL', state.modelName.slice(0, 12) || 'N/A'), label: '', command: null });
  } else {
    const heroSession = state.allSessions.length > 0 ? sessionsToDisplay[0] : null;
    slots.push({ col: 0, row: 0, svg: renderModeButton(state.mode), label: '', command: { type: 'mode_toggle' } });
    slots.push({ col: 1, row: 0, svg: renderSessionSlot(sessionsToDisplay[0], true, animFrame, undefined, { animated }), label: '', command: heroSession ? { type: 'focus_session', sessionId: heroSession.id } : null });
    slots.push({ col: 2, row: 0, svg: renderDetailInfo(sessionsToDisplay[0], state.state.toLowerCase() as State, state.currentTool, state.modelName, state.mode), label: '', command: null });

    for (let i = 0; i < 4; i++) {
      const col = (i + 3) % 5;
      const row = Math.floor((i + 3) / 5);
      slots.push(awaitingActionSlot(state, isAwaiting, i, col, row));
    }
    slots.push({ col: 2, row: 1, svg: renderInfoButton('MODEL', state.modelName.slice(0, 12) || 'N/A'), label: '', command: null });
    slots.push({ col: 3, row: 1, svg: renderUsageButton('5H', state.fiveHourPercent, '#28a0b4', state.usageKnown !== false), label: '', command: { type: 'usage_toggle' } });
    slots.push({ col: 4, row: 1, svg: renderUsageButton('7D', state.sevenDayPercent, '#2850a0', state.usageKnown !== false), label: '', command: { type: 'usage_toggle' } });
  }

  // Row 2 shared actions: STOP/ESC, TOKENS, COST
  if (isProcessing) {
    slots.push({ col: 0, row: 2, svg: renderStopButton(true), label: '', command: { type: 'interrupt' } });
  } else if (isAwaiting) {
    slots.push({ col: 0, row: 2, svg: renderEscButton(true), label: '', command: { type: 'interrupt' } });
  } else {
    slots.push({ col: 0, row: 2, svg: renderStopButton(false), label: '', command: { type: 'interrupt' } });
  }
  const tk = state.totalTokens > 1000 ? `${(state.totalTokens / 1000).toFixed(0)}K` : `${state.totalTokens}`;
  slots.push({ col: 1, row: 2, svg: renderInfoButton('TOKENS', tk), label: '', command: null });
  slots.push({ col: 2, row: 2, svg: renderInfoButton('COST', `$${state.totalCost.toFixed(2)}`), label: '', command: null });

  return slots;
}

/** Physical-key-index → command map (index = row*GRID_COLS+col). Direct-HID input. */
export function buildButtonCommandMap(stateEvt: any): Map<number, ButtonCommand> {
  const layout = computeLayout(parseState(stateEvt));
  const map = new Map<number, ButtonCommand>();
  for (const slot of layout) {
    if (slot.command) map.set(slot.row * GRID_COLS + slot.col, slot.command);
  }
  return map;
}

export interface DeckCell {
  svg: string;
  command: ButtonCommand | null;
}

/**
 * `col_row` → {svg, command} map for the WHOLE grid, for plugins that address
 * keys by position (Ulanzi Studio). Unlike direct-HID, slot 3_2 is a normal
 * per-key usage tile (no hardware merge), and 4_2 mirrors it.
 */
export function buildLayoutMap(stateEvt: any, animFrame = 0, animated = false): Map<string, DeckCell> {
  const state = parseState(stateEvt);
  const map = new Map<string, DeckCell>();
  for (const slot of computeLayout(state, animFrame, animated)) {
    map.set(`${slot.col}_${slot.row}`, { svg: slot.svg, command: slot.command ?? null });
  }
  // Per-key usage tiles for the right side of row 2 (direct-HID merges these).
  if (!map.has('3_2')) {
    map.set('3_2', { svg: renderUsageButton('5H', state.fiveHourPercent, '#28a0b4', state.usageKnown !== false), command: { type: 'usage_toggle' } });
  }
  if (!map.has('4_2')) {
    map.set('4_2', { svg: renderUsageButton('7D', state.sevenDayPercent, '#2850a0', state.usageKnown !== false), command: { type: 'usage_toggle' } });
  }
  return map;
}

// ============================================================================
// Session-centric two-level deck (v4) — the canonical AgentDeck layout.
// List view: one session per key (fixed position, awaiting emphasized).
// Detail view: press a session → keys reflow to its options / permission /
// quick-actions + BACK + STOP. Stateless; the caller tracks the DeckView.
// Addresses keys by `col_row`, laid out over whatever positions the device has.
// ============================================================================

/** A press resolves to a daemon command and/or a local view change. */
export type DeckAction =
  | { kind: 'open'; sessionId: string }   // enter detail (+ focus_session)
  | { kind: 'back' }                      // return to list
  | { kind: 'page'; delta: number }       // paginate current view
  | { kind: 'command'; command: ButtonCommand }
  | { kind: 'launch' }                    // daemon down → open the companion app locally
  | null;

export interface SessionDeckCell { svg: string; action: DeckAction; }

export interface DeckView {
  mode: 'list' | 'detail';
  openSessionId?: string;
  page?: number;
  animFrame?: number;
  animated?: boolean;
  /**
   * Host push-to-talk capture state (daemon `voice_state` events). Drives the
   * detail-view VOICE tile: idle → "tap to talk" (sends voice start),
   * recording → "● listening" (sends voice stop), transcribing → inert.
   * D200H presses are single-fire (`run`), so the tile toggles rather than
   * holding.
   */
  voiceState?: 'idle' | 'recording' | 'transcribing' | 'error';
  /**
   * Opt-in: pin the last two list-view positions to 5H/7D subscription-usage
   * tiles (the global quota gauges). Used by surfaces with no encoder LCD to
   * carry usage (Ulanzi D200H, classic Stream Deck). Off by default so other
   * consumers keep the full grid for sessions.
   */
  showUsage?: boolean;
}

/** Row-major position order ("0_0","1_0",…,"4_2"). */
function sortPositions(positions: string[]): string[] {
  return [...positions].sort((a, b) => {
    const [ac, ar] = a.split('_').map(Number);
    const [bc, br] = b.split('_').map(Number);
    return ar !== br ? ar - br : ac - bc;
  });
}

const awaitingState = (s?: string) => !!s && s.toLowerCase().startsWith('awaiting');
const processingState = (s?: string) => s?.toLowerCase() === 'processing';

/** Small colored action tile (Allow/Deny/Always/quick-action). */
/**
 * Host push-to-talk tile. The deck contributes the button; the daemon owns
 * mic, on-device STT and spoken reply (host speakers), and delivery reuses
 * the device-voice ladder. Toggle semantics — D200H fires a single `run`
 * per press, so hold-to-talk is not expressible here.
 */
function voiceTile(view: DeckView, sid: string): SessionDeckCell {
  switch (view.voiceState ?? 'idle') {
    case 'recording':
      return {
        svg: actionTile('VOICE', UI.error, '● tap to send'),
        action: { kind: 'command', command: { type: 'voice', action: 'stop', sessionId: sid } },
      };
    case 'transcribing':
      return { svg: actionTile('VOICE', UI.cyan, 'transcribing…'), action: null };
    case 'error':
      return {
        svg: actionTile('VOICE', UI.error, 'no speech'),
        action: { kind: 'command', command: { type: 'voice', action: 'start', sessionId: sid } },
      };
    default:
      return {
        svg: actionTile('VOICE', UI.cyan, 'tap to talk'),
        action: { kind: 'command', command: { type: 'voice', action: 'start', sessionId: sid } },
      };
  }
}

function actionTile(label: string, color: string, subtitle?: string): string {
  const els = [
    `<text x="72" y="${subtitle ? 70 : 80}" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="${color}">${label}</text>`,
    subtitle ? `<text x="72" y="98" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">${subtitle}</text>` : '',
  ].join('');
  return svgFrame('#16181d', els);
}

/**
 * REVIEW = independent on-demand eval (review_run), NOT a prompt to the
 * agent — the daemon judges the session's latest COMPLETED work with a
 * separate model, so this tile is valid for EVERY session type (managed,
 * observed Claude/OpenCode, even control-less observed Codex) — but only
 * once the turn has ended. Shows the last verdict as a badge; REVIEWING
 * while the judge runs.
 */
function reviewTile(sess: SessionInfo | undefined, sid: string): SessionDeckCell {
  if (sess?.reviewStatus === 'running') {
    return { svg: renderInfoSlot('REVIEWING', 'judge running', 'activity', 'info'), action: null };
  }
  const risk = sess?.reviewRisk;
  const subtitle = risk
    ? `risk ${risk}${sess?.reviewFindings != null ? ` · ${sess.reviewFindings}` : ''}`
    : 'independent eval';
  const color = risk === 'high' ? '#f87171' : risk === 'medium' ? '#fbbf24' : '#93c5fd';
  return {
    svg: actionTile('REVIEW', color, subtitle),
    action: { kind: 'command', command: { type: 'review_run', sessionId: sid } },
  };
}

/**
 * Non-pressable review status for the PROCESSING branch: REVIEWING while the
 * judge runs, or the last verdict as an inert badge. Null when there is
 * nothing to show. Mid-turn the tile must not fire review_run — the work is
 * not complete yet (the Swift daemon judges the session trajectory, which
 * mid-turn has no assistant response and systematically reads as
 * "incomplete/unverified"; the Node daemon would judge a half-written diff).
 */
function reviewBadgeTile(sess: SessionInfo | undefined): SessionDeckCell | null {
  if (sess?.reviewStatus === 'running') {
    return { svg: renderInfoSlot('REVIEWING', 'judge running', 'activity', 'info'), action: null };
  }
  const risk = sess?.reviewRisk;
  if (!risk) return null;
  const subtitle = `risk ${risk}${sess?.reviewFindings != null ? ` · ${sess.reviewFindings}` : ''}`;
  const color = risk === 'high' ? '#f87171' : risk === 'medium' ? '#fbbf24' : '#93c5fd';
  return { svg: actionTile('REVIEW', color, subtitle), action: null };
}

export function buildSessionDeck(stateEvt: any, view: DeckView, positions: string[]): Map<string, SessionDeckCell> {
  const state = parseState(stateEvt);
  const slots = sortPositions(positions);
  const out = new Map<string, SessionDeckCell>();
  const animFrame = view.animFrame ?? 0;
  const animated = view.animated ?? false;
  if (slots.length === 0) return out;

  // Daemon down → OFFLINE hero on the center key, rest dim. Every key launches
  // the companion app on press (parity with the SD/SD+ keypad). If AgentDeck
  // isn't installed yet, the hero shows the install command so a marketplace-only
  // user knows the daemon is the missing piece.
  //
  // Gate on an EMPTY session list, not the top-level state alone: the daemon
  // reports `state:'disconnected'` whenever no managed/focused session is active
  // — which is the normal case when only passively-observed sessions exist (e.g.
  // after a managed PTY session ends on sleep). Those still arrive via
  // `sessions_list`, so showing OFFLINE while sessions are present would hide a
  // live deck. Genuine link-down funnels through the store as DISCONNECTED with
  // an empty list, so this still fires for a truly absent daemon.
  if ((state.state === 'DISCONNECTED' || state.state === 'disconnected') && state.allSessions.length === 0) {
    const hero = Math.floor(slots.length / 2);
    slots.forEach((pos, i) => out.set(pos, {
      svg: i === hero ? renderInfoSlot(PASSIVE_OFFLINE_LABEL, OPEN_AGENTDECK_LABEL, 'agentdeck', 'brand', 'npx @agentdeck/setup') : renderEmptySlot(),
      action: { kind: 'launch' },
    }));
    return out;
  }

  if (view.mode === 'detail' && view.openSessionId) {
    return buildDetail(state, stateEvt, view, slots, animFrame, animated, out);
  }
  return buildList(state, view, slots, animFrame, animated, out);
}

function buildList(
  state: DashState, view: DeckView, slots: string[], animFrame: number, animated: boolean,
  out: Map<string, SessionDeckCell>,
): Map<string, SessionDeckCell> {
  const sessions = sortSessions(foldCodexSessionsForDisplay(state.allSessions));

  // Pin the bottom-row usage strip to the global quota gauges (opt-in,
  // water-tank style). On the D200H the strip sits just left of the native clock
  // widget; on classic Stream Deck it replaces the encoder LCD this surface
  // lacks. We reserve as many keys as we have usage tiles (Claude 5H/7D + any
  // Codex window), but never more than the strip is wide, and never more than
  // `slots.length - 1` so at least one key stays for sessions — the latter is
  // the fix for the old `slots.length >= 6` gate that silently dropped ALL usage
  // when the user placed only a few AgentDeck keys. Reserved keys are pinned on
  // EVERY page (usage is global), and paging math below treats them as
  // unavailable for sessions.
  const usageHere = new Map<string, SessionDeckCell>();
  if (view.showUsage) {
    const usageTiles = buildUsageTiles(state);
    const maxReserve = Math.max(0, slots.length - 1);
    const preferred = sortPositions(USAGE_PREFERRED_POS.filter((p) => slots.includes(p)));
    const reserveCount = Math.min(usageTiles.length, USAGE_PREFERRED_POS.length, maxReserve);
    // Fill the strip from its RIGHT end so a missing tile frees the LEFTMOST key
    // (which flows back to sessions) and the gauges stay flush against the clock
    // — never a hole mid-strip.
    const pinned = preferred.slice(Math.max(0, preferred.length - reserveCount));
    // Tiles whose strip key the user didn't place fall back to trailing keys.
    const rest = slots.filter((p) => !pinned.includes(p));
    const fallback = rest.slice(rest.length - Math.max(0, reserveCount - pinned.length));
    const reserved = sortPositions([...pinned, ...fallback]).slice(0, reserveCount);
    reserved.forEach((pos, i) => usageHere.set(pos, usageTiles[i]));
  }
  // Positions left for sessions / NEXT after carving out usage.
  const freeSlots = slots.filter((pos) => !usageHere.has(pos));

  if (sessions.length === 0) {
    freeSlots.forEach((pos, i) => out.set(pos, {
      svg: i === 0 ? renderInfoSlot('NO SESSION', 'waiting', 'activity', 'info') : renderEmptySlot(),
      action: null,
    }));
    for (const [pos, cell] of usageHere) out.set(pos, cell);
    return out;
  }

  const overflow = sessions.length > freeSlots.length;
  const sessionSlots = overflow ? freeSlots.length - 1 : freeSlots.length;
  const pages = Math.max(1, Math.ceil(sessions.length / Math.max(1, sessionSlots)));
  const page = ((view.page ?? 0) % pages + pages) % pages;
  const pageSessions = sessions.slice(page * sessionSlots, page * sessionSlots + sessionSlots);

  freeSlots.forEach((pos, i) => {
    if (overflow && i === freeSlots.length - 1) {
      out.set(pos, { svg: renderNextPageButton(`${page + 1}/${pages}`), action: { kind: 'page', delta: 1 } });
      return;
    }
    const sess = pageSessions[i];
    if (sess) {
      out.set(pos, {
        svg: renderSessionSlot(sess, false, animFrame, undefined, { animated }),
        action: { kind: 'open', sessionId: sess.id },
      });
    } else {
      out.set(pos, { svg: renderEmptySlot(), action: null });
    }
  });
  for (const [pos, cell] of usageHere) out.set(pos, cell);
  return out;
}

function buildDetail(
  state: DashState, stateEvt: any, view: DeckView, slots: string[], animFrame: number, animated: boolean,
  out: Map<string, SessionDeckCell>,
): Map<string, SessionDeckCell> {
  const sid = view.openSessionId!;
  const sess = state.allSessions.find((s) => s.id === sid);
  // Focused-session detail comes from the top-level state_update when it relays
  // this session (focusedSessionId/sessionId match); else fall back to SessionInfo.
  const focused = stateEvt?.focusedSessionId === sid || stateEvt?.sessionId === sid;
  const sState = (focused ? state.state : (sess?.state ?? 'idle')).toLowerCase();
  const options = (focused ? state.options : (sess?.options ?? [])) ?? [];
  // Whatever question these options belong to, echoed back on a press so the
  // daemon can tell an answer apart from one aimed at a superseded question.
  const question = (focused ? (state.question ?? sess?.question) : sess?.question) || undefined;
  const tool = focused ? state.currentTool : sess?.currentTool;
  // A selected session with no model is UNKNOWN, not an invitation to borrow
  // the daemon-global model from another agent. Only a matching focused event
  // may override the sessions_list row.
  const model = focused ? (state.modelName || sess?.modelName || '') : (sess?.modelName || '');

  const heroSess: SessionInfo = sess ?? {
    id: sid, port: 0, alive: true, projectName: state.projectName,
    agentType: state.agentType as any, state: sState, modelName: model,
  };

  const first = slots[0];
  const last = slots[slots.length - 1];
  out.set(first, { svg: renderBackButton(), action: { kind: 'back' } });
  out.set(slots[1] ?? first, {
    svg: renderDetailInfo(heroSess, sState as State, tool, model, undefined),
    action: null,
  });

  // Observed (hook-only, no PTY) sessions steer through hook primitives, so
  // every actionable cell must map to something the daemon can actually
  // deliver: STOP → soft stop (deny at next tool call), quick actions →
  // queued for turn end, ALLOW/DENY → held PreToolUse gate. Anything
  // undeliverable renders inert instead of pretending to work.
  const isObserved = sess?.controlMode === 'observed';
  // Which observed agents actually have a delivery path: Claude = hook RPC
  // (soft stop / turn-end queue / gate), OpenCode = observer-plugin command
  // queue (immediate abort / prompt injection). Codex hooks are notify-only —
  // no steering exists, so its buttons must stay inert.
  const observedSteerable = isObserved
    && (sess?.agentType === 'claude-code' || sess?.agentType === 'opencode');
  const stopRequested = Boolean(sess?.stopRequested);
  const gateRequestId = sess?.requestId;

  if (processingState(sState)) {
    if (isObserved && !observedSteerable) {
      out.set(last, { svg: renderStopButton(false), action: null });
    } else if (isObserved && stopRequested) {
      // Soft stop already requested — pressing again does nothing new.
      out.set(last, { svg: renderInfoSlot('STOPPING', 'at next tool', 'status', 'warning'), action: null });
    } else {
      const command: ButtonCommand = isObserved
        ? { type: 'session_command', sessionId: sid, command: { type: 'interrupt' } }
        : { type: 'interrupt' };
      out.set(last, { svg: renderStopButton(true), action: { kind: 'command', command } });
    }
  } else if (awaitingState(sState)) {
    if (isObserved) {
      // ESC can't reach an observed terminal; the gate (if any) is answered
      // by the ALLOW/DENY content cells below.
      out.set(last, { svg: renderEscButton(false), action: null });
    } else {
      out.set(last, { svg: renderEscButton(true), action: { kind: 'command', command: { type: 'escape' } } });
    }
  } else {
    // Idle: an observed session has nothing to interrupt — render STOP inert
    // (the old always-armed interrupt here was a silent-drop trap).
    out.set(last, {
      svg: renderStopButton(false),
      action: isObserved ? null : { kind: 'command', command: { type: 'interrupt' } },
    });
  }

  // Content slots between INFO and STOP.
  const content = slots.slice(2, slots.length - 1);
  const cells: SessionDeckCell[] = [];

  if (awaitingState(sState)) {
    // A focused PTY session reports `navigable` on the live state_update; a
    // non-focused SessionInfo never carries it (and rarely carries options).
    const navigable = Boolean(focused ? stateEvt?.navigable : false);
    if (options.length > 0) {
      // Render the REAL option set (permission OR multi-select) regardless of
      // promptType — the parser already extracted the actual labels (e.g.
      // "Yes" / "Yes, and don't ask again" / "No, tell Claude"). Navigable TUI
      // (❯ cursor) → select_option so the daemon drives arrows+Enter;
      // non-navigable inline prompts → respond with the option's shortcut.
      // Hook-observed AskUserQuestion has no PTY/requestId response path, but
      // the daemon may still be able to deliver the answer — by typing it into
      // the session's own terminal, or by holding the question's hook open and
      // resolving it with our choice. `liveAnswerable` covers both; without it
      // the cells stay display-only. Always select_option when answerable (the
      // observed route acts on that command only); a shortcut-`respond` has no
      // observed meaning.
      const observedAnswerable = isObserved && Boolean(sess?.liveAnswerable);
      options.forEach((opt, i) => {
        const command: ButtonCommand = (navigable || observedAnswerable)
          // The question echo lets the daemon drop a press aimed at a question
          // a multi-group AskUserQuestion has already moved past, instead of
          // applying its index to the new option list.
          ? {
            type: 'select_option',
            index: typeof opt.index === 'number' ? opt.index : i,
            sessionId: sid,
            ...(question ? { question } : {}),
          }
          : { type: 'respond', value: opt.shortcut || opt.label?.charAt(0)?.toLowerCase() || String(i + 1) };
        cells.push({
          svg: renderOptionButton(opt, i),
          action: (isObserved && !observedAnswerable) ? null : { kind: 'command', command },
        });
      });
    } else if (isObserved && gateRequestId) {
      // Held PreToolUse gate: these two answers are device-native semantics
      // (permit/deny THIS tool call), not a mirror of the TUI prompt — the
      // daemon only holds calls it verified Claude would genuinely prompt for.
      cells.push({
        svg: actionTile('ALLOW', '#22c55e', 'this tool call'),
        action: { kind: 'command', command: { type: 'permission_decision', requestId: gateRequestId, decision: 'allow' } },
      });
      cells.push({
        svg: actionTile('DENY', '#f87171', 'this tool call'),
        action: { kind: 'command', command: { type: 'permission_decision', requestId: gateRequestId, decision: 'deny' } },
      });
    } else {
      // Awaiting but no real options to render — only PTY-managed sessions expose
      // Claude's actual choices. Don't fabricate Allow/Deny that may not match the
      // real prompt; guide the user to the terminal instead.
      cells.push({ svg: renderInfoSlot('PERMIT?', 'answer in terminal', 'status', 'warning'), action: null });
    }
  } else if (processingState(sState)) {
    const queued = sess?.queuedDirectives ?? 0;
    cells.push({
      svg: renderInfoSlot('RUNNING', queued > 0 ? `${queued} queued` : (tool || 'working'), 'activity', 'info'),
      action: null,
    });
    // No queued task buttons mid-turn: PROCESSING is deliberately limited to
    // live status + STOP so users cannot mistake a future directive for the
    // agent's current work. Keep the
    // REVIEWING spinner / last-verdict badge visible as inert status.
    const badge = reviewBadgeTile(sess);
    if (badge) cells.push(badge);
  } else if (isObserved) {
    if (sess?.agentType === 'opencode') {
      // OpenCode observed injects immediately even while idle (observer
      // plugin + in-process SDK) — same semantics as managed idle presets.
      const inject: Array<[string, string]> = [
        ['GO ON', 'continue'], ['COMMIT', 'commit the changes'],
      ];
      inject.forEach(([label, text]) => cells.push({
        svg: actionTile(label, '#cbd5e1', 'inject now'),
        action: { kind: 'command', command: { type: 'session_command', sessionId: sid, command: { type: 'send_prompt', text } } },
      }));
      cells.push(reviewTile(sess, sid));
      cells.push(voiceTile(view, sid));
    } else {
      // Idle observed Claude/Codex: deck-native prompt presets don't exist,
      // but the independent review stays live — and so does voice, because
      // the daemon delivers a dictated prompt through its observed-steering
      // ladder (terminal injection on the Node daemon, queued directive on
      // the Swift daemon).
      cells.push(reviewTile(sess, sid));
      cells.push(voiceTile(view, sid));
      cells.push({ svg: renderInfoSlot('OBSERVED', 'control in terminal', 'status', 'info'), action: null });
    }
  } else {
    // Managed idle quick-actions. REVIEW routes to the independent eval
    // (uniform semantics across every session type); the rest type into the
    // PTY as before.
    cells.push({
      svg: actionTile('GO ON', '#cbd5e1'),
      action: { kind: 'command', command: { type: 'send_prompt', text: 'continue' } },
    });
    cells.push(reviewTile(sess, sid));
    cells.push({
      svg: actionTile('COMMIT', '#cbd5e1'),
      action: { kind: 'command', command: { type: 'send_prompt', text: 'commit the changes' } },
    });
    cells.push({
      svg: actionTile('CLEAR', '#cbd5e1'),
      action: { kind: 'command', command: { type: 'send_prompt', text: '/clear' } },
    });
    cells.push(voiceTile(view, sid));
  }

  // Paginate cells into content slots; reserve last content slot for MORE if overflow.
  const cap = content.length;
  const overflow = cells.length > cap;
  const perPage = overflow ? cap - 1 : cap;
  const pages = Math.max(1, Math.ceil(cells.length / Math.max(1, perPage)));
  const page = ((view.page ?? 0) % pages + pages) % pages;
  const pageCells = cells.slice(page * perPage, page * perPage + perPage);
  content.forEach((pos, i) => {
    if (overflow && i === content.length - 1) {
      out.set(pos, { svg: renderNextPageButton(`${page + 1}/${pages}`), action: { kind: 'page', delta: 1 } });
      return;
    }
    out.set(pos, pageCells[i] ?? { svg: renderEmptySlot(), action: null });
  });
  return out;
}
