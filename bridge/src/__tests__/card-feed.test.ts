import { describe, it, expect, vi } from 'vitest';
import {
  classifySessionCard,
  buildCardFeed,
  applyPullOtaBootstrap,
  applyOutboxDecisions,
  OutboxIdempotencyLedger,
  FeedPullTracker,
  formatFeedPull,
  normalizeClientIp,
  PERMISSION_GATE_TTL_MS,
  AWAITING_PROMPT_TTL_MS,
  trimUtf8Bytes,
  buildGlanceUsage,
  buildGlanceWrapup,
  buildGlance,
  projectPortableReaderGlance,
  parsePullTelemetry,
  type OutboxApplyDeps,
} from '../card-feed.js';
import type { SessionInfo, OutboxDecision } from '@agentdeck/shared';
import { CARD_FEED_IDLE_PULL_SEC, CARD_FEED_ACTIVE_PULL_SEC } from '@agentdeck/shared';

const NOW = 1_750_000_000_000;

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'observed:claude:abc',
    port: 0,
    projectName: 'AgentDeck',
    alive: true,
    state: 'idle',
    ...over,
  } as SessionInfo;
}

describe('classifySessionCard', () => {
  it('permission gate → live with the long-poll TTL', () => {
    const c = classifySessionCard(session({ requestId: 'req-1', state: 'awaiting_permission' }), NOW);
    expect(c.actionClass).toBe('live');
    expect(c.expiresAt).toBe(NOW + PERMISSION_GATE_TTL_MS);
  });

  it('awaiting prompt without requestId → live with the awaiting backstop TTL', () => {
    const c = classifySessionCard(session({ state: 'awaiting_option', question: 'Pick one' }), NOW);
    expect(c.actionClass).toBe('live');
    expect(c.expiresAt).toBe(NOW + AWAITING_PROMPT_TTL_MS);
  });

  it('idle/processing sessions → info without expiry', () => {
    expect(classifySessionCard(session({ state: 'idle' }), NOW)).toEqual({ actionClass: 'info' });
    expect(classifySessionCard(session({ state: 'processing' }), NOW)).toEqual({ actionClass: 'info' });
  });
});

describe('buildCardFeed', () => {
  it('derives one card per session with cardId session:<id>', () => {
    // `[]` = no card modules: this asserts the session projection alone.
    const feed = buildCardFeed([session({ id: 'a' }), session({ id: 'b', state: 'awaiting_option' })], NOW, []);
    expect(feed.type).toBe('card_feed');
    expect(feed.rev).toBe(1);
    expect(feed.serverTime).toBe(NOW);
    expect(feed.serverHm).toMatch(/^\d{2}:\d{2}$/);
    expect(feed.cards.map((c) => c.cardId)).toEqual(['session:a', 'session:b']);
    expect(feed.cards[1]!.actionClass).toBe('live');
    expect(feed.cards[0]!.session?.id).toBe('a');
  });

  it('module cards (M7) follow the session projections and carry no session body', () => {
    const feed = buildCardFeed([session({ id: 'a', projectName: 'AgentDeck' })], NOW);
    const modules = feed.cards.filter((c) => c.module);
    expect(feed.cards[0]!.cardId).toBe('session:a');
    expect(modules.map((c) => c.cardId)).toEqual(['module:thread:open']);
    expect(modules[0]!.session).toBeUndefined();
    expect(modules[0]!.actionClass).toBe('info');
    expect(modules[0]!.module!.module).toBe('thread');
  });

  it('builds a module-only feed for an offline-first Pocket reader', () => {
    const feed = buildCardFeed([session({ id: 'a', projectName: 'AgentDeck', state: 'processing' })], NOW, undefined, {
      includeSessions: false,
    });
    expect(feed.cards.some((card) => card.session)).toBe(false);
    expect(feed.cards.map((card) => card.cardId)).toEqual(['module:thread:open']);
    expect(feed.nextPullSec).toBe(CARD_FEED_IDLE_PULL_SEC);
  });

  it('pull cadence hint: idle roster → idle interval, active roster → active interval', () => {
    expect(buildCardFeed([session()], NOW).nextPullSec).toBe(CARD_FEED_IDLE_PULL_SEC);
    expect(buildCardFeed([session({ state: 'processing' })], NOW).nextPullSec).toBe(CARD_FEED_ACTIVE_PULL_SEC);
    expect(buildCardFeed([session({ state: 'awaiting_permission' })], NOW).nextPullSec).toBe(CARD_FEED_ACTIVE_PULL_SEC);
    expect(buildCardFeed([], NOW).nextPullSec).toBe(CARD_FEED_IDLE_PULL_SEC);
  });
});

