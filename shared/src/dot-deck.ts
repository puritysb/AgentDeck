import type { DotDeckSnapshot } from './protocol.js';
import { DOT_LIMITS } from './dot-rules.js';
import { Ink, UI } from './design-tokens.js';
import { svgFrame, escSvgText } from './svg-renderers/index.js';

/** Reserve a separate first key, retaining room for a session AND NEXT on sparse grids. */
export function dotDeckReservedKeys(dot: DotDeckSnapshot | null | undefined, keys: number, sessions: number): number {
  return dot?.configured === true && keys > 0 && (keys >= 3 || sessions <= keys - 1) ? 1 : 0;
}

export function dotDeckPresentation(dot: DotDeckSnapshot, now = Date.now()): { label: string; color: string } {
  if (!dot.hosting) return { label: 'HOST STOPPED', color: Ink.s300 };
  if (!dot.reportState) return { label: 'NO REPORT', color: Ink.s300 };
  if (dot.reportedAt === null || !Number.isSafeInteger(dot.reportedAt) || dot.reportedAt > now || dot.reportedAt < 0) return { label: 'UNKNOWN', color: Ink.s300 };
  if (dot.reportState === 'stale') return { label: 'OLD REPORT', color: Ink.s300 };
  if (dot.reportState === 'completed') return { label: 'COMPLETED', color: UI.ok };
  if (dot.reportState === 'failed') return { label: 'FAILED', color: UI.error };
  if ((dot.expiresAt !== null && dot.expiresAt <= now) || now - dot.reportedAt >= DOT_LIMITS.reportFreshMs) return { label: 'OLD REPORT', color: Ink.s300 };
  if (dot.reportState === 'working') return { label: 'WORKING', color: UI.cyan };
  if (dot.reportState === 'needs_attention') return { label: 'NEEDS YOU', color: UI.attn };
  return { label: 'UNKNOWN', color: Ink.s300 };
}

/** Deterministic, inert original orb; no provider/session impersonation or animation lease. */
export function renderDotDeckSlot(dot: DotDeckSnapshot, now = Date.now()): string {
  const { label, color } = dotDeckPresentation(dot, now);
  return svgFrame(Ink.s900, `<circle cx="72" cy="40" r="22" fill="${color}"/><rect x="63" y="34" width="4" height="10" rx="2" fill="${Ink.s900}"/><rect x="77" y="34" width="4" height="10" rx="2" fill="${Ink.s900}"/><text x="72" y="83" text-anchor="middle" fill="${UI.hudText}" font-family="IBM Plex Sans" font-size="18">DOT</text><text x="72" y="105" text-anchor="middle" fill="${color}" font-family="IBM Plex Sans" font-size="12">${escSvgText(label)}</text><text x="72" y="125" text-anchor="middle" fill="${UI.hudText}" font-family="IBM Plex Sans" font-size="10">${dot.reportState ? 'Dot report' : 'Integration'}</text>`);
}
