#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIGURATIONS = ['debugRuntimeClasspath', 'releaseRuntimeClasspath'];
const CONTROL = { name: 'com.google.guava:guava', version: '27.0-jre' };
const LIMITS = { coordinates: 10_000, batch: 100, pages: 20, responseBytes: 4 * 1024 * 1024 };
const COVERAGE = [
  'Matches resolved Maven coordinates against OSV; a match is not proof of exploitability.',
  'No claim of complete advisory coverage: release-note review remains necessary (the prior OkHttp certificate correction was not matched).',
  'AAR-internal native libraries, Android/SDK operating-system components and installed device versions are outside this scan.',
];

export function runtimeCoordinates(inventory) {
  if (inventory?.schema !== 1 || !inventory.configurations ||
      Object.keys(inventory.configurations).sort().join() !== [...CONFIGURATIONS].sort().join()) {
    throw new Error('Incomplete runtime inventory: both debug and release graphs are required');
  }
  const coordinates = new Map();
  for (const configuration of CONFIGURATIONS) {
    const rows = inventory.configurations[configuration];
    if (!Array.isArray(rows) || !rows.length || rows.length > LIMITS.coordinates) throw new Error(`Invalid runtime graph: ${configuration}`);
    for (const row of rows) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(row?.group ?? '') || !/^[a-zA-Z0-9_.-]+$/.test(row?.name ?? '') ||
          typeof row.version !== 'string' || !row.version || row.version.length > 200 ||
          /[\s:[\](),+]/.test(row.version) || row.version === 'unspecified' || row.version.startsWith('latest.')) {
        throw new Error('Unresolved or malformed Maven coordinate');
      }
      const name = `${row.group}:${row.name}`, key = `${name}:${row.version}`;
      const entry = coordinates.get(key) ?? { name, version: row.version, configurations: [] };
      if (!entry.configurations.includes(configuration)) entry.configurations.push(configuration);
      coordinates.set(key, entry);
      if (coordinates.size > LIMITS.coordinates) throw new Error('Runtime inventory exceeds coordinate limit');
    }
  }
  return [...coordinates.values()].sort((a, b) => `${a.name}:${a.version}`.localeCompare(`${b.name}:${b.version}`));
}

