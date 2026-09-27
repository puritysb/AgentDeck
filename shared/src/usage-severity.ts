import { UI } from './design-tokens.js';
import { PAPER_SCALE, toPaperColor } from './paper-palette.js';

/** Display severity always consumes USED percent, even for a "% left" label.
 * Missing/non-finite/negative readings are unknown, never healthy zero. */
export const USAGE_SEVERITY = { warning: 70, critical: 90, paperScale: PAPER_SCALE } as const;
export type UsageSeverity = 'unknown' | 'normal' | 'warning' | 'critical';
export function usageSeverity(used: number | null | undefined): UsageSeverity {
  if (used == null || !Number.isFinite(used) || used < 0) return 'unknown';
  if (used >= USAGE_SEVERITY.critical) return 'critical';
  if (used >= USAGE_SEVERITY.warning) return 'warning';
  return 'normal';
}
const darken = toPaperColor;
export const USAGE_COLORS = { normal: UI.ok, warning: UI.attn, critical: UI.error, unknown: UI.idleDark } as const;
export const USAGE_PAPER_COLORS = Object.fromEntries(Object.entries(USAGE_COLORS).map(([k, v]) => [k, darken(v)])) as Record<UsageSeverity, string>;
export const USAGE_INACTIVE_COLORS = { bright: UI.cyan, paper: darken(UI.cyan) } as const;
export function usageColor(used: number | null | undefined, options: { muted?: boolean; inactive?: boolean; paper?: boolean } = {}): string {
  const severity = options.muted ? 'unknown' : usageSeverity(used);
  if (severity !== 'unknown' && options.inactive) return options.paper ? USAGE_INACTIVE_COLORS.paper : USAGE_INACTIVE_COLORS.bright;
  return (options.paper ? USAGE_PAPER_COLORS : USAGE_COLORS)[severity];
}
/** Hardware palettes use the exact same RGB values, without per-pixel parsing. */
export function usageRgb(used: number | null | undefined): [number, number, number] {
  const value = parseInt(usageColor(used).slice(1), 16);
  return [(value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}
