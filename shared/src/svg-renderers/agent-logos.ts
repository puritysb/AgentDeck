/**
 * Agent creature SVG fragments for session buttons.
 *
 * The exported names are kept for plugin compatibility, but the rendered
 * marks are the same AgentDeck creature language used by the terrarium:
 * Claude = robot, Codex = cloud prompt, OpenClaw = crayfish, OpenCode =
 * nested-square floater, Antigravity = peak/arc mark.
 */

import type { AgentType } from '../adapter.js';
import { dimColor, agentBrandColor } from '../state-colors.js';

// Claude Code creature = the rusty robot (design/brand/claudecode.svg): blocky
// head with two eye holes. Exported so 1-bit surfaces (TRMNL e-ink) render the
// canonical mark rather than a drifted approximation.
export const ROBOT_CREATURE_PATH =
  'M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z';

/** OpenCode mark (design/brand/opencode.svg): hollow nested-square ring. */
export const OPENCODE_RING_PATH = 'M16 6H8v12h8V6zm4 16H4V2h16v20z';

/** Antigravity mark (design/brand/antigravity.svg): peak/arc. */
export const ANTIGRAVITY_PATH =
  'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z';

/** Kiro ghost (design/brand/kiro.svg): upstream Lobe Icons MIT mark. */
export const KIRO_GHOST_PATH =
  'M4.594 6.677C6.67-2.226 18.746-2.211 21.16 6.632c.353 1.297 1.725 7.582-1.673 13.747-1.545 2.797-5.841 5.49-6.99 1.883C8.6 25.477 3.315 24.1 5.789 18.609l-.318.143c-3.57 1.305-3.863-1.208-3.173-2.513.45-.84.727-1.335.937-1.897.353-.975.458-1.568.593-2.498.27-1.837.277-3.607.765-5.167zm8.37.01a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.214-.705 1.214-1.89 0-.622-.127-1.125-.367-1.455a1.014 1.014 0 00-.855-.435zm4.08 0a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.215-.705 1.215-1.89 0-.622-.128-1.125-.368-1.455a1.014 1.014 0 00-.855-.435z';

/** Claude Code mark (design/brand/claudecode.svg). Compatibility alias. */
export const CLAUDE_LOGO_PATH = ROBOT_CREATURE_PATH;

/** Codex CLI knot/clover — official SVG from codex brand assets. viewBox 0 0 24 24. */
export const CODEX_LOGO_PATH =
  'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z';

/** OpenClaw mark (design/brand/openclaw.svg). viewBox 0 0 24 24. */
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

function gradientPathIcon(path: string, size: number, opacity: number, cx: number, cy: number): string {
  const s = size / 24;
  const idSuffix = `${Math.round(size)}-${Math.round(cx * 10)}-${Math.round(cy * 10)}`.replace(/-/g, '_');
  const gradId = `antigravity_rainbow_${idSuffix}`;
  const warmId = `antigravity_warm_${idSuffix}`;
  const greenId = `antigravity_green_${idSuffix}`;
  const purpleId = `antigravity_purple_${idSuffix}`;
  return [
    `<g transform="translate(${cx},${cy}) scale(${s.toFixed(3)}) translate(-12,-12)" opacity="${opacity}">`,
    `<defs>`,
    `<linearGradient id="${gradId}" x1="12" y1="1" x2="12" y2="23" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0%" stop-color="#FF8A18"/>`,
    `<stop offset="24%" stop-color="#FF4F47"/>`,
    `<stop offset="52%" stop-color="#28BDF3"/>`,
    `<stop offset="100%" stop-color="#247CFF"/>`,
    `</linearGradient>`,
    `<radialGradient id="${warmId}" cx="9" cy="2" r="9" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0%" stop-color="#F3D233"/>`,
    `<stop offset="58%" stop-color="#FF8A18" stop-opacity="0.74"/>`,
    `<stop offset="100%" stop-color="#FF8A18" stop-opacity="0"/>`,
    `</radialGradient>`,
    `<radialGradient id="${greenId}" cx="4" cy="10" r="8" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0%" stop-color="#2FD66D"/>`,
    `<stop offset="72%" stop-color="#2FD66D" stop-opacity="0.58"/>`,
    `<stop offset="100%" stop-color="#2FD66D" stop-opacity="0"/>`,
    `</radialGradient>`,
    `<radialGradient id="${purpleId}" cx="20" cy="9" r="9" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0%" stop-color="#A85CC8"/>`,
    `<stop offset="70%" stop-color="#A85CC8" stop-opacity="0.58"/>`,
    `<stop offset="100%" stop-color="#A85CC8" stop-opacity="0"/>`,
    `</radialGradient>`,
    `</defs>`,
    `<path d="${path}" fill="url(#${gradId})" fill-rule="evenodd" clip-rule="evenodd"/>`,
    `<path d="${path}" fill="url(#${warmId})" fill-rule="evenodd" clip-rule="evenodd"/>`,
    `<path d="${path}" fill="url(#${greenId})" fill-rule="evenodd" clip-rule="evenodd"/>`,
    `<path d="${path}" fill="url(#${purpleId})" fill-rule="evenodd" clip-rule="evenodd"/>`,
    `</g>`,
  ].join('');
}

