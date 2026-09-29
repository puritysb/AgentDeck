// Replays shared/dashboard-provider-vectors.json against the TS resolver —
// the same file the Swift suite replays (DashboardProviderVectorsTests), so a
// vector is a cross-daemon contract: the same settings.json must not render
// differently depending on which daemon holds the port (#351).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveDashboardProviders, DASHBOARD_PROVIDER_IDS } from '../dashboard-providers.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const file = JSON.parse(
  readFileSync(`${repoRoot}shared/dashboard-provider-vectors.json`, 'utf8'),
) as { cases: Array<{
  note: string;
  state: { providers: string[] | null; seen: string[] | null };
  input: { update?: { providers: unknown; initialize?: boolean }; confirmed?: string[] };
  expected: { providers: string[] | null; seen: string[] | null };
}> };
const vectors = file.cases;

describe('dashboard provider vectors (shared with the Swift suite)', () => {
  it('the frozen pre-mechanism baseline is exactly the vocabulary minus z.ai', () => {
    // The ids that shipped WITH the mechanism are the first join-eligible; a
    // later vocabulary addition must NOT be added to the frozen baseline.
    const baseline = DASHBOARD_PROVIDER_IDS.filter(
      p => !['claude', 'codex', 'openclaw', 'mlx', 'ollama', 'antigravity'].includes(p),
    );
    expect(baseline).toEqual(['zai']);
  });

  for (const v of vectors) {
    it(v.note, () => {
      expect(resolveDashboardProviders(
        { providers: v.state.providers, seen: v.state.seen },
        (v.input.update ?? null) as never,
        v.input.confirmed ?? [],
      )).toEqual(v.expected);
    });
  }
});
