/**
 * Full-bleed level-fill usage gauge.
 *
 * The ENTIRE tile is the gauge: a full-width band rises from the bottom to a
 * height equal to the percent of the quota window already CONSUMED, so the tile
 * visibly fills as the agent burns through its window. The fill colour is a
 * vivid SEVERITY ramp (green → amber → red) driven by `usedPercent`, NOT the
 * agent brand — agent identity is carried by the provider's BRAND LOGO in the
 * top-right corner (Claude terracotta / Codex blue). Legibility WITHOUT a dark
 * overlay: the ramp fill is a SUBTLE level tint (~0.38 opacity) with a crisp 3px
 * line marking the exact level, so the bold white label / used% / reset (each
 * with a thin dark halo) read directly over it. Labels (5H/7D) and the reset
 * countdown are sized large for at-a-glance reading on the encoder strip.
 *
 * This module renders both the 144×144 keypad tile (`renderUsageGauge`) and the
 * 200×100 Stream Deck+ encoder LCD views (`renderUsageEncoderBoth`,
 * `renderUsageEncoderSingle`).
 */
import { Brand, UI, CLAUDE_LOGO_PATH, CODEX_LOGO_PATH } from '@agentdeck/shared';
import { formatResetTime, splitResetTwoLine, formatScopedLabel } from '../utility-modes/usage.js';

const W = 144;
const H = 144;
const RX = 12;

const BG = '#0f172a';
const CHIP = '#0b1220';
const LABEL_DIM = '#64748b';
const TEXT_DIM = '#475569';
const HEADLINE = '#ffffff';
const COUNTDOWN = '#ffffff';

/** Agent brand colour, used to tint the provider logo (NOT the fill — fill is severity). */
const BRAND_COLOR: Record<'claude' | 'codex', string> = {
  claude: Brand.claudeCode, // #C07058
  codex: Brand.codex,       // #6166E0
};

/** Canonical provider brand mark (viewBox 0 0 24 24). Replaces the old identity dot. */
const BRAND_LOGO_PATH: Record<'claude' | 'codex', string> = {
  claude: CLAUDE_LOGO_PATH,
  codex: CODEX_LOGO_PATH,
};

/**
 * Provider brand mark for the top-right corner (the agent identity, replacing
 * the old dot). The 24-unit path is scaled to `size` and centred on (cx,cy),
 * filled with the brand colour, over a subtle dark scrim circle so it stays
 * legible even when a ~100% fill colours the whole tile. `dim` greys it for the
 * unknown tile.
 */
function brandLogo(agent: 'claude' | 'codex', cx: number, cy: number, size: number, dim = false): string {
  const s = size / 24;
  const color = dim ? LABEL_DIM : BRAND_COLOR[agent];
  return (
    `<circle cx="${cx}" cy="${cy}" r="${(size / 2 + 3).toFixed(1)}" fill="${CHIP}" opacity="0.55"/>` +
    `<g transform="translate(${cx},${cy}) scale(${s.toFixed(3)}) translate(-12,-12)">` +
    `<path d="${BRAND_LOGO_PATH[agent]}" fill="${color}" fill-rule="evenodd"/></g>`
  );
}

/** Desaturated fill for an expired (stale) window — last-known %, dimmed. */
const STALE_FILL = '#64748b';

/** Informational fill for an INACTIVE per-model scoped cap: a high but non-binding
 *  cap must stay visible yet never wear the critical (red) ramp. The product-UI
 *  cyan reads as "info, not alarm" and is deliberately distinct from the stale
 *  slate above — an inactive limit is not a stale snapshot. Token (not raw hex)
 *  so it stays out of the design-lint R2 count. Exported for the scoped-gauge test. */
export const INACTIVE_FILL = UI.cyan;

/** The >80% critical (alarm) fill. Named + exported so the scoped-gauge test can
 *  assert "active cap wears critical, inactive does not" without re-hardcoding the
 *  hex (which would add to the R2 baseline). */
export const CRITICAL_FILL = '#ef4444';

