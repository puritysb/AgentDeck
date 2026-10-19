// Drift gate for the generated same-machine trust evaluator
// (shared/src/local-trust.ts → Swift). Behaviour stays pinned by
// shared/local-trust-vectors.json, which both suites replay.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rulesMod from '../local-trust.js';
import { OUTPUTS, rulesFrom } from '../../../scripts/generate-local-trust-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(rulesMod);

describe('generated local trust rule mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(rules));
    });
  }

  it('emitter embeds every constant the rule reads', () => {
    const swift = OUTPUTS[0][1](rules);
    for (const method of rulesMod.LOCAL_TRUST_SAFE_METHODS) expect(swift).toContain(`"${method}"`);
    for (const [scheme, port] of Object.entries(rulesMod.LOCAL_TRUST_DEFAULT_PORTS)) expect(swift).toContain(`"${scheme}": ${port}`);
    expect(swift).toContain(`static let fileOrigin = "${rulesMod.LOCAL_TRUST_FILE_ORIGIN}"`);
  });

  it('the Swift suite replays the shared vector file (grep the test wiring)', () => {
    const swiftTest = readFileSync(`${repoRoot}apple/AgentDeckTests/LocalTrustVectorsTests.swift`, 'utf8');
    expect(swiftTest).toContain('shared/local-trust-vectors.json');
    expect(swiftTest).toContain('LocalTrustRules.verdict(');
  });
});
