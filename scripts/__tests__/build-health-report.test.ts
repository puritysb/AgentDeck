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
  // Evidence recorded elsewhere: the Apple workflow's last hosted run, and a
  // committed pre-release receipt with an attested lab gate.
  writeFileSync(join(report, 'workflow-status.json'), JSON.stringify({ workflows: {
    '.github/workflows/apple-test.yml': { scope: 'master', conclusion: 'success', event: 'push', head_branch: 'master',
      head_sha: 'feedface00', created_at: '2026-10-06T02:21:02Z', html_url: 'https://github.com/x/y/actions/runs/1' },
    '.github/workflows/esp32-sim.yml': { scope: 'latest', conclusion: 'failure', event: 'pull_request', head_branch: 'feature',
      head_sha: 'badc0ffee0', created_at: '2026-10-05T00:00:00Z', html_url: 'https://github.com/x/y/actions/runs/2' },
  } }));
  mkdirSync(join(dir, 'receipts'));
  writeFileSync(join(dir, 'receipts', '2026-10-06-1234567.json'), JSON.stringify({
    schema: 1, tier: 'full', started_at: '2026-10-06T00:00:00Z', finished_at: '2026-10-06T00:30:00Z', duration_ms: 1_800_000,
    commit: '1234567890abcdef', dirty: false, host: { platform: 'darwin', arch: 'arm64', node: 'v22.0.0' }, result: 'pass',
    steps: [
      { id: 'vitest-coverage', gate: 'vitest', name: 'Vitest, whole suite + coverage floor', status: 'pass', duration_ms: 60_000 },
      { id: 'windows-runtime', gate: 'windows-runtime', name: 'Windows native runtime', status: 'skip', reason: 'needs Windows' },
      { id: 'esp32-robot', gate: 'esp32-robot', name: 'ESP32 boards', status: 'pass', attested: true, note: 'box_86 and ips_35' },
      { id: 'device-deploy', gate: 'device-deploy', name: 'Device deploy', status: 'manual', attested: false, reason: 'lab gate, not attested' },
    ],
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
      BUILD_HEALTH_RECEIPTS_DIR: join(dir, 'receipts'),
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
      const history = JSON.parse(readFileSync(join(report, 'history.json'), 'utf8')).at(-1);
      expect(history).toMatchObject(summary.total);
      expect(summary.total).toMatchObject({ executed, skipped, total: executed + skipped });
      const page = readFileSync(join(report, 'index.html'), 'utf8');
      expect(page).toContain(`<span class="dot ${decision}">`);
      expect(page).toContain(`<dd>${executed} / ${executed + skipped}</dd>`);
      expect(page).not.toContain('href="#coverage"');
      const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
      for (const [, target] of page.matchAll(/href="#([^"]+)"/g)) expect(ids.has(target), target).toBe(true);
      if (all) {
        for (const name of ['e2e', 'android', 'apple', 'robot']) {
          expect(summary.suites.find((s: { name: string }) => s.name === name).status).toBe('unknown');
        }
        expect(page).toMatch(/<h3>Apple \(XCTest\)<\/h3><span class="badge off">No case evidence<\/span>/);
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
    expect(html).toContain("document.createTreeWalker");
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain("<h1>Test Report</h1>");
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
        expect(page).toMatch(/<h3>Android<\/h3><span class="badge off">No executed cases<\/span>/);
      }
    } finally { rmSync(report, { recursive: true, force: true }); }
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
    expect(html).toMatch(/class="run-chip"><span class="dot fail"><\/span>Fail/);
    expect(html).toContain('keeps &lt;script&gt; &amp; &quot;quotes&quot; escaped');
    expect(html).toContain('expected &lt;b&gt;401&lt;/b&gt;');
    expect(html).not.toContain('<script> &');
  });

  it('never shows a suite that did not run as passing', () => {
    const badge = (name: string) => new RegExp(`<h3>${name.replace(/[()]/g, '\\$&')}</h3><span class="badge (\\w+)"`).exec(html)?.[1];
    expect(badge('Android')).toBe('off');
    // Evidence from another workflow or an attestation gets the outlined badge,
    // never the solid one, and never enters this page's totals.
    expect(badge('Apple (XCTest)')).toBe('elsewhere');
    expect(badge('ESP32 Robot')).toBe('elsewhere');
    expect(html).toContain('>Passed in CI<');
    expect(html).toMatch(/class="run-chip"><span class="dot fail"><\/span>Fail · 4 tests/);
  });

  it('shows a failed hosted run as failed on its gate', () => {
    expect(html).toMatch(/<span class="dot fail"><\/span>Latest hosted run failed · <a href="https:\/\/github.com\/x\/y\/actions\/runs\/2">badc0ff<\/a> · pull_request on feature/);
  });

  it('renders every tier and every step of the verification catalog', () => {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'scripts/verification-catalog.json'), 'utf8')) as {
      tiers: Array<{ name: string; command: string }>; steps: Array<{ name: string; id: string }>;
    };
    const text = html.replace(/&amp;/g, '&');
    for (const t of catalog.tiers) {
      expect(text, t.name).toContain(`<h3>${t.name}</h3>`);
      expect(text, t.command).toContain(`<code>${t.command}</code>`);
    }
    for (const s of catalog.steps) expect(text, s.id).toContain(`<strong>${s.name}</strong>`);
  });

  it('shows the recorded pre-release receipt, with skips and unattested lab gates named as such', () => {
    expect(html).toContain('<h3>Last recorded pre-release check</h3>');
    expect(html).toContain('commit <code>1234567</code>');
    expect(html).toContain('attested passed — box_86 and ips_35');
    expect(html).toMatch(/<li class="t off"><span class="mark">○<\/span><span class="tname">Windows native runtime<span class="fine"> needs Windows/);
    expect(html).toMatch(/<li class="t off"><span class="mark">\?<\/span><span class="tname">Device deploy/);
    expect(html).toContain('Last pre-release check: passed · <code>1234567</code>');
  });

  it('lists each skipped case with the runner that executes it', () => {
    expect(html).toContain('1 case skipped here: 1 run on another CI runner, 0 on no CI runner');
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
    expect(html.replace(/<script>[\s\S]*?<\/script>/g, "")).not.toMatch(/\bNone\b(?! recorded)|\bundefined\b|\bNaN\b|\{\{|\}\}/);
  });
});