describe('pull OTA Feed bootstrap', () => {
  it('replaces a full deck with a cache-preserving OTA bootstrap envelope', () => {
    const feed = buildCardFeed([session()], NOW, undefined, {
      glance: buildGlance({ sessions: [] }),
    });

    expect(applyPullOtaBootstrap(feed, true)).toBe(true);
    expect(feed.cards).toEqual([]);
    expect(feed.unchanged).toBe(true);
    expect(feed.glance).toBeUndefined();
  });

  it('leaves ordinary and already-conditional feeds untouched', () => {
    const ordinary = buildCardFeed([session()], NOW);
    const ordinaryCards = ordinary.cards;
    expect(applyPullOtaBootstrap(ordinary, false)).toBe(false);
    expect(ordinary.cards).toBe(ordinaryCards);
    expect(ordinary.unchanged).toBeUndefined();

    const conditional = buildCardFeed([session()], NOW, undefined, { echoSig: ordinary.deckSig });
    expect(applyPullOtaBootstrap(conditional, true)).toBe(false);
    expect(conditional.unchanged).toBe(true);
  });
});

function makeDeps(over: Partial<OutboxApplyDeps> = {}): OutboxApplyDeps & { dispatch: ReturnType<typeof vi.fn> } {
  return {
    sessions: [],
    isPendingRequest: () => false,
    dispatch: vi.fn(),
    now: NOW,
    ...over,
  } as OutboxApplyDeps & { dispatch: ReturnType<typeof vi.fn> };
}

const push = (decisions: OutboxDecision[], deps: OutboxApplyDeps) =>
  applyOutboxDecisions({ board: 'xteink_x4', decisions }, deps);

