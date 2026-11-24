import { expect, it } from 'vitest';
import { renderMatrixBase, renderCompanionBase } from '../pixoo/matrix-art.js';

const hues = (frame: Uint8Array) => {
  const seen = new Set<string>();
  for (let i = 0; i < frame.length; i += 3) {
    const [r, g, b] = [frame[i], frame[i + 1], frame[i + 2]];
    if (r + g + b < 120) continue;
    seen.add(r >= g && r >= b ? 'r' : g >= b ? 'g' : 'b');
  }
  return seen;
};

it('draws Antigravity as its gradient mark, not a gray tint, on the 32 px matrix', () => {
  for (const frame of [renderMatrixBase(32, 'idle', 'antigravity', 0), renderCompanionBase('idle', 'antigravity', 0)]) {
    expect(hues(frame).size).toBe(3);
  }
});

it('draws Dot as its pearl rather than the neutral stand-in face', () => {
  expect(renderMatrixBase(32, 'idle', 'dot', 0)).not.toEqual(renderMatrixBase(32, 'idle', 'neutral', 0));
});
