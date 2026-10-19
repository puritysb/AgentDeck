// Drift gate for the generated Codex device-approval hold mirror
// (shared/src/codex-approval-hold.ts → Swift). A hand edit to the generated
// file, or a skipped `pnpm generate-codex-approval-hold`, fails here.
// Behaviour stays pinned by shared/codex-approval-hold-vectors.json, which
// both suites replay.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rulesMod from '../codex-approval-hold.js';
import { OUTPUTS, rulesFrom } from '../../../scripts/generate-codex-approval-hold.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(rulesMod);

describe('generated Codex approval hold mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(rules));
    });
  }

  it('emitter embeds the SSOT constants', () => {
    const swift = OUTPUTS[0][1](rules);
    expect(swift).toContain(`static let header = ${JSON.stringify(rulesMod.CODEX_APPROVAL_HOLD_HEADER)}`);
    expect(swift).toContain(JSON.stringify(rulesMod.CODEX_APPROVAL_DENY_MESSAGE));
    for (const event of rulesMod.CODEX_APPROVAL_RELEASING_EVENTS) expect(swift).toContain(JSON.stringify(event));
    expect(swift).toContain(`static let allowIndex = ${rulesMod.CODEX_APPROVAL_ALLOW_INDEX}`);
    expect(swift).toContain(`static let denyIndex = ${rulesMod.CODEX_APPROVAL_DENY_INDEX}`);
  });

  it('the Swift suite replays the shared vector file (grep the test wiring)', () => {
    const swiftTest = readFileSync(`${repoRoot}apple/AgentDeckTests/CodexApprovalHoldTests.swift`, 'utf8');
    expect(swiftTest).toContain('shared/codex-approval-hold-vectors.json');
    expect(swiftTest).toContain('CodexApprovalHoldRules.decision(');
    expect(swiftTest).toContain('CodexApprovalHoldRules.pressDecision(');
    expect(swiftTest).toContain('CodexConfigInstaller.buildApprovalHoldCommand()');
  });
});
