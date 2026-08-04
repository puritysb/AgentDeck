/**
 * Card modules (M7) — the daemon's own card producers.
 *
 * M6 cards are all projections of a live session: the daemon reports what is
 * happening and the device renders it. A module card inverts that — the daemon
 * *authors* a card (a checkpoint, a digest, a nudge) and the device carries it
 * as a prepared decision, answerable even while offline.
 *
 * Contract: shared/src/protocol.ts § Card modules. Two rules hold here and are
 * enforced structurally rather than by convention, because a firmware that
 * receives a malformed card has no good move:
 *
 *  1. **≤4 choices, always.** Slot 1 of the four front buttons is the device's
 *     own *Later*, so a module binds at most three. `sealModuleCard` clamps.
 *  2. **Bytes, not characters.** Every text field is trimmed to a UTF-8 byte
 *     budget on a code-point boundary — a firmware `char[]` truncates
 *     mid-sequence into broken glyphs otherwise.
 *
 * Routing: a module card's `cardId` is `module:<moduleId>:<key>`, which is how
 * an outbox `card_choice` recorded hours ago finds its way back to the module
 * that authored it.
 */

import type {
  SessionInfo,
  FeedCard,
  ModuleCard,
  CardChoice,
  CardModuleId,
  CardActionClass,
  OutboxDecision,
  OutboxDecisionStatus,
} from '@agentdeck/shared';
import {
  CARD_MAX_CHOICES,
  CARD_MAX_CONTEXT_LINES,
  truncateUtf8Bytes,
} from '@agentdeck/shared';

/** Text budgets, in UTF-8 bytes, matched to the device's card buffers
 *  (`question[160]`, `PromptOption.label[80]` in the fork's agent_state.h).
 *  A re-port that grows a buffer bumps these together with it. */
export const CARD_TITLE_MAX_BYTES = 24;
export const CARD_QUESTION_MAX_BYTES = 160;
export const CARD_CONTEXT_LINE_MAX_BYTES = 96;
export const CARD_CHOICE_ID_MAX_BYTES = 31;
export const CARD_CHOICE_LABEL_MAX_BYTES = 40;

export const CARD_ID_PREFIX = 'module:';

export function moduleCardId(module: CardModuleId, key: string): string {
  return `${CARD_ID_PREFIX}${module}:${key}`;
}

