// Guards the Codex snapshot-freshness SSOT (format-utils.ts:
// CODEX_SNAPSHOT_STALE_MS + codexUsageFootnote's three states):
//  1. the generated Swift/Kotlin mirrors on disk match what the generator emits
//     from the current source — a hand edit or a skipped
//     `pnpm generate-codex-freshness-rules` fails here in CI, and
//  2. the emitted mirrors carry the SSOT threshold in each platform's own unit
//     (Swift seconds, Kotlin milliseconds) — a unit slip is the one drift a
//     byte-compare of two independently-written files would NOT catch.
//
// WHY generated rather than hand-mirrored: "how old is this reading" is the only
// thing separating a live Codex percentage from a frozen one, and every surface
// must answer it identically. A threshold that drifts by platform means one
// screen calls a number live while the next calls it stale.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHATGPT_PLAN_DISPLAY_NAMES,
  CODEX_SNAPSHOT_STALE_MS,
  codexUsageFootnote,
  formatChatGptPlanName,
  formatSnapshotAge,
} from '../format-utils.js';
import { OUTPUTS, emitSwift, emitKotlin } from '../../../scripts/generate-codex-freshness-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = { staleMs: CODEX_SNAPSHOT_STALE_MS, planNames: CHATGPT_PLAN_DISPLAY_NAMES };

describe('codex freshness threshold invariants', () => {
  it('is an absolute duration, not a fraction of any window', () => {
    // A weekly window is 10080 minutes; anything proportional to it would be
    // hours long and would never fire — exactly the bug this closes.
    expect(CODEX_SNAPSHOT_STALE_MS).toBeGreaterThan(60_000);
    expect(CODEX_SNAPSHOT_STALE_MS).toBeLessThan(10080 * 60_000 * 0.01);
  });

  it('is a whole number of minutes, so every platform can print it', () => {
    expect(CODEX_SNAPSHOT_STALE_MS % 60_000).toBe(0);
  });
});

describe('generated mirrors in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(emit(rules));
    });
  }

  it('emits the threshold in each platform\'s own unit', () => {
    // Swift takes a TimeInterval (seconds), Kotlin a Long of milliseconds.
    // Byte-comparing the files cannot catch a unit mistake in the emitter.
    expect(emitSwift(rules)).toContain(`snapshotStaleInterval: TimeInterval = ${CODEX_SNAPSHOT_STALE_MS / 1000}`);
    expect(emitKotlin(rules)).toContain(`SNAPSHOT_STALE_MS: Long = ${CODEX_SNAPSHOT_STALE_MS}L`);
  });

  it('mirrors the plan-reconciliation rule to Swift (the other PRODUCER of the wire snapshot)', () => {
    // Both daemons build `codexRateLimits`, so both must void a snapshot minted
    // under a retired plan identically — a Swift-daemon user would otherwise
    // keep seeing a lapsed subscription's 94% while the Node daemon dropped it.
    // Kotlin gets no copy on purpose: Android only consumes the wire.
    const swift = emitSwift(rules);
    expect(swift).toContain('enum CodexPlanRules');
    expect(swift).toContain('static func snapshotMatchesAccountPlan(snapshot: String?, account: String?) -> Bool');
    expect(swift).toContain('static func isFreePlan(_ plan: String?) -> Bool');
    // Unknown on either side matches — absence is "no information".
    expect(swift).toContain('if snap.isEmpty || acct.isEmpty { return true }');
    expect(emitKotlin(rules)).not.toContain('CodexPlanRules');
  });

  it('mirrors the plan-aware RANKING to Swift, not just the void rule', () => {
    // Voiding alone is not enough on either daemon: a snapshot that will be
    // voided must not first WIN the selection, or the valid same-plan snapshot
    // sitting in another rollout is never read. The Swift daemon needs this most
    // — sandboxed, it cannot spawn `codex app-server` and has no second source.
    const swift = emitSwift(rules);
    expect(swift).toContain('static func snapshotOutranks(');
    // Plan agreement is the PRIMARY key; age only breaks a tie within a class.
    expect(swift).toContain('if candidateMatches != incumbentMatches { return candidateMatches }');
    expect(swift).toContain('return candidateCapturedAt > incumbentCapturedAt');
    expect(emitKotlin(rules)).not.toContain('snapshotOutranks');
  });

  it('emits every plan display name from the SSOT table, Swift only', () => {
    // The tier table is generated because OpenAI mints plans unannounced
    // (`prolite`, 2026-08-22) and a hand mirror updated on one side renders the
    // same account two different ways. Android consumes the formatted wire name.
    const swift = emitSwift(rules);
    expect(swift).toContain('enum ChatGPTPlan');
    for (const [key, name] of Object.entries(CHATGPT_PLAN_DISPLAY_NAMES)) {
      expect(swift).toContain(`case "${key}": return "${name}"`);
    }
    // Separators are stripped before lookup, so `pro_lite` cannot miss `prolite`.
    expect(swift).toContain('$0 != "_"');
    expect(emitKotlin(rules)).not.toContain('ChatGPTPlan');
  });

  it('emits the same three footnote states the TS SSOT resolves', () => {
    for (const src of [emitSwift(rules), emitKotlin(rules)]) {
      expect(src).toContain('"stale"');   // window ended
      expect(src).toContain('m ago');     // aged, minutes
      expect(src).toContain('h ago');     // aged, hours
      expect(src).toContain('d ago');     // aged, days
    }
  });
});

describe('TS side still produces what the mirrors promise', () => {
  const NOW = Date.parse('2026-08-05T07:27:00.000Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('names a tier the build predates without dropping it or showing it raw', () => {
    expect(formatChatGptPlanName('prolite')).toBe('ChatGPT Pro Lite');
    expect(formatChatGptPlanName('pro_lite')).toBe('ChatGPT Pro Lite');
    expect(formatChatGptPlanName(' Pro Lite ')).toBe('ChatGPT Pro Lite');
    // Unrecognised: capitalised, never the raw token and never undefined.
    expect(formatChatGptPlanName('nebula')).toBe('ChatGPT Nebula');
    expect(formatChatGptPlanName('')).toBeUndefined();
    expect(formatChatGptPlanName(undefined)).toBeUndefined();
  });

  it('threshold boundary matches the emitted constant', () => {
    expect(codexUsageFootnote({ resetsAt: '2099-01-01T00:00:00Z' }, ago(CODEX_SNAPSHOT_STALE_MS), NOW))
      .toBeUndefined();
    expect(codexUsageFootnote({ resetsAt: '2099-01-01T00:00:00Z' }, ago(CODEX_SNAPSHOT_STALE_MS + 60_000), NOW))
      .toEqual({ text: formatSnapshotAge(ago(CODEX_SNAPSHOT_STALE_MS + 60_000), NOW), dim: true });
  });
});
