// Drift gate for the generated OpenClaw steering-key rule mirror
// (shared/src/openclaw-session-key.ts → Swift). Behaviour stays pinned by
// shared/openclaw-session-key-vectors.json, which both suites replay.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rulesMod from '../openclaw-session-key.js';
import { OUTPUTS, rulesFrom } from '../../../scripts/generate-openclaw-session-key-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(rulesMod);

describe('generated OpenClaw session-key rule mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(rules));
    });
  }

  it('emitter embeds every conversation pattern', () => {
    const swift = OUTPUTS[0][1](rules);
    for (const p of rulesMod.OPENCLAW_CONVERSATION_KEY_PATTERNS) expect(swift).toContain(`#"${p}"#`);
  });

  it('the Swift suite replays the shared vector file (grep the test wiring)', () => {
    const swiftTest = readFileSync(`${repoRoot}apple/AgentDeckTests/OpenClawSessionKeyRulesTests.swift`, 'utf8');
    expect(swiftTest).toContain('shared/openclaw-session-key-vectors.json');
  });
});
