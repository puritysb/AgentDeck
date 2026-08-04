import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CardFeedGlance, OutboxDecision, SessionInfo } from '@agentdeck/shared';
import { applyModuleChoice, buildModuleCards, type CardModuleContext } from '../card-modules.js';
import {
  AutonomousPocketEngine,
  parsePocketAutonomyConfig,
} from '../pocket-autonomy.js';

const NOW = new Date(2026, 7, 4, 9, 0, 0).getTime();
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sid',
    port: 0,
    projectName: 'AgentDeck',
    alive: true,
    state: 'idle',
    currentTask: 'Design the Pocket feed',
    ...over,
  } as SessionInfo;
}

function glance(): CardFeedGlance {
  return {
    weather: {
      place: 'Seoul',
      rain: { startHm: '15:00', endHm: '18:00', probability: 70 },
    },
    events: [{ startHm: '17:30', title: 'Dentist' }],
    usage: [{ provider: 'claude', label: 'Claude', primaryPercent: 84, stale: false }],
  };
}

function context(now = NOW, sessions = [session()]): CardModuleContext {
  return { now, sessions, glance: glance() };
}

function keyOf(cardId: string): string {
  return cardId.split(':').slice(2).join(':');
}

describe('AutonomousPocketEngine', () => {
  it('cold-start explores a preference quest and the strongest available signal', () => {
    const engine = new AutonomousPocketEngine({ persist: false, config: { maxCards: 2, exploration: 0 } });
    const cards = buildModuleCards(context(), engine.modules());

    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.module?.module)).toContain('quest');
    expect(cards.map((card) => card.cardId)).toContainEqual(expect.stringContaining('module:nudge:auto:weather:'));
    expect(cards.every((card) => card.actionClass === 'day')).toBe(true);
  });

  it('learns from choices and stops repeating the cold-start survey', () => {
    const engine = new AutonomousPocketEngine({ persist: false, config: { maxCards: 2, exploration: 0 } });
    const modules = engine.modules();
    const first = buildModuleCards(context(), modules);
    engine.observeDelivery(first, NOW, 'xteink_x4');

    const quest = first.find((card) => card.module?.module === 'quest')!;
    const weather = first.find((card) => card.cardId.includes(':weather:'))!;
    expect(applyModuleChoice({
      cardId: quest.cardId, action: 'card_choice', choiceId: 'day',
    } as OutboxDecision, context(), modules).status).toBe('applied');
    expect(applyModuleChoice({
      cardId: weather.cardId, action: 'card_choice', choiceId: 'less',
    } as OutboxDecision, context(), modules).status).toBe('applied');

    const next = buildModuleCards(context(NOW + 60 * 60 * 1000), modules);
    expect(next.some((card) => card.module?.module === 'quest')).toBe(false);
    expect(next[0]!.cardId).toContain('module:nudge:auto:agenda:');
  });

  it('treats a retried outbox answer as idempotent', () => {
    const engine = new AutonomousPocketEngine({ persist: false });
    const modules = engine.modules();
    const card = buildModuleCards(context(), modules).find((item) => item.module?.module === 'quest')!;
    const decision = { cardId: card.cardId, action: 'card_choice', choiceId: 'work' } as OutboxDecision;

    expect(applyModuleChoice(decision, context(), modules).status).toBe('applied');
    expect(applyModuleChoice(decision, context(), modules).status).toBe('applied');
    expect(engine.diagnostics().feedbackCount).toBe(1);
  });

  it('persists only aggregate learning state and opaque fingerprints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-pocket-'));
    scratch.push(dir);
    const statePath = join(dir, 'pocket-autonomy.json');
    const engine = new AutonomousPocketEngine({ statePath });
    const cards = buildModuleCards(context(NOW, [session({ projectName: 'Secret Project' })]), engine.modules());
    engine.observeDelivery(cards, NOW, 'xteink_x3');
    engine.flush();

    const saved = readFileSync(statePath, 'utf8');
    expect(saved).not.toContain('Secret Project');
    expect(saved).not.toContain('Dentist');
    expect(saved).not.toContain('Seoul');
    expect(saved).toContain('weather');

    const reloaded = new AutonomousPocketEngine({ statePath });
    expect(reloaded.diagnostics().arms.weather?.shown).toBe(1);
  });

  it('counts delivered cards with no response as weak negative evidence after a day', () => {
    const engine = new AutonomousPocketEngine({ persist: false, config: { maxCards: 2, exploration: 0 } });
    const first = buildModuleCards(context(), engine.modules());
    engine.observeDelivery(first, NOW);

    const tomorrow = NOW + 25 * 60 * 60 * 1000;
    const next = buildModuleCards(context(tomorrow), engine.modules());
    engine.observeDelivery(next, tomorrow);

    expect(engine.diagnostics().arms.weather?.ignored).toBe(1);
  });

  it('routes only stable Pocket choices', () => {
    const engine = new AutonomousPocketEngine({ persist: false });
    const modules = engine.modules();
    const card = buildModuleCards(context(), modules).find((item) => item.module?.module === 'nudge')!;
    const rejected = applyModuleChoice({
      cardId: card.cardId,
      action: 'card_choice',
      choiceId: 'position-2',
    } as OutboxDecision, context(), modules);
    expect(rejected).toEqual({ status: 'rejected', reason: 'unknown Pocket feedback' });
    expect(keyOf(card.cardId)).toMatch(/^auto:/);
  });
});

describe('parsePocketAutonomyConfig', () => {
  it('defaults on absent settings and clamps explicit bounds', () => {
    expect(parsePocketAutonomyConfig({})).toEqual({ enabled: true, maxCards: 2, exploration: 0.65 });
    expect(parsePocketAutonomyConfig({ pocketAutonomy: { enabled: false, maxCards: 99, exploration: -4 } }))
      .toEqual({ enabled: false, maxCards: 3, exploration: 0 });
  });
});

