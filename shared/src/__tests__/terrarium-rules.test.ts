// Guards the terrarium rules SSOT (terrarium-rules.ts):
//  1. the clearance invariant that motivated it (610fe15c) holds, and
//  2. the generated Swift/Kotlin/C++ mirrors on disk match what the
//     generator emits from the current source — hand edits or a skipped
//     `pnpm generate-terrarium-rules` fail here in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TERRARIUM_RULES, ciCompanionSeed } from '../terrarium-rules.js';
import { OUTPUTS } from '../../../scripts/generate-terrarium-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('terrarium rules invariants', () => {
  it('floor-rest clear anchor stays left of the crayfish claws', () => {
    const { crayfish, resterMaxWidthFrac } = TERRARIUM_RULES;
    const clawLeftEdge = crayfish.homeX - crayfish.widthFrac;
    expect(crayfish.clearMaxX + resterMaxWidthFrac / 2).toBeLessThan(clawLeftEdge);
  });

  it('CI companion motion and footprint fit the visible session surface', () => {
    const orbit = TERRARIUM_RULES.ciCompanion;
    expect(orbit.orbitRadiusX).toBeGreaterThan(orbit.sizeFrac);
    expect(orbit.orbitRadiusY).toBeGreaterThan(orbit.sizeFrac);
    expect(orbit.edgeInset).toBeGreaterThanOrEqual(orbit.sizeFrac / 2);
    expect(orbit.nativeRadiusX).toBeGreaterThan(orbit.nativeSize);
    expect(orbit.resultSeconds).toBeGreaterThan(0);
    expect(orbit.unknownSpeed).toBeLessThan(orbit.queuedSpeed);
    expect(orbit.queuedSpeed).toBeLessThan(1);
  });

  it('identity phase uses deterministic unsigned FNV-1a over UTF-8', () => {
    expect(ciCompanionSeed('hello')).toBe(0.1723);
    expect(ciCompanionSeed('')).toBe(0.6261);
    expect(ciCompanionSeed('ci:한글')).toBe(0.1909);
    expect(ciCompanionSeed('ci:한글')).not.toBe(ciCompanionSeed('ci:다른'));
  });

  it('rest strips sit above the crayfish, below mid-water', () => {
    const { floorRestStrip, antigravityHoverStrip } = TERRARIUM_RULES;
    expect(floorRestStrip.yMin).toBeLessThan(floorRestStrip.yMax);
    expect(antigravityHoverStrip.yMax).toBeLessThan(floorRestStrip.yMin);
  });
});

describe('generated mirrors in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(emit(TERRARIUM_RULES));
    });
  }
});
