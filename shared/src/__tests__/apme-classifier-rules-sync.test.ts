// Drift gate for the APME classifier LLM-assist SSOT mirror
// (shared/src/apme-classifier-rules.ts → Swift). A hand edit to the
// generated file, or a skipped `pnpm generate-apme-classifier-rules`, fails
// here in CI.
//
// The byte compare alone is not the point. `task_category` selects the
// judge rubric downstream, so the two daemons disagreeing about the LLM
// classification backend — which prompt, which labels are valid, which
// backends may even be tried — is a score difference, not a cosmetic one
// (#299). This file pins the fact a compare would happily let rot back:
// `api`/`openai` are never members of the backend order, on either daemon.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rules from '../apme-classifier-rules.js';
import { OUTPUTS, emitSwift, rulesFrom } from '../../../scripts/generate-apme-classifier-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const emitted = rulesFrom(rules);

describe('generated mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(emitted));
    });
  }

  it('the Swift mirror carries every label the TS union declares', () => {
    const swift = emitSwift(emitted);
    for (const label of rules.APME_CLASSIFIER_LABELS) {
      expect(swift).toContain(`"${label}",`);
    }
  });

  it('neither side ever offers a paid backend in the classifier try-order', () => {
    // This is the whole outage: Swift's classifier used to route through
    // `callConfiguredJudge`, i.e. whatever judge backend the user configured
    // — including `api`/`openai` — billing a paid backend for a call that
    // decides nothing more than which of ten labels a task gets.
    expect(rules.APME_CLASSIFIER_BACKEND_ORDER as readonly string[]).not.toContain('api');
    expect(rules.APME_CLASSIFIER_BACKEND_ORDER as readonly string[]).not.toContain('openai');
    expect(rules.APME_CLASSIFIER_BACKEND_ORDER as readonly string[]).not.toContain('openclaw');
    const swift = emitSwift(emitted);
    expect(swift).not.toMatch(/"api",/);
    expect(swift).not.toMatch(/"openai",/);
  });

  it('`rules` is always the last entry — it is a give-up, not a network call', () => {
    expect(rules.APME_CLASSIFIER_BACKEND_ORDER[rules.APME_CLASSIFIER_BACKEND_ORDER.length - 1]).toBe('rules');
  });

  it('the output cap stays far below the eval judge budget (a different call, a different purpose)', () => {
    expect(rules.APME_CLASSIFIER_MAX_TOKENS).toBeLessThanOrEqual(20);
    expect(rules.APME_CLASSIFIER_MAX_TOKENS).toBeGreaterThan(0);
  });

  it('normalizeClassifierLabel and the Swift mirror agree on exact + partial match', () => {
    expect(rules.normalizeClassifierLabel('coding')).toBe('coding');
    expect(rules.normalizeClassifierLabel('  Coding!  ')).toBe('coding');
    expect(rules.normalizeClassifierLabel('The answer is coding.')).toBe('coding');
    expect(rules.normalizeClassifierLabel('not a real label')).toBe(null);
    const swift = emitSwift(emitted);
    expect(swift).toContain('static func normalizeLabel(_ raw: String) -> String?');
  });
});
