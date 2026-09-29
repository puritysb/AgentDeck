/**
 * Paper rule: a product-UI colour on a paper / light background keeps its hue
 * and scales each RGB channel by this factor (rounded down), which keeps small
 * text at 4.5:1 against `--ui-popup-bg-light`. DESIGN.md §2.8. Quota severity
 * and session state both derive their paper palettes from this one rule.
 */
export const PAPER_SCALE = 0.5;

export function toPaperColor(hex: string): string {
  return '#' + hex.slice(1).match(/../g)!
    .map((v) => Math.floor(parseInt(v, 16) * PAPER_SCALE).toString(16).padStart(2, '0'))
    .join('');
}
