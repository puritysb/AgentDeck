import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// @ts-expect-error — plain ESM script, no type declarations
import { findEntry, parseTag } from '../release-notes.mjs';
// @ts-expect-error — plain ESM script, no type declarations
import { readTargetVersion, releaseTargets } from '../release-version.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const CHANGELOG = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');

describe('release notes lookup', () => {
  // The point of the whole mechanism: every channel's CURRENT version must
  // resolve to a section, because that section IS its release body. Before
  // this existed, all six workflows hardcoded a static install blurb and a
  // round that shipped a new observed agent across five channels published
  // with not one line about it.
  it.each(releaseTargets as string[])('%s at its declared version has an entry', (target) => {
    const version = readTargetVersion(ROOT, target);
    const { label } = parseTag(`${target}-v${version}`);
    const entry = findEntry(CHANGELOG, { version, label });
    expect(entry, `CHANGELOG.md has no section for ${target} ${version}`).not.toBeNull();
    expect(entry.body.length).toBeGreaterThan(0);
  });

  it('matches a channel named anywhere in a multi-channel heading', () => {
    const md = [
      '## 2026-08-18 — npm 1.0.21 · Apple 1.0.7 · Android 1.0.10',
      '',
      'shared round',
      '',
      '## 2026-08-14 — npm 1.0.20',
      '',
      'older',
    ].join('\n');
    expect(findEntry(md, { version: '1.0.7', label: 'Apple' })?.body).toBe('shared round');
    expect(findEntry(md, { version: '1.0.10', label: 'Android' })?.body).toBe('shared round');
    expect(findEntry(md, { version: '1.0.20', label: 'npm' })?.body).toBe('older');
  });

  it('does not let a prefix version match a longer one', () => {
    // 1.0.2 must not resolve to the 1.0.21 section — that would publish one
    // release's notes under a different release's tag.
    const md = '## 2026-08-18 — npm 1.0.21\n\nnew round\n';
    expect(findEntry(md, { version: '1.0.2', label: 'npm' })).toBeNull();
    expect(findEntry(md, { version: '1.0.21', label: 'npm' })?.body).toBe('new round');
  });

  it('never falls back to a bare version heading', () => {
    // `## 1.0.7` was npm's on 2026-08-06; Apple reached 1.0.7 on 2026-08-18
    // with entirely different content. Emitting one channel's notes under
    // another channel's tag is worse than emitting none.
    const md = '## 2026-08-06 — 1.0.7\n\nlegacy shared numbering\n';
    expect(findEntry(md, { version: '1.0.7', label: 'Apple' })).toBeNull();
    expect(findEntry(md, { version: '1.0.7', label: 'npm' })).toBeNull();
  });

  it('stops a section at the next heading', () => {
    const md = '## 2026-08-18 — npm 1.0.21\n\nmine\n\n## 2026-08-14 — npm 1.0.20\n\nnot mine\n';
    expect(findEntry(md, { version: '1.0.21', label: 'npm' })?.body).toBe('mine');
  });

  it('never matches the Unreleased section, and never spills it into a real entry', () => {
    // Landed-but-unshipped work is collected under `## Unreleased` so a release
    // cut renames one heading instead of reconstructing a commit range — the
    // failure this file exists to stop. No tag may resolve to it, and it must
    // not leak into the section below it either.
    const md = [
      '## Unreleased', '', 'not shipped yet', '',
      '## 2026-09-06 — npm 1.2.1, Apple 1.2.1, ESP32 1.2.2', '', 'shipped', '',
    ].join('\n');
    expect(findEntry(md, { version: '1.2.2', label: 'npm' })).toBeNull();
    expect(findEntry(md, { version: '1.2.1', label: 'Apple' })?.body).toBe('shipped');
  });

  it('rejects anything that is not a delivery tag', () => {
    expect(() => parseTag('v1.0.21')).toThrow();
    expect(() => parseTag('npm-1.0.21')).toThrow();
    expect(() => parseTag('kiro-v1.0.0')).toThrow(/unknown channel/);
  });
});
