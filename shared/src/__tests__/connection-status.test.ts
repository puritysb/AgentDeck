import { describe, expect, it } from 'vitest';
// @ts-expect-error executable generator has no TypeScript declaration
import { outputs } from '../../../scripts/generate-connection-labels.mjs';

describe('native connection recovery labels', () => {
  it('keeps Swift and Kotlin labels generated from the canonical vocabulary', () => {
    for (const { path, current, expected } of outputs()) {
      expect(current, path).toBe(expected);
    }
  });
});