describe('applyOutboxDecisions', () => {
  it('dismiss is always acknowledged, never dispatched', () => {
    const deps = makeDeps();
    const res = push([{ cardId: 'session:a', action: 'dismiss' }], deps);
    expect(res.results).toEqual([{ cardId: 'session:a', status: 'applied' }]);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('permission_decision applies only while the gate is still pending', () => {
    const deps = makeDeps({ isPendingRequest: (id) => id === 'req-live' });
    const res = push([
      { cardId: 'session:a', action: 'permission_decision', requestId: 'req-live', decision: 'allow' },
      { cardId: 'session:b', action: 'permission_decision', requestId: 'req-dead', decision: 'deny' },
    ], deps);
    expect(res.results[0]!.status).toBe('applied');
    expect(res.results[1]!.status).toBe('expired');
    expect(deps.dispatch).toHaveBeenCalledOnce();
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'permission_decision', requestId: 'req-live', decision: 'allow' });
  });

  it('permission_decision without requestId/decision is rejected', () => {
    const deps = makeDeps();
    const res = push([{ cardId: 'session:a', action: 'permission_decision' }], deps);
    expect(res.results[0]!.status).toBe('rejected');
  });

  it('select_option routes session-scoped when the session is still awaiting', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'awaiting_option', question: 'Pick one' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'select_option', index: 2, question: 'Pick one' }], deps);
    expect(res.results[0]!.status).toBe('applied');
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'select_option', index: 2, sessionId: 'sid-1' });
  });

  it('select_option expires when the prompt question changed', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'awaiting_option', question: 'NEW question' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'select_option', index: 0, question: 'OLD question' }], deps);
    expect(res.results[0]!.status).toBe('expired');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('select_option expires when the session is no longer awaiting', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'processing' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'select_option', index: 0 }], deps);
    expect(res.results[0]!.status).toBe('expired');
  });

  it('unknown session → unknown_card', () => {
    const deps = makeDeps();
    const res = push([{ cardId: 'session:ghost', action: 'select_option', index: 0 }], deps);
    expect(res.results[0]!.status).toBe('unknown_card');
  });

  it('respond routes through session_command with the value', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'awaiting_permission', question: 'Allow?' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'respond', value: 'y' }], deps);
    expect(res.results[0]!.status).toBe('applied');
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: 'session_command', sessionId: 'sid-1', command: { type: 'respond', value: 'y' },
    });
  });

  it('send_prompt queues via session_command for any alive session', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'processing' })] });
    const res = push([{ cardId: 'session:sid-1', action: 'send_prompt', text: 'run the tests' }], deps);
    expect(res.results[0]!.status).toBe('applied');
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: 'session_command', sessionId: 'sid-1', command: { type: 'send_prompt', text: 'run the tests' },
    });
  });

  it('malformed decisions are rejected without dispatch, order preserved', () => {
    const deps = makeDeps({ sessions: [session({ id: 'sid-1', state: 'awaiting_option' })] });
    const res = push([
      { cardId: '', action: 'select_option', index: 0 } as OutboxDecision,
      { cardId: 'session:sid-1', action: 'nonsense' } as unknown as OutboxDecision,
      { cardId: 'session:sid-1', action: 'select_option', index: -1 },
      { cardId: 'session:sid-1', action: 'select_option', index: 1 },
    ], deps);
    expect(res.results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'applied']);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
  });

  it('empty/absent decisions array → ok with no results', () => {
    const res = applyOutboxDecisions({ decisions: [] }, makeDeps());
    expect(res).toEqual({ ok: true, results: [] });
  });

  it('deduplicates a response-loss retry even when its computed age changed', () => {
    const idempotency = new OutboxIdempotencyLedger();
    const deps = makeDeps({
      sessions: [session({ id: 'sid-1', state: 'awaiting_option', question: 'Pick one' })],
      idempotency,
    });
    const first = push([{
      cardId: 'session:sid-1', action: 'select_option', index: 1, question: 'Pick one', ageSec: 30,
    }], deps);
    const retry = push([{
      cardId: 'session:sid-1', action: 'select_option', index: 1, question: 'Pick one', ageSec: 90,
    }], deps);
    expect(first.results).toEqual([{ cardId: 'session:sid-1', status: 'applied' }]);
    expect(retry.results).toEqual(first.results);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });
});