/** Severity ramp by USED percent: <=50 green, 50–80 amber, >80 red. A stale
 *  window drops to a muted grey so it reads as "not current"; an inactive scoped
 *  cap drops to the informational cyan so a high-but-non-binding cap never reads
 *  as a critical alarm (puritysb #99: inactive ≠ same critical treatment). Stale
 *  wins over inactive — "not current" is the stronger caveat. */
function rampColor(used: number, stale = false, inactive = false): { fill: string; hi: string } {
  if (stale) return { fill: STALE_FILL, hi: STALE_FILL };
  if (inactive) return { fill: INACTIVE_FILL, hi: INACTIVE_FILL };
  if (used > 80) return { fill: CRITICAL_FILL, hi: '#fca5a5' };
  if (used > 50) return { fill: '#eab308', hi: '#fde047' };
  return { fill: '#22c55e', hi: '#86efac' };
}

export interface UsageGaugeData {
  agent: 'claude' | 'codex';
  /** Which rolling window this tile represents (drives the clip id + fallback). */
  window: '5h' | '7d';
  /** Tile label, e.g. "5H", "7D". Agent identity rides the brand dot, not a prefix. */
  label: string;
  /** Percent of the window already CONSUMED (0–100). Fill rises with this. */
  usedPercent: number;
  /** ISO-8601 reset instant for the countdown. */
  resetsAt?: string;
  /** False when no live quota exists — dark tile + dim label + "—", no fill. */
  known?: boolean;
  /** Codex snapshot expired: keep last-known % but desaturate the fill and show
   *  a "stale" marker instead of a (misleading) "now" countdown. */
  stale?: boolean;
  /** Scoped cap that is not the currently binding constraint: fill drops to the
   *  informational cyan instead of the severity ramp. Defaults false so the real
   *  5H/7D tiles are byte-unchanged. */
  inactive?: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}

function clampPct(p: number): number {
  // Guard NaN/Infinity (an undocumented scoped percent could be non-finite) so a
  // gauge never renders "NaN%"; finite values are unchanged.
  return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
}