describe('report Korean locale', () => {
  const ko = JSON.parse(readFileSync(join(ROOT, 'scripts/report-locales/ko.json'), 'utf8')) as Record<string, string>;
  it('covers catalog explanations, domains, tiers, steps and scenario gaps', () => {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'scripts/verification-catalog.json'), 'utf8')) as {
      merge_policy: { summary: string };
      levels: Record<string, string>;
      domains: Array<{ name: string; question: string }>;
      gates: Array<{ name: string; trigger: string; proves: string[]; does_not_prove: string[] }>;
      steps: Array<{ name: string }>;
      tiers: Array<{ name: string; when: string; budget: string; selects: string; does_not_replace: string }>;
      not_verified: Array<{ what: string; why: string; instead: string }>;
    };
    const { scenarios } = JSON.parse(readFileSync(join(ROOT, 'scripts/scenario-matrix.json'), 'utf8')) as {
      scenarios: Array<{ name: string; description: string; gaps: string[] }>;
    };
    const copy = [
      catalog.merge_policy.summary,
      ...Object.values(catalog.levels),
      ...catalog.domains.flatMap((d) => [d.name, d.question]),
      ...catalog.gates.flatMap((g) => [g.name, g.trigger, ...g.proves, ...g.does_not_prove]),
      ...catalog.steps.map((s) => s.name),
      ...catalog.tiers.flatMap((t) => [t.name, t.when, t.budget, t.selects, t.does_not_replace]),
      ...catalog.not_verified.flatMap((g) => [g.what, g.why, g.instead]),
      ...scenarios.flatMap((s) => [s.name, s.description, ...s.gaps]),
    ];
    for (const text of copy) expect(ko[String(text)], String(text)).toMatch(/[가-힣]/);
  });

  function localeFixture(storageBlocked = false, initialLocale: string | null = 'ko') {
    let handler = () => {};
    const control = {
      value: 'en',
      addEventListener: (_: string, fn: () => void) => {
        handler = fn;
      },
    };
    const texts = [
      'Test Report',
      'Pass',
      '5 tests executed',
      'floor 52% · BELOW',
      'Pass · 5 tests · commit abc1234 · generated 2026-10-08 UTC',
      'LAN security & pairing',
      'Pass',
      'While iterating, and before pushing a focused fix · Seconds to a few minutes, depending on what changed',
      'Before cutting any release tag · 20–40 minutes on a Mac with every toolchain, plus lab time',
      'Decision first', 'Manual QA still needed', 'Partial verification',
      'Partial verification · 19 tests · commit abc1234 · generated 2026-10-08 UTC',
      'Example cases: 19 passed, 0 failed, 0 skipped.',
      'Review the decision, remaining risk and next action first; inspect the exact test evidence below.',
      'Not run or no parsed case evidence here: apple, robot.',
      ': Run missing suites and review manual QA before a release decision. ',
      'Parsed input scope: vitest, e2e, android. Only supplied cases are counted; this is not release approval.',
    ];
    const nodes = texts.map((text, index) => ({ nodeValue: text, parentElement: { closest: () => index === 6 } }));
    const attributes = new Map([['aria-label', 'Language']]);
    const attributeNode = {
      closest: () => false,
      hasAttribute: (k: string) => attributes.has(k),
      getAttribute: (k: string) => attributes.get(k),
      setAttribute: (k: string, v: string) => attributes.set(k, v),
    };
    let cursor = -1;
    const walker = {
      nextNode: () => ++cursor < nodes.length,
      get currentNode() {
        return nodes[cursor];
      },
    };
    const document = {
      body: {},
      documentElement: { lang: 'en' },
      title: '',
      getElementById: () => control,
      createTreeWalker: () => walker,
      querySelectorAll: () => [attributeNode],
    };
    let stored = initialLocale;
    const localStorage = {
      getItem: () => {
        if (storageBlocked) throw Error('denied');
        return stored;
      },
      setItem: (_: string, v: string) => {
        if (storageBlocked) throw Error('denied');
        stored = v;
      },
    };
    runInNewContext(
      'const REPORT_KO = ' + JSON.stringify(ko) + ';' + readFileSync(join(ROOT, 'scripts/report-locale.js'), 'utf8'),
      { document, localStorage, NodeFilter: { SHOW_TEXT: 4 } },
    );
    return {
      document,
      nodes,
      attributes,
      change(locale: string) {
        control.value = locale;
        handler();
      },
      stored: () => stored,
    };
  }

  it('restores Korean, translates counts and accessibility, preserves evidence, and reverses to English', () => {
    const f = localeFixture();
    expect(f.document.documentElement.lang).toBe('ko');
    expect(f.nodes[0].nodeValue).toBe('테스트 리포트');
    expect(f.nodes[1].nodeValue).toBe('통과');
    expect(f.nodes[2].nodeValue).toBe('5개 테스트 실행');
    expect(f.nodes[3].nodeValue).toBe('기준 52% · 미달');
    expect(f.nodes[4].nodeValue).toContain('테스트 5개 · 커밋 abc1234');
    expect(f.nodes[5].nodeValue).toBe('LAN 보안과 페어링');
    expect(f.nodes[6].nodeValue).toBe('Pass');
    expect(f.nodes[7].nodeValue).toBe('수정 중 및 범위가 작은 수정의 푸시 전 · 변경 범위에 따라 수 초에서 수 분');
    expect(f.nodes[8].nodeValue).toBe('모든 릴리스 태그 생성 전 · 모든 도구를 갖춘 Mac에서 20~40분 + 실험실 검증 시간');
    expect(f.attributes.get('aria-label')).toBe('언어');
    expect(f.nodes[9].nodeValue).toBe('검증 결론부터');
    expect(f.nodes[10].nodeValue).toBe('수동 QA가 필요한 이유');
    expect(f.nodes[12].nodeValue).toContain('부분 검증');
    expect(f.nodes[13].nodeValue).toContain('19 통과');
    expect(f.nodes[14].nodeValue).toContain('검증 결론과 남은 위험');
    expect(f.nodes[15].nodeValue).toBe('이 실행에서 미실행 또는 케이스 근거 없음: apple, robot.');
    expect(f.nodes[16].nodeValue).toBe(': 누락된 suite와 수동 QA를 확인한 뒤 릴리스를 판단하세요. ');
    expect(f.nodes[17].nodeValue).toBe('결과 입력 범위: vitest, E2E, android. 입력된 케이스만 집계하며 릴리스 승인은 아닙니다.');

    f.change('en');
    expect(f.nodes[0].nodeValue).toBe('Test Report');
    expect(f.document.documentElement.lang).toBe('en');
    expect(f.stored()).toBe('en');
    f.change('ko');
    expect(f.nodes[0].nodeValue).toBe('테스트 리포트');
    f.change('ja');
    expect(f.document.documentElement.lang).toBe('en');
    expect(f.nodes[0].nodeValue).toBe('Test Report');
  });

  it.each([null, 'invalid', 'en', 'ja'])('uses English source for initial locale %s', (initial) => {
    const f = localeFixture(false, initial);
    expect(f.nodes[0].nodeValue).toBe('Test Report');
    expect(f.document.documentElement.lang).toBe('en');
    for (let cycle = 0; cycle < 5; cycle++) {
      f.change('ko');
      expect(f.nodes[9].nodeValue).toBe('검증 결론부터');
      f.change('en');
      expect(f.nodes[9].nodeValue).toBe('Decision first');
      expect(f.nodes[6].nodeValue).toBe('Pass');
    }
  });

  it('switches language even when localStorage is unavailable', () => {
    const f = localeFixture(true);
    f.change('ko');
    expect(f.nodes[0].nodeValue).toBe('테스트 리포트');
    expect(f.document.documentElement.lang).toBe('ko');
    f.change('en');
    expect(f.nodes[9].nodeValue).toBe('Decision first');
    f.change('ko');
    expect(f.nodes[9].nodeValue).toBe('검증 결론부터');
  });
});