describe('FeedPullTracker', () => {
  const IP = '::ffff:192.168.68.77';

  it('normalizes v4-mapped and loopback client addresses', () => {
    expect(normalizeClientIp('::ffff:192.168.68.77')).toBe('192.168.68.77');
    expect(normalizeClientIp('::1')).toBe('127.0.0.1');
    expect(normalizeClientIp('192.168.68.76')).toBe('192.168.68.76');
  });

  it('first pull carries no interval; the second measures it against the advertised cadence', () => {
    const t = new FeedPullTracker();
    const first = t.record(IP, { cards: 3, nextPullSec: 3600, now: NOW });
    expect(first.client).toBe('192.168.68.77');
    expect(first.sinceLastSec).toBeUndefined();
    expect(first.cadenceHonoured).toBeUndefined();

    // Woke 12s late off a drifty internal timer — still the cadence working.
    const second = t.record(IP, { cards: 2, nextPullSec: 3600, now: NOW + 3612_000 });
    expect(second.sinceLastSec).toBe(3612);
    expect(second.expectedSec).toBe(3600);
    expect(second.driftPct).toBeCloseTo(0.003, 3);
    expect(second.cadenceHonoured).toBe(true);
  });

  it('a gap far off the advertised cadence is not counted as honoured', () => {
    const t = new FeedPullTracker();
    t.record(IP, { cards: 0, nextPullSec: 3600, now: NOW });
    // Came back after 4 minutes: something woke it, but not the hourly timer.
    const early = t.record(IP, { cards: 0, nextPullSec: 3600, now: NOW + 240_000 });
    expect(early.cadenceHonoured).toBe(false);
    expect(early.driftPct).toBeCloseTo(-0.933, 3);
    expect(t.clients()[0]!.cadenceHonouredCount).toBe(0);
  });

  it('compares against the cadence advertised on the PREVIOUS pull, not the current one', () => {
    const t = new FeedPullTracker();
    // Sessions were active, so the daemon asked for a 900s cadence...
    t.record(IP, { cards: 1, nextPullSec: 900, now: NOW });
    // ...the device honoured that, and by now the roster went idle (3600s).
    const ev = t.record(IP, { cards: 1, nextPullSec: 3600, now: NOW + 900_000 });
    expect(ev.expectedSec).toBe(900);
    expect(ev.cadenceHonoured).toBe(true);
    expect(ev.nextPullSec).toBe(3600);
  });

  it('learns the board from an outbox push and keeps it for later anonymous pulls', () => {
    const t = new FeedPullTracker();
    const anon = t.record(IP, { cards: 1, nextPullSec: 3600, now: NOW });
    expect(anon.board).toBeUndefined();
    t.noteBoard(IP, 'xteink_x4');
    const named = t.record(IP, { cards: 1, nextPullSec: 3600, now: NOW + 3600_000 });
    expect(named.board).toBe('xteink_x4');
    expect(t.clients()[0]!.board).toBe('xteink_x4');
  });

  it('retains non-secret Surface product identity for card-feed diagnostics', () => {
    const t = new FeedPullTracker();
    t.noteIdentity(IP, {
      board: 'xteink_x3',
      productId: 'io.pocketdaily.reader',
      clientId: 'io.pocketdaily.reader',
      clientVersion: '1.4.1-pocket',
      profile: 'portable-reader/v1',
    });
    const event = t.record(IP, { cards: 2, nextPullSec: 1800, now: NOW });
    expect(event).toMatchObject({
      board: 'xteink_x3', productId: 'io.pocketdaily.reader', clientVersion: '1.4.1-pocket',
    });
    expect(t.clients()[0]).toMatchObject({
      clientId: 'io.pocketdaily.reader', profile: 'portable-reader/v1',
    });
    expect(formatFeedPull(event)).toContain('io.pocketdaily.reader v1.4.1-pocket · xteink_x3');
    expect(JSON.stringify(t.clients())).not.toMatch(/token|secret/i);
  });

  it('tracks clients independently and reports the median observed interval', () => {
    const t = new FeedPullTracker();
    t.noteBoard('192.168.68.76', 'xteink_x3');
    t.record('192.168.68.76', { cards: 0, nextPullSec: 3600, now: NOW });
    t.record(IP, { cards: 0, nextPullSec: 3600, now: NOW + 1000 });
    t.record('192.168.68.76', { cards: 0, nextPullSec: 3600, now: NOW + 3600_000 });
    t.record('192.168.68.76', { cards: 0, nextPullSec: 3600, now: NOW + 7300_000 });

    const clients = t.clients();
    expect(clients).toHaveLength(2);
    const x3 = clients.find((c) => c.board === 'xteink_x3')!;
    expect(x3.pulls).toBe(3);
    expect(x3.medianIntervalSec).toBe(3650);
    expect(x3.cadenceHonouredCount).toBe(2);
    // Newest-first ordering: the X3 pulled most recently.
    expect(clients[0]!.client).toBe('192.168.68.76');
  });

  it('bounds its history ring, newest first', () => {
    const t = new FeedPullTracker({ historyLimit: 3 });
    for (let i = 0; i < 5; i++) t.record(IP, { cards: i, nextPullSec: 3600, now: NOW + i * 1000 });
    const recent = t.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.cards)).toEqual([4, 3, 2]);
  });

  it('formats the pull line with the drift verdict', () => {
    const t = new FeedPullTracker();
    t.noteBoard(IP, 'xteink_x4');
    expect(formatFeedPull(t.record(IP, { cards: 3, nextPullSec: 3600, now: NOW })))
      .toBe('card feed pull from xteink_x4 (192.168.68.77): 3 cards, next 3600s — first pull');
    expect(formatFeedPull(t.record(IP, { cards: 1, nextPullSec: 3600, now: NOW + 3708_000 })))
      .toBe('card feed pull from xteink_x4 (192.168.68.77): 1 card, next 3600s'
        + ' — 3708s since last pull (expected 3600s, +3.0%, cadence ok)');
  });
});

