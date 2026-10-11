// Drift gate for the generated hook harness-identity mirror
// (shared/src/hook-harness.ts → Swift). A hand edit to the generated file, or
// a skipped `pnpm generate-hook-harness`, fails here. Behaviour stays pinned
// by shared/hook-harness-vectors.json, which both suites replay.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rulesMod from '../hook-harness.js';
import { OUTPUTS, rulesFrom } from '../../../scripts/generate-hook-harness.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(rulesMod);

describe('generated hook harness mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(rules));
    });
  }

  it('emitter embeds the SSOT constants', () => {
    const swift = OUTPUTS[0][1](rules);
    expect(swift).toContain(`#"${rulesMod.CODEX_ROLLOUT_BASENAME_PATTERN}"#`);
    for (const [name, event] of Object.entries(rulesMod.CODEX_HOOK_ROUTES)) {
      expect(swift).toContain(`${JSON.stringify(name)}: ${JSON.stringify(event)}`);
    }
  });

  it('the Swift suite replays the shared vector file (grep the test wiring)', () => {
    const swiftTest = readFileSync(`${repoRoot}apple/AgentDeckTests/CodexOriginatorTests.swift`, 'utf8');
    expect(swiftTest).toContain('shared/hook-harness-vectors.json');
    expect(swiftTest).toContain('CodexHookHarness.route(');
  });
});