export function renderUsageGauge(data: UsageGaugeData): string {
  const known = data.known !== false;
  const agent = data.agent === 'codex' ? 'codex' : 'claude';
  const label = data.label || data.window.toUpperCase();
  const clipId = `ug-${agent}-${data.window}`;
  const clip = `<defs><clipPath id="${clipId}"><rect x="0" y="0" width="${W}" height="${H}" rx="${RX}"/></clipPath></defs>`;
  const bg = `<rect width="${W}" height="${H}" rx="${RX}" fill="${BG}"/>`;
  const logo = brandLogo(agent, 124, 22, 26, !known);

  if (!known) {
    return svgWrap(
      clip + bg +
      `<text x="14" y="36" font-family="JetBrains Mono, monospace" font-size="26" font-weight="bold" fill="${LABEL_DIM}">${esc(label)}</text>` +
      logo +
      `<text x="72" y="94" text-anchor="middle" font-family="Arial,sans-serif" font-size="44" font-weight="bold" fill="${TEXT_DIM}">—</text>`,
    );
  }

  const stale = data.stale === true;
  const used = clampPct(data.usedPercent);
  const ramp = rampColor(used, stale, data.inactive === true);
  const fillH = Math.round((H * used) / 100);
  const fillY = H - fillH;
  // Subtle level tint (low opacity) so text reads on top WITHOUT a dark overlay;
  // a crisp 3px solid line marks the exact level. Stale = extra-faint tint.
  const fillOpacity = stale ? 0.22 : 0.38;
  const fill = fillH > 0
    ? `<g clip-path="url(#${clipId})">` +
        `<rect x="0" y="${fillY}" width="${W}" height="${fillH}" fill="${ramp.fill}" opacity="${fillOpacity}"/>` +
        `<rect x="0" y="${fillY}" width="${W}" height="3" fill="${ramp.fill}"/>` +
      `</g>`
    : '';

  // Expired window: drop the (misleading) countdown for a muted "stale" marker;
  // the % stays as last-known but dims so it doesn't read as live.
  const reset = stale ? 'stale' : formatResetTime(data.resetsAt);
  const pctColor = stale ? LABEL_DIM : HEADLINE;
  const resetColor = stale ? LABEL_DIM : COUNTDOWN;

  return svgWrap(
    // Small text (label/reset) = plain white, NO outline — a stroke muddies
    // small glyphs. Only the big % keeps a thin outline (it can sit over fill).
    clip + bg + fill +
    `<text x="14" y="36" font-family="JetBrains Mono, monospace" font-size="26" font-weight="bold" fill="${stale ? LABEL_DIM : HEADLINE}">${esc(label)}</text>` +
    logo +
    `<text x="72" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="46" font-weight="bold" fill="${pctColor}">${Math.round(used)}<tspan font-size="24">%</tspan></text>` +
    (reset ? `<text x="72" y="122" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" font-weight="bold" fill="${resetColor}">${esc(reset)}</text>` : ''),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Encoder-LCD variants (Stream Deck+ touch strip, 200×100).
//
// Each SD+ usage encoder (E2 = Claude, E3 = Codex) cycles between views by dial
// rotation: 'both' (5H + 7D side-by-side mini level-fills), '5h' / '7d' (one big
// level-fill), and 'session' (text — rendered separately). Same visual language
// as the keypad tile: full-bleed severity-ramp fill + agent brand dot.
// ─────────────────────────────────────────────────────────────────────────

const ENC_W = 200;
const ENC_H = 100;

export interface UsageEncoderTank {
  /** Tank label, e.g. "5H" / "7D". */
  label: string;
  /** Percent of the window already CONSUMED (0–100). */
  usedPercent: number;
  /** ISO-8601 reset instant for the countdown. */
  resetsAt?: string;
  /** False when no live quota exists for this window — dim panel + "—". */
  known: boolean;
  /** Codex snapshot expired: keep last-known % but desaturate the fill and show
   *  a "stale" marker instead of a (misleading) "now" countdown. */
  stale?: boolean;
  /** Scoped cap that is not the currently binding constraint: fill drops to the
   *  informational cyan instead of the severity ramp. Defaults false so the real
   *  5H/7D panels are byte-unchanged. */
  inactive?: boolean;
}

/**
 * Companion readout shown beside a lone gauge in the 'both' view. A provider can
 * permanently report a single window (Codex dropped its 5h rolling window
 * upstream on 2026-07-12 and has reported the weekly cap alone ever since), which
 * left the other half of the LCD as a dim "—" ghost. This card fills that half
 * with the facts the gauge itself cannot carry: how far out the reset is in
 * absolute terms, or the plan tier.
 */
export interface UsageEncoderSideCard {
  /** Small dim heading, e.g. "RESETS" / "PLAN". */
  label: string;
  /** Headline value, e.g. "6d2h" / "PLUS". */
  value: string;
  /** Optional second line, e.g. the absolute reset instant "Thu 15:02". */
  sub?: string;
  /** Dim the headline. Set for the stale marker so it matches the desaturated
   *  gauge beside it — a "not current" notice must not be the loudest thing on
   *  the LCD. */
  muted?: boolean;
}

export interface UsageEncoderData {
  agent: 'claude' | 'codex';
  /** Top-left title, e.g. "CLAUDE" / "CODEX". */
  title: string;
  fiveHour: UsageEncoderTank;
  sevenDay: UsageEncoderTank;
  /**
   * When set, the gauges are replaced by a single centred status line (e.g.
   * "Waiting…" for the first-payload case, or "No Codex usage" when the agent
   * reports no rate limits). Keeps the agent title + brand framing.
   */
  note?: string;
  /** Companion readout for the single-window 'both' view (see the interface). */
  sideCard?: UsageEncoderSideCard;
}

function encSvgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ENC_W}" height="${ENC_H}" viewBox="0 0 ${ENC_W} ${ENC_H}">${inner}</svg>`;
}

/** Logo-only agent identity (top-right), matching the SD key tiles — no
 * separate agent-name text, which read as awkward floating next to the logo. */
function encHeader(data: UsageEncoderData, muted = false): string {
  const agent = data.agent === 'codex' ? 'codex' : 'claude';
  return brandLogo(agent, 186, 12, 16, muted);
}