async function responseJson(response) {
  if (!response.ok) throw new Error(`OSV request failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('OSV response has no body');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMITS.responseBytes) throw new Error('OSV response exceeds byte limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** OSV guarantees positional results, including empty objects for no match.
 * Drain each query's own page token; never turn a truncated page into success.
 * https://google.github.io/osv.dev/post-v1-querybatch/ */
export async function queryOsv(coordinates, fetcher = fetch) {
  const findings = coordinates.map(() => new Map());
  const deadline = Date.now() + 120_000;
  for (let offset = 0; offset < coordinates.length; offset += LIMITS.batch) {
    let pending = coordinates.slice(offset, offset + LIMITS.batch).map((c, i) => ({
      index: offset + i, query: { package: { ecosystem: 'Maven', name: c.name }, version: c.version }, tokens: new Set(),
    }));
    for (let page = 0; pending.length; page++) {
      if (page >= LIMITS.pages) throw new Error('OSV pagination exceeds page limit');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('OSV audit exceeded total time budget');
      const response = await fetcher('https://api.osv.dev/v1/querybatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(Math.min(30_000, remaining)), body: JSON.stringify({ queries: pending.map(p => p.query) }),
      });
      const data = await responseJson(response);
      if (!Array.isArray(data?.results) || data.results.length !== pending.length || data.error) throw new Error('Incomplete OSV result list');
      const next = [];
      for (const [i, result] of data.results.entries()) {
        if (!result || typeof result !== 'object' || Array.isArray(result) ||
            Object.keys(result).some(key => !['vulns', 'next_page_token'].includes(key)) ||
            (result.vulns !== undefined && !Array.isArray(result.vulns))) throw new Error('Invalid OSV result schema');
        const item = pending[i];
        for (const vulnerability of result.vulns ?? []) {
          if (typeof vulnerability?.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{1,199}$/.test(vulnerability.id)) throw new Error('Invalid OSV advisory');
          findings[item.index].set(vulnerability.id, vulnerability);
        }
        if (result.next_page_token !== undefined) {
          const token = result.next_page_token;
          if (typeof token !== 'string' || !token || token.length > 4096 || item.tokens.has(token)) throw new Error('Invalid or repeated OSV page token');
          item.tokens.add(token);
          next.push({ ...item, query: { ...item.query, page_token: token } });
        }
      }
      pending = next;
    }
  }
  return coordinates.map((coordinate, i) => ({ ...coordinate, vulnerabilities: [...findings[i].values()].sort((a, b) => a.id.localeCompare(b.id)) }));
}

export async function auditInventory(inventory, fetcher = fetch) {
  const coordinates = runtimeCoordinates(inventory);
  const results = await queryOsv([...coordinates, CONTROL], fetcher);
  const control = results.pop();
  if (!control.vulnerabilities.length) throw new Error('Known-vulnerable OSV control returned no advisories');
  return { coordinates: results, positiveControl: control, blocked: results.some(r => r.vulnerabilities.length > 0) };
}

export function collectInventory(output, offline = false) {
  if (process.platform === 'win32') throw new Error('Android native audit requires a POSIX Gradle build host');
  const inventoryPath = join(output, 'inventory.json');
  const result = spawnSync('./gradlew', [
    '--no-daemon', '--console=plain', '--quiet', ...(offline ? ['--offline'] : []),
    '-I', join(ROOT, 'scripts/android-runtime-inventory.gradle'),
    `-PagentdeckInventoryOutput=${inventoryPath}`, ':app:agentdeckRuntimeInventory',
  ], { cwd: join(ROOT, 'android'), encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(output, 'gradle.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error || result.status !== 0) throw new Error('Gradle runtime resolution failed; see gradle.log');
  return JSON.parse(readFileSync(inventoryPath, 'utf8'));
}

export async function runAudit(output, { offline = false, collect = collectInventory, fetcher = fetch } = {}) {
  mkdirSync(output, { recursive: true });
  const hash = path => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
  const receipt = { schema: 1, capturedAt: new Date().toISOString(), status: 'unknown',
    offlineResolution: offline, coverageLimits: COVERAGE };
  const save = () => writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  save(); // Replace any prior pass before collection or network work can fail.
  writeFileSync(join(output, 'summary.md'), '# Android runtime dependency audit\n\nStatus: unknown; scan has not completed.\n');
  try {
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 5_000 });
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', timeout: 5_000 });
    if (commit.error || commit.status !== 0 || status.error || status.status !== 0) throw new Error('Audit source identity is unavailable');
    Object.assign(receipt, { commit: commit.stdout.trim(), dirty: status.stdout.trim() !== '',
      sourceInputs: Object.fromEntries(['android/app/build.gradle.kts', 'android/build.gradle.kts',
        'android/settings.gradle.kts', 'android/gradle.properties', 'android/gradle/wrapper/gradle-wrapper.properties',
        'scripts/android-runtime-inventory.gradle', 'scripts/audit-android-runtime.mjs'].map(path => [path, hash(path)])) });
    const inventory = collect(output, offline);
    const result = await auditInventory(inventory, fetcher);
    Object.assign(receipt, { status: result.blocked ? 'blocked' : 'pass', inventory, ...result });
    const matched = result.coordinates.filter(r => r.vulnerabilities.length);
    const lines = ['# Android runtime dependency audit', '', `Status: **${receipt.status}**`,
      `Resolved Maven coordinates: ${result.coordinates.length} (debug + release runtime graphs).`,
      `Coordinates with advisory matches: ${matched.length}.`,
      `Positive control: Guava 27.0-jre matched ${result.positiveControl.vulnerabilities.length} advisory IDs; it is queried only, never installed.`, '',
      ...matched.map(r => `- ${r.name}@${r.version}: ${r.vulnerabilities.map(v => v.id).join(', ')}`), '',
      'Coverage limits:', ...COVERAGE.map(limit => `- ${limit}`)];
    writeFileSync(join(output, 'summary.md'), lines.join('\n') + '\n');
    return receipt;
  } catch (error) {
    receipt.status = 'error'; receipt.error = error.message;
    writeFileSync(join(output, 'summary.md'), '# Android runtime dependency audit\n\nStatus: **error**; no successful scan is claimed. See receipt.json and gradle.log.\n');
    throw error;
  } finally { save(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), offline = args.includes('--offline');
  const paths = args.filter(arg => arg !== '--offline');
  if (paths.length > 1 || paths.some(path => path.startsWith('--'))) {
    console.error('Usage: node scripts/audit-android-runtime.mjs [output-directory] [--offline]'); process.exitCode = 1;
  } else {
    try {
      const receipt = await runAudit(resolve(paths[0] ?? join(ROOT, 'diagnostics/android-audit')), { offline });
      console.log(`Android runtime audit: ${receipt.coordinates.length} Maven coordinates; ${receipt.status}; control ${receipt.positiveControl.vulnerabilities.length} advisory IDs`);
      if (receipt.blocked) process.exitCode = 1;
    } catch (error) { console.error(`Android runtime audit failed: ${error.message}`); process.exitCode = 1; }
  }
}
