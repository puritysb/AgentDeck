// Drift gate for the generated Claude background-job rule mirror
// (shared/src/claude-background-jobs.ts → Swift). A hand edit to the generated
// file, or a skipped `pnpm generate-claude-background-jobs`, fails here.
// Behaviour stays pinned by shared/claude-background-job-vectors.json, which
// both suites replay.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rulesMod from '../claude-background-jobs.js';
import { OUTPUTS, rulesFrom } from '../../../scripts/generate-claude-background-jobs.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(rulesMod);

describe('generated Claude background-job rule mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(rules));
    });
  }

  it('emitter embeds the SSOT constants', () => {
    const swift = OUTPUTS[0][1](rules);
    expect(swift).toContain(`#"${rulesMod.CLAUDE_BG_RESUME_PATTERN}"#`);
    for (const flag of Object.values(rulesMod.CLAUDE_BG_FLAGS)) expect(swift).toContain(JSON.stringify(flag));
  });

  it('the Swift suite replays the shared vector file (grep the test wiring)', () => {
    const swiftTest = readFileSync(`${repoRoot}apple/AgentDeckTests/ClaudeBackgroundJobRulesTests.swift`, 'utf8');
    expect(swiftTest).toContain('shared/claude-background-job-vectors.json');
  });
});
