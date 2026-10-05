import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CI_WAIT_MAX_COMMAND_CHARS, classifyCiWaitIntent } from '../ci-wait.js';
const vectors = JSON.parse(readFileSync(new URL('../../ci-wait-vectors.json', import.meta.url), 'utf8'));

describe('CI wait command evidence', () => {
  it.each(vectors.map((vector, index) => ({ ...vector, name: 'shared vector ' + index })))('$name', vector => {
    expect(classifyCiWaitIntent(vector.command, vector.background)).toEqual(vector.expected);
  });
  it('bounds UTF-16 input including surrogate pairs', () => {
    expect(classifyCiWaitIntent('gh run watch 42 # ' + '🦐'.repeat(CI_WAIT_MAX_COMMAND_CHARS / 2), true)).toBeNull();
  });
});
