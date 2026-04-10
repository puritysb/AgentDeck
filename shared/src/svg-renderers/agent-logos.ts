/**
 * Agent logo SVG paths for icon and watermark rendering on session buttons.
 *
 * Each logo is a centered path designed for a 144x144 button canvas.
 * Two rendering modes:
 *   agentLogoIcon()      — prominent icon at top of button (primary identification)
 *   agentLogoWatermark()  — low-opacity background mark
 */

import type { AgentType } from '../adapter.js';
import { dimColor, agentBrandColor } from '../state-colors.js';

/**
 * Claude Code Antigravity robot — official logo from claudecode.svg.
 * viewBox 0 0 24 24. fill-rule: evenodd (eyes are transparent cutouts).
 */
export const CLAUDE_LOGO_PATH =
  'M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z';

/**
 * OpenClaw lobster — official logo paths from openclaw.ai brand assets.
 * Original viewBox 0 0 120 120, rendered at 1:1 inside 144x144 button.
 * Source: Dashboard Icons (CC-BY-4.0)
 */
export const OC_BODY =
  'M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z';
export const OC_CLAW_L =
  'M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z';
export const OC_CLAW_R =
  'M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z';
const OC_ANTENNA_L = 'M45 15 Q35 5 30 8';
const OC_ANTENNA_R = 'M75 15 Q85 5 90 8';

