/**
 * Agent creature SVG fragments for session buttons.
 *
 * The exported names are kept for plugin compatibility, but the rendered
 * marks are the same AgentDeck creature language used by the terrarium:
 * Claude = robot, Codex = cloud prompt, OpenClaw = crayfish, OpenCode =
 * nested-square floater.
 */

import type { AgentType } from '../adapter.js';
import { dimColor, agentBrandColor } from '../state-colors.js';

// Claude Code creature = the rusty robot (design/brand/claudecode.svg): blocky
// head with two eye holes. Exported so 1-bit surfaces (TRMNL e-ink) render the
// canonical mark rather than a drifted approximation.
export const ROBOT_CREATURE_PATH =
  'M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0v-3.1h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z';

/** OpenCode mark (design/brand/opencode.svg): hollow nested-square ring. */
export const OPENCODE_RING_PATH = 'M16 6H8v12h8V6zm4 16H4V2h16v20z';

/** Claude Code creature asset: assets/logos/claude.svg. viewBox 0 0 24 24. */
export const CLAUDE_LOGO_PATH =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

/** Legacy OpenClaw paths kept for the Gateway preset mini-browser icon. */
export const OC_BODY =
  'M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z';
export const OC_CLAW_L =
  'M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z';
export const OC_CLAW_R =
  'M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z';

/** Codex CLI knot/clover — official SVG from codex brand assets. viewBox 0 0 24 24. */
export const CODEX_LOGO_PATH =
  'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z';

/** OpenClaw creature asset: assets/logos/openclaw.svg. viewBox 0 0 24 24. */
export const OPENCLAW_LOGO_PATHS = [
  'M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z',
  'M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z',
  'M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z',
  'M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z',
  'M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z',
];
const OPENCLAW_BODY_PATHS = OPENCLAW_LOGO_PATHS.slice(2);

function officialPathIcon(path: string, fill: string, size: number, opacity: number, cx: number, cy: number): string {
  const s = size / 24;
  return `<g transform="translate(${cx},${cy}) scale(${s.toFixed(3)}) translate(-12,-12)" opacity="${opacity}"><path d="${path}" fill="${fill}" fill-rule="evenodd" clip-rule="evenodd"/></g>`;
}

function robotCreatureIcon(fill: string, size: number, opacity: number, cx: number, cy: number): string {
  return officialPathIcon(ROBOT_CREATURE_PATH, fill, size, opacity, cx, cy);
}

