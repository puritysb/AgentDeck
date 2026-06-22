/**
 * TRMNL e-ink dashboard layout — renders the AgentDeck session overview as a
 * monochrome SVG. Defaults to 800×480 (the OG TRMNL 7.5" panel) but reflows to
 * any device-reported resolution via `opts.width`/`opts.height` so different
 * BYOS panels render correctly.
 *
 * Unlike the Stream Deck / D200H renderers (color tiles, fast refresh), this is
 * a slow-refresh, 1-bit surface: pure black on white, no color reliance, status
 * conveyed by labels + borders + shapes (DESIGN.md §10.4 e-ink rule). The bridge
 * rasterizes this SVG to a 1-bit PNG (bridge/src/trmnl/image-renderer.ts) which
 * the device pulls over the BYOS HTTP API.
 *
 * Reuses `parseState`/`DashState` (the shared deck state model) so it stays in
 * lockstep with the other surfaces, and `measureTextWidth`/`sliceByPx` for
 * CJK-aware truncation.
 */
import { parseState, type DashState } from './d200h-layout.js';
import { measureTextWidth, sliceByPx } from './svg-renderers/text-utils.js';
import type { SessionInfo } from './protocol.js';

export const TRMNL_WIDTH = 800;
export const TRMNL_HEIGHT = 480;

const SANS = 'IBM Plex Sans, sans-serif';
const MONO = 'JetBrains Mono, monospace';
const INK = '#000000';
const PAPER = '#ffffff';

function escXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Truncate to fit `maxPx` at `fontSize`, appending an ellipsis when clipped. */
function truncatePx(s: string, maxPx: number, fontSize: number): string {
  if (!s) return '';
  if (measureTextWidth(s, fontSize) <= maxPx) return s;
  const [head] = sliceByPx(s, Math.max(0, maxPx - fontSize * 0.6), fontSize);
  return head.replace(/\s+$/, '') + '…';
}

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'CLAUDE',
  'codex-cli': 'CODEX',
  'codex-app': 'CODEX',
  codex: 'CODEX',
  opencode: 'OPENCODE',
  openclaw: 'OPENCLAW',
  daemon: 'AGENT',
};

function agentLabel(agentType?: string): string {
  return AGENT_LABEL[agentType ?? ''] ?? (agentType ? agentType.toUpperCase().slice(0, 8) : 'AGENT');
}

/** Normalized status verb for a session state. */
function statusLabel(state?: string): string {
  const s = (state ?? '').toLowerCase();
  if (s.startsWith('awaiting')) return 'AWAITING';
  if (s === 'processing') return 'WORKING';
  if (s === 'disconnected') return 'OFFLINE';
  if (s === 'idle') return 'IDLE';
  if (!s) return 'IDLE';
  return s.toUpperCase().slice(0, 9);
}

function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

/** Hour:Minute for the "updated" stamp. Caller may pass a fixed Date for tests. */
function hhmm(now: Date): string {
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Outline + filled gauge bar (no color — fill is solid ink). */
function gauge(x: number, y: number, w: number, h: number, pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const fillW = Math.round((w * clamped) / 100);
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${INK}" stroke-width="1.5"/>`,
    fillW > 0 ? `<rect x="${x}" y="${y}" width="${fillW}" height="${h}" fill="${INK}"/>` : '',
  ].join('');
}

/** "No data" gauge — outlined box with a diagonal hatch (usage truly unknown). */
function gaugeUnknown(x: number, y: number, w: number, h: number): string {
  const clipId = `nh${Math.round(x)}_${Math.round(y)}`;
  const lines: string[] = [
    `<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>`,
    `<g clip-path="url(#${clipId})">`,
  ];
  // Sparse diagonal hatch so it reads as "unavailable", not "0% filled".
  for (let hx = x - h; hx < x + w; hx += 8) {
    lines.push(`<line x1="${hx}" y1="${y + h}" x2="${hx + h}" y2="${y}" stroke="${INK}" stroke-width="1"/>`);
  }
  lines.push(`</g>`);
  lines.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${INK}" stroke-width="1.5"/>`);
  return lines.join('');
}

