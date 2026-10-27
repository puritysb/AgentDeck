// The APME dashboard is a self-contained HTML+JS SPA string. These tests lock
// the data-quality affordances that are easy to regress: honest empty/degenerate
// states and the manual-review surface.

import { describe, it, expect, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apmeDashboardHtml } from '../apme/dashboard-html.js';
import { ApmeRecommender } from '../apme/recommend.js';
import type { ApmeStore } from '../apme/store.js';
import { APME_COMPARISON_MIN_SAMPLES, type ApmeSampleScorecardRow } from '@agentdeck/shared';

const HTML = apmeDashboardHtml();

function dashboardContext(fetch = vi.fn()) {
  const elements = new Map<string, { innerHTML: string; innerText: string; querySelector: () => null }>();
  const clipboard = vi.fn().mockResolvedValue(undefined);
  const location = new URL('http://user:password@127.0.0.1:9120/apme?token=pairing-secret&key=other-secret#token=fragment-secret');
  const context = createContext({
    URL, URLSearchParams, AbortSignal, location, fetch,
    navigator: { clipboard: { writeText: clipboard } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    document: { documentElement: {}, getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', innerText: 'Task report', querySelector: () => null });
      return elements.get(id);
    } },
  });
  const script = HTML.split('<script>')[1].split('</script>')[0];
  // Run the shipped functions without the boot-time polling. The tests call
  // real UI actions against controlled API responses, not copied UI logic.
  runInContext(script.slice(0, script.indexOf('loadWork(0);loadActivity();loadRuns();')), context);
  return { context, elements, clipboard };
}

describe('APME dashboard P0 user actions', () => {
  it('copies a report without query, fragment or URL credentials', async () => {
    const { context, clipboard } = dashboardContext();
    runInContext("copyRunReport('run-123')", context);
    await Promise.resolve();
    expect(clipboard).toHaveBeenCalledWith('Run: run-123\nURL: http://127.0.0.1:9120/apme\n\nTask report');
    expect(clipboard.mock.calls[0][0]).not.toMatch(/secret|password|token=|user:/);
  });

  it('renders API candidates without promoting singleton, unknown or synthetic models', async () => {
    const row = (modelId: string, samples: number): ApmeSampleScorecardRow => ({
      agentType: 'claude-code', provider: null, modelId, samples, taskCategory: 'coding',
      avgQuality: 1, totalCost: null, costKnown: false, avgLatencyMs: null, costPerQuality: null,
    });
    const rows = [row('singleton', 1), row('unknown', 10), row('<synthetic>', 10), row('eligible-model', 3)];
    const recommender = new ApmeRecommender({ enabled: true, sampleScorecard: () => rows } as ApmeStore);
    const fetch = vi.fn(async (url: string, options?: { body: string }) => ({
      ok: true,
      json: async () => url.includes('/apme/samples') ? { scorecards: rows }
        : { candidates: recommender.recommend(JSON.parse(options!.body)), minSamples: APME_COMPARISON_MIN_SAMPLES },
    }));
    const { context, elements } = dashboardContext(fetch);
    await runInContext('loadRecommend()', context);
    const html = elements.get('recommend-content')!.innerHTML;
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/apme/recommend'), expect.objectContaining({ body: '{"taskKind":"coding"}' }));
    expect(html).toContain('eligible-model');
    expect(html).toContain('unpriced');
    expect(html).not.toMatch(/singleton|unknown|synthetic|★|Best:|recommended default/);
  });

  it('withholds comparison when the daemon has no eligible task evidence', async () => {
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/apme/samples')
      ? { scorecards: [{ taskCategory: 'planning' }] } : { candidates: [], minSamples: APME_COMPARISON_MIN_SAMPLES } }));
    const { context, elements } = dashboardContext(fetch);
    await runInContext('loadRecommend()', context);
    expect(elements.get('recommend-content')!.innerHTML).toContain('Not enough evaluated tasks yet');
  });
});

describe('apmeDashboardHtml — data-quality affordances', () => {
  it('explains an un-scored completed run instead of showing a bare header', () => {
    expect(HTML).toContain('Not evaluated');
    // Points at the fix (judge setup) rather than dead-ending.
    expect(HTML).toContain('apme.judge');
    // Makes clear the run still has non-score data.
    expect(HTML).toMatch(/trajectory, cost, and outcome/);
  });

  it('surfaces manual reviews as a distinct, layer-filtered section', () => {
    expect(HTML).toContain('Manual Reviews');
    expect(HTML).toContain("e.layer==='manual_review'");
  });

  it('each aggregate tab has a graceful empty state (no NaN / blank grid)', () => {
    expect(HTML).toContain('No scorecard data yet');
    expect(HTML).toContain('No category data yet');
    expect(HTML).toMatch(/Not enough evaluated tasks yet/);
  });

  it('active sessions are flagged as pending, not silently score-less', () => {
    expect(HTML).toContain('Session active');
  });

  it('opens on the simple deduplicated activity view', () => {
    expect(HTML).toContain("showTab('activity')");
    expect(HTML).toContain('/apme/activity');
    expect(HTML).toContain('Swift + CLI merged');
  });
});

describe('bundled Swift-daemon dashboard copy', () => {
  // The Swift daemon serves apple/AgentDeck/Resources/apme-dashboard.html at
  // GET /apme (ApmeHttpRoutes.dashboardHtml). Before this gate it was a
  // hand-copied snapshot that silently fell a whole feature behind (31 KB vs
  // 66 KB — App Store users never saw the Work board). The renderer stays the
  // SSOT; the bundle is a generated mirror.
  it('matches apmeDashboardHtml() byte-for-byte (pnpm generate-apme-dashboard)', () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const bundled = readFileSync(
      `${repoRoot}apple/AgentDeck/Resources/apme-dashboard.html`, 'utf-8');
    // Hash compare so a drift failure prints one line, not a 66 KB diff.
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(
      `${bundled.length} bytes sha256:${sha(bundled)}`,
    ).toBe(`${HTML.length} bytes sha256:${sha(HTML)}`);
  });
});
