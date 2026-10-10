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
import { globToRegExp as pathGlob } from '../verify.mjs';

const ROOT = resolve(__dirname, '../..');

interface Gate {
  id: string;
  level: string[];
  workflow: string | null;
  report_suite?: string;
  blocking: boolean;
  required?: boolean;
  evidence?: string[];
  files?: string[];
  proves: string[];
  does_not_prove: string[];
  command: string;
}
interface Domain { id: string; match: string[] }
interface Tier { id: string; name: string; command: string; when: string; budget: string; selects: string; does_not_replace: string }
interface Step {
  id: string;
  gate: string;
  tiers: string[];
  run?: string;
  builtin?: string;
  manual?: string;
  paths?: string[];
  needs?: string[];
}
interface Catalog {
  merge_policy: { as_of: string; summary: string };
  levels: Record<string, string>;
  tiers: Tier[];
  steps: Step[];
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

  it('calls a gate required only when it is a failing-CI check, and dates that claim', () => {
    // `required` mirrors master branch protection, which CI cannot read; the
    // date says when it was last compared by hand.
    const required = catalog.gates.filter((g) => g.required);
    expect(required.length).toBeGreaterThan(0);
    for (const gate of required) {
      expect(gate.blocking, gate.id).toBe(true);
      expect(gate.workflow, gate.id).toBeTruthy();
    }
    expect(catalog.merge_policy.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(catalog.merge_policy.summary.length).toBeGreaterThan(0);
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

  it('keeps every scenario name pattern present in its TypeScript test file', () => {
    // The report matches these patterns against test names; one that no longer
    // appears in the file renders as "not found" on the public page (four did,
    // e.g. "permission" in tier3-integration, which has no permission test).
    // A substring of the source is a static stand-in for the runtime name.
    const matrix = JSON.parse(readFileSync(join(ROOT, 'scripts/scenario-matrix.json'), 'utf8')) as {
      scenarios: Array<{ id: string; tests: Record<string, Array<{ file: string; patterns?: string[] }>> }>;
    };
    const stale: string[] = [];
    for (const s of matrix.scenarios) {
      for (const t of Object.values(s.tests).flat()) {
        if (!t.file.endsWith('.ts') || !existsSync(join(ROOT, t.file))) continue;
        const source = readFileSync(join(ROOT, t.file), 'utf8').toLowerCase();
        for (const p of t.patterns ?? ['*']) {
          if (p !== '*' && !source.includes(p.toLowerCase())) stale.push(`${s.id}: "${p}" not in ${t.file}`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});

describe('verification tiers', () => {
  const gates = new Map(catalog.gates.map((g) => [g.id, g]));
  const tierIds = catalog.tiers.map((t) => t.id);
  const inTier = (tier: string) => catalog.steps.filter((s) => s.tiers.includes(tier));

  it('defines exactly the changed, quick and pre-release tiers, each with a package script', () => {
    expect(tierIds).toEqual(['changed', 'quick', 'full']);
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    for (const tier of catalog.tiers) {
      const name = /^pnpm ([\w:-]+)$/.exec(tier.command)?.[1];
      expect(name && scripts[name], tier.command).toContain(`--tier ${tier.id}`);
      for (const field of ['when', 'budget', 'selects', 'does_not_replace'] as const) expect(tier[field].length, `${tier.id}.${field}`).toBeGreaterThan(0);
    }
  });

  it('gives every step a unique id, a known gate, known tiers and exactly one way to run', () => {
    expect(new Set(catalog.steps.map((s) => s.id)).size).toBe(catalog.steps.length);
    for (const step of catalog.steps) {
      expect(gates.has(step.gate), `${step.id} → ${step.gate}`).toBe(true);
      expect(step.tiers.length, step.id).toBeGreaterThan(0);
      expect(step.tiers.filter((t) => !tierIds.includes(t)), step.id).toEqual([]);
      expect([step.builtin ?? step.run, step.manual].filter(Boolean).length, step.id).toBe(1);
      for (const need of step.needs ?? []) expect(catalog.steps.some((s) => s.id === need), `${step.id} needs ${need}`).toBe(true);
    }
  });

  it('keeps lab steps in the pre-release tier only, and gives every lab gate a step there', () => {
    for (const step of catalog.steps.filter((s) => s.manual)) expect(step.tiers, step.id).toEqual(['full']);
    // A gate with no hosted workflow is only real if some tier makes a person run or attest it.
    const labGates = catalog.gates.filter((g) => !g.workflow).map((g) => g.id);
    expect(labGates.filter((id) => !inTier('full').some((s) => s.gate === id))).toEqual([]);
  });

  it('makes the pre-release tier cover every gate the quick tier does', () => {
    const fullGates = new Set(inTier('full').map((s) => s.gate));
    expect(inTier('quick').map((s) => s.gate).filter((g) => !fullGates.has(g))).toEqual([]);
  });

  it('runs only scripts and files that exist', () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    for (const step of catalog.steps.filter((s) => s.run && !s.builtin)) {
      for (const [, name] of step.run!.matchAll(/pnpm ([a-z][\w:-]*)/g)) {
        expect(name in scripts || ['build', 'typecheck', 'test'].includes(name!), `${step.id}: pnpm ${name}`).toBe(true);
      }
      for (const [, file] of step.run!.matchAll(/(?:node|bash|python3) ((?:scripts|design|esp32|apple)\/[\w./-]+)/g)) {
        expect(existsSync(join(ROOT, file!)), `${step.id}: ${file}`).toBe(true);
      }
    }
  });

  it('has no changed-area path that matches no tracked file', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const dead = catalog.steps.flatMap((s) => (s.paths ?? []).filter((g) => !tracked.some((f) => pathGlob(g).test(f))).map((g) => `${s.id}: ${g}`));
    expect(dead).toEqual([]);
  });

  it('runs every platform-gated test file on a CI runner of that platform', () => {
    // A case behind runIf/skipIf(process.platform …) is skipped on ubuntu; it
    // counts as verified only if a gate on that platform names its file. Before
    // macos-native-parity existed, the Swift parity vectors ran on no runner.
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const jobCommand = (job: string) => {
      const body = ci.split(new RegExp(`^  ${job}:$`, 'm'))[1]?.split(/^ {2}\S/m)[0] ?? '';
      return /vitest run ([^\n]+)/.exec(body)?.[1] ?? '';
    };
    for (const [platform, gateId, job] of [['darwin', 'macos-native-parity', 'macos-native-parity'], ['win32', 'windows-runtime', 'windows-native-runtime']] as const) {
      const files = gates.get(gateId)?.files ?? [];
      const gated = trackedTestFiles().filter((f) => {
        const src = readFileSync(join(ROOT, f), 'utf8');
        // Only on this platform: runIf(=== p) or skipIf(!== p). skipIf(=== p) runs on ubuntu already.
        return new RegExp(`(?:runIf\\(\\s*process\\.platform\\s*===|skipIf\\(\\s*process\\.platform\\s*!==)\\s*'${platform}'`).test(src);
      });
      expect(gated.length, platform).toBeGreaterThan(0);
      expect(gated.filter((f) => !files.includes(f)), `${platform}-gated files missing from ${gateId}`).toEqual([]);
      const listed = jobCommand(job).split(/\s+/).filter((a) => a.endsWith('.test.ts'));
      expect([...listed].sort(), `ci.yml ${job} must run exactly the ${gateId} files`).toEqual([...files].sort());
    }
  });
});
