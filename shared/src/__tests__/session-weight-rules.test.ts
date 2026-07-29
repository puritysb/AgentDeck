// Guards the session-weight range SSOT (session-utils.ts SESSION_WEIGHT_MIN/MAX):
//  1. the generated Swift/Kotlin mirrors on disk match what the generator
//     emits from the current source — hand edits or a skipped
//     `pnpm generate-session-weight-rules` fail here in CI, and
//  2. the deliberately self-contained D200H preview hand-port
//     (apple/.../D200HLayoutModel.swift) carries the same literals — it does
//     not import the generated enum by design, so its copy is grep-gated.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SESSION_WEIGHT_MIN, SESSION_WEIGHT_MAX, sessionWeight } from '../session-utils.js';
import { OUTPUTS, emitSwift, emitKotlin } from '../../../scripts/generate-session-weight-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = { min: SESSION_WEIGHT_MIN, max: SESSION_WEIGHT_MAX };

describe('session weight range invariants', () => {
  it('range is symmetric around the neutral band and fits every platform integer', () => {
    expect(SESSION_WEIGHT_MIN).toBeLessThan(0);
    expect(SESSION_WEIGHT_MAX).toBeGreaterThan(0);
    expect(SESSION_WEIGHT_MIN).toBe(-SESSION_WEIGHT_MAX);
    // Kotlin Int headroom: even MAX - MIN must be far from 2^31.
    expect(SESSION_WEIGHT_MAX - SESSION_WEIGHT_MIN).toBeLessThan(2 ** 20);
  });

  it('sessionWeight clamps exactly to the SSOT bounds', () => {
    expect(sessionWeight(Number.MAX_SAFE_INTEGER)).toBe(SESSION_WEIGHT_MAX);
    expect(sessionWeight(-Number.MAX_SAFE_INTEGER)).toBe(SESSION_WEIGHT_MIN);
  });
});

describe('generated mirrors in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(emit(rules));
    });
  }

  it('emitters embed the SSOT literals (sanity on the emitters themselves)', () => {
    expect(emitSwift(rules)).toContain(`min = ${SESSION_WEIGHT_MIN}`);
    expect(emitSwift(rules)).toContain(`max = ${SESSION_WEIGHT_MAX}`);
    expect(emitKotlin(rules)).toContain(`MIN = ${SESSION_WEIGHT_MIN}`);
    expect(emitKotlin(rules)).toContain(`MAX = ${SESSION_WEIGHT_MAX}`);
  });
});

describe('self-contained hand-port copies', () => {
  it('D200HLayoutModel.swift carries the same weight-range literals', () => {
    const src = readFileSync(
      `${repoRoot}apple/AgentDeck/UI/Preview/Devices/D200HLayoutModel.swift`,
      'utf8',
    );
    expect(src).toContain(`sessionWeightMin = ${SESSION_WEIGHT_MIN}`);
    expect(src).toContain(`sessionWeightMax = ${SESSION_WEIGHT_MAX}`);
  });
});
