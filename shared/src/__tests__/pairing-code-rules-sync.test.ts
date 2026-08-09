// Drift gate for the pairing-code SSOT mirrors (shared/src/pairing-code.ts →
// Swift/Kotlin). A hand edit to either generated file, or a skipped
// `pnpm generate-pairing-code-rules`, fails here in CI.
//
// The Swift mirror carries the full evaluator, so this file also pins the parts
// of it a byte-compare would happily let rot into nonsense: the branch ORDER
// (expiry before code, malformed before mismatch) and the HTTP status per
// outcome are the wire contract a client's retry policy reads, and the Node
// evaluator is the only executable copy in this test process.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pairingCode from '../pairing-code.js';
import { evaluatePairingRedemption } from '../pairing-code.js';
import { OUTPUTS, emitSwift, emitKotlin, rulesFrom } from '../../../scripts/generate-pairing-code-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(pairingCode);

describe('generated mirrors in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(emit(rules));
    });
  }

  it('emitters embed the SSOT constants (sanity on the emitters themselves)', () => {
    const swift = emitSwift(rules);
    const kotlin = emitKotlin(rules);
    expect(swift).toContain(`static let digits = ${pairingCode.PAIRING_CODE_DIGITS}`);
    expect(swift).toContain(`static let windowMs = ${pairingCode.PAIRING_WINDOW_MS}`);
    expect(swift).toContain(`static let maxFailedAttempts = ${pairingCode.PAIRING_MAX_FAILED_ATTEMPTS}`);
    expect(kotlin).toContain(`const val DIGITS = ${pairingCode.PAIRING_CODE_DIGITS}`);
    expect(kotlin).toContain(`const val MAX_FAILED_ATTEMPTS = ${pairingCode.PAIRING_MAX_FAILED_ATTEMPTS}`);
  });

  it('the Swift mirror emits every outcome the TS union declares', () => {
    // A new outcome added to TS without a Swift case would otherwise only
    // surface as a Swift compile error on a machine with Xcode.
    const swift = emitSwift(rules);
    for (const wire of ['accepted', 'no-window', 'expired', 'exhausted', 'mismatch', 'malformed']) {
      const swiftCase = wire === 'no-window' ? 'case noWindow = "no-window"' : `case ${wire}`;
      expect(swift).toContain(swiftCase);
    }
  });

  it('Kotlin stays a client mirror — no evaluator, no HTTP statuses', () => {
    // Android submits codes and never judges them. An evaluator it cannot reach
    // is mirror surface that can only drift.
    const kotlin = emitKotlin(rules);
    expect(kotlin).not.toContain('fun evaluate');
    expect(kotlin).not.toContain('410');
  });
});

describe('status contract the mirrors must agree on', () => {
  const NOW = 1_700_000_000_000;
  const open = {
    code: '482913',
    expiresAt: NOW + pairingCode.PAIRING_WINDOW_MS,
    failedAttempts: 0,
    redemptionsRemaining: 1,
  };

  // outcome → status, asserted against the executable TS evaluator and then
  // grepped out of the emitted Swift, so the two cannot diverge silently.
  const cases: Array<[pairingCode.PairingRedemptionOutcome, number, () => unknown]> = [
    ['accepted', 200, () => evaluatePairingRedemption(open, '482913', NOW)],
    ['no-window', 401, () => evaluatePairingRedemption(null, '482913', NOW)],
    ['expired', 410, () => evaluatePairingRedemption({ ...open, expiresAt: NOW }, '482913', NOW)],
    ['exhausted', 429, () => evaluatePairingRedemption({ ...open, redemptionsRemaining: 0 }, '482913', NOW)],
    ['mismatch', 401, () => evaluatePairingRedemption(open, '000000', NOW)],
    ['malformed', 400, () => evaluatePairingRedemption(open, 'nope', NOW)],
  ];

  for (const [outcome, status, run] of cases) {
    it(`${outcome} answers ${status} in TS and in the Swift mirror`, () => {
      expect(run()).toMatchObject({ outcome, status });
      const swiftCase = outcome === 'no-window' ? '.noWindow' : `.${outcome}`;
      expect(emitSwift(rules)).toContain(`outcome: ${swiftCase}, status: ${status}`);
    });
  }

  it('the Swift mirror decides expiry before it reads the code', () => {
    // Grep the emitted order rather than trusting the prose: the expiry guard
    // must appear before the first `normalize(submitted)`.
    const swift = emitSwift(rules);
    const evaluate = swift.slice(swift.indexOf('static func evaluate('));
    expect(evaluate.indexOf('now >= window.expiresAt')).toBeLessThan(evaluate.indexOf('normalize(submitted)'));
    expect(evaluate.indexOf('.malformed')).toBeLessThan(evaluate.indexOf('.mismatch'));
  });
});