/** Split `module:<moduleId>:<key>`. Returns undefined for session card ids. */
export function parseModuleCardId(cardId: string): { module: string; key: string } | undefined {
  if (typeof cardId !== 'string' || !cardId.startsWith(CARD_ID_PREFIX)) return undefined;
  const rest = cardId.slice(CARD_ID_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return undefined;
  return { module: rest.slice(0, sep), key: rest.slice(sep + 1) };
}

/** What a module returns; ids/limits are applied by `sealModuleCard`. */
export interface ModuleCardDraft {
  /** Unique within the module. Combined into `module:<id>:<key>`. */
  key: string;
  actionClass: CardActionClass;
  expiresAt?: number;
  title: string;
  question: string;
  context?: string[];
  choices?: CardChoice[];
  sessionId?: string;
}

/**
 * The single chokepoint every module card passes through. Clamps rather than
 * rejects: a module that over-produces should still show its question, minus
 * the parts that cannot fit a four-button e-ink card.
 */
export function sealModuleCard(module: CardModuleId, draft: ModuleCardDraft): FeedCard {
  const choices = (draft.choices ?? [])
    .filter((c) => c && typeof c.id === 'string' && c.id && typeof c.label === 'string' && c.label)
    .slice(0, CARD_MAX_CHOICES)
    .map((c) => ({
      id: truncateUtf8Bytes(c.id, CARD_CHOICE_ID_MAX_BYTES),
      label: truncateUtf8Bytes(c.label, CARD_CHOICE_LABEL_MAX_BYTES),
      ...(c.intent ? { intent: c.intent } : {}),
    }));
  const context = (draft.context ?? [])
    .filter((l) => typeof l === 'string' && l.length > 0)
    .slice(0, CARD_MAX_CONTEXT_LINES)
    .map((l) => truncateUtf8Bytes(l, CARD_CONTEXT_LINE_MAX_BYTES));

  const body: ModuleCard = {
    module,
    title: truncateUtf8Bytes(draft.title, CARD_TITLE_MAX_BYTES),
    question: truncateUtf8Bytes(draft.question, CARD_QUESTION_MAX_BYTES),
    ...(context.length ? { context } : {}),
    ...(choices.length ? { choices } : {}),
    ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
  };
  return {
    cardId: moduleCardId(module, draft.key),
    actionClass: draft.actionClass,
    ...(draft.expiresAt !== undefined ? { expiresAt: draft.expiresAt } : {}),
    module: body,
  };
}

export interface CardModuleContext {
  /** The same enriched roster `sessions_list` broadcasts. */
  sessions: SessionInfo[];
  now: number;
  /** Optional personal context already resolved for the sleep glance. Adaptive
   *  Pocket producers consume this snapshot; they never fetch on their own. */
  glance?: import('@agentdeck/shared').CardFeedGlance;
}

export interface CardChoiceOutcome {
  status: OutboxDecisionStatus;
  reason?: string;
}

export interface CardModule {
  id: CardModuleId;
  /** Cards this module wants in the feed right now. Called per pull, so it
   *  must be cheap and must not block. */
  build(ctx: CardModuleContext): ModuleCardDraft[];
  /** Apply a choice the user pressed, possibly hours ago and offline. Modules
   *  that produce no choices need not implement it. The returned status is
   *  terminal — the device drops the decision either way. */
  apply?(
    decision: OutboxDecision & { choiceId?: string },
    key: string,
    ctx: CardModuleContext,
  ): CardChoiceOutcome;
}

// ===== THREAD — the reference module =====
//
// The checkpoint card: where the open threads stopped. It is `info` (no
// choices) and derives entirely from the live roster, so it introduces no new
// state, no persistence and no product policy — its job is to prove the module
// path end to end. `AutonomousPocketEngine` injects the stateful PULSE / NUDGE /
// QUEST producers at the Node daemon boundary; keeping this default list pure
// makes library callers deterministic and opt-in.

/** A thread is worth checkpointing only if it is a real, alive session. */
const THREAD_MAX_LINES = CARD_MAX_CONTEXT_LINES;

function threadLine(s: SessionInfo): string {
  const project = s.projectName || s.agentType || 'session';
  if (typeof s.state === 'string' && s.state.startsWith('awaiting')) {
    return `${project} — waiting on you`;
  }
  if (s.state === 'processing') {
    const mins = typeof s.elapsedSec === 'number' && s.elapsedSec > 0 ? Math.round(s.elapsedSec / 60) : 0;
    const tool = typeof s.currentTool === 'string' && s.currentTool ? ` ${s.currentTool}` : '';
    return `${project} — working${tool}${mins > 0 ? ` ${mins}m` : ''}`;
  }
  // Idle: what it was last doing is the checkpoint — that is the whole point of
  // the card. `currentTask` is the daemon-computed milestone line.
  const task = typeof s.currentTask === 'string' && s.currentTask ? s.currentTask : '';
  return task ? `${project} — ${task}` : `${project} — idle`;
}

export const threadModule: CardModule = {
  id: 'thread',
  build(ctx) {
    const alive = ctx.sessions.filter((s) => s.alive !== false);
    if (alive.length === 0) return [];
    // Attention first, then work in progress, then the rest: the top lines are
    // the ones worth reading if only the first line is legible across a room.
    const rank = (s: SessionInfo): number => {
      if (typeof s.state === 'string' && s.state.startsWith('awaiting')) return 0;
      if (s.state === 'processing') return 1;
      return 2;
    };
    const ordered = [...alive].sort((a, b) => rank(a) - rank(b));
    const shown = ordered.slice(0, THREAD_MAX_LINES);
    const hidden = ordered.length - shown.length;
    const waiting = alive.filter((s) => typeof s.state === 'string' && s.state.startsWith('awaiting')).length;

    const question = waiting > 0
      ? `${waiting} of ${alive.length} threads need you`
      : `${alive.length} thread${alive.length === 1 ? '' : 's'} open`;
    const context = shown.map((s) => threadLine(s));
    // An honest count beats a silently truncated list — the device shows one
    // screen, so say what did not fit rather than implying this is all of it.
    if (hidden > 0) context[context.length - 1] = `${context[context.length - 1]} (+${hidden} more)`;

    return [{
      key: 'open',
      actionClass: 'info',
      title: 'THREAD',
      question,
      context,
    }];
  },
};

/** Modules that run by default. Order is feed order after the session cards. */
export const DEFAULT_CARD_MODULES: CardModule[] = [threadModule];

/** Build every module's cards, sealed. A module that throws is skipped — one
 *  bad producer must not cost the device its whole feed. */
export function buildModuleCards(
  ctx: CardModuleContext,
  modules: CardModule[] = DEFAULT_CARD_MODULES,
): FeedCard[] {
  const out: FeedCard[] = [];
  for (const m of modules) {
    let drafts: ModuleCardDraft[];
    try {
      drafts = m.build(ctx) ?? [];
    } catch {
      continue;
    }
    for (const d of drafts) out.push(sealModuleCard(m.id, d));
  }
  return out;
}

/** Route a `card_choice` decision back to the module that authored the card. */
export function applyModuleChoice(
  decision: OutboxDecision & { choiceId?: string },
  ctx: CardModuleContext,
  modules: CardModule[] = DEFAULT_CARD_MODULES,
): CardChoiceOutcome {
  const parsed = parseModuleCardId(decision.cardId);
  if (!parsed) return { status: 'rejected', reason: 'not a module card id' };
  if (typeof decision.choiceId !== 'string' || !decision.choiceId) {
    return { status: 'rejected', reason: 'choiceId required' };
  }
  const mod = modules.find((m) => m.id === parsed.module);
  // Unknown module, or a read-only one: the card is gone as far as the daemon
  // is concerned, which is terminal for the device either way.
  if (!mod) return { status: 'unknown_card', reason: `no module '${parsed.module}'` };
  if (!mod.apply) return { status: 'rejected', reason: `module '${parsed.module}' takes no choices` };
  try {
    return mod.apply(decision, parsed.key, ctx);
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
