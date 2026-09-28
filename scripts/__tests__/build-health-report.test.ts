/**
 * The Build Health page (GitHub Pages /reports/) is generated, so design/lint.sh
 * never sees it: the linter walks committed HTML/CSS, and the page only exists
 * under coverage/ after a CI run. That is how it drifted — Tailwind greens and
 * yellows, a sidebar-app layout — while every committed surface stayed on the
 * aquarium-tide rules. This renders the page from fixtures and lints the OUTPUT
 * against the same rules (DESIGN.md §10), plus the facts the page must never
 * misstate: a failure is shown as a failure, and a suite that did not run is
 * never counted as passing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const RADIUS_SCALE = new Set([0, 4, 8, 10, 12, 14, 16, 18, 999]);

let dir = '';
let html = '';

function assertion(title: string, status: 'passed' | 'failed' | 'skipped', extra: Record<string, unknown> = {}) {
  return { ancestorTitles: ['fixture'], title, status, duration: 3, failureMessages: [], ...extra };
}

function vitestJson(results: Array<{ file: string; assertions: unknown[] }>) {
  const flat = results.flatMap((r) => r.assertions as Array<{ status: string }>);
  return {
    numPassedTests: flat.filter((a) => a.status === 'passed').length,
    numFailedTests: flat.filter((a) => a.status === 'failed').length,
    numPendingTests: flat.filter((a) => a.status === 'skipped').length,
    numTotalTests: flat.length,
    startTime: 1_000,
    testResults: results.map((r) => ({
      name: join(ROOT, r.file), status: 'passed', startTime: 1_000, endTime: 1_250, assertionResults: r.assertions,
    })),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'build-health-'));
  const report = join(dir, 'report');
  mkdirSync(report);
  writeFileSync(join(report, 'vitest.json'), JSON.stringify(vitestJson([
    { file: 'bridge/src/__tests__/http-auth-gate.test.ts', assertions: [
      assertion('denies a LAN peer without a token', 'passed'),
      assertion('keeps <script> & "quotes" escaped', 'failed', { failureMessages: ['AssertionError: expected <b>401</b>'] }),
    ] },
    { file: 'bridge/src/__tests__/state-machine.test.ts', assertions: [
      assertion('idle → processing', 'passed'), assertion('darwin only', 'skipped'),
    ] },
  ])));
  writeFileSync(join(report, 'e2e.json'), JSON.stringify(vitestJson([
    { file: 'tests/e2e/daemon-hub.e2e.test.ts', assertions: [assertion('boots in an empty HOME', 'passed')] },
  ])));
  writeFileSync(join(report, 'run-metadata.json'), JSON.stringify({
    run_profile: 'fixture',
    suites: {
      vitest: { status: 'fail', executed: true, note: '' },
      e2e: { status: 'pass', executed: true, note: '' },
      android: { status: 'not-run', executed: false, note: 'not in this fixture' },
      apple: { status: 'not-run', executed: false, note: 'Runs in the Apple Tests workflow' },
      robot: { status: 'not-run', executed: false, note: 'lab only' },
    },
  }));
  const metric = (covered: number, total: number) => ({ covered, total, skipped: 0, pct: Math.round((covered / total) * 1000) / 10 });
  const cov = { lines: metric(60, 100), statements: metric(59, 100), functions: metric(61, 100), branches: metric(40, 100) };
  writeFileSync(join(dir, 'coverage-summary.json'), JSON.stringify({
    total: cov, [join(ROOT, 'bridge/src/http-auth-gate.ts')]: cov,
  }));
  execFileSync('python3', [join(ROOT, 'scripts/generate-html-report.py')], {
    env: {
      ...process.env,
      BUILD_HEALTH_REPORT_DIR: report,
      BUILD_HEALTH_COVERAGE_JSON: join(dir, 'coverage-summary.json'),
      BUILD_HEALTH_ANDROID_DIR: join(dir, 'no-android'),
      GITHUB_SHA: 'abc1234def',
    },
    stdio: 'pipe',
  });
  html = readFileSync(join(report, 'index.html'), 'utf8');
}, 30_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const styleBlock = () => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
const withoutRoot = (css: string) => css.replace(/:root\s*\{[^}]*\}/g, '');

describe('Build Health page — design rules on the generated output', () => {
  it('keeps every colour literal inside :root (R1, R2)', () => {
    const outsideRoot = withoutRoot(styleBlock()) + html.replace(/<style>[\s\S]*?<\/style>/, '');
    // Numeric entities (&#9745;) are not colours; strip them before looking for hex.
    const hex = outsideRoot.replace(/&#\d+;/g, '').match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(hex).toEqual([]);
    expect(/rgb\(|hsl\(/i.test(withoutRoot(styleBlock()))).toBe(false);
  });

  it('declares its tokens with the canonical design/tokens.css values', () => {
    const tokens = readFileSync(join(ROOT, 'design/tokens.css'), 'utf8');
    const root = /:root\s*\{([^}]*)\}/.exec(styleBlock())?.[1] ?? '';
    const declared = [...root.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})/gi)];
    expect(declared.length).toBeGreaterThan(10);
    for (const [, name, value] of declared) {
      expect(tokens, name).toMatch(new RegExp(`${name}:\\s*${value}`, 'i'));
    }
  });

  it('uses only the two type faces (R3)', () => {
    const families = [...styleBlock().matchAll(/font-family\s*:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    const allowed = /^(var\(--font-(sans|mono)\)|inherit|"(IBM Plex (Sans|Sans KR|Sans JP|Mono)|JetBrains Mono)"|-apple-system|BlinkMacSystemFont|system-ui|sans-serif|ui-monospace|monospace)$/;
    for (const f of families) for (const part of f.split(',')) expect(part.trim(), f).toMatch(allowed);
    expect(styleBlock()).not.toMatch(/\b(Inter|Roboto|Arial|Fraunces|Helvetica)\b/);
  });

  it('keeps radii on the design scale', () => {
    for (const [, value] of styleBlock().matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      const v = value!.trim();
      if (v.startsWith('var(--r-')) continue;
      for (const px of v.split(/\s+/)) expect(RADIUS_SCALE.has(Number.parseFloat(px)), v).toBe(true);
    }
  });

  it('animates nothing (only amber awaiting may pulse, and a report has no awaiting state)', () => {
    expect(styleBlock()).not.toMatch(/@keyframes|animation\s*:/);
  });

  it('shares the Pages chrome: the canonical GNB with Test Report active, and the page grammar', () => {
    const partial = readFileSync(join(ROOT, 'scripts/pages-nav.html'), 'utf8');
    const firstLink = /href="\{\{base\}\}([^"]*)"/.exec(partial)?.[1];
    expect(html).toContain(`href="../${firstLink}"`);
    expect(html).toMatch(/<a[^>]*href="\.\.\/reports\/"[^>]*class="active"|<a[^>]*class="active"[^>]*href="\.\.\/reports\/"/);
    expect(html).toContain('class="kicker"');
    expect(html).toContain('class="section-head"');
    expect(html).toContain('class="jump"');
  });
});

describe('Build Health page — what it states', () => {
  it('reports a failing run as failing, with the escaped failure', () => {
    expect(html).toMatch(/class="run-chip"><span class="dot fail"><\/span>Fail/);
    expect(html).toContain('keeps &lt;script&gt; &amp; &quot;quotes&quot; escaped');
    expect(html).toContain('expected &lt;b&gt;401&lt;/b&gt;');
    expect(html).not.toContain('<script> &');
  });

  it('never shows a suite that did not run as passing', () => {
    for (const name of ['Android', 'Apple (XCTest)', 'ESP32 Robot']) {
      const card = new RegExp(`<h3>${name.replace(/[()]/g, '\\$&')}</h3><span class="badge (\\w+)"`).exec(html);
      expect(card?.[1], name).toBe('off');
    }
  });

  it('renders every gate and every test domain from the verification catalog', () => {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'scripts/verification-catalog.json'), 'utf8')) as {
      gates: Array<{ name: string }>; domains: Array<{ name: string }>;
    };
    const text = html.replace(/&amp;/g, '&');
    for (const g of catalog.gates) expect(text, g.name).toContain(`<h3>${g.name}</h3>`);
    for (const d of catalog.domains) expect(text, d.name).toContain(`<h3>${d.name}</h3>`);
  });

  it('quotes the coverage floor from vitest.config.ts and flags a metric under it', () => {
    const floor = /branches:\s*(\d+)/.exec(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8'))?.[1];
    expect(html).toContain(`floor ${floor}% · BELOW`);
  });

  it('leaks no Python or JS placeholders', () => {
    expect(html).not.toMatch(/\bNone\b|\bundefined\b|\bNaN\b|\{\{|\}\}/);
  });
});
