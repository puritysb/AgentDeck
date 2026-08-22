import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseCodexRateLimitsFromText, pickCodexRateLimits, readCodexRateLimits } from '../codex-rate-limits.js';

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

const rolloutLineAt = (primaryPct: number, timestamp: string): string => {
  const line = JSON.parse(rolloutLine(primaryPct));
  line.timestamp = timestamp;
  return JSON.stringify(line);
};

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
      try {
        fs.rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
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

  it('chooses the newest captured snapshot across concurrent active rollouts', () => {
    const root = makeTree({
      '2026/07/05/rollout-newest-mtime-older-snapshot.jsonl': {
        content: rolloutLineAt(39, '2026-07-05T18:00:00.000Z') + '\n{"type":"tool_output"}\n',
        mtimeMs: Date.parse('2026-07-05T18:02:00Z'),
      },
      '2026/07/05/rollout-older-mtime-newer-snapshot.jsonl': {
        content: rolloutLineAt(40, '2026-07-05T18:01:00.000Z') + '\n',
        mtimeMs: Date.parse('2026-07-05T18:01:00Z'),
      },
    });
    const result = pickCodexRateLimits(root);
    expect(result!.primary!.usedPercent).toBe(40);
    expect(result!.capturedAt).toBe('2026-07-05T18:01:00.000Z');
  });

  it('invalidates the cache when a non-leading rollout writes a newer snapshot', () => {
    const root = makeTree({
      '2026/07/05/rollout-leading.jsonl': {
        content: rolloutLineAt(39, '2026-07-05T18:00:00.000Z') + '\n{"type":"tool_output"}\n',
        mtimeMs: Date.parse('2026-07-05T18:05:00Z'),
      },
      '2026/07/05/rollout-secondary.jsonl': {
        content: rolloutLineAt(40, '2026-07-05T18:01:00.000Z') + '\n',
        mtimeMs: Date.parse('2026-07-05T18:01:00Z'),
      },
    });
    expect(readCodexRateLimits(root)!.primary!.usedPercent).toBe(40);

    const secondary = path.join(root, '2026/07/05/rollout-secondary.jsonl');
    fs.writeFileSync(secondary, rolloutLineAt(41, '2026-07-05T18:02:00.000Z') + '\n');
    const changed = new Date('2026-07-05T18:02:00Z');
    fs.utimesSync(secondary, changed, changed);

    expect(readCodexRateLimits(root)!.primary!.usedPercent).toBe(41);
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
/**
 * Plan-aware selection. Both lines below are VERBATIM from
 * `~/.codex/sessions` on 2026-08-22, minutes after a ChatGPT plan upgrade:
 *
 *   • the `plus` line comes from a Codex session opened BEFORE the upgrade and
 *     still running — Codex stamps `plan_type` from the auth token its process
 *     started with, so it keeps writing the retired tier, and being the busy
 *     session it also keeps minting the newest timestamps (16:50 here).
 *   • the `prolite` line comes from a session started AFTER the upgrade. Older
 *     (16:43), and the only snapshot the account can actually use.
 *
 * A newest-wins picker returns the `plus` one, `normalizeCodexRateLimits` voids
 * it as a plan mismatch, and every Codex gauge goes blank for as long as the old
 * session stays open — with a valid snapshot unread on disk the whole time.
 *
 * Fixtures are copied, not composed: a line built from what the parser expects
 * cannot fail the way a real one does.
 */
describe('pickCodexRateLimits (plan-aware selection)', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const r of tmpRoots.splice(0)) {
      try {
        fs.rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // A real pre-upgrade ACCOUNT-WIDE line (`limit_id: "codex"`, no `limit_name`),
  // with ONE field changed: its `timestamp` is moved from 16:30:22 to 16:55:00 so
  // the plan-mismatched snapshot is the NEWER one. Two notes on why, because a
  // fixture that is edited has to say what it is:
  //
  //  - That ordering did occur in the wild — but the line that produced it was a
  //    per-model `codex_bengalfox` snapshot, which the limit-family filter now
  //    skips. Among ACCOUNT-WIDE lines this user's tree never contains a `plus`
  //    line newer than a `prolite` one, because once the account-wide family
  //    caught up it stayed caught up. The ordering is real; this pairing of it
  //    with an account-wide line is constructed.
  //  - The first version of this fixture WAS that `codex_bengalfox` line, taken
  //    as "the newest rate_limits line in the file". Real, and wrong for this
  //    test: it conflated the plan axis with the limit-family axis, and it
  //    started failing the moment the family filter landed. A fixture has to
  //    isolate the axis under test.
  const retiredPlanLine =
    "{\"timestamp\":\"2026-08-21T16:55:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":59664963,\"cached_input_tokens\":58193152,\"cache_write_input_tokens\":0,\"output_tokens\":240328,\"reasoning_output_tokens\":58567,\"total_tokens\":59905291},\"last_token_usage\":{\"input_tokens\":83931,\"cached_input_tokens\":82432,\"cache_write_input_tokens\":0,\"output_tokens\":763,\"reasoning_output_tokens\":311,\"total_tokens\":84694},\"model_context_window\":258400},\"rate_limits\":{\"limit_id\":\"codex\",\"limit_name\":null,\"primary\":{\"used_percent\":100.0,\"window_minutes\":10080,\"resets_at\":1787805401},\"secondary\":null,\"credits\":{\"has_credits\":false,\"unlimited\":false,\"balance\":\"0\"},\"individual_limit\":null,\"spend_control_reached\":null,\"plan_type\":\"plus\",\"rate_limit_reached_type\":null}}}";
  // Captured verbatim from a rollout written by a post-upgrade Codex session.
  const currentPlanLine =
    "{\"timestamp\":\"2026-08-21T16:43:09.009Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":17356,\"cached_input_tokens\":11008,\"cache_write_input_tokens\":0,\"output_tokens\":5,\"reasoning_output_tokens\":0,\"total_tokens\":17361},\"last_token_usage\":{\"input_tokens\":17356,\"cached_input_tokens\":11008,\"cache_write_input_tokens\":0,\"output_tokens\":5,\"reasoning_output_tokens\":0,\"total_tokens\":17361},\"model_context_window\":258400},\"rate_limits\":{\"limit_id\":\"codex\",\"limit_name\":null,\"primary\":{\"used_percent\":0.0,\"window_minutes\":10080,\"resets_at\":1787934975},\"secondary\":null,\"credits\":{\"has_credits\":false,\"unlimited\":false,\"balance\":\"0\"},\"individual_limit\":null,\"spend_control_reached\":null,\"plan_type\":\"prolite\",\"rate_limit_reached_type\":null}}}";

  function makeTree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-'));
    tmpRoots.push(root);
    const files: Record<string, { content: string; mtimeMs: number }> = {
      // The pre-upgrade session is the busiest one, so it also has the newest
      // mtime — it wins the candidate ordering too, not just the timestamps.
      '2026/08/21/rollout-2026-08-21T20-35-38-old.jsonl': {
        content: retiredPlanLine + '\n',
        mtimeMs: Date.parse('2026-08-21T16:51:26.000Z'),
      },
      '2026/08/22/rollout-2026-08-22T01-43-04-new.jsonl': {
        content: currentPlanLine + '\n',
        mtimeMs: Date.parse('2026-08-21T16:43:10.000Z'),
      },
    };
    for (const [rel, { content, mtimeMs }] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      const t = new Date(mtimeMs);
      fs.utimesSync(full, t, t);
    }
    return root;
  }

  it('takes the older snapshot that matches the account tier', () => {
    const result = pickCodexRateLimits(makeTree(), 'prolite');
    expect(result).not.toBeNull();
    expect(result!.planType).toBe('prolite');
  });

  it('keeps pure newest-wins when the account tier is unknown', () => {
    // An API-key install reports no tier. Absence must not reshuffle real data.
    const result = pickCodexRateLimits(makeTree(), undefined);
    expect(result!.planType).toBe('plus');
  });

  it('still returns a mismatched snapshot when it is the only one', () => {
    // Ranking orders snapshots; it never rescues one. The caller voids this
    // downstream — but "no snapshot at all" and "a voided snapshot" are
    // different wire payloads, and only the second one carries the live tier.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-solo-'));
    tmpRoots.push(root);
    const full = path.join(root, '2026/08/21/rollout-old.jsonl');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, retiredPlanLine + '\n');
    expect(pickCodexRateLimits(root, 'prolite')!.planType).toBe('plus');
  });
});

/**
 * Limit-family selection. Both lines are VERBATIM from ONE real rollout on
 * 2026-08-22 — the same session, hours apart, nothing edited.
 *
 * Codex writes more than one limit family and the rollout carries whichever the
 * last request was metered against. Within this single session the family
 * alternated codex -> codex_bengalfox -> codex -> codex_bengalfox over ten
 * hours, so "newest line wins" silently switches which QUANTITY is reported.
 * With the tail ending on the scoped family the deck showed Spark's 0%/0% as
 * the account's Codex usage while the account sat at 13%.
 *
 * Neither existing axis catches it: the scoped line is the newest AND carries
 * the right plan. Only `limit_name` separates them.
 */
describe('pickCodexRateLimits (limit family)', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const r of tmpRoots.splice(0)) {
      try {
        fs.rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // limit_id "codex_bengalfox", limit_name "GPT-5.3-Codex-Spark" — one model.
  const scopedLine = "{\"timestamp\":\"2026-08-22T03:35:01.817Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":171933079,\"cached_input_tokens\":168024576,\"cache_write_input_tokens\":0,\"output_tokens\":553033,\"reasoning_output_tokens\":134283,\"total_tokens\":172486112},\"last_token_usage\":{\"input_tokens\":61724,\"cached_input_tokens\":59904,\"cache_write_input_tokens\":0,\"output_tokens\":284,\"reasoning_output_tokens\":96,\"total_tokens\":62008},\"model_context_window\":258400},\"rate_limits\":{\"limit_id\":\"codex_bengalfox\",\"limit_name\":\"GPT-5.3-Codex-Spark\",\"primary\":{\"used_percent\":0.0,\"window_minutes\":300,\"resets_at\":1787387692},\"secondary\":{\"used_percent\":0.0,\"window_minutes\":10080,\"resets_at\":1787934922},\"credits\":{\"has_credits\":false,\"unlimited\":false,\"balance\":\"0\"},\"individual_limit\":null,\"spend_control_reached\":null,\"plan_type\":\"prolite\",\"rate_limit_reached_type\":null}}}";
  // limit_id "codex", limit_name null — the account. Older than the line above.
  const accountLine = "{\"timestamp\":\"2026-08-21T20:31:37.933Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":90363999,\"cached_input_tokens\":88225792,\"cache_write_input_tokens\":0,\"output_tokens\":336556,\"reasoning_output_tokens\":84038,\"total_tokens\":90700555},\"last_token_usage\":{\"input_tokens\":146078,\"cached_input_tokens\":145536,\"cache_write_input_tokens\":0,\"output_tokens\":689,\"reasoning_output_tokens\":139,\"total_tokens\":146767},\"model_context_window\":258400},\"rate_limits\":{\"limit_id\":\"codex\",\"limit_name\":null,\"primary\":{\"used_percent\":5.0,\"window_minutes\":10080,\"resets_at\":1787934975},\"secondary\":null,\"credits\":{\"has_credits\":false,\"unlimited\":false,\"balance\":\"0\"},\"individual_limit\":null,\"spend_control_reached\":null,\"plan_type\":\"prolite\",\"rate_limit_reached_type\":null}}}";

  function makeTree(content: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-family-'));
    tmpRoots.push(root);
    const full = path.join(root, '2026/08/21/rollout-2026-08-21T20-35-38-mixed.jsonl');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return root;
  }

  it('scans past a newer per-model line to the account-wide one behind it', () => {
    const result = pickCodexRateLimits(makeTree(accountLine + '\n' + scopedLine + '\n'));
    expect(result).not.toBeNull();
    expect(result!.limitId).toBe('codex');
    expect(result!.capturedAt).toBe('2026-08-21T20:31:37.933Z');
    // Codex reports the weekly window in its own `primary` slot here, so this is
    // the 10080-minute account window — not Spark's 5h one.
    expect(result!.primary!.windowMinutes).toBe(10080);
  });

  it("reports no snapshot rather than one model's quota as the account's", () => {
    // A tail with only scoped lines yields nothing. The daemon then falls back to
    // its live `codex app-server` read, which is account-wide; a session bridge
    // shows no Codex gauge. Both beat printing 0: a number under the wrong label
    // is a wrong reading, not a missing one.
    expect(pickCodexRateLimits(makeTree(scopedLine + '\n'))).toBeNull();
  });

  it('keeps the credit-plan family, which is account-wide despite its odd id', () => {
    // limit_id "premium" reports null windows plus a credits block, and
    // limit_name null. 66 such lines exist in the real tree; an id-based filter
    // would have dropped them and taken the credits gauge with them.
    const premium = JSON.stringify({
      timestamp: '2026-07-21T16:17:18.519Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'premium',
          limit_name: null,
          primary: null,
          secondary: null,
          credits: { has_credits: true, unlimited: false, balance: '12' },
        },
      },
    });
    const result = pickCodexRateLimits(makeTree(premium + '\n'));
    expect(result!.limitId).toBe('premium');
    expect(result!.credits!.balance).toBe('12');
  });
});

describe('capturedAt (snapshot freshness anchor)', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const r of tmpRoots.splice(0)) {
      try {
        fs.rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
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
        content:
          rolloutLine(94) +
          '\n' +
          JSON.stringify({
            timestamp: '2026-08-04T22:38:42.000Z',
            type: 'response_item',
            payload: { type: 'reasoning' },
          }) +
          '\n',
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
