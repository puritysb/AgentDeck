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
import { CODEX_SNAPSHOT_STALE_MS, codexUsageFootnote, formatSnapshotAge } from '../format-utils.js';
import { OUTPUTS, emitSwift, emitKotlin } from '../../../scripts/generate-codex-freshness-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = { staleMs: CODEX_SNAPSHOT_STALE_MS };

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

  it('threshold boundary matches the emitted constant', () => {
    expect(codexUsageFootnote({ resetsAt: '2099-01-01T00:00:00Z' }, ago(CODEX_SNAPSHOT_STALE_MS), NOW))
      .toBeUndefined();
    expect(codexUsageFootnote({ resetsAt: '2099-01-01T00:00:00Z' }, ago(CODEX_SNAPSHOT_STALE_MS + 60_000), NOW))
      .toEqual({ text: formatSnapshotAge(ago(CODEX_SNAPSHOT_STALE_MS + 60_000), NOW), dim: true });
  });
});
