/**
 * The public "What we verify" page is only honest while it matches the repo.
 *
 * scripts/verification-catalog.json is rendered by the Build Health report on
 * GitHub Pages. Before it existed the report classified 26 of 326 test files by
 * a hand-kept list (the rest landed in "Other Tests") and its scenario matrix
 * pointed at test files that had been deleted. These checks keep the catalog
 * from drifting the same way: every workflow is accounted for, every path it
 * names exists, every test file lands in a domain (domains are ordered and the
 * first match wins, so a timeline test of the Gateway counts as Timeline), and
 * no domain pattern is dead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

interface Gate {
  id: string;
  level: string[];
  workflow: string | null;
  report_suite?: string;
  evidence?: string[];
  proves: string[];
  does_not_prove: string[];
  command: string;
}
interface Domain { id: string; match: string[] }
interface Catalog {
  levels: Record<string, string>;
  gates: Gate[];
  not_a_gate: Record<string, string>;
  not_verified: Array<{ what: string; why: string; instead: string }>;
  domains: Domain[];
}

const catalog = JSON.parse(readFileSync(join(ROOT, 'scripts/verification-catalog.json'), 'utf8')) as Catalog;

/** `*` matches within one path segment — the same rule generate-html-report.py applies. */
function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${body}$`);
}

function trackedTestFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.test.ts', 'tests/e2e/*.e2e.test.ts'], { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(Boolean))].filter((f) => !f.startsWith('android/') && !f.startsWith('apple/'));
}

describe('verification catalog', () => {
  it('accounts for every GitHub workflow as a gate or a stated non-gate', () => {
    const workflows = readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')).map((f) => `.github/workflows/${f}`);
    const listed = new Set([...catalog.gates.map((g) => g.workflow).filter(Boolean), ...Object.keys(catalog.not_a_gate)]);
    expect(workflows.filter((w) => !listed.has(w))).toEqual([]);
    expect([...listed].filter((w) => !existsSync(join(ROOT, w!)))).toEqual([]);
  });

  it('names only files that exist', () => {
    const missing = catalog.gates.flatMap((g) => g.evidence ?? []).filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('states, for every gate, what it proves and what it does not', () => {
    const levels = new Set(Object.keys(catalog.levels));
    for (const gate of catalog.gates) {
      expect(gate.proves.length, gate.id).toBeGreaterThan(0);
      expect(gate.does_not_prove.length, gate.id).toBeGreaterThan(0);
      expect(gate.level.filter((l) => !levels.has(l)), gate.id).toEqual([]);
    }
    expect(new Set(catalog.gates.map((g) => g.id)).size).toBe(catalog.gates.length);
  });

  it('refers only to package scripts that exist', () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    const named = catalog.gates.flatMap((g) => [...g.command.matchAll(/pnpm ([a-z][\w:-]*)/g)].map((m) => m[1]));
    expect(named.filter((s) => !(s in scripts) && !['build', 'typecheck', 'test'].includes(s!))).toEqual([]);
  });

  it('puts every tracked TypeScript test file in a domain', () => {
    const res = catalog.domains.flatMap((d) => d.match.map(globToRegExp));
    expect(trackedTestFiles().filter((f) => !res.some((re) => re.test(f)))).toEqual([]);
  });

  it('has no domain pattern that matches nothing', () => {
    const files = trackedTestFiles();
    const dead = catalog.domains.flatMap((d) => d.match.filter((g) => !files.some((f) => globToRegExp(g).test(f))).map((g) => `${d.id}: ${g}`));
    expect(dead).toEqual([]);
  });

  it('keeps the scenario matrix pointing at test files that exist', () => {
    const matrix = JSON.parse(readFileSync(join(ROOT, 'scripts/scenario-matrix.json'), 'utf8')) as {
      scenarios: Array<{ id: string; tests: Record<string, Array<{ file: string }>> }>;
    };
    const missing = matrix.scenarios.flatMap((s) =>
      Object.values(s.tests).flat().map((t) => t.file).filter((f) => !existsSync(join(ROOT, f))).map((f) => `${s.id}: ${f}`));
    expect(missing).toEqual([]);
  });
});
