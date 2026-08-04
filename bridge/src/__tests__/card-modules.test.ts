import { describe, it, expect, vi } from 'vitest';
import {
  sealModuleCard,
  moduleCardId,
  parseModuleCardId,
  buildModuleCards,
  applyModuleChoice,
  threadModule,
  CARD_CHOICE_ID_MAX_BYTES,
  CARD_CHOICE_LABEL_MAX_BYTES,
  CARD_QUESTION_MAX_BYTES,
  type CardModule,
  type CardModuleContext,
} from '../card-modules.js';
import { applyOutboxDecisions } from '../card-feed.js';
import type { SessionInfo, OutboxDecision } from '@agentdeck/shared';
import { CARD_MAX_CHOICES, CARD_MAX_CONTEXT_LINES } from '@agentdeck/shared';

const NOW = 1_750_000_000_000;

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 'sid', port: 0, projectName: 'AgentDeck', alive: true, state: 'idle', ...over } as SessionInfo;
}
const ctx = (sessions: SessionInfo[] = []): CardModuleContext => ({ sessions, now: NOW });
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

describe('module card ids', () => {
  it('round-trips module:<id>:<key>, including keys that contain colons', () => {
    expect(moduleCardId('nudge', 'observed:claude:abc')).toBe('module:nudge:observed:claude:abc');
    expect(parseModuleCardId('module:nudge:observed:claude:abc'))
      .toEqual({ module: 'nudge', key: 'observed:claude:abc' });
  });

  it('rejects session card ids and malformed ones', () => {
    expect(parseModuleCardId('session:abc')).toBeUndefined();
    expect(parseModuleCardId('module:')).toBeUndefined();
    expect(parseModuleCardId('module::key')).toBeUndefined();
    expect(parseModuleCardId('')).toBeUndefined();
  });
});

