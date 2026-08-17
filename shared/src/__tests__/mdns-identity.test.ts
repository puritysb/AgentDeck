/**
 * The instance name two daemons publish on one segment, and the gate that
 * keeps the Swift mirror from drifting away from this source.
 *
 * The value of this name is entirely in being computed the same way twice: the
 * previous shape (`AgentDeck-9120`) was byte-identical on every machine in an
 * office, which is what turned a name conflict into a permanent republish storm
 * (docs/ENTERPRISE-ROADMAP.md §2.1).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buildMdnsInstanceName,
  mdnsUserTag,
  sanitizeMdnsLabel,
  MDNS_TXT_SCHEMA_VERSION,
  MDNS_HOST_LABEL_MAX,
} from '../mdns-identity.js';
// The generator imports shared/dist at CLI time, but its emitters are pure —
// importing them here gates drift in CI whether or not the CLI was ever run.
import { OUTPUTS } from '../../../scripts/generate-mdns-identity.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('sanitizeMdnsLabel', () => {
  it('keeps a hostname greppable and collision-free', () => {
    expect(sanitizeMdnsLabel("Sam's MacBook Pro")).toBe('Sam-s-MacBook-Pro');
    expect(sanitizeMdnsLabel('mac-mini.local')).toBe('mac-mini');
    expect(sanitizeMdnsLabel('---weird---')).toBe('weird');
    expect(sanitizeMdnsLabel('한글호스트')).toBe('');
  });

  it('bounds the label so the whole instance name stays inside DNS-SD limits', () => {
    expect(sanitizeMdnsLabel('a'.repeat(80)).length).toBe(MDNS_HOST_LABEL_MAX);
    expect(buildMdnsInstanceName({
      project: 'AgentDeck', hostname: 'x'.repeat(80), userTag: 'abcd', port: 9120,
    }).length).toBeLessThanOrEqual(63);
  });
});

describe('mdnsUserTag', () => {
  it('is stable, short, and never the account name', () => {
    const tag = mdnsUserTag(501, 'puritysb');
    expect(tag).toMatch(/^[0-9a-f]{4}$/);
    expect(tag).toBe(mdnsUserTag(501, 'puritysb'));
    expect(tag).not.toContain('puritysb');
  });

  it('separates two accounts on one machine', () => {
    expect(mdnsUserTag(501, 'alice')).not.toBe(mdnsUserTag(502, 'bob'));
  });
});

describe('buildMdnsInstanceName', () => {
  it('names host, user and port — the three ways two daemons can differ', () => {
    expect(buildMdnsInstanceName({
      project: 'AgentDeck', hostname: 'mac-mini.local', userTag: 'a1b2', port: 9120,
    })).toBe('AgentDeck-mac-mini-a1b2-9120');
  });

  it('degrades to the old shape rather than emitting a malformed name', () => {
    // A platform that cannot answer one of the questions must not produce
    // `AgentDeck--9120`, which would be a new way to collide, not a fallback.
    expect(buildMdnsInstanceName({ project: 'AgentDeck', port: 9120 }))
      .toBe('AgentDeck-9120');
    expect(buildMdnsInstanceName({ project: 'AgentDeck', hostname: '한글', userTag: '', port: 9121 }))
      .toBe('AgentDeck-9121');
  });
});

describe('generated Swift mirror', () => {
  it('matches this source', () => {
    for (const [rel, emit] of OUTPUTS as Array<[string, (r: unknown) => string]>) {
      const onDisk = readFileSync(join(repoRoot, rel), 'utf8');
      expect(onDisk, `${rel} drifted — run pnpm generate-mdns-identity`).toBe(
        emit({ txtSchemaVersion: MDNS_TXT_SCHEMA_VERSION, hostLabelMax: MDNS_HOST_LABEL_MAX }),
      );
    }
  });
});
