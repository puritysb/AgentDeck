import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const levels = ['info', 'low', 'moderate', 'high', 'critical'];

// An exception is tied to an advisory, package and exact installed version.
// It stays visible in the report, and expires even if no dependencies change.
export function evaluate(report, policy, now = new Date()) {
  if (!report || report.error || !report.advisories || !report.metadata?.vulnerabilities) {
    throw new Error('Incomplete audit response; the registry may be unavailable');
  }
  if (!Array.isArray(policy.exceptions)) throw new Error('Invalid exception policy');
  const today = now.toISOString().slice(0, 10);
  const seen = new Set();
  for (const e of policy.exceptions) {
    const key = `${e.advisory}:${e.package}:${e.version}`;
    if (!/^GHSA-[\w-]+$/.test(e.advisory) || !e.package || !e.version ||
        !levels.includes(e.severity) || !e.owner || !e.reason || !e.tracking || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires) ||
        !Number.isFinite(Date.parse(e.expires)) || seen.has(key)) throw new Error(`Invalid exception: ${key}`);
    if (e.expires <= today) throw new Error(`Expired exception: ${key} (${e.expires})`);
    seen.add(key);
  }
  const findings = Object.values(report.advisories).flatMap(a => {
    if (!levels.includes(a.severity) || !a.github_advisory_id || !a.module_name || !a.findings?.length) {
      throw new Error('Unknown advisory schema');
    }
    return a.findings.map(f => {
      if (!f.version || !Array.isArray(f.paths)) throw new Error('Missing affected version or paths');
      const exception = policy.exceptions.find(e => e.advisory === a.github_advisory_id &&
        e.package === a.module_name && e.version === f.version && e.severity === a.severity);
      return { advisory: a.github_advisory_id, package: a.module_name, version: f.version,
        severity: a.severity, paths: f.paths, url: a.url, exception: exception ?? null,
        blocking: levels.indexOf(a.severity) >= levels.indexOf('high') && !exception };
    });
  });
  const expected = Object.values(report.metadata.vulnerabilities).reduce((n, v) => n + v, 0);
  if (!Number.isFinite(expected) || (expected > 0 && findings.length === 0)) throw new Error('Inconsistent audit response');
  return { counts: report.metadata.vulnerabilities, findings, blocked: findings.some(f => f.blocking) };
}

export function main() {
  const dir = resolve(process.argv[2] ?? 'diagnostics/security-audit');
  mkdirSync(dir, { recursive: true });
  const policy = JSON.parse(readFileSync('security/audit-policy.json', 'utf8'));
  const receipt = {
    capturedAt: new Date().toISOString(),
    commit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    lockfileSha256: createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex'),
    policySha256: createHash('sha256').update(readFileSync('security/audit-policy.json')).digest('hex'),
    scopes: {},
  };
  let blocked = false;
  for (const [scope, extra] of [['all', []], ['production', ['--prod']]]) {
    const result = spawnSync('pnpm', ['audit', '--json', ...extra], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '30000' },
      shell: process.platform === 'win32',
    });
    writeFileSync(resolve(dir, `${scope}.json`), result.stdout ?? '');
    if (result.error || ![0, 1].includes(result.status)) throw new Error(`${scope}: audit execution failed (${result.error ?? result.stderr})`);
    const evaluated = evaluate(JSON.parse(result.stdout), policy);
    receipt.scopes[scope] = evaluated;
    blocked ||= evaluated.blocked;
    console.log(`${scope}: ${JSON.stringify(evaluated.counts)}; unreviewed high/critical: ${evaluated.findings.filter(f => f.blocking).length}`);
  }
  writeFileSync(resolve(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  const lines = ['# Dependency audit', '', `Captured: ${receipt.capturedAt}`, `Lockfile SHA-256: ${receipt.lockfileSha256}`, '',
    '| Scope | Critical | High | Moderate | Low | Blocking findings |', '|---|---:|---:|---:|---:|---:|'];
  for (const [scope, r] of Object.entries(receipt.scopes)) {
    lines.push(`| ${scope} | ${r.counts.critical} | ${r.counts.high} | ${r.counts.moderate} | ${r.counts.low} | ${r.findings.filter(f => f.blocking).length} |`);
    for (const f of r.findings.filter(f => f.exception)) lines.push(`\nReviewed exception (${scope}): ${f.advisory}, ${f.package}@${f.version}; expires ${f.exception.expires}. ${f.exception.reason}`);
  }
  writeFileSync(resolve(dir, 'summary.md'), lines.join('\n') + '\n');
  if (blocked) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Security audit failed: ${error.message}`); process.exitCode = 1; }
}
