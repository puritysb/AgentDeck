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
import { agentGlyphMono } from './svg-renderers/agent-logos.js';
import type { SessionInfo, SubscriptionInfo } from './protocol.js';

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

/** Shorten a model id for the description line: "claude-opus-4-8" → "opus-4-8". */
function shortModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/^anthropic\//, '')
    .replace(/-(\d{8})$/, '')
    .replace(/^gpt-/, 'gpt-');
}

/** Compact elapsed time: 12m, 1h04m, 45s. */
function fmtElapsed(secs: number): string {
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m`;
  if (secs >= 60) return `${Math.floor(secs / 60)}m`;
  return `${Math.max(0, secs)}s`;
}

/**
 * Condense a "Verb /long/path/or command" activity into "Verb basename" so the
 * description carries signal, not a full filesystem path that crowds out the
 * model + elapsed. "Edit /a/b/c.ts" → "Edit c.ts"; "Bash cd /x; rm…" → "Bash cd…".
 */
function cleanAction(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const sp = s.indexOf(' ');
  if (sp < 0) return s;
  const verb = s.slice(0, sp);
  const rest = s.slice(sp + 1).trim();
  const firstTok = rest.split(/\s+/)[0] || '';
  if (firstTok.includes('/')) {
    const base = firstTok.split('/').filter(Boolean).pop() || firstTok;
    return `${verb} ${base}`;
  }
  return rest.length > 20 ? `${verb} ${rest.slice(0, 19)}…` : `${verb} ${rest}`;
}

/** One-line "what is this session doing": action · model · elapsed. */
function sessionDescription(sess: SessionInfo, now: Date): string {
  const parts: string[] = [];
  const action = cleanAction((sess.currentTask || sess.currentTool || '').trim());
  if (action) parts.push(action);
  if (sess.modelName) parts.push(shortModel(sess.modelName));
  let elapsed = sess.elapsedSec;
  if ((elapsed == null || elapsed <= 0) && sess.startedAt) {
    const e = Math.round((now.getTime() - Date.parse(sess.startedAt)) / 1000);
    if (Number.isFinite(e) && e > 0) elapsed = e;
  }
  if (elapsed != null && elapsed > 0) parts.push(fmtElapsed(elapsed));
  return parts.join(' · ');
}

/** Short month-day for an expiry: "2026-06-30T..." → "Jun 30". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtShortDate(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Header-right subscription summary: "Claude · ChatGPT Plus → Jun 30". */
function subscriptionSummary(subs: SubscriptionInfo[] | undefined): string {
  if (!subs || subs.length === 0) return '';
  return subs
    .map((s) => {
      const until = fmtShortDate(s.until);
      return until ? `${s.name} → ${until}` : s.name;
    })
    .join('   ·   ');
}

/** Very compact reset countdown for the one-line footer: "3h", "2d", "45m". */
function fmtRemainingShort(resetsAt: string | undefined, now: Date): string {
  if (!resetsAt) return '';
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return '';
  const secs = Math.round((t - now.getTime()) / 1000);
  if (secs <= 0) return 'now';
  if (secs >= 86400) return `${Math.floor(secs / 86400)}d`;
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

/** Column geometry for one session row, derived from the panel width. */
interface RowGeom {
  pad: number;
  iconSize: number;
  textX: number;
  textW: number;
  badgeX: number;
  badgeW: number;
}

/** One session row. `y` is the row's top edge; `geom` is width-derived columns. */
function sessionRow(sess: SessionInfo, y: number, rowH: number, geom: RowGeom, now: Date): string {
  const { pad, iconSize, textX, textW, badgeX, badgeW } = geom;
  const status = statusLabel(sess.state);
  const awaiting = status === 'AWAITING';
  const els: string[] = [];

  // Agent icon (canonical brand mark — robot/cloud/lobster/ring) in place of the
  // wide text tag, freeing room for a description.
  els.push(agentGlyphMono(sess.agentType ?? '', pad + iconSize / 2, y + rowH / 2, iconSize, INK, PAPER));

  // Project name (bold) + a "what is it doing" description line.
  const project = truncatePx(sess.projectName || '(no project)', textW, 24);
  const desc = truncatePx(sessionDescription(sess, now), textW, 15);
  els.push(
    `<text x="${textX}" y="${y + rowH / 2 - 3}" font-family="${SANS}" font-size="24" font-weight="700" fill="${INK}">${escXml(project)}</text>`,
  );
  if (desc) {
    els.push(
      `<text x="${textX}" y="${y + rowH / 2 + 19}" font-family="${MONO}" font-size="15" fill="${INK}">${escXml(desc)}</text>`,
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

  const headerH = 56;
  // Single-line footer (5H + 7D side by side) — frees a whole row of body space.
  const footerTop = H - 52;
  // An AWAITING agent is the single most valuable glance signal on a slow panel,
  // so it gets a full-width inverted banner above the rows.
  const awaitingSessions = sessions.filter((s) => statusLabel(s.state) === 'AWAITING');
  const bannerH = awaitingSessions.length > 0 ? 44 : 0;
  const bodyTop = headerH + 12 + bannerH;
  const rowH = 58;
  const maxRows = Math.floor((footerTop - bodyTop) / rowH);
  const subSummary = subscriptionSummary(state.subscriptions);

  // --- Extreme-aspect / tiny-panel guard ---
  if (maxRows < 1 || W < 320) {
    els.push(
      `<text x="${W / 2}" y="${H / 2 - 6}" text-anchor="middle" font-family="${SANS}" font-size="${Math.min(34, Math.round(W * 0.09))}" font-weight="700" fill="${INK}">AgentDeck</text>`,
      `<text x="${W / 2}" y="${H / 2 + 22}" text-anchor="middle" font-family="${SANS}" font-size="14" font-weight="600" fill="${INK}">${escXml(summary)}</text>`,
    );
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${els.join('')}</svg>`;
  }

  // --- Header: wordmark + subscription/plan summary (with expiry) on the right ---
  els.push(
    `<text x="${pad}" y="38" font-family="${SANS}" font-size="28" font-weight="700" fill="${INK}">AgentDeck</text>`,
    `<text x="${W - pad}" y="38" text-anchor="end" font-family="${SANS}" font-size="16" font-weight="600" fill="${INK}">${escXml(truncatePx(subSummary || summary, W * 0.62, 16))}</text>`,
    `<rect x="${pad}" y="${headerH}" width="${W - 2 * pad}" height="2.5" fill="${INK}"/>`,
  );

  // --- AWAITING banner (highest-priority glance signal) ---
  if (bannerH > 0) {
    const by = headerH + 12;
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
  const iconSize = 36;
  const badgeW = clamp(Math.round(W * 0.17), 108, 168);
  const badgeX = W - pad - badgeW;
  const textX = pad + iconSize + 14;
  const rowGeom: RowGeom = { pad, iconSize, textX, textW: badgeX - textX - 16, badgeX, badgeW };

  if (sessions.length === 0) {
    const cy = (bodyTop + footerTop) / 2;
    els.push(
      `<text x="${W / 2}" y="${cy - 6}" text-anchor="middle" font-family="${SANS}" font-size="28" font-weight="700" fill="${INK}">No active sessions</text>`,
      `<text x="${W / 2}" y="${cy + 30}" text-anchor="middle" font-family="${SANS}" font-size="18" fill="${INK}">Start Claude Code, Codex, or OpenCode to see them here</text>`,
    );
  } else {
    // Reserve the last visible row for an overflow summary when there are extras,
    // so we never half-clip a row.
    const overflow = Math.max(0, sessions.length - maxRows);
    const showRows = overflow > 0 ? maxRows - 1 : maxRows;
    const visible = sessions.slice(0, showRows);
    visible.forEach((sess, i) => {
      const y = bodyTop + i * rowH;
      if (i > 0) {
        els.push(`<rect x="${pad}" y="${y}" width="${W - 2 * pad}" height="1" fill="${INK}"/>`);
      }
      els.push(sessionRow(sess, y, rowH, rowGeom, now));
    });
    if (overflow > 0) {
      const hidden = sessions.slice(showRows);
      const w = hidden.filter((s) => statusLabel(s.state) === 'WORKING').length;
      const a = hidden.filter((s) => statusLabel(s.state) === 'AWAITING').length;
      const idle = hidden.length - w - a;
      const bits = [
        w > 0 ? `${w} working` : '',
        a > 0 ? `${a} awaiting` : '',
        idle > 0 ? `${idle} idle` : '',
      ].filter(Boolean);
      const y = bodyTop + showRows * rowH;
      els.push(`<rect x="${pad}" y="${y}" width="${W - 2 * pad}" height="1" fill="${INK}"/>`);
      els.push(
        `<text x="${pad + iconSize / 2}" y="${y + rowH / 2 + 6}" text-anchor="middle" font-family="${SANS}" font-size="20" font-weight="700" fill="${INK}">+${hidden.length}</text>`,
        `<text x="${textX}" y="${y + rowH / 2 + 6}" font-family="${SANS}" font-size="18" font-weight="600" fill="${INK}">${escXml(`${hidden.length} more${bits.length ? ' · ' + bits.join(' · ') : ''}`)}</text>`,
      );
    }
  }

  // --- Footer: 5H + 7D quota on one line (gauge + % + short reset) ---
  // Actionable numbers only — no token tally or wall clock. Unknown quota draws a
  // hatched "—" rather than a misleading 0%.
  els.push(`<rect x="${pad}" y="${footerTop}" width="${W - 2 * pad}" height="2" fill="${INK}"/>`);
  const usageKnown = state.usageKnown !== false;
  const fy = footerTop + 33;
  const gh = 16;
  const gaugeW = clamp(Math.round(W * 0.14), 80, 150);

  const quotaInline = (x: number, label: string, pct: number, resetsAt: string | undefined): void => {
    const gx = x + 34;
    const px = gx + gaugeW + 8;
    els.push(
      `<text x="${x}" y="${fy}" font-family="${SANS}" font-size="16" font-weight="700" fill="${INK}">${label}</text>`,
      usageKnown ? gauge(gx, fy - 13, gaugeW, gh, pct) : gaugeUnknown(gx, fy - 13, gaugeW, gh),
      `<text x="${px}" y="${fy}" font-family="${MONO}" font-size="16" fill="${INK}">${usageKnown ? `${Math.round(pct)}%` : '—'}</text>`,
    );
    const remaining = usageKnown ? fmtRemainingShort(resetsAt, now) : '';
    if (remaining) {
      els.push(
        `<text x="${px + 52}" y="${fy}" font-family="${SANS}" font-size="14" font-weight="600" fill="${INK}">${escXml(remaining)}</text>`,
      );
    }
  };
  quotaInline(pad, '5H', state.fiveHourPercent, state.fiveHourResetsAt);
  quotaInline(Math.round(W * 0.52), '7D', state.sevenDayPercent, state.sevenDayResetsAt);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${els.join('')}</svg>`;
}
