import type { DotDeckSnapshot } from './protocol.js';
import { validDotAppearance, compactDotAppearance, DOT_PHASES, type DotAppearance, type DotSurfaceRelation } from './dot-appearance.js';
import { DOT_INTERACTION_KINDS, DOT_INTERACTION_STAGES } from './dot-interactions.js';
import { DOT_LIMITS } from './dot-rules.js';
import { Ink, UI } from './design-tokens.js';
import { svgFrame, escSvgText } from './svg-renderers/index.js';

/** Reserve a separate first key, retaining room for a session AND NEXT on sparse grids. */
export function dotDeckReservedKeys(dot: DotDeckSnapshot | null | undefined, keys: number, sessions: number): number {
  return dot?.configured === true && keys > 0 && (keys >= 3 || sessions <= keys - 1) ? 1 : 0;
}

export function dotDeckPresentation(dot: DotDeckSnapshot, now = Date.now()): { label: string; color: string } {
  if (!dot.hosting) return { label: 'HOST STOPPED', color: Ink.s300 };
  if (dot.authorized === false) return { label: DOT_PHASES[8], color: Ink.s300 };
  if (!dot.reportState) return { label: DOT_PHASES[0], color: Ink.s300 };
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
  const relation = dot.relation?.evidence === 'dot_report' ? dot.relation : null;
  const edge = relation && DOT_INTERACTION_KINDS.some(k => k === relation.kind) && DOT_INTERACTION_STAGES.some(s => s === relation.stage)
    ? (relation.direction === 'dot_to_agent' ? 'D→?' : '?→D') + ' ' + relation.kind.toUpperCase().slice(0, 8) + ' ' + relation.stage.toUpperCase().replace('NEEDS_ATTENTION', 'ATTN').slice(0, 6) + ' report'
    : dot.reportState ? 'Dot report' : 'No activity shared';
  const portrait = validDotAppearance(dot.appearance) && dot.appearance.png
    ? `<image x="48" y="16" width="48" height="48" href="data:image/png;base64,${dot.appearance.png}"/>`
    : null;
  const svg = svgFrame(Ink.s900, `<circle cx="72" cy="40" r="22" fill="${color}"/><rect x="63" y="34" width="4" height="10" rx="2" fill="${Ink.s900}"/><rect x="77" y="34" width="4" height="10" rx="2" fill="${Ink.s900}"/><text x="72" y="83" text-anchor="middle" fill="${UI.hudText}" font-family="IBM Plex Sans" font-size="18">DOT</text><text x="72" y="105" text-anchor="middle" fill="${color}" font-family="IBM Plex Sans" font-size="12">${escSvgText(label)}</text><text x="72" y="125" text-anchor="middle" fill="${UI.hudText}" font-family="IBM Plex Sans" font-size="10">${escSvgText(edge)}</text>`);
  return portrait ? svg.replace(/<circle cx="72".*?<text x="72" y="83"/, portrait + '<text x="72" y="83"') : svg;
}

/** Relative age budget is computed at the host; compact boards need no wall clock. */
export function dotSurfaceSnapshot(dot: DotDeckSnapshot, appearance: DotAppearance | null = null, relation: DotSurfaceRelation | null = null, now = Date.now()): DotDeckSnapshot {
  const code = DOT_PHASES.indexOf(dotDeckPresentation(dot, now).label as typeof DOT_PHASES[number]);
  const validForMs = code === 2 || code === 3 ? Math.max(0, Math.min(
    DOT_LIMITS.reportFreshMs - (now - (dot.reportedAt ?? 0)),
    (dot.expiresAt ?? (now + DOT_LIMITS.reportFreshMs)) - now,
  )) : 0;
  return { ...dot, code: Math.max(0, code), validForMs, appearance, relation };
}
export function compactDotSnapshot(dot: DotDeckSnapshot | null | undefined): DotDeckSnapshot | null {
  if (!dot?.configured) return null;
  const value = dotSurfaceSnapshot(dot, null, dot.relation ?? null);
  return { ...value, appearance: compactDotAppearance(dot.appearance) };
}
