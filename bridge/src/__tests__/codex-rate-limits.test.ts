import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseCodexRateLimitsFromText, pickCodexRateLimits } from '../codex-rate-limits.js';

// A realistic token_count line as Codex CLI writes it to a rollout file.
const tokenCountLine = JSON.stringify({
  timestamp: '2026-06-27T09:59:09.566Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 18390 }, model_context_window: 258400 },
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 8.0, window_minutes: 300, resets_at: 1782570990 },
      secondary: { used_percent: 1.0, window_minutes: 10080, resets_at: 1783157790 },
      credits: null,
      plan_type: 'plus',
      rate_limit_reached_type: null,
    },
  },
});

describe('parseCodexRateLimitsFromText', () => {
  it('parses primary/secondary windows and converts resets_at to ISO', () => {
    const result = parseCodexRateLimitsFromText(tokenCountLine);
    expect(result).not.toBeNull();
    expect(result!.planType).toBe('plus');
    expect(result!.primary).toEqual({
      usedPercent: 8.0,
      windowMinutes: 300,
      resetsAt: new Date(1782570990 * 1000).toISOString(),
    });
    expect(result!.secondary).toEqual({
      usedPercent: 1.0,
      windowMinutes: 10080,
      resetsAt: new Date(1783157790 * 1000).toISOString(),
    });
  });

  it('returns the most recent snapshot when multiple lines are present', () => {
    const older = JSON.parse(tokenCountLine);
    older.payload.rate_limits.primary.used_percent = 2.0;
    const newer = JSON.parse(tokenCountLine);
    newer.payload.rate_limits.primary.used_percent = 42.0;
    const text = [JSON.stringify(older), JSON.stringify(newer)].join('\n');
    const result = parseCodexRateLimitsFromText(text);
    expect(result!.primary!.usedPercent).toBe(42.0);
  });

  it('clamps used_percent into 0..100', () => {
    const over = JSON.parse(tokenCountLine);
    over.payload.rate_limits.primary.used_percent = 150;
    over.payload.rate_limits.secondary.used_percent = -5;
    const result = parseCodexRateLimitsFromText(JSON.stringify(over));
    expect(result!.primary!.usedPercent).toBe(100);
    expect(result!.secondary!.usedPercent).toBe(0);
  });

  it('tolerates a truncated leading line (tail window cut mid-line)', () => {
    const text = ['{"payload":{"type":"token_co', tokenCountLine].join('\n');
    const result = parseCodexRateLimitsFromText(text);
    expect(result!.primary!.usedPercent).toBe(8.0);
  });

  it('returns null when no rate_limits line exists', () => {
    expect(parseCodexRateLimitsFromText('{"type":"message"}\n{"foo":1}')).toBeNull();
  });

  it('omits a window missing required fields', () => {
    const partial = JSON.parse(tokenCountLine);
    delete partial.payload.rate_limits.secondary.window_minutes;
    const result = parseCodexRateLimitsFromText(JSON.stringify(partial));
    expect(result!.primary).toBeDefined();
    expect(result!.secondary).toBeUndefined();
  });

  // Credit-based plans report null 5h/7d windows and a `credits` block instead.
  // Verbatim shape from a live rollout after the account moved to "premium".
  const creditsLine = JSON.stringify({
    timestamp: '2026-06-28T03:38:23.141Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        limit_id: 'premium',
        limit_name: null,
        primary: null,
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        individual_limit: null,
        plan_type: null,
        rate_limit_reached_type: null,
      },
    },
  });

  it('keeps a credit-based snapshot when windows are null', () => {
    const result = parseCodexRateLimitsFromText(creditsLine);
    expect(result).not.toBeNull();
    expect(result!.primary).toBeUndefined();
    expect(result!.secondary).toBeUndefined();
    expect(result!.limitId).toBe('premium');
    expect(result!.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' });
  });

  it('prefers a windowed snapshot over an older credits-only one', () => {
    const text = [creditsLine, tokenCountLine].join('\n');
    const result = parseCodexRateLimitsFromText(text);
    expect(result!.primary!.usedPercent).toBe(8.0);
  });

  it('still returns null when neither windows, credits, nor limitId are present', () => {
    const bare = JSON.stringify({
      payload: { type: 'token_count', rate_limits: { primary: null, secondary: null } },
    });
    expect(parseCodexRateLimitsFromText(bare)).toBeNull();
  });
});

// A rollout line with the given primary/secondary used_percent.
const rolloutLine = (primaryPct: number, secondaryPct = 1): string =>
  JSON.stringify({
    timestamp: '2026-07-05T00:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: primaryPct, window_minutes: 300, resets_at: 1783249801 },
        secondary: { used_percent: secondaryPct, window_minutes: 10080, resets_at: 1783836601 },
        credits: null,
        plan_type: 'plus',
      },
    },
  });

/**
 * pickCodexRateLimits selects the newest usable snapshot across recent
 * day-directories — not just the single newest day-dir. This guards the bug
 * where a session that started on a prior day (its rollout stays in the older
 * day-dir) had its live rate_limits ignored because a fresh, empty session
 * created a newer day-directory.
 */