/**
 * One full-bleed level-fill panel inside the encoder LCD. Fill rises from the
 * panel's bottom by `usedPercent`; overlays (label, used%, reset) carry halos.
 * `big` enlarges the headline for the single-window view.
 */
function encPanel(
  x: number, y: number, w: number, h: number,
  tank: UsageEncoderTank, clipId: string, big: boolean,
  showReset = true,
  narrow = false,
): string {
  const panelRx = 7;
  const clip = `<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${panelRx}"/></clipPath>`;
  const bg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${panelRx}" fill="#0b1220"/>`;
  const cx = x + w / 2;
  // Big, bold window label so "which is 5H vs 7D" reads at a glance.
  const labelEl = `<text x="${cx}" y="${y + (big ? 22 : 19)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${big ? 20 : 16}" font-weight="bold" fill="${tank.known ? HEADLINE : LABEL_DIM}">${esc(tank.label)}</text>`;

  if (!tank.known) {
    return (
      `<defs>${clip}</defs>` + bg +
      labelEl +
      `<text x="${cx}" y="${y + h / 2 + 14}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${big ? 34 : 22}" font-weight="bold" fill="${TEXT_DIM}">—</text>`
    );
  }

  const stale = tank.stale === true;
  const used = clampPct(tank.usedPercent);
  const ramp = rampColor(used, stale, tank.inactive === true);
  const fillH = Math.round((h * used) / 100);
  const fillY = y + h - fillH;
  // Subtle level tint + crisp 3px level line — no dark overlay behind text.
  // Stale = extra-faint tint so it reads as "not current".
  const fillOpacity = stale ? 0.22 : 0.38;
  const fill = fillH > 0
    ? `<g clip-path="url(#${clipId})">` +
        `<rect x="${x}" y="${fillY}" width="${w}" height="${fillH}" fill="${ramp.fill}" opacity="${fillOpacity}"/>` +
        `<rect x="${x}" y="${fillY}" width="${w}" height="3" fill="${ramp.fill}"/>` +
      `</g>`
    : '';
  // Expired window: muted "stale" marker instead of the (absent) countdown.
  // `showReset` is false when a side card already carries the reset horizon —
  // printing it twice on one 200px LCD reads as a rendering bug.
  const reset = showReset ? (stale ? 'stale' : formatResetTime(tank.resetsAt)) : '';
  const pctColor = stale ? LABEL_DIM : HEADLINE;
  const resetColor = stale ? LABEL_DIM : COUNTDOWN;

  // Narrow panels (the 3-up "triple" view) stack a two-part countdown onto two
  // lines ("1h" / "45m") instead of shrinking the font to fit "1h45m".
  let resetEl = '';
  if (reset) {
    const parts = narrow ? splitResetTwoLine(reset) : [reset];
    if (parts.length === 2) {
      resetEl =
        `<text x="${cx}" y="${y + h - 18}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="${resetColor}">${esc(parts[0])}</text>` +
        `<text x="${cx}" y="${y + h - 5}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="${resetColor}">${esc(parts[1])}</text>`;
    } else {
      resetEl = `<text x="${cx}" y="${y + h - 7}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${big ? 15 : 13}" font-weight="bold" fill="${resetColor}">${esc(parts[0])}</text>`;
    }
  }

  return (
    `<defs>${clip}</defs>` + bg + fill +
    labelEl +
    `<text x="${cx}" y="${y + h / 2 + (big ? 16 : 12)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${big ? 42 : 26}" font-weight="bold" fill="${pctColor}">${Math.round(used)}<tspan font-size="${big ? 20 : 13}">%</tspan></text>` +
    resetEl
  );
}

/** Note view (Waiting… / No usage data): a brand-forward empty state. The agent
 *  mark is centred as the focal point so the dial still reads as its provider's
 *  usage — with the title above and a short status line beneath — instead of a
 *  tiny corner logo next to stark floating text, which read as "broken" when a
 *  single provider had no data. */