describe('conditional pull (deckSig)', () => {
  it('stamps a deckSig and short-circuits to unchanged on a matching echo', () => {
    const roster = [session({ id: 'a' }), session({ id: 'b' })];
    const full = buildCardFeed(roster, NOW, []);
    expect(full.deckSig).toMatch(/^[0-9a-f]{8}$/);
    expect(full.unchanged).toBeUndefined();

    const again = buildCardFeed(roster, NOW + 60_000, [], { echoSig: full.deckSig });
    expect(again.unchanged).toBe(true);
    expect(again.cards).toEqual([]);
    expect(again.glance).toBeUndefined();
    expect(again.deckSig).toBe(full.deckSig);
    // Clock re-anchor and cadence still ride the short-circuit response.
    expect(again.serverTime).toBe(NOW + 60_000);
    expect(again.nextPullSec).toBe(CARD_FEED_IDLE_PULL_SEC);
  });

  it('a ticking elapsedSec does not defeat the signature', () => {
    // Measured on a live daemon (2026-07-31): elapsedSec advances once a
    // second, so before it was excluded the signature changed every second and
    // the conditional pull could never match — the feature was inert.
    const a = buildCardFeed([session({ id: 'a', elapsedSec: 100 })], NOW, []);
    const b = buildCardFeed([session({ id: 'a', elapsedSec: 163 })], NOW + 63_000, [], { echoSig: a.deckSig });
    expect(b.unchanged).toBe(true);
  });

  it('an idle roster stays signature-stable across a long clock advance (the idle-night case)', () => {
    // The conditional pull exists for the overnight case: an idle desk must
    // produce the SAME signature hours later, or a battery client re-downloads
    // the full feed on every wake. Idle sessions render from currentTask, which
    // does not move with the clock — unlike a `processing` thread, whose minute
    // counter is genuine content (it really has been working longer).
    const idle = [
      session({ id: 'a', state: 'idle', currentTask: 'Reviewing the OTA path', elapsedSec: 4000 }),
      session({ id: 'b', state: 'idle', currentTask: 'Waiting for input', elapsedSec: 900 }),
    ];
    const first = buildCardFeed(idle, NOW);
    const laterRoster = idle.map((s) => ({ ...s, elapsedSec: (s.elapsedSec ?? 0) + 8 * 3600 }));
    const later = buildCardFeed(laterRoster, NOW + 8 * 3600_000, undefined, { echoSig: first.deckSig });
    expect(later.unchanged).toBe(true);
  });

  it('a real content change still breaks the match even when elapsedSec moves', () => {
    const a = buildCardFeed([session({ id: 'a', elapsedSec: 100, activity: 'building' })], NOW, []);
    const b = buildCardFeed([session({ id: 'a', elapsedSec: 163, activity: 'running tests' })], NOW + 63_000, [],
      { echoSig: a.deckSig });
    expect(b.unchanged).toBeUndefined();
  });

  it('expiresAt churn does not defeat the signature (live cards re-stamp every build)', () => {
    const roster = [session({ id: 'a', state: 'awaiting_option', question: 'Pick' })];
    const a = buildCardFeed(roster, NOW, []);
    const b = buildCardFeed(roster, NOW + 5_000, [], { echoSig: a.deckSig });
    expect(b.unchanged).toBe(true);
  });

  it('content change breaks the match', () => {
    const a = buildCardFeed([session({ id: 'a', state: 'idle' })], NOW, []);
    const b = buildCardFeed([session({ id: 'a', state: 'processing' })], NOW, [], { echoSig: a.deckSig });
    expect(b.unchanged).toBeUndefined();
    expect(b.cards).toHaveLength(1);
    expect(b.deckSig).not.toBe(a.deckSig);
  });

  it('glance is covered by the signature', () => {
    const roster = [session({ id: 'a' })];
    const a = buildCardFeed(roster, NOW, [], { glance: { wrapup: ['AgentDeck · idle'] } });
    const b = buildCardFeed(roster, NOW, [], { glance: { wrapup: ['AgentDeck · working'] }, echoSig: a.deckSig });
    expect(b.unchanged).toBeUndefined();
    const c = buildCardFeed(roster, NOW, [], { glance: { wrapup: ['AgentDeck · idle'] }, echoSig: a.deckSig });
    expect(c.unchanged).toBe(true);
  });
});

