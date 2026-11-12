/**
 * Pixoo64 Bitmap Font — 3×5 pixel font for 64×64 LED matrix.
 *
 * Supports ASCII uppercase A-Z, digits 0-9, and basic symbols.
 * At 3px + 1px gap per character, a 64px line fits ~16 characters.
 */

// 3×5 bitmap font data. Each glyph is 5 rows of 3 bits (MSB left).
// Format: [row0, row1, row2, row3, row4] where each row is 0b___ (3 bits)
const GLYPHS: Record<string, number[]> = {
  'A': [0b010, 0b101, 0b111, 0b101, 0b101],
  'B': [0b110, 0b101, 0b110, 0b101, 0b110],
  'C': [0b011, 0b100, 0b100, 0b100, 0b011],
  'D': [0b110, 0b101, 0b101, 0b101, 0b110],
  'E': [0b111, 0b100, 0b110, 0b100, 0b111],
  'F': [0b111, 0b100, 0b110, 0b100, 0b100],
  'G': [0b011, 0b100, 0b101, 0b101, 0b011],
  'H': [0b101, 0b101, 0b111, 0b101, 0b101],
  'I': [0b111, 0b010, 0b010, 0b010, 0b111],
  'J': [0b001, 0b001, 0b001, 0b101, 0b010],
  'K': [0b101, 0b110, 0b100, 0b110, 0b101],
  'L': [0b100, 0b100, 0b100, 0b100, 0b111],
  'M': [0b101, 0b111, 0b111, 0b101, 0b101],
  // A diagonal, not the old M-shaped double-join. At 3px wide the fully
  // connected form makes N byte-identical to M and reads as a smudged block.
  'N': [0b101, 0b110, 0b101, 0b011, 0b101],
  'O': [0b010, 0b101, 0b101, 0b101, 0b010],
  'P': [0b110, 0b101, 0b110, 0b100, 0b100],
  'Q': [0b010, 0b101, 0b101, 0b110, 0b011],
  'R': [0b110, 0b101, 0b110, 0b101, 0b101],
  'S': [0b011, 0b100, 0b010, 0b001, 0b110],
  'T': [0b111, 0b010, 0b010, 0b010, 0b010],
  'U': [0b101, 0b101, 0b101, 0b101, 0b010],
  'V': [0b101, 0b101, 0b101, 0b010, 0b010],
  // One low bar, not two rows: at 3 px the old W read as H ("HORK", "HAIT").
  'W': [0b101, 0b101, 0b101, 0b111, 0b101],
  'X': [0b101, 0b101, 0b010, 0b101, 0b101],
  'Y': [0b101, 0b101, 0b010, 0b010, 0b010],
  'Z': [0b111, 0b001, 0b010, 0b100, 0b111],
  '0': [0b010, 0b101, 0b101, 0b101, 0b010],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b110, 0b001, 0b010, 0b100, 0b111],
  '3': [0b110, 0b001, 0b010, 0b001, 0b110],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b110, 0b001, 0b110],
  '6': [0b011, 0b100, 0b110, 0b101, 0b010],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b010, 0b101, 0b010, 0b101, 0b010],
  '9': [0b010, 0b101, 0b011, 0b001, 0b110],
  '.': [0b000, 0b000, 0b000, 0b000, 0b010],
  ':': [0b000, 0b010, 0b000, 0b010, 0b000],
  '%': [0b101, 0b001, 0b010, 0b100, 0b101],
  '/': [0b001, 0b001, 0b010, 0b100, 0b100],
  '-': [0b000, 0b000, 0b111, 0b000, 0b000],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
  '$': [0b011, 0b110, 0b010, 0b011, 0b110],
  '!': [0b010, 0b010, 0b010, 0b000, 0b010],
  '?': [0b110, 0b001, 0b010, 0b000, 0b010],
  ' ': [0b000, 0b000, 0b000, 0b000, 0b000],
  '_': [0b000, 0b000, 0b000, 0b000, 0b111],
  '(': [0b010, 0b100, 0b100, 0b100, 0b010],
  ')': [0b010, 0b001, 0b001, 0b001, 0b010],
  '>': [0b100, 0b010, 0b001, 0b010, 0b100],
  '<': [0b001, 0b010, 0b100, 0b010, 0b001],
};

/** Parse "#RRGGBB" hex color to [r, g, b]. */
function parseColor(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Draw text onto a 64×64 RGB buffer.
 * @param buf - 12,288 byte RGB buffer (mutated in place)
 * @param x - starting X pixel
 * @param y - starting Y pixel
 * @param text - string to draw (auto-uppercased, unknown chars → space)
 * @param color - hex color "#RRGGBB"
 */
export function drawText(
  buf: Uint8Array, x: number, y: number, text: string, color: string
): void {
  const [r, g, b] = parseColor(color);
  const upper = text.toUpperCase();

  let cx = x;
  for (const ch of upper) {
    const glyph = GLYPHS[ch];
    if (!glyph) {
      cx += 4; // unknown char → space
      continue;
    }
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row] & (0b100 >> col)) {
          const px = cx + col;
          const py = y + row;
          if (px >= 0 && px < 64 && py >= 0 && py < 64) {
            const idx = (py * 64 + px) * 3;
            buf[idx] = r;
            buf[idx + 1] = g;
            buf[idx + 2] = b;
          }
        }
      }
    }
    cx += 4; // 3px glyph + 1px gap
  }
}

/**
 * Measure text width in pixels.
 */
export function measureText(text: string): number {
  if (text.length === 0) return 0;
  return text.length * 4 - 1; // each char 3px + 1px gap, minus trailing gap
}

/**
 * Draw text centered horizontally on the 64px canvas.
 */
export function drawTextCentered(
  buf: Uint8Array, y: number, text: string, color: string
): void {
  const width = measureText(text);
  const x = Math.max(0, Math.floor((64 - width) / 2));
  drawText(buf, x, y, text, color);
}