/** Column geometry for one session row, derived from the panel width. */
interface RowGeom {
  pad: number;
  tagW: number;
  midX: number;
  midW: number;
  badgeX: number;
  badgeW: number;
}

/** One session row. `y` is the row's top edge; `geom` is width-derived columns. */
function sessionRow(sess: SessionInfo, y: number, rowH: number, geom: RowGeom): string {
  const { pad, tagW, midX, midW, badgeX, badgeW } = geom;
  const status = statusLabel(sess.state);
  const awaiting = status === 'AWAITING';
  const els: string[] = [];

  // Row separator (hairline above each row except the first is drawn by caller).
  // Agent tag box.
  els.push(
    `<rect x="${pad}" y="${y + 8}" width="${tagW}" height="${rowH - 16}" fill="none" stroke="${INK}" stroke-width="2"/>`,
    `<text x="${pad + tagW / 2}" y="${y + rowH / 2 + 6}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="700" fill="${INK}">${escXml(agentLabel(sess.agentType))}</text>`,
  );

  // Project + model (middle column).
  const project = truncatePx(sess.projectName || '(no project)', midW, 24);
  const model = truncatePx(sess.modelName || '', midW, 16);
  els.push(
    `<text x="${midX}" y="${y + rowH / 2 - 4}" font-family="${SANS}" font-size="24" font-weight="700" fill="${INK}">${escXml(project)}</text>`,
  );
  if (model) {
    els.push(
      `<text x="${midX}" y="${y + rowH / 2 + 22}" font-family="${MONO}" font-size="16" fill="${INK}">${escXml(model)}</text>`,
    );
  }

  // Status badge (right column). Awaiting gets a bold double border to stand out
  // without color; working gets a filled triangle marker.
  const badgeY = y + 12;
  const badgeH = rowH - 24;
  if (awaiting) {
    els.push(
      `<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" fill="${INK}"/>`,
      `<text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH / 2 + 7}" text-anchor="middle" font-family="${SANS}" font-size="20" font-weight="700" fill="${PAPER}">${status}</text>`,
    );
  } else {
    els.push(
      `<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" fill="none" stroke="${INK}" stroke-width="1.5"/>`,
    );
    if (status === 'WORKING') {
      const tx = badgeX + 18;
      const cy = badgeY + badgeH / 2;
      els.push(`<path d="M ${tx} ${cy - 7} L ${tx + 12} ${cy} L ${tx} ${cy + 7} Z" fill="${INK}"/>`);
      els.push(
        `<text x="${badgeX + badgeW / 2 + 10}" y="${cy + 6}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="700" fill="${INK}">${status}</text>`,
      );
    } else {
      els.push(
        `<text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH / 2 + 6}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="600" fill="${INK}">${status}</text>`,
      );
    }
  }

  return els.join('');
}