function robotCreatureIcon(fill: string, size: number, opacity: number, cx: number, cy: number): string {
  return officialPathIcon(ROBOT_CREATURE_PATH, fill, size, opacity, cx, cy);
}

function codexCloudCreatureIcon(size: number, opacity: number, cx: number, cy: number): string {
  const idSuffix = `${Math.round(size)}-${Math.round(cx * 10)}-${Math.round(cy * 10)}`.replace(/-/g, '_');
  const gradId = `codex_cloud_${idSuffix}`;
  const s = (size * 0.82) / 24;
  return [
    `<defs>`,
    `<linearGradient id="${gradId}" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0%" stop-color="#D9D3FF"/>`,
    `<stop offset="48%" stop-color="#8BA4FF"/>`,
    `<stop offset="100%" stop-color="#3941FF"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<g transform="translate(${cx},${cy}) scale(${s.toFixed(3)}) translate(-12,-12)" opacity="${opacity}">`,
    `<path d="${CODEX_LOGO_PATH}" fill="url(#${gradId})" fill-rule="evenodd" clip-rule="evenodd"/>`,
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

function antigravityCreatureIcon(size: number, opacity: number, cx: number, cy: number): string {
  return gradientPathIcon(ANTIGRAVITY_PATH, size * 0.76, opacity, cx, cy);
}

function kiroCreatureIcon(fill: string, size: number, opacity: number, cx: number, cy: number): string {
  return officialPathIcon(KIRO_GHOST_PATH, fill, size * 0.84, opacity, cx, cy);
}

// ===== 1-bit monochrome glyph (e-ink / TRMNL) =====

/** Canonical brand-path glyph per agent, plus optional white "eye" cutouts that
 * aren't part of the fill path (openClaw). Faithful to the design/brand marks
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
  antigravity: { paths: [ANTIGRAVITY_PATH] },
  'kiro-cli': { paths: [KIRO_GHOST_PATH] },
  'kiro-ide': { paths: [KIRO_GHOST_PATH] },
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
  const agentClass = (agent || '').toLowerCase();
  const out: string[] = [`<g class="agent-mono-glyph-${agentClass}" transform="translate(${cx.toFixed(2)},${cy.toFixed(2)}) scale(${s.toFixed(4)}) translate(-12,-12)">`];
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
  if (agent === 'antigravity') {
    return antigravityCreatureIcon(size, opacity, cx, cy);
  }
  if (agent === 'kiro-cli' || agent === 'kiro-ide') {
    return kiroCreatureIcon(brandColor, size, opacity, cx, cy);
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
  if (agent === 'antigravity') {
    return antigravityCreatureIcon(72, markOpacity, 72, 72);
  }
  if (agent === 'kiro-cli' || agent === 'kiro-ide') {
    return kiroCreatureIcon(fill, 72, markOpacity, 72, 72);
  }
  return openClawCreatureIcon(72, markOpacity, 72, 72);
}
