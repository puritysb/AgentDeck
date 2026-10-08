import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ciWaitForegroundMs, ciWaitDuration, CI_WAIT_MAX_COMMAND_CHARS, classifyCiWaitIntent } from '../ci-wait.js';
const vectors = JSON.parse(readFileSync(new URL('../../ci-wait-vectors.json', import.meta.url), 'utf8'));

describe('CI wait command evidence', () => {
  it.each(vectors.map((vector, index) => ({ ...vector, name: 'shared vector ' + index })))('$name', vector => {
    expect(classifyCiWaitIntent(vector.command, vector.background)).toEqual(vector.expected);
  });
  it('bounds UTF-16 input including surrogate pairs', () => {
    expect(classifyCiWaitIntent('gh run watch 42 # ' + '🦐'.repeat(CI_WAIT_MAX_COMMAND_CHARS / 2), true)).toBeNull();
  });
});

it('clips and unions CI spans instead of double-counting concurrent watchers', () => {
  expect(ciWaitDuration([{ start: 0, end: 50 }, { start: 40, end: 75 }, { start: 90, end: 200 }], 10, 100)).toBe(75);
  expect(ciWaitDuration([{ start: NaN, end: 100 }, { start: 50, end: 20 }], 0, 100)).toBe(0);
});

const accounting = JSON.parse(readFileSync(new URL('../../ci-wait-accounting-vectors.json', import.meta.url), 'utf8'));
it.each(accounting)('accounts CI spans: $name', vector => {
  expect(ciWaitForegroundMs(vector.events, vector.turnIndex, vector.start, vector.end)).toBe(vector.expected);
});
