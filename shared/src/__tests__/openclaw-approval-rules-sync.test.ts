// Drift gate for the OpenClaw exec-approval SSOT mirror
// (shared/src/openclaw-approval.ts → Swift). A hand edit to the generated file,
// or a skipped `pnpm generate-openclaw-approval-rules`, fails here in CI.
//
// The byte compare alone is not the point. What this file really pins is the
// pair of facts a compare would happily let rot back into the shape that broke
// the feature: the decision vocabulary the Gateway accepts (`allow` is not a
// member), and the fact that the payload is NESTED under `request`. Both were
// wrong in every implementation at once, so "the two mirrors agree" would have
// been true the whole time it was broken.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as approval from '../openclaw-approval.js';
import { OUTPUTS, emitSwift, rulesFrom } from '../../../scripts/generate-openclaw-approval-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(approval);

describe('generated mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(rules));
    });
  }

  it('the Swift mirror carries every decision the TS union declares', () => {
    const swift = emitSwift(rules);
    for (const decision of approval.EXEC_APPROVAL_DECISIONS) {
      expect(swift).toContain(`= "${decision}"`);
    }
    // A decision added to TS without regenerating would otherwise only surface
    // as a Swift compile error on a machine with Xcode.
    const cases = swift.match(/^\s{4}case \w+ = "/gm) ?? [];
    expect(cases.length).toBe(approval.EXEC_APPROVAL_DECISIONS.length);
  });

  it('neither side ever offers the plain "allow" the Gateway rejects', () => {
    // The whole outage was this string. `isApprovalDecision('allow')` is false
    // and the Gateway checks it BEFORE the id lookup, so the resolve fails and
    // the approval stays pending with nothing surfaced anywhere.
    expect(approval.EXEC_APPROVAL_DECISIONS as readonly string[]).not.toContain('allow');
    expect(emitSwift(rules)).not.toMatch(/= "allow"$/m);
  });

  it('both suites replay the same "is this approval gone?" vectors', () => {
    // The predicate decides whether a prompt comes OFF a deck. If only one
    // daemon replays the vectors, the other can quietly keep offering an
    // approval the Gateway dropped — which is the defect, not a regression of
    // it. Pins the wiring, not the membership, so a new vector needs no edit.
    const swiftTest = readFileSync(
      `${repoRoot}apple/AgentDeckTests/OpenClawApprovalErrorTests.swift`, 'utf8');
    expect(swiftTest).toContain('openclaw-approval-error-vectors.json');
    expect(swiftTest).toContain('OpenClawApprovalRules.isApprovalGoneError');
    const tsTest = readFileSync(
      `${repoRoot}shared/src/__tests__/openclaw-approval.test.ts`, 'utf8');
    // The TS side builds the path from parts, so match the file, not a literal
    // path string.
    expect(tsTest).toContain('openclaw-approval-error-vectors.json');
    // And the mirror must actually carry the predicate.
    expect(emitSwift(rules)).toContain('static func isApprovalGoneError');
  });

  it('the Swift mirror reads the nested request, not flat fields', () => {
    // `payload["tool"]` / a flat `payload["command"]` are the invented shapes
    // that rendered every approval as a bare "Approve tool execution?".
    const swift = emitSwift(rules);
    expect(swift).toContain('payload["request"] as? [String: Any]');
    expect(swift).not.toContain('payload["tool"]');
  });
});