function codexCloudCreatureIcon(size: number, opacity: number, cx: number, cy: number): string {
  const body = size * 0.78;
  const half = body / 2;
  const idSuffix = `${Math.round(size)}-${Math.round(cx * 10)}-${Math.round(cy * 10)}`.replace(/-/g, '_');
  const gradId = `codex_cloud_${idSuffix}`;
  const glowId = `codex_cloud_glow_${idSuffix}`;
  const lobes = [
    [-0.14, -0.30, 0.30],
    [0.16, -0.26, 0.28],
    [0.32, -0.02, 0.28],
    [0.14, 0.26, 0.28],
    [-0.16, 0.26, 0.28],
    [-0.32, -0.02, 0.28],
  ];
  const lobeEls = lobes.map(([dx, dy, r]) => {
    const lcx = cx + dx * body;
    const lcy = cy + dy * body;
    const lr = r * body;
    return `<circle cx="${lcx.toFixed(2)}" cy="${lcy.toFixed(2)}" r="${lr.toFixed(2)}" fill="url(#${gradId})"/>`;
  }).join('');
  const glowEls = lobes.map(([dx, dy, r]) => {
    const lcx = cx + dx * body;
    const lcy = cy + dy * body;
    const lr = r * body * 1.06;
    return `<circle cx="${lcx.toFixed(2)}" cy="${lcy.toFixed(2)}" r="${lr.toFixed(2)}" fill="#BFD7FF"/>`;
  }).join('');
  return [
    `<g opacity="${opacity}">`,
    `<defs>`,
    `<linearGradient id="${gradId}" x1="${cx}" y1="${cy - half}" x2="${cx}" y2="${cy + half}" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0%" stop-color="#D9D3FF"/>`,
    `<stop offset="48%" stop-color="#8BA4FF"/>`,
    `<stop offset="100%" stop-color="#3941FF"/>`,
    `</linearGradient>`,
    `<filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.max(1.4, size * 0.04).toFixed(1)}"/></filter>`,
    `</defs>`,
    `<g opacity="0.30" filter="url(#${glowId})">${glowEls}</g>`,
    `<g>${lobeEls}</g>`,
    `<path d="M${(cx - body * 0.17).toFixed(1)} ${(cy - body * 0.11).toFixed(1)} L${(cx + body * 0.05).toFixed(1)} ${cy.toFixed(1)} L${(cx - body * 0.17).toFixed(1)} ${(cy + body * 0.11).toFixed(1)}" fill="none" stroke="#FFFFFF" stroke-width="${Math.max(2, body * 0.075).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<line x1="${(cx + body * 0.16).toFixed(1)}" y1="${(cy + body * 0.11).toFixed(1)}" x2="${(cx + body * 0.34).toFixed(1)}" y2="${(cy + body * 0.11).toFixed(1)}" stroke="#FFFFFF" stroke-width="${Math.max(2, body * 0.075).toFixed(1)}" stroke-linecap="round"/>`,
    `</g>`,
  ].join('');
}

function openClawCreatureIcon(size: number, opacity: number, cx: number, cy: number): string {
  const bodySize = size * 0.92;
  const s = bodySize / 24;
  const idSuffix = `${Math.round(size)}-${Math.round(cx * 10)}-${Math.round(cy * 10)}`.replace(/-/g, '_');
  const gradId = `openclaw_shell_${idSuffix}`;
  return [
    `<g transform="translate(${cx},${cy}) scale(${s.toFixed(3)}) translate(-12,-12)" opacity="${opacity}">`,
    `<defs>`,
    `<linearGradient id="${gradId}" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0%" stop-color="#FF6B6B"/>`,
    `<stop offset="100%" stop-color="#991B1B"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<g fill="url(#${gradId})" fill-rule="evenodd" clip-rule="evenodd">`,
    ...OPENCLAW_BODY_PATHS.map((p) => `<path d="${p}"/>`),
    `</g>`,
    `<circle cx="8.835" cy="7.843" r="1.266" fill="#050810"/>`,
    `<circle cx="15.165" cy="7.843" r="1.266" fill="#050810"/>`,
    `<circle cx="9.046" cy="7.632" r="0.527" fill="#00E5CC" opacity="0.9"/>`,
    `<circle cx="15.376" cy="7.632" r="0.527" fill="#00E5CC" opacity="0.9"/>`,
    `</g>`,
  ].join('');
}

function openCodeCreatureIcon(size: number, opacity: number, cx: number, cy: number): string {
  // Canonical opencode mark (opencode.svg, viewBox 24, evenodd): a single-color vertical
  // rectangular RING with a HOLLOW center — not filled nested squares. Map so the mark
  // (16×20) sits centered on (cx,cy) at ~0.6×size tall.
  const s = (size * 0.72) / 24;
  const tx = cx - 12 * s;
  const ty = cy - 12 * s;
  return [
    `<g opacity="${opacity}" transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">`,
    `<path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" fill-rule="evenodd" fill="#F1ECEC"/>`,
    `</g>`,
  ].join('');
}

// ===== 1-bit monochrome glyph (e-ink / TRMNL) =====

/** Canonical brand-path glyph per agent, plus optional white "eye" cutouts that
 * aren't part of the fill path (openClaw). Faithful to the assets/logos creatures
 * (robot / cloud-prompt / lobster / ring) so 1-bit surfaces don't drift. */