function encNote(data: UsageEncoderData): string {
  const agent = data.agent === 'codex' ? 'codex' : 'claude';
  const logoSize = 30;
  // brandLogo's x/y are the mark's CENTRE (see encHeader), so centre it on the
  // canvas: title above, mark in the middle, status line beneath.
  return encSvgWrap(
    `<rect width="${ENC_W}" height="${ENC_H}" fill="${BG}"/>` +
    `<text x="${ENC_W / 2}" y="19" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="12" font-weight="bold" fill="${LABEL_DIM}">${esc(data.title)}</text>` +
    brandLogo(agent, ENC_W / 2, 42, logoSize, true) +
    `<text x="${ENC_W / 2}" y="85" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="${LABEL_DIM}">${esc(data.note ?? '')}</text>`,
  );
}

/**
 * Companion readout beside a lone gauge: a dim heading, a bold value, and an
 * optional second line. Same chip background and corner radius as `encPanel` so
 * the two halves read as one instrument rather than a gauge plus a caption.
 */
function encSideCard(x: number, y: number, w: number, h: number, card: UsageEncoderSideCard): string {
  const cx = x + w / 2;
  // Deliberately smaller than the gauge's 26px percentage: this half is context
  // for the reading, not a second reading. Matching the gauge's weight made the
  // encoder look like two competing instruments.
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${CHIP}"/>` +
    `<text x="${cx}" y="${y + 18}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" font-weight="bold" fill="${LABEL_DIM}">${esc(card.label)}</text>` +
    `<text x="${cx}" y="${y + 47}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${card.muted ? 16 : 18}" font-weight="bold" fill="${card.muted ? LABEL_DIM : COUNTDOWN}">${esc(card.value)}</text>` +
    (card.sub
      ? `<text x="${cx}" y="${y + 67}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="${LABEL_DIM}">${esc(card.sub)}</text>`
      : '')
  );
}

/**
 * 'both' view: 5H and 7D as two side-by-side full-bleed mini level-fills.
 *
 * When the provider reports only ONE live window the second panel would be a
 * permanent dim "—" ghost (Codex dropped its 5h rolling window upstream on
 * 2026-07-12 and has reported the weekly cap alone since). The lone gauge KEEPS
 * its half-width geometry — stretching one level-fill across the full 200px LCD
 * reads as a banner, not a gauge — and the freed half carries the side card
 * instead. Providers still reporting both windows are unaffected.
 *
 * The gauge also keeps its CANONICAL COLUMN — 5H left, 7D right — so E2 (Claude,
 * both windows) and E3 (Codex, weekly only) put the same window in the same
 * place. Centring the lone gauge or always drawing it left made the two
 * encoders disagree about where "7D" lives, which read as a layout glitch.
 *
 * The gauge keeps printing its own reset countdown too, exactly as it does
 * beside a sibling gauge on E2 — moving that number out to the side card made
 * the same fact live in a different place depending on the provider. The card
 * therefore carries only what no gauge can: the subscription behind the quota.
 */
export function renderUsageEncoderBoth(data: UsageEncoderData): string {
  if (data.note != null) return encNote(data);
  const y = 18, h = 80;
  const live = [data.fiveHour, data.sevenDay].filter((t) => t.known);
  if (live.length === 1 && data.sideCard) {
    const soloIsWeekly = data.sevenDay.known;
    const gaugeX = soloIsWeekly ? 102 : 4;
    const cardX = soloIsWeekly ? 4 : 102;
    return encSvgWrap(
      `<rect width="${ENC_W}" height="${ENC_H}" fill="${BG}"/>` +
      encHeader(data) +
      encSideCard(cardX, y, 94, h, data.sideCard) +
      encPanel(gaugeX, y, 94, h, live[0], `enc-${data.agent}-both-solo`, false),
    );
  }
  return encSvgWrap(
    `<rect width="${ENC_W}" height="${ENC_H}" fill="${BG}"/>` +
    encHeader(data) +
    encPanel(4, y, 94, h, data.fiveHour, `enc-${data.agent}-both-5h`, false) +
    encPanel(102, y, 94, h, data.sevenDay, `enc-${data.agent}-both-7d`, false),
  );
}