describe('pickCodexRateLimits (file selection across day-dirs)', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const r of tmpRoots.splice(0)) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  /** Build a temp sessions tree. `files` maps `YYYY/MM/DD/rollout-name.jsonl`
   *  → { content, mtimeMs }. Returns the sessions-root path. */
  function makeTree(files: Record<string, { content: string; mtimeMs: number }>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sessions-'));
    tmpRoots.push(root);
    for (const [rel, { content, mtimeMs }] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      const t = new Date(mtimeMs);
      fs.utimesSync(full, t, t);
    }
    return root;
  }

  it('returns null when the tree does not exist', () => {
    expect(pickCodexRateLimits(path.join(os.tmpdir(), 'no-such-codex-root-xyz'))).toBeNull();
  });

  it('picks the active prior-day rollout over a newer empty day-dir', () => {
    // Newer day-dir (07/05) file: no rate_limits, older mtime.
    // Prior day-dir (07/04) file: valid windows, NEWEST mtime (still appending).
    const root = makeTree({
      '2026/07/05/rollout-2026-07-05T17-22-21-aaaa.jsonl': {
        content: '{"type":"message"}\n{"foo":1}\n',
        mtimeMs: Date.parse('2026-07-05T17:22:00Z'),
      },
      '2026/07/04/rollout-2026-07-04T09-42-09-bbbb.jsonl': {
        content: rolloutLine(71) + '\n',
        mtimeMs: Date.parse('2026-07-05T17:41:00Z'),
      },
    });
    const result = pickCodexRateLimits(root);
    expect(result).not.toBeNull();
    expect(result!.primary!.usedPercent).toBe(71);
    expect(result!.secondary!.usedPercent).toBe(1);
    expect(result!.planType).toBe('plus');
  });

  it('falls through a newer empty file to an older one with data in the same day-dir', () => {
    const root = makeTree({
      '2026/07/05/rollout-2026-07-05T18-00-00-empty.jsonl': {
        content: '{"type":"session_meta"}\n',
        mtimeMs: Date.parse('2026-07-05T18:00:00Z'),
      },
      '2026/07/05/rollout-2026-07-05T12-00-00-data.jsonl': {
        content: rolloutLine(33) + '\n',
        mtimeMs: Date.parse('2026-07-05T17:50:00Z'),
      },
    });
    expect(pickCodexRateLimits(root)!.primary!.usedPercent).toBe(33);
  });

  it('reaches across a month boundary for a still-active prior-month session', () => {
    const root = makeTree({
      '2026/08/01/rollout-2026-08-01T09-00-00-fresh.jsonl': {
        content: '{"type":"message"}\n',
        mtimeMs: Date.parse('2026-08-01T09:00:00Z'),
      },
      '2026/07/31/rollout-2026-07-31T23-30-00-active.jsonl': {
        content: rolloutLine(55) + '\n',
        mtimeMs: Date.parse('2026-08-01T09:05:00Z'),
      },
    });
    expect(pickCodexRateLimits(root)!.primary!.usedPercent).toBe(55);
  });
});

/**
 * `capturedAt` is what lets every consumer tell "94% right now" from "94% four
 * hours ago" — the window's own `resetsAt` cannot, since a weekly window stays
 * in the future for up to 7 days. It must come from the snapshot LINE's
 * timestamp, not the file mtime: a rollout keeps growing with lines that carry
 * no `rate_limits`, so mtime drifts forward while the newest usage reading stays
 * put, under-reporting the age of exactly the frozen snapshot it must expose.
 */
describe('capturedAt (snapshot freshness anchor)', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const r of tmpRoots.splice(0)) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeTree(files: Record<string, { content: string; mtimeMs: number }>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-captured-'));
    tmpRoots.push(root);
    for (const [rel, { content, mtimeMs }] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      const t = new Date(mtimeMs);
      fs.utimesSync(full, t, t);
    }
    return root;
  }

  it('stamps the snapshot line timestamp, not the file mtime', () => {
    // The rate_limits line is 4h old; the file kept growing since (mtime now).
    const root = makeTree({
      '2026/08/04/rollout-2026-08-04T20-30-56-active.jsonl': {
        content: rolloutLine(94) + '\n' + JSON.stringify({
          timestamp: '2026-08-04T22:38:42.000Z',
          type: 'response_item',
          payload: { type: 'reasoning' },
        }) + '\n',
        mtimeMs: Date.parse('2026-08-04T22:38:42Z'),
      },
    });
    expect(pickCodexRateLimits(root)!.capturedAt).toBe('2026-07-05T00:00:00.000Z');
  });

  it('falls back to the file mtime when the line carries no timestamp', () => {
    const noTs = JSON.parse(rolloutLine(41));
    delete noTs.timestamp;
    const root = makeTree({
      '2026/08/04/rollout-2026-08-04T20-30-56-active.jsonl': {
        content: JSON.stringify(noTs) + '\n',
        mtimeMs: Date.parse('2026-08-04T18:38:42Z'),
      },
    });
    expect(pickCodexRateLimits(root)!.capturedAt).toBe('2026-08-04T18:38:42.000Z');
  });

  it('falls back to the file mtime when the line timestamp is unparseable', () => {
    const badTs = JSON.parse(rolloutLine(41));
    badTs.timestamp = 'not-a-date';
    const root = makeTree({
      '2026/08/04/rollout-2026-08-04T20-30-56-active.jsonl': {
        content: JSON.stringify(badTs) + '\n',
        mtimeMs: Date.parse('2026-08-04T18:38:42Z'),
      },
    });
    expect(pickCodexRateLimits(root)!.capturedAt).toBe('2026-08-04T18:38:42.000Z');
  });
});
