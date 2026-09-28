import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The preview mirror pin check used to run only as a CI step, which is the
// one place a Swift/firmware-only workflow never looks: on 2026-09-01 the
// same pin (Trmnl75Preview → eink_display.cpp) broke master twice in one
// day, each time from work verified green locally against vitest, the Swift
// suite, and hardware — none of which executed the check. Running it inside
// vitest puts it in every `pnpm test`, so a moved renderer fails on the
// author's machine instead of after the push.
describe('preview mirror pins', () => {
  it('every SYNC-HASH pin matches its origin file', () => {
    const script = resolve(import.meta.dirname, '..', 'check-preview-mirror-sync.mjs');
    expect(() =>
      execFileSync(process.execPath, [script], { stdio: 'pipe' }),
    ).not.toThrow();
    // A fresh `node` process on a cold runner, not a unit test: 10 s was
    // exceeded once on a freshly booted container.
  }, 30_000);
});
