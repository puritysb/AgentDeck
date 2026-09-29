import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { usageSeverity, usageColor, USAGE_SEVERITY, USAGE_COLORS, USAGE_PAPER_COLORS, USAGE_INACTIVE_COLORS } from '../usage-severity.js';
import { UI } from '../design-tokens.js';
// @ts-expect-error executable generator has no TypeScript declaration
import { outputs } from '../../../scripts/generate-usage-severity.mjs';

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe('quota severity across dashboards', () => {
  it.each([[0, 'normal'], [69.9, 'normal'], [70, 'warning'], [82, 'warning'], [89.9, 'warning'], [90, 'critical'], [100, 'critical'], [101, 'critical']] as const)('classifies %s%% consumed as %s', (used, severity) => {
    expect(usageSeverity(used)).toBe(severity);
  });
  it.each([undefined, null, -1, NaN, Infinity])('does not portray unknown %s as healthy zero', used => {
    expect(usageSeverity(used)).toBe('unknown');
    expect(usageColor(used, { inactive: true })).toBe(UI.idleDark);
  });
  it('keeps remaining and consumed readings equivalent, with freshness first', () => {
    expect(usageColor(100 - 18)).toBe(UI.attn);
    expect(usageColor(100 - 10)).toBe(UI.error);
    expect(usageColor(98, { inactive: true })).toBe(UI.cyan);
    expect(usageColor(98, { inactive: true, muted: true })).toBe(UI.idleDark);
  });
  it('keeps small percentage text legible on dark screens and paper', () => {
    for (const c of Object.values(USAGE_COLORS)) expect(contrast(c, UI.popupBgDark)).toBeGreaterThanOrEqual(4.5);
    for (const c of Object.values(USAGE_PAPER_COLORS)) expect(contrast(c, UI.popupBgLight)).toBeGreaterThanOrEqual(4.5);
  });
  it('generates every native palette and boundary from the source', () => {
    for (const [target, emit] of outputs) expect(readFileSync(new URL(`../../../${target}`, import.meta.url), 'utf8')).toBe(emit(USAGE_SEVERITY, USAGE_COLORS, USAGE_PAPER_COLORS, USAGE_INACTIVE_COLORS));
  });
});
