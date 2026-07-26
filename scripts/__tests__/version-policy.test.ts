import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { readTargetVersion, releaseTargets, validateReleaseVersion } from '../release-version.mjs';
import { areVersionsCompatible, compatibilityLine, parseNumericVersion } from '../version-policy.mjs';

// fileURLToPath, not `.pathname`: on Windows the latter yields
// `/C:/…/Claude%20Code/…`, whose leading slash and percent-encoding turn into
// `C:\C:\…%20…` once resolve() sees it.
const root = fileURLToPath(new URL('../..', import.meta.url));

describe('cross-target version compatibility', () => {
  it('ignores patch values and ordering within the same major.minor line', () => {
    expect(areVersionsCompatible('1.0.0', '1.0.999')).toBe(true);
    expect(areVersionsCompatible('1.0.999', '1.0.0')).toBe(true);
  });

  it('rejects different major or minor lines', () => {
    expect(areVersionsCompatible('1.0.2', '1.1.0')).toBe(false);
    expect(areVersionsCompatible('1.0.2', '2.0.0')).toBe(false);
  });

  it('requires strict numeric X.Y.Z versions', () => {
    expect(parseNumericVersion('1.0.2')).toEqual({ major: 1, minor: 0, patch: 2 });
    expect(parseNumericVersion('v1.0.2')).toBeNull();
    expect(parseNumericVersion('1.0')).toBeNull();
    expect(compatibilityLine('1.0.27')).toBe('1.0');
  });
});

describe('release tag identity', () => {
  it('matches a release tag against that target, not the root patch', () => {
    expect(() => validateReleaseVersion('esp32', '1.0.9', '1.0.9')).not.toThrow();
    expect(() => validateReleaseVersion('esp32', '1.0.2', '1.0.9')).toThrow(
      'esp32 tag 1.0.2 does not match target source version 1.0.9',
    );
  });

  it('can resolve every maintained target source', () => {
    for (const target of releaseTargets) {
      expect(parseNumericVersion(readTargetVersion(root, target))).not.toBeNull();
    }
  });
});
