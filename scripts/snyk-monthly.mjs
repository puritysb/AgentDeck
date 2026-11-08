#!/usr/bin/env node
/**
 * Monthly Snyk comparison (docs/security-scanning.md § Snyk trial 2026-11-08).
 *
 * Reads a Snyk Code SARIF file and any number of `snyk test --json` outputs,
 * compares them with the triaged baseline in security/snyk-baseline.json and
 * writes `summary.md` and `new-findings.json` to the output directory. Only
 * findings that are not in the baseline are "new"; the workflow opens an issue
 * for those. This script never fails on findings: Snyk is an advisory second
 * opinion here, and a malformed input is the only error.
 *
 *   node scripts/snyk-monthly.mjs --code code.sarif --oss oss.json [--oss more.json] \
 *     [--baseline security/snyk-baseline.json] [--out diagnostics/snyk]
 *   node scripts/snyk-monthly.mjs --code code.sarif --oss oss.json --write-baseline
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Snyk Code results; `identity` survives code motion, `0` is an exact-content hash. */
export function codeFindings(sarif) {
  const run = sarif?.runs?.[0];
  if (!run || !Array.isArray(run.results)) throw new Error('Not a Snyk Code SARIF file');
  return run.results.map((r) => {
    const loc = r.locations?.[0]?.physicalLocation;
    return {
      kind: 'code',
      key: r.fingerprints?.identity ?? r.fingerprints?.['0'] ?? `${r.ruleId}:${loc?.artifactLocation?.uri}:${loc?.region?.startLine}`,
      alt: r.fingerprints?.['0'] ?? null,
      rule: r.ruleId,
      level: r.level,
      file: decodeURIComponent(loc?.artifactLocation?.uri ?? ''),
      line: loc?.region?.startLine ?? 0,
      message: String(r.message?.text ?? '').slice(0, 200),
    };
  });
}

/** Open-source results, one per advisory and package version. */
export function ossFindings(json) {
  const projects = Array.isArray(json) ? json : [json];
  const out = new Map();
  for (const p of projects) {
    if (!p || typeof p !== 'object') throw new Error('Not a snyk test JSON file');
    if (p.error && !Array.isArray(p.vulnerabilities)) throw new Error(`snyk test failed: ${String(p.error).slice(0, 200)}`);
    for (const v of p.vulnerabilities ?? []) {
      const key = `${v.id}@${v.packageName}@${v.version}`;
      if (!out.has(key)) {
        out.set(key, {
          kind: 'oss', key, alt: null, rule: v.id, level: v.severity,
          file: p.displayTargetFile ?? p.targetFile ?? '', line: 0,
          message: `${v.packageName}@${v.version}: ${v.title}`.slice(0, 200),
        });
      }
    }
  }
  return [...out.values()];
}

export function compare(findings, baseline) {
  const known = new Set();
  for (const e of baseline.findings ?? []) { known.add(e.key); if (e.alt) known.add(e.alt); }
  const fresh = findings.filter((f) => !known.has(f.key) && !(f.alt && known.has(f.alt)));
  const seen = new Set(findings.flatMap((f) => [f.key, f.alt].filter(Boolean)));
  const gone = (baseline.findings ?? []).filter((e) => !seen.has(e.key) && !(e.alt && seen.has(e.alt)));
  return { fresh, gone };
}

const ORDER = ['critical', 'error', 'high', 'warning', 'medium', 'low', 'note'];
const rank = (l) => { const i = ORDER.indexOf(l); return i < 0 ? ORDER.length : i; };

export function summary({ findings, fresh, gone }) {
  const lines = ['# Snyk monthly comparison', '',
    `${findings.length} findings in this scan, **${fresh.length} new** against security/snyk-baseline.json, ${gone.length} baseline entries no longer reported.`, ''];
  if (fresh.length) {
    lines.push('| Level | Rule | Where | Message |', '|---|---|---|---|');
    for (const f of [...fresh].sort((a, b) => rank(a.level) - rank(b.level))) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`| ${f.level} | \`${f.rule}\` | \`${where}\` | ${f.message.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    }
    lines.push('', 'Triage each one: fix it, or add it to the baseline with a reason (`--write-baseline`, then edit `decision`).');
  }
  return lines.join('\n') + '\n';
}

function args(argv) {
  const a = { code: [], oss: [], baseline: join(ROOT, 'security/snyk-baseline.json'), out: join(ROOT, 'diagnostics/snyk'), write: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--code') a.code.push(argv[++i]);
    else if (k === '--oss') a.oss.push(argv[++i]);
    else if (k === '--baseline') a.baseline = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--write-baseline') a.write = true;
    else throw new Error(`Unknown argument ${k}`);
  }
  if (!a.code.length && !a.oss.length) throw new Error('Pass at least one --code or --oss file');
  return a;
}

function main() {
  const a = args(process.argv.slice(2));
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const findings = [...a.code.flatMap((p) => codeFindings(read(p))), ...a.oss.flatMap((p) => ossFindings(read(p)))];
  let baseline = { findings: [] };
  try { baseline = read(a.baseline); } catch (e) { if (!a.write) throw e; }
  if (a.write) {
    const prior = new Map((baseline.findings ?? []).map((e) => [e.key, e]));
    const entries = findings.map(({ kind, key, alt, rule, level, file }) => ({
      kind, key, alt, rule, level, file,
      decision: prior.get(key)?.decision ?? (alt && [...prior.values()].find((e) => e.alt === alt)?.decision) ?? 'recorded, not individually reviewed',
    }));
    writeFileSync(a.baseline, JSON.stringify({ ...baseline, findings: entries }, null, 2) + '\n');
    console.log(`Baseline written: ${entries.length} findings`);
    return;
  }
  const { fresh, gone } = compare(findings, baseline);
  mkdirSync(a.out, { recursive: true });
  writeFileSync(join(a.out, 'summary.md'), summary({ findings, fresh, gone }));
  writeFileSync(join(a.out, 'new-findings.json'), JSON.stringify(fresh, null, 2) + '\n');
  console.log(`${findings.length} findings, ${fresh.length} new, ${gone.length} gone`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(String(e?.message ?? e)); process.exit(2); }
}