interface MonoGlyph {
  paths: string[];
  eyes?: Array<[number, number, number]>; // cx, cy, r in the 24-unit viewBox
}
const AGENT_MONO_GLYPH: Record<string, MonoGlyph> = {
  'claude-code': { paths: [ROBOT_CREATURE_PATH] },
  'codex-cli': { paths: [CODEX_LOGO_PATH] },
  'codex-app': { paths: [CODEX_LOGO_PATH] },
  codex: { paths: [CODEX_LOGO_PATH] },
  opencode: { paths: [OPENCODE_RING_PATH] },
  openclaw: { paths: OPENCLAW_BODY_PATHS, eyes: [[8.835, 7.843, 1.05], [15.165, 7.843, 1.05]] },
};

/**
 * Render the agent's canonical brand mark as a 1-bit glyph: the path(s) filled
 * with `ink` (evenodd so in-path holes — robot eyes, opencode ring, codex prompt —
 * read as paper), plus any separate `paper` eye cutouts. 24-unit viewBox scaled to
 * `size`, centered on (cx,cy). Used by the TRMNL e-ink layout; mirrored in Swift.
 */
export function agentGlyphMono(
  agent: string,
  cx: number,
  cy: number,
  size: number,
  ink: string,
  paper: string,
): string {
  const g = AGENT_MONO_GLYPH[(agent || '').toLowerCase()] ?? AGENT_MONO_GLYPH.openclaw;
  const s = size / 24;
  const out: string[] = [`<g transform="translate(${cx.toFixed(2)},${cy.toFixed(2)}) scale(${s.toFixed(4)}) translate(-12,-12)">`];
  for (const p of g.paths) out.push(`<path d="${p}" fill="${ink}" fill-rule="evenodd"/>`);
  if (g.eyes) for (const [ex, ey, er] of g.eyes) out.push(`<circle cx="${ex}" cy="${ey}" r="${er}" fill="${paper}"/>`);
  out.push('</g>');
  return out.join('');
}

// ===== Prominent agent icon (top of button, primary identification) =====

/**
 * Render agent logo as a visible icon at top-center of button.
 * Uses agent brand color (not state color) for consistent identification.
 * @param agent Agent type
 * @param size Target size in px (default 48)
 * @param opacity Icon opacity (default 0.7)
 */
export function agentLogoIcon(
  agent: AgentType,
  size = 48,
  opacity = 0.7,
  cx = 72,
  cy = size / 2 + 12
): string {
  const brandColor = agentBrandColor(agent);

  if (agent === 'claude-code') {
    return robotCreatureIcon(brandColor, size, opacity, cx, cy);
  }
  if (agent === 'codex-cli' || agent === 'codex-app') {
    return codexCloudCreatureIcon(size, opacity, cx, cy);
  }
  if (agent === 'opencode') {
    return openCodeCreatureIcon(size, opacity, cx, cy);
  }
  return openClawCreatureIcon(size, opacity, cx, cy);
}

// ===== Low-opacity watermark (background mark) =====

/**
 * Render agent logo as a background watermark.
 * Uses brand color dimmed for subtle identification.
 */
export function agentLogoWatermark(
  agent: AgentType,
  _color?: string,
  opacity = 0.12,
): string {
  const brandColor = agentBrandColor(agent);
  const markOpacity = Math.min(opacity * 4, 0.9);
  const fill = dimColor(brandColor, 0.5);

  if (agent === 'claude-code') {
    return robotCreatureIcon(fill, 72, markOpacity, 72, 72);
  }
  if (agent === 'codex-cli' || agent === 'codex-app') {
    return codexCloudCreatureIcon(72, markOpacity, 72, 72);
  }
  if (agent === 'opencode') {
    return openCodeCreatureIcon(72, markOpacity, 72, 72);
  }
  return openClawCreatureIcon(72, markOpacity, 72, 72);
}
