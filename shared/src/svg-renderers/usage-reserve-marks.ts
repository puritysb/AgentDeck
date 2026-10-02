// SVG fragments shared by the Codex fallback readings that replace an
// exhausted plan window — the Luna reserve and the purchased-credit balance.
// The Stream Deck keypad/encoder (plugin/src/renderers/usage-gauge.ts) and the
// D200H/Ulanzi tiles (shared/src/d200h-layout.ts) both draw them, so the text
// geometry lives here once instead of drifting per surface.

/**
 * "68% LEFT" with the unit word set smaller than the number. At one size the
 * worst case "100% LEFT" is ~150px of bold Arial at 28px — wider than a 144px
 * key, and past the right edge of the 200px encoder LCD from its x=72 anchor —
 * so the trailing "T" clipped. The number stays the headline; LEFT is a label.
 */
export function remainingPercentSvgText(opts: {
  x: number;
  y: number;
  size: number;
  fill: string;
  remaining: number;
  anchor?: 'start' | 'middle';
}): string {
  const anchor = opts.anchor ?? 'middle';
  const unit = Math.round(opts.size * 0.5);
  return `<text x="${opts.x}" y="${opts.y}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${opts.size}" font-weight="bold" fill="${opts.fill}">`
    + `${Math.round(opts.remaining)}%<tspan font-size="${unit}" dx="${Math.max(2, Math.round(unit * 0.25))}">LEFT</tspan></text>`;
}

/** A short stack of coins: the focal mark of the purchased-credit reading,
 *  drawn in the same box and position the Luna crescent uses so the two states
 *  read as peers. (A single ringed coin with a bar read as a power button.) */
export function creditCoinSvg(cx: number, cy: number, radius: number, fill: string, bg: string): string {
  const rx = radius;
  const ry = Math.max(3, Math.round(radius * 0.36));
  const step = Math.max(3, Math.round(radius * 0.42));
  const stroke = Math.max(1.5, Math.round(radius * 0.1 * 2) / 2);
  // Centre the whole stack (three faces plus the last rim) on cy.
  const bottom = cy + Math.round(step / 2);
  let out = '';
  for (let i = 0; i < 3; i++) {
    const y = bottom - i * step;
    // Each coin: its rim (a rect joining the faces) and its top face.
    out += `<rect x="${cx - rx}" y="${y}" width="${rx * 2}" height="${step}" fill="${fill}"/>`
      + `<ellipse cx="${cx}" cy="${y + step}" rx="${rx}" ry="${ry}" fill="${fill}"/>`
      + `<ellipse cx="${cx}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${bg}" stroke-width="${stroke}"/>`;
  }
  const top = bottom - 2 * step;
  return out + `<ellipse cx="${cx}" cy="${top}" rx="${Math.round(rx * 0.62)}" ry="${Math.max(1.5, Math.round(ry * 0.55))}" fill="none" stroke="${bg}" stroke-width="${stroke}"/>`;
}
