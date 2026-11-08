import { describe, expect, it } from 'vitest';
import { cell, codeFindings, compare, ossFindings, summary } from '../snyk-monthly.mjs';

const sarif = (results: unknown[]) => ({ runs: [{ results }] });
const codeResult = (identity: string, fp0: string, ruleId = 'javascript/PT', line = 10) => ({
  ruleId, level: 'error', message: { text: 'Unsanitized input | flows' },
  fingerprints: { identity, 0: fp0 },
  locations: [{ physicalLocation: { artifactLocation: { uri: 'bridge/src/a%20b.ts' }, region: { startLine: line } } }],
});

describe('snyk monthly comparison', () => {
  it('reads code findings by identity and decodes the file path', () => {
    const [f] = codeFindings(sarif([codeResult('id-1', 'h-1')]));
    expect(f).toMatchObject({ key: 'id-1', alt: 'h-1', rule: 'javascript/PT', file: 'bridge/src/a b.ts', line: 10 });
  });

  it('dedupes open-source findings across paths and projects', () => {
    const vuln = { id: 'SNYK-1', packageName: 'qs', version: '6.13.0', severity: 'high', title: 'x' };
    const found = ossFindings([{ vulnerabilities: [vuln, vuln] }, { vulnerabilities: [vuln] }]);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('SNYK-1@qs@6.13.0');
  });

  it('treats a matching identity or exact hash as known, and reports the rest', () => {
    const found = codeFindings(sarif([codeResult('id-1', 'h-1'), codeResult('id-moved', 'h-2'), codeResult('id-3', 'h-3')]));
    const baseline = { findings: [{ key: 'id-1', alt: 'h-1' }, { key: 'id-2', alt: 'h-2' }, { key: 'id-old', alt: 'h-old' }] };
    const { fresh, gone } = compare(found, baseline);
    expect(fresh.map((f: { key: string }) => f.key)).toEqual(['id-3']);
    expect(gone.map((e: { key: string }) => e.key)).toEqual(['id-old']);
  });

  it('refuses inputs that are not Snyk output instead of reporting zero', () => {
    expect(() => codeFindings({})).toThrow();
    expect(() => ossFindings({ error: 'Authentication failed' })).toThrow(/snyk test failed/);
  });

  it('escapes table separators in the summary', () => {
    const found = codeFindings(sarif([codeResult('id-9', 'h-9')]));
    const text = summary({ findings: found, fresh: found, gone: [] });
    expect(text).toContain('**1 new**');
    expect(text).toContain('Unsanitized input \\| flows');
  });
});

describe('summary table cells', () => {
  it('escapes backslashes before pipes so a cell cannot end early', () => {
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
    expect(cell('x\ny')).toBe('x y');
  });
});
