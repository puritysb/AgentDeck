import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLocallyTrusted, localTrustVerdict, type LocalTrustEnvironment, type LocalTrustRequest } from '../local-trust.js';

const { environment, cases } = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../local-trust-vectors.json', import.meta.url)), 'utf8',
)) as {
  environment: { port: number; localAddresses: string[]; hostNames: string[] };
  cases: Array<{ note: string; hostNames?: string[]; request: LocalTrustRequest; verdict: string }>;
};

const env: LocalTrustEnvironment = {
  port: environment.port,
  isLocalAddress: (ip) => environment.localAddresses.includes(ip),
  hostNames: environment.hostNames,
};

describe('local trust (shared vectors)', () => {
  it('has vectors for every verdict', () => {
    expect(new Set(cases.map((c) => c.verdict))).toEqual(new Set(['trusted', 'foreign-host', 'foreign-origin']));
  });
  for (const c of cases) {
    it(c.note, () => {
      const caseEnv = c.hostNames ? { ...env, hostNames: c.hostNames } : env;
      expect(localTrustVerdict(c.request, caseEnv)).toBe(c.verdict);
      expect(isLocallyTrusted(c.request, caseEnv)).toBe(c.verdict === 'trusted');
    });
  }
});

describe('local trust environment', () => {
  it('asks isLocalAddress only about an IP origin, without brackets or zone', () => {
    const asked: string[] = [];
    const probe: LocalTrustEnvironment = { ...env, isLocalAddress: (ip) => { asked.push(ip); return true; } };
    localTrustVerdict({ method: 'POST', host: '127.0.0.1:9120', origin: 'http://[fe80::1%25en0]:9120' }, probe);
    localTrustVerdict({ method: 'POST', host: '127.0.0.1:9120', origin: 'http://localhost:9120' }, probe);
    expect(asked).toEqual(['fe80::1']);
  });

});