describe('sealModuleCard — the ≤4-choice rule as a clamp', () => {
  it('binds at most three choices, because slot 1 is the device Later', () => {
    const card = sealModuleCard('quest', {
      key: 'k',
      actionClass: 'day',
      title: 'QUEST',
      question: 'Ship the thing?',
      choices: [
        { id: 'a', label: 'Yes' }, { id: 'b', label: 'No' },
        { id: 'c', label: 'Tomorrow' }, { id: 'd', label: 'Never' },
      ],
    });
    expect(card.module!.choices).toHaveLength(CARD_MAX_CHOICES);
    expect(card.module!.choices!.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops choices missing an id or a label rather than shipping a blank button', () => {
    const card = sealModuleCard('nudge', {
      key: 'k',
      actionClass: 'day',
      title: 'NUDGE',
      question: 'q',
      choices: [
        { id: '', label: 'no id' },
        { id: 'ok', label: '' },
        { id: 'yes', label: 'Yes' },
      ] as never,
    });
    expect(card.module!.choices).toEqual([{ id: 'yes', label: 'Yes' }]);
  });

  it('caps context lines and omits empty collections entirely', () => {
    const card = sealModuleCard('pulse', {
      key: 'k',
      actionClass: 'info',
      title: 'PULSE',
      question: 'q',
      context: ['a', '', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(card.module!.context).toEqual(['a', 'b', 'c', 'd'].slice(0, CARD_MAX_CONTEXT_LINES));
    expect(card.module!.choices).toBeUndefined();
  });

  it('trims text to a UTF-8 byte budget on a code-point boundary', () => {
    // 3 bytes per Hangul syllable: a character-counted cap would sail past the
    // firmware buffer and get cut mid-sequence into broken glyphs.
    const label = '가'.repeat(40);
    const card = sealModuleCard('nudge', {
      key: 'k',
      actionClass: 'day',
      title: 'NUDGE',
      question: '나'.repeat(200),
      choices: [{ id: 'a', label }],
    });
    const trimmedLabel = card.module!.choices![0]!.label;
    expect(utf8Len(trimmedLabel)).toBeLessThanOrEqual(CARD_CHOICE_LABEL_MAX_BYTES);
    expect(trimmedLabel).toBe('가'.repeat(Math.floor(CARD_CHOICE_LABEL_MAX_BYTES / 3)));
    expect(utf8Len(card.module!.question)).toBeLessThanOrEqual(CARD_QUESTION_MAX_BYTES);
    // Boundary-clean: re-encoding is lossless (no replacement characters).
    expect(card.module!.question).not.toContain('�');
  });

  it('bounds stable choice ids for fixed firmware outbox buffers', () => {
    const card = sealModuleCard('nudge', {
      key: 'k', actionClass: 'day', title: 'NUDGE', question: 'q',
      choices: [{ id: 'x'.repeat(100), label: 'Long id' }],
    });
    expect(new TextEncoder().encode(card.module!.choices![0]!.id).length).toBeLessThanOrEqual(CARD_CHOICE_ID_MAX_BYTES);
  });

  it('stamps the card id and keeps the class/expiry the module asked for', () => {
    const card = sealModuleCard('thread', {
      key: 'open', actionClass: 'info', title: 'THREAD', question: 'q',
    });
    expect(card.cardId).toBe('module:thread:open');
    expect(card.actionClass).toBe('info');
    expect(card.expiresAt).toBeUndefined();
    expect(card.session).toBeUndefined();
  });
});

describe('buildModuleCards', () => {
  it('a module that throws is skipped, the rest of the feed survives', () => {
    const bad: CardModule = { id: 'pulse', build: () => { throw new Error('boom'); } };
    const good: CardModule = {
      id: 'nudge',
      build: () => [{ key: 'k', actionClass: 'day', title: 'NUDGE', question: 'still on?' }],
    };
    const cards = buildModuleCards(ctx(), [bad, good]);
    expect(cards.map((c) => c.cardId)).toEqual(['module:nudge:k']);
  });
});

describe('THREAD module', () => {
  it('produces nothing when there is no live session', () => {
    expect(threadModule.build(ctx([]))).toEqual([]);
    expect(threadModule.build(ctx([session({ alive: false })]))).toEqual([]);
  });

  it('leads with how many threads need the user', () => {
    const drafts = threadModule.build(ctx([
      session({ id: '1', projectName: 'AgentDeck', state: 'processing', elapsedSec: 130 }),
      session({ id: '2', projectName: 'Remin', state: 'awaiting_option' }),
    ]));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.question).toBe('1 of 2 threads need you');
    // Attention sorts first — the top line is the one read from across a room.
    expect(drafts[0]!.context![0]).toBe('Remin — waiting on you');
    expect(drafts[0]!.context![1]).toBe('AgentDeck — working 2m');
    expect(drafts[0]!.actionClass).toBe('info');
  });

  it('checkpoints an idle session with its last milestone', () => {
    const drafts = threadModule.build(ctx([
      session({ id: '1', projectName: 'AgentDeck', state: 'idle', currentTask: 'card modules' }),
    ]));
    expect(drafts[0]!.question).toBe('1 thread open');
    expect(drafts[0]!.context).toEqual(['AgentDeck — card modules']);
  });

  it('says what did not fit instead of implying the list is complete', () => {
    const many = Array.from({ length: 7 }, (_, i) => session({ id: String(i), projectName: `P${i}` }));
    const drafts = threadModule.build(ctx(many));
    const context = drafts[0]!.context!;
    expect(context).toHaveLength(CARD_MAX_CONTEXT_LINES);
    expect(context[context.length - 1]).toContain(`(+${7 - CARD_MAX_CONTEXT_LINES} more)`);
  });
});

describe('card_choice routing', () => {
  const answering: CardModule = {
    id: 'nudge',
    build: () => [],
    apply: vi.fn(() => ({ status: 'applied' as const })),
  };

  it('routes a choice to the authoring module with the card key', () => {
    const out = applyModuleChoice(
      { cardId: 'module:nudge:2026-07-27', action: 'card_choice', choiceId: 'yes' } as OutboxDecision,
      ctx(), [answering],
    );
    expect(out.status).toBe('applied');
    expect(answering.apply).toHaveBeenCalledWith(
      expect.objectContaining({ choiceId: 'yes' }), '2026-07-27', expect.anything(),
    );
  });

  it('is terminal — never retryable — for unknown, read-only, or id-less cards', () => {
    expect(applyModuleChoice(
      { cardId: 'module:quest:k', action: 'card_choice', choiceId: 'y' } as OutboxDecision, ctx(), [answering],
    ).status).toBe('unknown_card');
    expect(applyModuleChoice(
      { cardId: 'module:thread:open', action: 'card_choice', choiceId: 'y' } as OutboxDecision,
      ctx(), [threadModule],
    ).status).toBe('rejected');
    expect(applyModuleChoice(
      { cardId: 'module:nudge:k', action: 'card_choice' } as OutboxDecision, ctx(), [answering],
    ).status).toBe('rejected');
    expect(applyModuleChoice(
      { cardId: 'session:abc', action: 'card_choice', choiceId: 'y' } as OutboxDecision, ctx(), [answering],
    ).status).toBe('rejected');
  });

  it('a throwing module reports error rather than taking the batch down', () => {
    const boom: CardModule = { id: 'quest', build: () => [], apply: () => { throw new Error('nope'); } };
    const out = applyModuleChoice(
      { cardId: 'module:quest:k', action: 'card_choice', choiceId: 'y' } as OutboxDecision, ctx(), [boom],
    );
    expect(out).toEqual({ status: 'error', reason: 'nope' });
  });

  it('reaches the module through the outbox path, without touching session state', () => {
    const dispatch = vi.fn();
    const res = applyOutboxDecisions(
      { board: 'xteink_x4', decisions: [{ cardId: 'module:nudge:k', action: 'card_choice', choiceId: 'yes' }] },
      { sessions: [], isPendingRequest: () => false, dispatch, now: NOW, modules: [answering] },
    );
    expect(res.results[0]!.status).toBe('applied');
    // A day-class answer is the module's business — no session command escapes.
    expect(dispatch).not.toHaveBeenCalled();
  });
});