describe('report evidence calculations', () => {
  function python(body: string) {
    return JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import runpy,json,tempfile,pathlib\nm=runpy.run_path(${JSON.stringify(join(ROOT, 'scripts/generate-html-report.py'))})\n${body}`,
        ],
        { encoding: 'utf8' },
      ),
    );
  }
  it('keeps skip-only hardware input outside executed evidence', () => {
    const result = python(
      `r=dict(passed=0,failed=0,skipped=2)\nmdata=m['reconcile_case_evidence'](dict(suites=dict(robot=dict(status='pass',executed=True))),None,[],r)\nc=m['result_counts'](None,[],r)\nprint(json.dumps(dict(counts=c,meta=mdata,decision=m['run_decision'](c,mdata))))`,
    );
    expect(result.counts).toMatchObject({ passed: 0, failed: 0, skipped: 2, executed: 0, total: 2 });
    expect(result.meta.suites.robot.status).toBe('unknown');
    expect(result.decision).toBe('off');
  });

  it('provides Korean for every authored QA explanation', () => {
    const copy = python(
      `import ast\nt=ast.parse((m['ROOT']/'scripts/generate-html-report.py').read_text())\nf=[n for n in t.body if isinstance(n,ast.FunctionDef) and n.name in ('_render_qa_summary','_render_qa_method')]\nlabels=[n.args[0].value for item in f for n in ast.walk(item) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='_esc' and n.args and isinstance(n.args[0],ast.Constant) and isinstance(n.args[0].value,str)]\nlabels += [a.value for item in f for n in ast.walk(item) if isinstance(n,ast.Tuple) and len(n.elts)==2 and all(isinstance(a,ast.Constant) and isinstance(a.value,str) for a in n.elts) for a in n.elts]\nprint(json.dumps(labels))`,
    );
    const ko = JSON.parse(readFileSync(join(ROOT, 'scripts/report-locales/ko.json'), 'utf8'));
    expect(copy.length).toBeGreaterThan(25);
    for (const text of copy) expect(ko[text], text).toBeTruthy();
  });

  it('preserves JUnit errors and skipped cases instead of calling them passed', () => {
    const result = python(
      `d=pathlib.Path(tempfile.mkdtemp())\n(d/'TEST-fixture.xml').write_text('<testsuite tests="3" errors="1" failures="0" skipped="1"><testcase name="ok"/><testcase name="error"><error>boom</error></testcase><testcase name="skip"><skipped/></testcase></testsuite>')\nm['load_android_xml'].__globals__['ANDROID_XML_DIR']=d\nprint(json.dumps(m['load_android_xml']()))`,
    );
    expect(result[0].cases.map((c: { status: string }) => c.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(result[0].passed).toBe(1);
  });
  it('plots pass percentages and normalizes legacy test totals to executed counts', () => {
    const result = python(
      `h=[dict(passed=5,failed=0,total=9),dict(passed=10,failed=0,total=14)]\nprint(json.dumps([m['sparkline_svg'](h,'passed','Pass rate'),m['sparkline_svg'](h,'total','Tests')]))`,
    );
    expect(result[0]).toContain('100.0%');
    expect(result[0]).toContain('4.0,42.0 236.0,42.0');
    expect(result[1]).toContain('>10</p>');
  });
  it('does not show coverage or runner failures as an overall pass even with no failing assertions', () => {
    const result = python(
      `v=dict(testResults=[dict(name=str(m['ROOT']/'bridge/src/__tests__/state-machine.test.ts'),startTime=0,endTime=2,assertionResults=[dict(title='ok',status='passed')])])\nmeta=dict(suites=dict(vitest=dict(status='fail',executed=True)))\nprint(json.dumps(m['generate_html'](v,[],None,[],[],[],meta)))`,
    );
    expect(result).toContain('class="dot fail"></span>Fail');
    expect(result).toContain('Cumulative test time');
    expect(result).not.toContain('href="#coverage"');
  });
});
