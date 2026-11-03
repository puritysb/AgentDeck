import { describe, expect, it } from 'vitest';
import { evaluate } from '../security-audit.mjs';

const report = (severity = 'high', version = '3.25.76') => ({
  advisories: { 1: { github_advisory_id: 'GHSA-mrhx-c7xc-m3w5', module_name: 'zod', severity,
    findings: [{ version, paths: ['plugin>@elgato/utils>zod'] }] } },
  metadata: { vulnerabilities: { [severity]: 1 } },
});
const exception = { advisory: 'GHSA-mrhx-c7xc-m3w5', package: 'zod', version: '3.25.76',
  severity: 'high', owner: 'maintainer', reason: 'Major migration pending', tracking: 'issue', expires: '2026-11-17' };
const now = new Date('2026-11-03T00:00:00Z');

describe('dependency audit gate', () => {
  it('blocks a new high or critical finding while retaining moderate findings', () => {
    expect(evaluate(report(), { exceptions: [] }, now).blocked).toBe(true);
    expect(evaluate(report('critical'), { exceptions: [] }, now).blocked).toBe(true);
    const r = evaluate(report('moderate'), { exceptions: [] }, now);
    expect(r.blocked).toBe(false);
    expect(r.findings).toHaveLength(1);
  });

  it('keeps reviewed risk visible and limits the exception to the exact package version', () => {
    const policy = { exceptions: [exception] };
    const r = evaluate(report(), policy, now);
    expect(r.blocked).toBe(false);
    expect(r.findings[0].exception).toEqual(exception);
    expect(evaluate(report('high', '3.25.75'), policy, now).blocked).toBe(true);
    expect(evaluate(report('critical'), policy, now).blocked).toBe(true);
    const other = report(); other.advisories[1].module_name = 'other';
    expect(evaluate(other, policy, now).blocked).toBe(true);
  });

  it('fails on expired, duplicate or incomplete exceptions even with no advisories', () => {
    const empty = { advisories: {}, metadata: { vulnerabilities: { high: 0 } } };
    expect(() => evaluate(empty, { exceptions: [exception] }, new Date('2026-11-17'))).toThrow('Expired');
    expect(() => evaluate(empty, { exceptions: [exception, exception] }, now)).toThrow('Invalid');
    expect(() => evaluate(empty, { exceptions: [{ ...exception, owner: '' }] }, now)).toThrow('Invalid');
  });

  it('fails closed on registry errors, changed output schemas or missing advisories', () => {
    for (const r of [{ error: 'offline' }, {}, { advisories: {}, metadata: { vulnerabilities: { high: 1 } } }, report('unknown')]) {
      expect(() => evaluate(r, { exceptions: [] }, now)).toThrow();
    }
  });
});