/** '5h' / '7d' view: one big full-bleed level-fill across the LCD. */
export function renderUsageEncoderSingle(data: UsageEncoderData, window: '5h' | '7d'): string {
  if (data.note != null) return encNote(data);
  const tank = window === '5h' ? data.fiveHour : data.sevenDay;
  return encSvgWrap(
    `<rect width="${ENC_W}" height="${ENC_H}" fill="${BG}"/>` +
    encHeader(data) +
    encPanel(4, 18, 192, 80, tank, `enc-${data.agent}-single-${window}`, true),
  );
}

// ─── Scoped per-model limit (e.g. weekly "Fable" cap) ───────────────────────
// The account-wide 5H/7D windows can read low while a per-model weekly cap is
// the ACTIVE binding constraint. These variants surface that limit: inline as a
// third panel in the 'triple' default view, and full-width in the zoom view.

export interface UsageEncoderScoped {
  /** Model display name (untruncated), e.g. "Fable". */
  label: string;
  /** Percent of this scoped limit already CONSUMED (0–100). */
  usedPercent: number;
  /** ISO-8601 reset instant. */
  resetsAt?: string;
  /** False when no scoped limit exists — dim panel + "—". */
  known: boolean;
  /** True when this cap is the currently binding constraint (API `is_active`).
   *  Inactive caps stay visible but render MUTED (informational cyan) — never the
   *  critical ramp (puritysb #99). */
  active: boolean;
}

/** Map a scoped limit onto the panel renderer: clean+cap the model label and
 *  mute the fill when the cap is not the binding constraint. */
function scopedToTank(s: UsageEncoderScoped, maxLabel: number): UsageEncoderTank {
  return {
    label: formatScopedLabel(s.label, maxLabel),
    usedPercent: s.usedPercent,
    resetsAt: s.resetsAt,
    known: s.known,
    inactive: !s.active,
  };
}

/** 'triple' default view: 5H, 7D and the worst per-model scoped cap as three
 *  side-by-side full-bleed mini level-fills on one 200×100 LCD. */
export function renderUsageEncoderTriple(data: UsageEncoderData, scoped: UsageEncoderScoped): string {
  if (data.note != null) return encNote(data);
  const y = 18, h = 80, pw = 62;
  return encSvgWrap(
    `<rect width="${ENC_W}" height="${ENC_H}" fill="${BG}"/>` +
    encHeader(data) +
    encPanel(4, y, pw, h, data.fiveHour, `enc-${data.agent}-tri-5h`, false, true, true) +
    encPanel(69, y, pw, h, data.sevenDay, `enc-${data.agent}-tri-7d`, false, true, true) +
    encPanel(134, y, pw, h, scopedToTank(scoped, 6), `enc-${data.agent}-tri-sc`, false, true, true),
  );
}

/** Scoped zoom view: one big full-bleed level-fill for a single per-model cap. */
export function renderUsageEncoderScopedSingle(data: UsageEncoderData, scoped: UsageEncoderScoped): string {
  if (data.note != null) return encNote(data);
  return encSvgWrap(
    `<rect width="${ENC_W}" height="${ENC_H}" fill="${BG}"/>` +
    encHeader(data) +
    encPanel(4, 18, 192, 80, scopedToTank(scoped, 12), `enc-${data.agent}-scoped`, true),
  );
}

/** 144×144 keypad tile for the worst per-model scoped cap (the "Claude Limit"
 *  button). Reuses the level-fill gauge; `undefined` renders the unknown tile. */
export function renderUsageLimitGauge(scoped?: UsageEncoderScoped): string {
  return renderUsageGauge({
    agent: 'claude',
    window: '7d',
    label: scoped ? formatScopedLabel(scoped.label, 8) : 'LIMIT',
    usedPercent: scoped?.usedPercent ?? 0,
    resetsAt: scoped?.resetsAt,
    known: scoped?.known === true,
    // Inactive cap → informational cyan, never the critical ramp (puritysb #99).
    inactive: scoped ? !scoped.active : false,
  });
}
