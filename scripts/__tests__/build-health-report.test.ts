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
import { runInNewContext } from 'node:vm';
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

describe('QA decision and accounting', () => {
  it.each([
    { name: 'empty results', statuses: [], suite: 'pass', all: false, decision: 'off', executed: 0, skipped: 0 },
    { name: 'skipped only', statuses: ['skipped'], suite: 'pass', all: false, decision: 'off', executed: 0, skipped: 1 },
    { name: 'partial platform scope', statuses: ['passed'], suite: 'pass', all: false, decision: 'partial', executed: 1, skipped: 0 },
    { name: 'skip excluded from execution', statuses: ['passed', 'skipped'], suite: 'pass', all: true, decision: 'partial', executed: 1, skipped: 1 },
    { name: 'suite error without failing case', statuses: ['passed'], suite: 'fail', all: true, decision: 'fail', executed: 1, skipped: 0 },
    { name: 'failed assertion despite pass metadata', statuses: ['failed'], suite: 'pass', all: true, decision: 'fail', executed: 1, skipped: 0 },
    { name: 'metadata alone cannot prove native cases', statuses: ['passed'], suite: 'pass', all: true, decision: 'partial', executed: 1, skipped: 0 },
  ])('$name keeps HTML and summary consistent', ({ statuses, suite, all, decision, executed, skipped }) => {
    const report = mkdtempSync(join(tmpdir(), 'qa-decision-'));
    try {
      // Deliberately incorrect reporter aggregate: authoritative case outcomes win.
      const input = vitestJson([{ file: 'bridge/src/__tests__/state-machine.test.ts',
        assertions: statuses.map((status) => assertion('public fixture', status as 'passed' | 'failed' | 'skipped')) }]);
      input.numTotalTests = 999;
      input.numPassedTests = 998;
      writeFileSync(join(report, 'vitest.json'), JSON.stringify(input));
      writeFileSync(join(report, 'run-metadata.json'), JSON.stringify({ run_profile: 'synthetic-fixture', suites:
        Object.fromEntries(['vitest', 'e2e', 'android', 'apple', 'robot'].map((name) => [name,
          { executed: name === 'vitest' || all, status: name === 'vitest' ? suite : all ? 'pass' : 'not-run' }])) }));
      execFileSync('python3', [join(ROOT, 'scripts/generate-html-report.py')], { env: { ...process.env,
        BUILD_HEALTH_REPORT_DIR: report, BUILD_HEALTH_COVERAGE_JSON: join(report, 'absent'),
        BUILD_HEALTH_ANDROID_DIR: join(report, 'absent'),
        GITHUB_SHA: 'abc1234',
      } });
      const summary = JSON.parse(readFileSync(join(report, 'summary.json'), 'utf8'));
      expect(summary.decision).toBe(decision);
      expect(summary.total).toMatchObject({ executed, skipped, total: executed + skipped });
      const page = readFileSync(join(report, 'index.html'), 'utf8');
      expect(page).toContain(`<span class="dot ${decision}">`);
      expect(page).toContain(`<dd>${executed} / ${executed + skipped}</dd>`);
      expect(page).not.toContain('href="#coverage"');
      const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
      for (const [, target] of page.matchAll(/href="#([^"]+)"/g)) expect(ids.has(target), target).toBe(true);
      const history = JSON.parse(readFileSync(join(report, 'history.json'), 'utf8'));
      expect(history.at(-1).total).toBe(summary.total.total);
      if (all) {
        for (const name of ['e2e', 'android', 'apple', 'robot']) {
          expect(summary.suites.find((s: { name: string }) => s.name === name).status).toBe('unknown');
        }
        expect(page).toMatch(/<h3>Apple \(XCTest\)<\/h3><span class="badge off"><span data-i18n="[^"]+">No case evidence<\/span><\/span>/);
        expect(page).not.toContain('<h3>Apple (XCTest)</h3><span class="badge pass">');
      }
    } finally { rmSync(report, { recursive: true, force: true }); }
  });

  it('puts the readable judgment before details and provides actual reproduction inputs', () => {
    expect(html.indexOf('id="qa-summary"')).toBeLessThan(html.indexOf('class="jump"'));
    expect(html).toContain('검증 결론부터');
    expect(html).toContain('수동 QA가 필요한 이유');
    expect(html).toContain('BUILD_HEALTH_COVERAGE_JSON=');
    expect(html).toContain('No QA execution video is attached');
    expect(html).toContain("node.getAttribute('data-i18n')");
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<h1><span data-i18n="[^"]+">Test Report<\/span><\/h1>/);
    expect(html).not.toContain('data-en=');
    expect(html).toContain('id="run" tabindex="-1"');
    expect(styleBlock()).toContain(':focus-visible');
  });

  it.each(['e2e-only', 'file-setup-failure', 'skipped-native'])('%s cannot manufacture a passing suite', (kind) => {
    const report = mkdtempSync(join(tmpdir(), 'qa-evidence-'));
    try {
      let androidDir = join(report, 'absent');
      if (kind === 'e2e-only') {
        writeFileSync(join(report, 'e2e.json'), JSON.stringify(vitestJson([
          { file: 'tests/e2e/daemon-hub.e2e.test.ts', assertions: [assertion('public fixture', 'passed')] },
        ])));
      } else {
        const input = vitestJson([{ file: 'bridge/src/__tests__/state-machine.test.ts', assertions: [] }]);
        if (kind === 'file-setup-failure') input.testResults[0]!.status = 'failed';
        writeFileSync(join(report, 'vitest.json'), JSON.stringify(input));
        if (kind === 'skipped-native') {
          androidDir = join(report, 'android'); mkdirSync(androidDir);
          writeFileSync(join(androidDir, 'TEST-fixture.xml'), '<testsuite name="public.FixtureTest" tests="1" failures="0" errors="0" skipped="1" time="0"><testcase name="requires target" time="0"><skipped/></testcase></testsuite>');
        }
      }
      execFileSync('python3', [join(ROOT, 'scripts/generate-html-report.py')], { env: { ...process.env,
        BUILD_HEALTH_REPORT_DIR: report, BUILD_HEALTH_COVERAGE_JSON: join(report, 'absent'),
        BUILD_HEALTH_ANDROID_DIR: androidDir,
      } });
      const summary = JSON.parse(readFileSync(join(report, 'summary.json'), 'utf8'));
      const page = readFileSync(join(report, 'index.html'), 'utf8');
      if (kind === 'e2e-only') {
        expect(summary.total.executed).toBe(1);
        expect(summary.suites.find((s: { name: string }) => s.name === 'vitest').executed).toBe(false);
        expect(page).toContain('<h3>Vitest</h3><span class="badge off">');
      } else if (kind === 'file-setup-failure') {
        expect(summary.total.failed).toBe(0);
        expect(summary.decision).toBe('fail');
        expect(page).toContain('<h3>Vitest</h3><span class="badge fail">');
      } else {
        expect(summary.total).toMatchObject({ executed: 0, skipped: 1 });
        expect(summary.decision).toBe('off');
        expect(page).toMatch(/<h3>Android<\/h3><span class="badge off"><span data-i18n="[^"]+">No executed cases<\/span><\/span>/);
      }
    } finally { rmSync(report, { recursive: true, force: true }); }
  });

  it.each(['ko', 'en', 'ja', null, 'invalid'])('language choice %s changes reader copy without touching evidence', (saved) => {
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
    expect(script).toBeTruthy();
    let change = () => {};
    const selector = { value: 'en', addEventListener: (_event: string, fn: () => void) => { change = fn; } };
    const key = /<h1><span data-i18n="([^"]+)">Test Report/.exec(html)![1];
    const copy = { textContent: 'Test Report', getAttribute: () => key };
    const document = { documentElement: { lang: 'ko' }, getElementById: () => selector,
      querySelectorAll: (query: string) => { expect(query).toBe('[data-i18n]'); return [copy]; } };
    runInNewContext(script!, { document, localStorage: { getItem: () => saved, setItem: () => {} } });
    expect(copy.textContent).toBe(saved === 'ko' ? '테스트 보고서' : saved === 'ja' ? 'テストレポート' : 'Test Report');
    expect(selector.value).toBe(saved && ['en', 'ko', 'ja'].includes(saved) ? saved : 'en');
    expect(document.documentElement.lang).toBe(selector.value);
    selector.value = 'en'; change();
    expect(copy.textContent).toBe('Test Report');
    expect(document.documentElement.lang).toBe('en');
    selector.value = 'ko'; change();
    expect(copy.textContent).toBe('테스트 보고서');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('provides Korean for every authored report string and preserves the Pages locale contract', () => {
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
    const dictionaries = JSON.parse(/var I18N = ([\s\S]*?);\n/.exec(script)![1]!);
    const nodes = [...html.matchAll(/<span data-i18n="([^"]+)">([^<]*)<\/span>/g)].map(([, key, text]) => ({
      key, textContent: text, getAttribute: () => key,
    }));
    expect(nodes.length).toBeGreaterThan(30);
    for (const node of nodes) expect(dictionaries.ko[node.key!], node.key).toBeTruthy();
    let change = () => {};
    const selector = { value: 'en', addEventListener: (_event: string, fn: () => void) => { change = fn; } };
    const document = { documentElement: { lang: 'en' }, getElementById: () => selector,
      querySelectorAll: () => nodes };
    const stored: Array<[string, string]> = [];
    runInNewContext(script, { document, localStorage: { getItem: (key: string) => {
      expect(key).toBe('agentdeck-design-locale'); return 'ko';
    }, setItem: (key: string, value: string) => { stored.push([key, value]); } } });
    for (const node of nodes) expect(node.textContent).toBe(dictionaries.ko[node.key!]);
    expect(nodes.some((node) => node.textContent === '실패 — 원인 확인 필요')).toBe(true);
    expect(nodes.some((node) => node.textContent === '수동 QA가 필요한 이유')).toBe(true);
    selector.value = 'ja'; change();
    expect(document.documentElement.lang).toBe('ja');
    expect(stored.at(-1)).toEqual(['agentdeck-design-locale', 'ja']);
    // Missing Japanese strings retain the canonical English source, as other Pages do.
    expect(nodes.some((node) => node.textContent === 'Manual QA still needed')).toBe(true);
  });
});

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
    expect(html).toMatch(/class="run-chip"><span class="dot fail"><\/span><span data-i18n="[^"]+">Fail/);
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

  it('calls only a branch-protection-required gate a merge blocker', () => {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'scripts/verification-catalog.json'), 'utf8')) as {
      gates: Array<{ required?: boolean; report_suite?: string }>;
    };
    // A required gate with its own suite in this run shows that result instead.
    const shown = catalog.gates.filter((g) => g.required && !g.report_suite).length;
    expect(shown).toBeGreaterThan(0);
    expect(html.match(/>Required to merge</g)?.length).toBe(shown);
    expect(html).not.toContain('>Blocking<');
    expect(html).toContain('Merge policy · checked');
  });

  it('quotes the coverage floor from vitest.config.ts and flags a metric under it', () => {
    const floor = /branches:\s*(\d+)/.exec(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8'))?.[1];
    expect(html).toContain(`floor ${floor}% · BELOW`);
  });

  it('leaks no Python or JS placeholders', () => {
    expect(html).not.toMatch(/\bNone\b|\bundefined\b|\bNaN\b|\{\{|\}\}/);
  });
});