describe('glance builders', () => {
  it('trimUtf8Bytes trims on rune boundaries by byte budget', () => {
    expect(trimUtf8Bytes('short', 64)).toBe('short');
    const cjk = '한국어라벨'.repeat(10); // 3 bytes per char
    const trimmed = trimUtf8Bytes(cjk, 32);
    expect(new TextEncoder().encode(trimmed).length).toBeLessThanOrEqual(32);
    expect(trimmed.endsWith('.')).toBe(true);
  });

  it('buildGlanceUsage derives Claude and Codex rows with integer percents', () => {
    const rows = buildGlanceUsage({
      type: 'usage_update',
      fiveHourPercent: 42.6,
      sevenDayPercent: 17.2,
      fiveHourResetsAt: new Date(NOW + 3600_000).toISOString(),
      usageStale: false,
      codexRateLimits: {
        primary: { usedPercent: 88.4, windowMinutes: 300, resetsAt: new Date(NOW + 1800_000).toISOString() },
        secondary: { usedPercent: 12, windowMinutes: 10080 },
      },
    } as never);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: 'claude', label: 'Claude', primaryPercent: 43, secondaryPercent: 17, stale: false });
    expect(rows[0]!.primaryResetHm).toMatch(/^\d{2}:\d{2}$/);
    expect(rows[1]).toMatchObject({ provider: 'codex', primaryPercent: 88, secondaryPercent: 12 });
  });

  it('buildGlanceUsage emits no row for a provider with no numbers', () => {
    expect(buildGlanceUsage({ type: 'usage_update', usageStale: true } as never)).toEqual([]);
  });

  it('buildGlanceWrapup ranks attention first and folds overflow', () => {
    const roster = [
      session({ id: 'i1', projectName: 'idle-1', state: 'idle' }),
      session({ id: 'p', projectName: 'busy', state: 'processing', activity: 'fixing OTA flash OOM' }),
      session({ id: 'g', projectName: 'gated', state: 'awaiting_permission', requestId: 'r1' }),
      session({ id: 'i2', projectName: 'idle-2', state: 'idle' }),
      session({ id: 'i3', projectName: 'idle-3', state: 'idle' }),
    ];
    const lines = buildGlanceWrapup(roster);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('gated · needs approval');
    expect(lines[1]).toBe('busy · fixing OTA flash OOM');
    expect(lines[3]).toBe('+2 more sessions');
  });

  it('buildGlance returns undefined when there is nothing to say', () => {
    expect(buildGlance({ sessions: [] })).toBeUndefined();
  });

  it('projects portable-reader weather to exactly the fields firmware renders', () => {
    const projected = projectPortableReaderGlance({
      weather: {
        place: 'Seongnam', tempC: 25, code: 0, summary: 'Clear', todayMinC: 23, todayMaxC: 31,
        rain: { startHm: '05:00', endHm: '06:00', probability: 70, amountMm: 2.4 },
        tomorrow: { date: '2026-08-25', summary: 'Showers', code: 81, minC: 24, maxC: 31,
          rainProbability: 78, precipitationMm: 1.6 },
        issuedAt: NOW, validUntil: NOW + 3600_000,
        source: { id: 'met-no', displayName: 'MET Norway', attributionText: 'Data',
          attributionUrl: 'https://example.invalid', modified: true },
        days: [{ date: '2026-08-25', summary: 'Showers' }],
        cues: [{ id: 'rain', revision: 1, kind: 'precipitation.start', severity: 'notice',
          displayAt: NOW, startsAt: NOW, expiresAt: NOW + 3600_000, title: 'Rain' }],
      },
      usage: [{ provider: 'codex', label: 'Codex', primaryPercent: 20, stale: false }],
      wrapup: ['Pocket Daily · testing'],
      events: [{ startHm: '09:00', title: 'Review' }],
    });
    expect(projected).toEqual({
      weather: {
        place: 'Seongnam', tempC: 25, code: 0, summary: 'Clear', todayMinC: 23, todayMaxC: 31,
        rain: { startHm: '05:00', endHm: '06:00', probability: 70 },
        tomorrow: { summary: 'Showers', code: 81, minC: 24, maxC: 31, rainProbability: 78 },
      },
      events: [{ startHm: '09:00', title: 'Review' }],
    });
    expect(JSON.stringify(projected)).not.toContain('source');
    expect(JSON.stringify(projected)).not.toContain('cues');
    expect(JSON.stringify(projected)).not.toContain('days');
  });

  it('projects a compact five-day outlook only when the reader negotiated it', () => {
    const projected = projectPortableReaderGlance({
      weather: {
        place: 'Seongnam', tempC: 25, code: 2, summary: 'Cloudy',
        tomorrow: { summary: 'Legacy', minC: 20, maxC: 30 },
        days: Array.from({ length: 7 }, (_, i) => ({
          date: `2026-08-${String(24 + i).padStart(2, '0')}`,
          summary: i === 2 ? 'Rain' : 'Clear',
          code: i === 2 ? 61 : 0,
          minC: 20 + i,
          maxC: 28 + i,
          rainProbability: i === 2 ? 70 : 0,
          precipitationMm: i === 2 ? 4.5 : 0,
        })),
      },
    }, true);
    expect(projected?.weather?.days).toEqual([
      { date: '2026-08-24', code: 0, minC: 20, maxC: 28 },
      { date: '2026-08-25', code: 0, minC: 21, maxC: 29 },
      { date: '2026-08-26', code: 61, minC: 22, maxC: 30, rainProbability: 70 },
      { date: '2026-08-27', code: 0, minC: 23, maxC: 31 },
      { date: '2026-08-28', code: 0, minC: 24, maxC: 32 },
    ]);
    expect(projected?.weather?.tomorrow).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('precipitationMm');
    expect(JSON.stringify(projected)).not.toContain('summary":"Rain');
  });
});

