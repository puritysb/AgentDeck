import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditInventory, queryOsv, runAudit, runtimeCoordinates } from '../audit-android-runtime.mjs';

const module = (name = 'first', version = '1.0') => ({ group: 'test.example', name, version });
const inventory = () => ({ schema: 1, configurations: {
  debugRuntimeClasspath: [module(), module('second')], releaseRuntimeClasspath: [module(), module('second', '2.0')],
} });
const response = (results: unknown[]) => new Response(JSON.stringify({ results }));
const advisory = (id = 'GHSA-test-1234-5678') => ({ id, modified: '2026-11-04T00:00:00Z' });
let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; vi.useRealTimers(); });

describe('Android runtime inventory and advisory audit', () => {
  it('deduplicates coordinates across both variants while retaining distinct selected versions', () => {
    const rows = runtimeCoordinates(inventory());
    expect(rows).toEqual([
      { name: 'test.example:first', version: '1.0', configurations: ['debugRuntimeClasspath', 'releaseRuntimeClasspath'] },
      { name: 'test.example:second', version: '1.0', configurations: ['debugRuntimeClasspath'] },
      { name: 'test.example:second', version: '2.0', configurations: ['releaseRuntimeClasspath'] },
    ]);
  });

  it('refuses missing/empty variants, unresolved versions and malformed module identities', () => {
    for (const bad of [null, {}, { ...inventory(), schema: 2 }, { schema: 1, configurations: { debugRuntimeClasspath: [module()] } }]) {
      expect(() => runtimeCoordinates(bad)).toThrow();
    }
    for (const bad of [[], [module('first', '1.+')], [module('first', 'unspecified')], [module('bad:name')], [module('first', 'latest.release')]]) {
      expect(() => runtimeCoordinates({ ...inventory(), configurations: { ...inventory().configurations, releaseRuntimeClasspath: bad } })).toThrow();
    }
  });

  it('drains only the paginated query and correlates results back to their original coordinates', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([
      { vulns: [advisory()], next_page_token: 'first-page' }, {},
    ])).mockResolvedValueOnce(response([{ vulns: [advisory(), advisory('OSV-second')] }]));
    const result = await queryOsv([{ name: 'a:a', version: '1' }, { name: 'b:b', version: '2' }], fetcher);
    expect(result[0].vulnerabilities.map((v: {id: string}) => v.id)).toEqual(['GHSA-test-1234-5678', 'OSV-second']);
    expect(result[1].vulnerabilities).toEqual([]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ queries: [
      { package: { ecosystem: 'Maven', name: 'a:a' }, version: '1', page_token: 'first-page' },
    ] });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', method: 'POST', signal: expect.any(AbortSignal) });
  });

  it('keeps positional correspondence when the inventory crosses a batch boundary', async () => {
    const coordinates = Array.from({ length: 101 }, (_, i) => ({ name: `g:p${i}`, version: '1' }));
    const fetcher = vi.fn().mockResolvedValueOnce(response(coordinates.slice(0, 100).map(() => ({}))))
      .mockResolvedValueOnce(response([{ vulns: [advisory()] }]));
    const results = await queryOsv(coordinates, fetcher);
    expect(results.slice(0, 100).every((r: {vulnerabilities: unknown[]}) => !r.vulnerabilities.length)).toBe(true);
    expect(results[100]).toMatchObject({ name: 'g:p100', vulnerabilities: [advisory()] });
  });

  it('fails on missing results, unexpected schemas, bad advisory records and network/HTTP errors', async () => {
    const rows = [{ name: 'g:p', version: '1' }];
    for (const data of [{}, { results: [] }, { results: [null] }, { results: [{ error: 'unavailable' }] },
      { results: [{ vulns: {} }] }, { results: [{ vulns: [{}] }] }, { results: [{ next_page_token: 123 }] }]) {
      await expect(queryOsv(rows, async () => new Response(JSON.stringify(data)))).rejects.toThrow();
    }
    await expect(queryOsv(rows, async () => new Response('unavailable', { status: 503 }))).rejects.toThrow('HTTP 503');
    await expect(queryOsv(rows, async () => { throw new Error('network'); })).rejects.toThrow('network');
    await expect(queryOsv(rows, async () => new Response('not json'))).rejects.toThrow();
  });

  it('refuses looping or excessive pagination rather than reporting a partial clean scan', async () => {
    const rows = [{ name: 'g:p', version: '1' }];
    await expect(queryOsv(rows, async () => response([{ next_page_token: 'again' }]))).rejects.toThrow('repeated');
    let n = 0;
    await expect(queryOsv(rows, async () => response([{ next_page_token: `page-${++n}` }]))).rejects.toThrow('page limit');
    expect(n).toBe(20);
  });

  it('bounds response bytes and the total query budget', async () => {
    const rows = [{ name: 'g:p', version: '1' }];
    await expect(queryOsv(rows, async () => new Response(' '.repeat(4 * 1024 * 1024 + 1)))).rejects.toThrow('byte limit');
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => { vi.setSystemTime(Date.now() + 120_001); return response([{ next_page_token: 'later' }]); });
    await expect(queryOsv(rows, fetcher)).rejects.toThrow('total time budget');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires the positive control but excludes its known vulnerabilities from product findings', async () => {
    const fetcher = vi.fn(async (_url: string, options: {body: string}) => {
      const { queries } = JSON.parse(options.body);
      return response(queries.map((q: {package: {name: string}}) => q.package.name === 'com.google.guava:guava' ? { vulns: [advisory()] } : {}));
    });
    const result = await auditInventory(inventory(), fetcher);
    expect(result.blocked).toBe(false);
    expect(result.positiveControl).toMatchObject({ name: 'com.google.guava:guava', version: '27.0-jre', vulnerabilities: [advisory()] });
    expect(result.coordinates).toHaveLength(3);
    await expect(auditInventory(inventory(), async () => response([{}, {}, {}, {}]))).rejects.toThrow('control');
  });

  it('blocks every unreviewed product advisory match and retains the affected variants', async () => {
    const result = await auditInventory(inventory(), async () => response([
      { vulns: [advisory('OSV-product')] }, {}, {}, { vulns: [advisory()] },
    ]));
    expect(result.blocked).toBe(true);
    expect(result.coordinates[0]).toMatchObject({ configurations: ['debugRuntimeClasspath', 'releaseRuntimeClasspath'], vulnerabilities: [advisory('OSV-product')] });
  });

  it('replaces an old pass with explicit error evidence if runtime resolution fails', async () => {
    directory = mkdtempSync(join(tmpdir(), 'android-audit-'));
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ status: 'pass' }));
    await expect(runAudit(directory, { collect: () => { throw new Error('unresolved runtime dependency'); } })).rejects.toThrow('unresolved');
    expect(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'))).toMatchObject({ status: 'error', error: 'unresolved runtime dependency' });
    expect(readFileSync(join(directory, 'summary.md'), 'utf8')).toContain('no successful scan');
  });
});