export interface TrmnlRenderOpts {
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Panel width in px (device-reported). Defaults to the OG 800. */
  width?: number;
  /** Panel height in px (device-reported). Defaults to the OG 480. */
  height?: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Render the dashboard SVG at an arbitrary panel resolution. Accepts either a
 * raw broadcast state event or a pre-parsed DashState. Geometry reflows from
 * `opts.width`/`opts.height` (default 800×480) so any TRMNL/BYOS panel renders
 * correctly: the row count is derived from the available height and the columns
 * + footer gauges scale with the width.
 */
export function renderTrmnlDashboard(input: DashState | any, opts: TrmnlRenderOpts = {}): string {
  const state: DashState =
    input && Array.isArray((input as DashState).allSessions) && 'mode' in input
      ? (input as DashState)
      : parseState(input);
  const now = opts.now ?? new Date();
  const W = opts.width && opts.width > 0 ? Math.round(opts.width) : TRMNL_WIDTH;
  const H = opts.height && opts.height > 0 ? Math.round(opts.height) : TRMNL_HEIGHT;

  // The dashboard is read-only — show exactly the live sessions, nothing
  // synthetic. An empty list yields the idle hero below.
  const sessions: SessionInfo[] = state.allSessions;

  const els: string[] = [];
  // Paper background — ensures alpha=255 everywhere so the 1-bit threshold is clean.
  els.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${PAPER}"/>`);

  const pad = 24;
  const awaitingCount = sessions.filter((s) => statusLabel(s.state) === 'AWAITING').length;
  const workingCount = sessions.filter((s) => statusLabel(s.state) === 'WORKING').length;
  const summary = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${workingCount} working · ${awaitingCount} awaiting`;

  const headerH = 72;
  const footerTop = H - 68;
  // An AWAITING agent is the single most valuable glance signal on a slow panel,
  // so it gets a full-width inverted banner above the rows instead of hiding in a
  // per-row badge. The banner steals vertical space from the row area.
  const awaitingSessions = sessions.filter((s) => statusLabel(s.state) === 'AWAITING');
  const bannerH = awaitingSessions.length > 0 ? 48 : 0;
  const bodyTop = headerH + 14 + bannerH;
  const rowH = 64;
  const maxRows = Math.floor((footerTop - bodyTop) / rowH);

  // --- Extreme-aspect / tiny-panel guard ---
  // Too short for even one row, or too narrow for the column layout: collapse to
  // a centered wordmark + summary instead of overlapping boxes.
  if (maxRows < 1 || W < 320) {
    els.push(
      `<text x="${W / 2}" y="${H / 2 - 6}" text-anchor="middle" font-family="${SANS}" font-size="${Math.min(34, Math.round(W * 0.09))}" font-weight="700" fill="${INK}">AgentDeck</text>`,
      `<text x="${W / 2}" y="${H / 2 + 22}" text-anchor="middle" font-family="${SANS}" font-size="14" font-weight="600" fill="${INK}">${escXml(summary)}</text>`,
    );
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${els.join('')}</svg>`;
  }

  // --- Header ---
  els.push(
    `<text x="${pad}" y="48" font-family="${SANS}" font-size="34" font-weight="700" fill="${INK}">AgentDeck</text>`,
    `<text x="${W - pad}" y="48" text-anchor="end" font-family="${SANS}" font-size="18" font-weight="600" fill="${INK}">${escXml(summary)}</text>`,
    `<rect x="${pad}" y="${headerH}" width="${W - 2 * pad}" height="3" fill="${INK}"/>`,
  );

  // --- AWAITING banner (highest-priority glance signal) ---
  if (bannerH > 0) {
    const by = headerH + 14;
    const bh = bannerH - 8;
    const n = awaitingSessions.length;
    const projects = awaitingSessions
      .map((s) => s.projectName || agentLabel(s.agentType))
      .filter(Boolean)
      .join(', ');
    const label = `${n} agent${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you`;
    els.push(
      `<rect x="${pad}" y="${by}" width="${W - 2 * pad}" height="${bh}" fill="${INK}"/>`,
      `<text x="${pad + 16}" y="${by + bh / 2 + 7}" font-family="${SANS}" font-size="22" font-weight="700" fill="${PAPER}">${escXml(label)}</text>`,
      `<text x="${W - pad - 16}" y="${by + bh / 2 + 6}" text-anchor="end" font-family="${SANS}" font-size="16" font-weight="600" fill="${PAPER}">${escXml(truncatePx(projects, W * 0.5, 16))}</text>`,
    );
  }

  // --- Session rows (or idle hero) ---
  // Width-derived column geometry, shared by every row.
  const tagW = Math.min(108, Math.round(W * 0.16));
  const badgeW = clamp(Math.round(W * 0.19), 120, 180);
  const badgeX = W - pad - badgeW;
  const midX = pad + tagW + 18;
  const rowGeom: RowGeom = { pad, tagW, midX, midW: badgeX - midX - 18, badgeX, badgeW };