describe('pull telemetry', () => {
  it('keeps omitted telemetry absent rather than inventing a zero-percent battery', () => {
    expect(parsePullTelemetry(new URLSearchParams())).toEqual({});
  });

  it('parsePullTelemetry keeps in-range values and drops garbage', () => {
    const p = new URLSearchParams('batt=87&mv=4012&rssi=-71');
    expect(parsePullTelemetry(p)).toEqual({ battPct: 87, battMv: 4012, rssiDbm: -71 });
    expect(parsePullTelemetry(new URLSearchParams('batt=180&mv=-5&rssi=12'))).toEqual({});
    expect(parsePullTelemetry(new URLSearchParams('batt=abc'))).toEqual({});
  });

  it('tracker records telemetry and unchanged counts per client', () => {
    const t = new FeedPullTracker();
    t.record('192.168.68.90', { cards: 2, nextPullSec: 3600, now: NOW, telemetry: { battPct: 80, rssiDbm: -66 } });
    t.record('192.168.68.90', { cards: 0, nextPullSec: 3600, now: NOW + 3600_000, unchanged: true, telemetry: { battPct: 79 } });
    const c = t.clients()[0]!;
    expect(c.lastBattPct).toBe(79);
    expect(c.lastRssiDbm).toBe(-66);
    expect(c.unchangedCount).toBe(1);
  });

  it('formats unchanged pulls and telemetry into the log line', () => {
    const t = new FeedPullTracker();
    const line = formatFeedPull(t.record('10.0.0.5', {
      cards: 0, nextPullSec: 3600, now: NOW, unchanged: true, telemetry: { battPct: 55, rssiDbm: -80 },
    }));
    expect(line).toContain('unchanged');
    expect(line).toContain('batt 55%');
    expect(line).toContain('rssi -80');
  });
});
