/**
 * scripts/verify.mjs decides what the changed-area tier runs. A wrong path
 * glob or a missed test silently narrows "verified" to "not looked at", so the
 * selection rules are pinned here; the step list itself is gated by
 * verification-catalog.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { globToRegExp, vitestRelatedPlan } from '../verify.mjs';

describe('catalog path globs', () => {
  it('keeps * inside one segment and lets ** cross directories', () => {
    expect(globToRegExp('shared/src/*protocol*.ts').test('shared/src/gateway-protocol.ts')).toBe(true);
    expect(globToRegExp('shared/src/*protocol*.ts').test('shared/src/sub/protocol.ts')).toBe(false);
    expect(globToRegExp('android/**').test('android/app/src/main/Foo.kt')).toBe(true);
    expect(globToRegExp('*/package.json').test('bridge/package.json')).toBe(true);
    expect(globToRegExp('*/package.json').test('package.json')).toBe(false);
  });

  it('lets a leading **/ match a file at the repository root too', () => {
    expect(globToRegExp('**/*.md').test('README.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('docs/testing.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('docs/testing.mdx')).toBe(false);
  });
});

describe('changed-area Vitest selection', () => {
  const noTests = () => '';

  it('runs the whole suite when a package manifest, the lockfile, a tsconfig or the Vitest config changed', () => {
    for (const file of ['package.json', 'bridge/package.json', 'pnpm-lock.yaml', 'vitest.config.ts', 'shared/tsconfig.json']) {
      expect(vitestRelatedPlan([file], noTests)?.args, file).toEqual(['vitest', 'run']);
    }
  });

  it('passes changed TypeScript to vitest related and leaves native sources to their own steps', () => {
    const plan = vitestRelatedPlan(['shared/src/task-title.ts', 'android/app/build.gradle.kts', 'apple/AgentDeck/App.swift'], noTests);
    expect(plan?.args).toEqual(['vitest', 'related', '--run', '--passWithNoTests', 'shared/src/task-title.ts']);
  });

  it('adds a test that reads a changed non-code file by name, which no import graph shows', () => {
    const plan = vitestRelatedPlan(['shared/ci-wait-projection-vectors.json'], (test) =>
      test === 'shared/src/__tests__/ci-wait-sync.test.ts' ? "import projection from '../../ci-wait-projection-vectors.json';" : '');
    expect(plan?.args).toContain('shared/src/__tests__/ci-wait-sync.test.ts');
  });

  it('ignores names too generic to identify a reader', () => {
    expect(vitestRelatedPlan(['esp32/README.md'], () => 'README.md everywhere')).toBeNull();
  });

  it('runs nothing when no change is visible to Vitest', () => {
    expect(vitestRelatedPlan([], noTests)).toBeNull();
    expect(vitestRelatedPlan(['deleted/file/that/does-not-exist.ts'], noTests)).toBeNull();
  });
});