  if (sessions.length === 0) {
    // Idle hero — keep header + footer (usage is still meaningful) and center a
    // clean "no sessions" message in the body band (mirrors D200H's offline hero
    // spirit, but read-only so no action prompt).
    const cy = (bodyTop + footerTop) / 2;
    els.push(
      `<text x="${W / 2}" y="${cy - 6}" text-anchor="middle" font-family="${SANS}" font-size="28" font-weight="700" fill="${INK}">No active sessions</text>`,
      `<text x="${W / 2}" y="${cy + 30}" text-anchor="middle" font-family="${SANS}" font-size="18" fill="${INK}">Start Claude Code, Codex, or OpenCode to see them here</text>`,
    );
  } else {
    const visible = sessions.slice(0, maxRows);
    const overflow = sessions.length - visible.length;
    visible.forEach((sess, i) => {
      const y = bodyTop + i * rowH;
      if (i > 0) {
        els.push(`<rect x="${pad}" y="${y}" width="${W - 2 * pad}" height="1" fill="${INK}"/>`);
      }
      els.push(sessionRow(sess, y, rowH, rowGeom));
    });
    if (overflow > 0) {
      els.push(
        `<text x="${W / 2}" y="${bodyTop + maxRows * rowH - 10}" text-anchor="middle" font-family="${SANS}" font-size="16" font-weight="600" fill="${INK}">+${overflow} more session${overflow === 1 ? '' : 's'}</text>`,
      );
    }
  }

  // --- Footer (usage + totals + timestamp), scaled to the panel width ---
  els.push(`<rect x="${pad}" y="${footerTop}" width="${W - 2 * pad}" height="2" fill="${INK}"/>`);
  const fy = footerTop + 26;
  const gaugeW = clamp(Math.round(W * 0.18), 110, 200);
  const g1Bar = pad + 34;
  const g1Pct = g1Bar + gaugeW + 8;
  const col2 = Math.round(W * 0.34);
  const g2Bar = col2 + 34;
  const g2Pct = g2Bar + gaugeW + 8;
  // When the serving hub has no subscription quota (OAuth-blind / no relay), the
  // gauges would otherwise read a confident 0%. Draw a hatched "no data" bar and
  // an em dash instead so the panel never lies about usage.
  const usageKnown = state.usageKnown !== false;
  els.push(
    // 5H gauge
    `<text x="${pad}" y="${fy + 4}" font-family="${SANS}" font-size="16" font-weight="700" fill="${INK}">5H</text>`,
    usageKnown ? gauge(g1Bar, fy - 12, gaugeW, 16, state.fiveHourPercent) : gaugeUnknown(g1Bar, fy - 12, gaugeW, 16),
    `<text x="${g1Pct}" y="${fy + 4}" font-family="${MONO}" font-size="16" fill="${INK}">${usageKnown ? `${Math.round(state.fiveHourPercent)}%` : '—'}</text>`,
    // 7D gauge
    `<text x="${col2}" y="${fy + 4}" font-family="${SANS}" font-size="16" font-weight="700" fill="${INK}">7D</text>`,
    usageKnown ? gauge(g2Bar, fy - 12, gaugeW, 16, state.sevenDayPercent) : gaugeUnknown(g2Bar, fy - 12, gaugeW, 16),
    `<text x="${g2Pct}" y="${fy + 4}" font-family="${MONO}" font-size="16" fill="${INK}">${usageKnown ? `${Math.round(state.sevenDayPercent)}%` : '—'}</text>`,
  );
  // tokens + cost + updated stamp (right aligned)
  const totals = `${fmtTokens(state.totalTokens)} tok · $${(state.totalCost || 0).toFixed(2)}`;
  els.push(
    `<text x="${W - pad}" y="${fy + 4}" text-anchor="end" font-family="${MONO}" font-size="16" fill="${INK}">${escXml(totals)}  ·  ${hhmm(now)}</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${els.join('')}</svg>`;
}
