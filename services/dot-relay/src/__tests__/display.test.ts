import { expect, it } from 'vitest';
import { dotResultModule } from '../../../../bridge/src/dot-host.js';
import { buildModuleCards } from '../../../../bridge/src/card-modules.js';
import { buildCardFeed } from '../../../../bridge/src/card-feed.js';
import { DOT_LIMITS } from '@agentdeck/shared';
it('projects only received reports into bounded inert cards, with absolute times and no session', () => {
  const now = 1800000000000;
  const row = { requestId: 'r', integrationId: 'desk', createdAt: now, expiresAt: now + 1000, delivery: 'accepted',
    report: { summary: '한글'.repeat(100) + '\u001b', state: 'completed', receivedAt: now } };
  const module = dotResultModule(() => [row, { ...row, requestId: 'no-report', report: null }]);
  const cards = buildModuleCards({ sessions: [], now }, [module]);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ cardId: 'module:dot:r', actionClass: 'info', module: { module: 'dot', title: 'DOT' } });
  expect(cards[0].session).toBeUndefined(); expect(cards[0].module?.choices).toBeUndefined();
  expect(Buffer.byteLength(cards[0].module!.question)).toBeLessThanOrEqual(160);
  expect(cards[0].module!.question).not.toContain('\ufffd');
  expect(cards[0].module!.context?.[1]).toBe(new Date(now).toISOString());
  const first = buildCardFeed([], now, [module]);
  expect(buildCardFeed([], now, [module], { echoSig: first.deckSig }).unchanged).toBe(true);
  row.report.summary = '새 결과';
  const updated = buildCardFeed([], now, [module], { echoSig: first.deckSig });
  expect(updated.unchanged).not.toBe(true);
  expect(updated.deckSig).not.toBe(first.deckSig);
  expect(updated.cards[0].cardId).toBe(first.cards[0].cardId);
  expect(module.build({ sessions: [], now: now + DOT_LIMITS.retentionMs })).toEqual([]);
});
it('keeps direction and stage visible on compact cards without granting control', () => {
  const now = 1800000000000;
  const event = { relationId: 'r', sequence: 1, kind: 'control' as const, direction: 'dot_to_agent' as const,
    stage: 'requested' as const, targetRef: '대상'.repeat(64), summary: 'Reported command', evidence: 'dot_report' as const, receivedAt: now };
  const module = dotResultModule(() => [{ requestId: 'r', integrationId: 'desk', createdAt: now, expiresAt: now + 1000,
    delivery: 'accepted', report: null, interactions: [event] }]);
  const card = buildModuleCards({ sessions: [], now }, [module])[0];
  expect(card.module!.question).toContain('control · requested · Dot →');
  expect(card.module!.context).toContain('Dot report; target unverified');
  expect(Buffer.byteLength(card.module!.question)).toBeLessThanOrEqual(160);
  expect(card.actionClass).toBe('info');
  expect(card.module!.choices).toBeUndefined(); expect(card.session).toBeUndefined();
});