/** Codex CLI knot/clover — official SVG from codex brand assets. viewBox 0 0 24 24. */
export const CODEX_LOGO_PATH =
  'M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388z';

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
): string {
  const brandColor = agentBrandColor(agent);
  // Center icon slightly below top — can overlap with text for compact layout
  const cy = size / 2 + 12;

  if (agent === 'claude-code') {
    const s = size / 24;
    return `<g transform="translate(72,${cy}) scale(${s.toFixed(2)}) translate(-12,-12)" opacity="${opacity}"><path d="${CLAUDE_LOGO_PATH}" fill="${brandColor}" fill-rule="evenodd"/></g>`;
  }
  if (agent === 'codex-cli') {
    const s = size / 24;
    return [
      `<defs><linearGradient id="cx-i" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#B1A7FF"/><stop offset="48%" stop-color="#7A9DFF"/><stop offset="100%" stop-color="${brandColor}"/></linearGradient></defs>`,
      `<g transform="translate(72,${cy}) scale(${s.toFixed(2)}) translate(-12,-12)" opacity="${opacity}"><path d="${CODEX_LOGO_PATH}" fill="url(#cx-i)"/></g>`,
    ].join('');
  }
  if (agent === 'opencode') {
    // Smaller icon for OpenCode (geometric squares are visually heavier)
    const ocSize = Math.round(size * 0.75);
    const half = ocSize / 2;
    const ring = ocSize * 0.18;
    const inner = ocSize * 0.5;
    return [
      `<g opacity="${opacity}">`,
      `<rect x="${72 - half}" y="${cy - half}" width="${ocSize}" height="${ocSize}" rx="4" fill="${dimColor(brandColor, 0.3)}"/>`,
      `<rect x="${72 - half + ring}" y="${cy - half + ring}" width="${ocSize - ring * 2}" height="${ocSize - ring * 2}" rx="2" fill="${dimColor('#4B4646', 0.2)}"/>`,
      `<rect x="${72 - inner / 2}" y="${cy - inner / 2}" width="${inner}" height="${inner}" rx="2" fill="${dimColor('#4B4646', 0.2)}"/>`,
      `</g>`,
    ].join('');
  }
  // OpenClaw lobster
  const ocScale = size / 120;
  return [
    `<defs><linearGradient id="oc-i" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${brandColor}"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs>`,
    `<g transform="translate(${72 - 60 * ocScale},${cy - 60 * ocScale}) scale(${ocScale.toFixed(3)})" opacity="${opacity}">`,
    `<path d="${OC_BODY}" fill="url(#oc-i)"/>`,
    `<path d="${OC_CLAW_L}" fill="url(#oc-i)"/>`,
    `<path d="${OC_CLAW_R}" fill="url(#oc-i)"/>`,
    `<path d="${OC_ANTENNA_L}" stroke="${brandColor}" stroke-width="3" stroke-linecap="round" fill="none"/>`,
    `<path d="${OC_ANTENNA_R}" stroke="${brandColor}" stroke-width="3" stroke-linecap="round" fill="none"/>`,
    `<circle cx="45" cy="35" r="6" fill="#0a0a14"/>`,
    `<circle cx="75" cy="35" r="6" fill="#0a0a14"/>`,
    `<circle cx="46" cy="34" r="2.5" fill="#00e5cc" opacity="0.7"/>`,
    `<circle cx="76" cy="34" r="2.5" fill="#00e5cc" opacity="0.7"/>`,
    `</g>`,
  ].join('');
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
    return `<g transform="translate(72,72) scale(3) translate(-12,-12)" opacity="${markOpacity}"><path d="${CLAUDE_LOGO_PATH}" fill="${fill}" fill-rule="evenodd"/></g>`;
  }
  if (agent === 'codex-cli') {
    return [
      `<defs><linearGradient id="cx-g" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="${dimColor('#B1A7FF', 0.5)}"/><stop offset="48%" stop-color="${dimColor('#7A9DFF', 0.5)}"/><stop offset="100%" stop-color="${dimColor('#3941FF', 0.5)}"/></linearGradient></defs>`,
      `<g transform="translate(72,72) scale(3) translate(-12,-12)" opacity="${markOpacity}"><path d="${CODEX_LOGO_PATH}" fill="url(#cx-g)"/></g>`,
    ].join('');
  }
  if (agent === 'opencode') {
    const s = 72;
    const half = s / 2;
    const ring = s * 0.18;
    const inner = s * 0.5;
    return [
      `<g opacity="${markOpacity}">`,
      `<rect x="${72 - half}" y="${72 - half}" width="${s}" height="${s}" fill="${dimColor('#F1ECEC', 0.6)}"/>`,
      `<rect x="${72 - half + ring}" y="${72 - half + ring}" width="${s - ring * 2}" height="${s - ring * 2}" fill="${dimColor('#4B4646', 0.5)}"/>`,
      `<rect x="${72 - inner / 2}" y="${72 - inner / 2}" width="${inner}" height="${inner}" fill="${dimColor('#4B4646', 0.5)}"/>`,
      `</g>`,
    ].join('');
  }
  // OpenClaw lobster
  const ocFill1 = dimColor('#ff4d4d', 0.4);
  const ocFill2 = dimColor('#991b1b', 0.4);
  return [
    `<defs><linearGradient id="oc-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${ocFill1}"/><stop offset="100%" stop-color="${ocFill2}"/></linearGradient></defs>`,
    `<g transform="translate(36,36) scale(0.6)" opacity="${markOpacity}">`,
    `<path d="${OC_BODY}" fill="url(#oc-g)"/>`,
    `<path d="${OC_CLAW_L}" fill="url(#oc-g)"/>`,
    `<path d="${OC_CLAW_R}" fill="url(#oc-g)"/>`,
    `<path d="${OC_ANTENNA_L}" stroke="${ocFill1}" stroke-width="3" stroke-linecap="round" fill="none"/>`,
    `<path d="${OC_ANTENNA_R}" stroke="${ocFill1}" stroke-width="3" stroke-linecap="round" fill="none"/>`,
    `<circle cx="45" cy="35" r="6" fill="#0a0a14"/>`,
    `<circle cx="75" cy="35" r="6" fill="#0a0a14"/>`,
    `<circle cx="46" cy="34" r="2.5" fill="${dimColor('#00e5cc', 0.3)}"/>`,
    `<circle cx="76" cy="34" r="2.5" fill="${dimColor('#00e5cc', 0.3)}"/>`,
    `</g>`,
  ].join('');
}
