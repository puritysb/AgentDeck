/**
 * Autonomous Pocket — adaptive, daemon-authored content for battery e-ink.
 *
 * The device is a consumer, not an authoring surface. On every full card-feed
 * pull the daemon derives a small candidate set from facts it already owns
 * (sessions, schedule, weather, provider usage), explores unfamiliar content,
 * and learns from module-card choices returned through the offline outbox.
 *
 * Privacy boundary: persistence contains only aggregate counters and opaque
 * content fingerprints. Session names, event titles, weather locations and
 * card copy are never written to the learning state.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type {
  CardModuleId,
  FeedCard,
  OutboxDecision,
  SessionInfo,
} from '@agentdeck/shared';
import type {
  CardChoiceOutcome,
  CardModule,
  CardModuleContext,
  ModuleCardDraft,
} from './card-modules.js';

export type PocketContentKind =
  | 'agenda'
  | 'weather'
  | 'usage'
  | 'attention'
  | 'progress'
  | 'resume'
  | 'overview'
  | 'preference';

export interface PocketAutonomyConfig {
  enabled: boolean;
  /** Total autonomous cards after session projections and THREAD. */
  maxCards: number;
  /** UCB exploration coefficient. Zero is allowed for deterministic tests. */
  exploration: number;
}

export const DEFAULT_POCKET_AUTONOMY_CONFIG: PocketAutonomyConfig = {
  enabled: true,
  maxCards: 2,
  exploration: 0.65,
};

export function parsePocketAutonomyConfig(settings: Record<string, unknown>): PocketAutonomyConfig {
  const raw = settings.pocketAutonomy;
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const maxCards = typeof obj.maxCards === 'number' && Number.isFinite(obj.maxCards)
    ? Math.max(1, Math.min(3, Math.round(obj.maxCards)))
    : DEFAULT_POCKET_AUTONOMY_CONFIG.maxCards;
  const exploration = typeof obj.exploration === 'number' && Number.isFinite(obj.exploration)
    ? Math.max(0, Math.min(2, obj.exploration))
    : DEFAULT_POCKET_AUTONOMY_CONFIG.exploration;
  return {
    enabled: obj.enabled !== false,
    maxCards,
    exploration,
  };
}

interface ArmState {
  shown: number;
  positive: number;
  negative: number;
  ignored: number;
  lastShownAt?: number;
  hourPositive: number[];
}

interface PendingExposure {
  cardId: string;
  kind: PocketContentKind;
  shownAt: number;
  hourBucket: number;
  board?: string;
}

interface PocketAutonomyState {
  rev: 1;
  feedbackCount: number;
  lastSurveyAt?: number;
  arms: Partial<Record<PocketContentKind, ArmState>>;
  pending: PendingExposure[];
  /** Opaque card ids only; values are last-delivery epochs. */
  seen: Record<string, number>;
  /** First answer wins. Makes an HTTP retry idempotent without retaining copy. */
  answered: Record<string, { choice: string; at: number }>;
}

export interface PocketAutonomyDiagnostics {
  enabled: boolean;
  maxCards: number;
  exploration: number;
  feedbackCount: number;
  pendingExposures: number;
  arms: Partial<Record<PocketContentKind, Pick<ArmState, 'shown' | 'positive' | 'negative' | 'ignored'>>>;
}

interface PocketCandidate {
  module: 'pulse' | 'nudge' | 'quest';
  kind: PocketContentKind;
  priority: number;
  draft: ModuleCardDraft;
}

export interface PocketAutonomyOptions {
  statePath?: string;
  persist?: boolean;
  config?: Partial<PocketAutonomyConfig>;
  onError?: (message: string) => void;
}

const STATE_REV = 1;
const HOUR_BUCKETS = 6; // four-hour local buckets
const NO_RESPONSE_AFTER_MS = 24 * 60 * 60 * 1000;
const KEEP_SEEN_MS = 14 * 24 * 60 * 60 * 1000;
const KEEP_PENDING_MS = 7 * 24 * 60 * 60 * 1000;
const SURVEY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const SURVEY_FEEDBACK_INTERVAL = 12;

const emptyState = (): PocketAutonomyState => ({
  rev: STATE_REV,
  feedbackCount: 0,
  arms: {},
  pending: [],
  seen: {},
  answered: {},
});

const newArm = (): ArmState => ({
  shown: 0,
  positive: 0,
  negative: 0,
  ignored: 0,
  hourPositive: Array.from({ length: HOUR_BUCKETS }, () => 0),
});

const isKind = (value: unknown): value is PocketContentKind =>
  value === 'agenda' || value === 'weather' || value === 'usage'
  || value === 'attention' || value === 'progress' || value === 'resume'
  || value === 'overview' || value === 'preference';

function normalizeArm(raw: unknown): ArmState {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const count = (key: string): number => {
    const n = obj[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  const hours = Array.isArray(obj.hourPositive) ? obj.hourPositive : [];
  return {
    shown: count('shown'),
    positive: count('positive'),
    negative: count('negative'),
    ignored: count('ignored'),
    ...(typeof obj.lastShownAt === 'number' && Number.isFinite(obj.lastShownAt)
      ? { lastShownAt: obj.lastShownAt } : {}),
    hourPositive: Array.from({ length: HOUR_BUCKETS }, (_, i) => {
      const n = hours[i];
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }),
  };
}

function normalizeState(raw: unknown): PocketAutonomyState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const obj = raw as Record<string, unknown>;
  if (obj.rev !== STATE_REV) return emptyState();
  const out = emptyState();
  if (typeof obj.feedbackCount === 'number' && Number.isFinite(obj.feedbackCount) && obj.feedbackCount >= 0) {
    out.feedbackCount = Math.floor(obj.feedbackCount);
  }
  if (typeof obj.lastSurveyAt === 'number' && Number.isFinite(obj.lastSurveyAt)) out.lastSurveyAt = obj.lastSurveyAt;
  if (obj.arms && typeof obj.arms === 'object') {
    for (const [kind, arm] of Object.entries(obj.arms as Record<string, unknown>)) {
      if (isKind(kind)) out.arms[kind] = normalizeArm(arm);
    }
  }
  if (Array.isArray(obj.pending)) {
    out.pending = obj.pending.flatMap((item): PendingExposure[] => {
      if (!item || typeof item !== 'object') return [];
      const p = item as Record<string, unknown>;
      if (typeof p.cardId !== 'string' || !isKind(p.kind)
        || typeof p.shownAt !== 'number' || !Number.isFinite(p.shownAt)) return [];
      return [{
        cardId: p.cardId,
        kind: p.kind,
        shownAt: p.shownAt,
        hourBucket: typeof p.hourBucket === 'number'
          ? Math.max(0, Math.min(HOUR_BUCKETS - 1, Math.floor(p.hourBucket))) : 0,
        ...(typeof p.board === 'string' && p.board ? { board: p.board } : {}),
      }];
    }).slice(-64);
  }
  if (obj.seen && typeof obj.seen === 'object') {
    for (const [cardId, at] of Object.entries(obj.seen as Record<string, unknown>)) {
      if (cardId.startsWith('module:') && typeof at === 'number' && Number.isFinite(at)) out.seen[cardId] = at;
    }
  }
  if (obj.answered && typeof obj.answered === 'object') {
    for (const [cardId, rawAnswer] of Object.entries(obj.answered as Record<string, unknown>)) {
      if (!cardId.startsWith('module:') || !rawAnswer || typeof rawAnswer !== 'object') continue;
      const answer = rawAnswer as Record<string, unknown>;
      if (typeof answer.choice === 'string' && typeof answer.at === 'number' && Number.isFinite(answer.at)) {
        out.answered[cardId] = { choice: answer.choice, at: answer.at };
      }
    }
  }
  return out;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const dayKey = (now: number): string => {
  const d = new Date(now);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

const hourBucket = (now: number): number => Math.floor(new Date(now).getHours() / 4);

function candidateKey(kind: PocketContentKind, now: number, contentIdentity: unknown): string {
  return `auto:${kind}:${dayKey(now)}:${fnv1a(JSON.stringify(contentIdentity))}`;
}

function kindFromKey(key: string): PocketContentKind | undefined {
  const parts = key.split(':');
  return parts[0] === 'auto' && isKind(parts[1]) ? parts[1] : undefined;
}

const feedbackChoices = [
  { id: 'useful', label: 'Useful', intent: 'affirm' as const },
  { id: 'more', label: 'More', intent: 'affirm' as const },
  { id: 'less', label: 'Less', intent: 'deny' as const },
];

function sessionLabel(s: SessionInfo): string {
  return s.projectName || s.agentType || 'session';
}

function waitingSession(s: SessionInfo): boolean {
  return Boolean(s.requestId) || (typeof s.state === 'string' && s.state.startsWith('awaiting'));
}

function cardIdFor(candidate: PocketCandidate): string {
  return `module:${candidate.module}:${candidate.draft.key}`;
}

export class AutonomousPocketEngine {
  private state: PocketAutonomyState;
  private config: PocketAutonomyConfig;
  private readonly statePath: string;
  private readonly persist: boolean;
  private readonly onError?: (message: string) => void;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private readonly selectionCache = new WeakMap<CardModuleContext, PocketCandidate[]>();
  private readonly cardModules: CardModule[];

  constructor(opts: PocketAutonomyOptions = {}) {
    this.statePath = opts.statePath
      ?? join(process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck'), 'pocket-autonomy.json');
    this.persist = opts.persist !== false;
    this.onError = opts.onError;
    this.config = parsePocketAutonomyConfig({
      pocketAutonomy: { ...DEFAULT_POCKET_AUTONOMY_CONFIG, ...opts.config },
    });
    this.state = this.load();
    this.cardModules = [
      { id: 'pulse', build: (ctx) => this.buildFor('pulse', ctx) },
      {
        id: 'nudge',
        build: (ctx) => this.buildFor('nudge', ctx),
        apply: (decision, key, ctx) => this.applyChoice('nudge', decision, key, ctx.now),
      },
      {
        id: 'quest',
        build: (ctx) => this.buildFor('quest', ctx),
        apply: (decision, key, ctx) => this.applyChoice('quest', decision, key, ctx.now),
      },
    ];
  }

  configure(config: PocketAutonomyConfig): void {
    this.config = parsePocketAutonomyConfig({ pocketAutonomy: config });
  }

  modules(): CardModule[] {
    return this.cardModules;
  }

  diagnostics(): PocketAutonomyDiagnostics {
    const arms: PocketAutonomyDiagnostics['arms'] = {};
    for (const [kind, arm] of Object.entries(this.state.arms)) {
      if (!isKind(kind) || !arm) continue;
      arms[kind] = {
        shown: arm.shown,
        positive: arm.positive,
        negative: arm.negative,
        ignored: arm.ignored,
      };
    }
    return {
      ...this.config,
      feedbackCount: this.state.feedbackCount,
      pendingExposures: this.state.pending.length,
      arms,
    };
  }

  /** Called only after a full feed is actually delivered (never `unchanged`). */
  observeDelivery(cards: FeedCard[], now: number = Date.now(), board?: string): void {
    if (!this.config.enabled) return;
    let changed = this.settleIgnored(now);
    for (const card of cards) {
      if (!card.module || (card.module.module !== 'pulse' && card.module.module !== 'nudge'
        && card.module.module !== 'quest')) continue;
      const key = card.cardId.slice(`module:${card.module.module}:`.length);
      const kind = kindFromKey(key);
      if (!kind || this.state.seen[card.cardId] !== undefined) continue;
      const arm = this.arm(kind);
      arm.shown += 1;
      arm.lastShownAt = now;
      this.state.seen[card.cardId] = now;
      this.state.pending.push({ cardId: card.cardId, kind, shownAt: now, hourBucket: hourBucket(now), ...(board ? { board } : {}) });
      changed = true;
    }
    if (this.state.pending.length > 64) this.state.pending.splice(0, this.state.pending.length - 64);
    for (const [cardId, at] of Object.entries(this.state.seen)) {
      if (now - at > KEEP_SEEN_MS) delete this.state.seen[cardId];
    }
    for (const [cardId, answer] of Object.entries(this.state.answered)) {
      if (now - answer.at > KEEP_SEEN_MS) delete this.state.answered[cardId];
    }
    this.state.pending = this.state.pending.filter((p) => now - p.shownAt <= KEEP_PENDING_MS);
    if (changed) this.schedulePersist();
  }

  flush(): void {
    if (!this.persist) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.statePath);
    } catch (err) {
      this.onError?.(`Pocket autonomy persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private load(): PocketAutonomyState {
    if (!this.persist) return emptyState();
    try {
      return normalizeState(JSON.parse(readFileSync(this.statePath, 'utf8')));
    } catch {
      return emptyState();
    }
  }

  private schedulePersist(): void {
    if (!this.persist || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flush();
    }, 50);
    this.persistTimer.unref?.();
  }

  private arm(kind: PocketContentKind): ArmState {
    const existing = this.state.arms[kind];
    if (existing) return existing;
    const created = newArm();
    this.state.arms[kind] = created;
    return created;
  }

  private settleIgnored(now: number): boolean {
    let changed = false;
    const keep: PendingExposure[] = [];
    for (const pending of this.state.pending) {
      if (now - pending.shownAt >= NO_RESPONSE_AFTER_MS) {
        this.arm(pending.kind).ignored += 1;
        changed = true;
      } else {
        keep.push(pending);
      }
    }
    this.state.pending = keep;
    return changed;
  }

  private shouldSurvey(now: number): boolean {
    if (this.state.feedbackCount < 2) return true;
    if (this.state.feedbackCount % SURVEY_FEEDBACK_INTERVAL !== 0) return false;
    return !this.state.lastSurveyAt || now - this.state.lastSurveyAt >= SURVEY_INTERVAL_MS;
  }

  private buildFor(module: CardModuleId, ctx: CardModuleContext): ModuleCardDraft[] {
    if (!this.config.enabled || (module !== 'pulse' && module !== 'nudge' && module !== 'quest')) return [];
    let selected = this.selectionCache.get(ctx);
    if (!selected) {
      selected = this.select(ctx);
      this.selectionCache.set(ctx, selected);
    }
    return selected.filter((candidate) => candidate.module === module).map((candidate) => candidate.draft);
  }

  private select(ctx: CardModuleContext): PocketCandidate[] {
    const candidates = this.candidates(ctx);
    if (candidates.length === 0) return [];
    const selected: PocketCandidate[] = [];
    const survey = candidates.find((candidate) => candidate.kind === 'preference');
    if (survey && this.shouldSurvey(ctx.now) && !this.state.answered[cardIdFor(survey)]) selected.push(survey);
    const totalShown = Object.values(this.state.arms).reduce((sum, arm) => sum + (arm?.shown ?? 0), 0);
    const ranked = candidates
      .filter((candidate) => candidate !== survey && !this.state.answered[cardIdFor(candidate)])
      .sort((a, b) => this.score(b, ctx.now, totalShown) - this.score(a, ctx.now, totalShown)
        || cardIdFor(a).localeCompare(cardIdFor(b)));
    for (const candidate of ranked) {
      if (selected.length >= this.config.maxCards) break;
      selected.push(candidate);
    }
    return selected.slice(0, this.config.maxCards);
  }

  private score(candidate: PocketCandidate, now: number, totalShown: number): number {
    const arm = this.arm(candidate.kind);
    const effectiveNegative = arm.negative + arm.ignored * 0.15;
    const mean = (arm.positive + 1) / (arm.positive + effectiveNegative + 2);
    const explore = this.config.exploration * Math.sqrt(Math.log(totalShown + 2) / (arm.shown + 1));
    const bucketAffinity = arm.positive > 0 ? (arm.hourPositive[hourBucket(now)] ?? 0) / arm.positive : 0;
    const cooldown = arm.lastShownAt && now - arm.lastShownAt < 6 * 60 * 60 * 1000 ? 0.45 : 0;
    const unseen = arm.shown === 0 ? 0.35 : 0;
    return candidate.priority + mean + explore + bucketAffinity * 0.25 + unseen - cooldown;
  }

  private candidates(ctx: CardModuleContext): PocketCandidate[] {
    const out: PocketCandidate[] = [];
    const now = ctx.now;
    const glance = ctx.glance;

    const event = glance?.events?.[0];
    if (event) {
      const time = event.startHm ? `${event.startHm}${event.endHm ? `-${event.endHm}` : ''}` : 'All day';
      out.push(this.nudge('agenda', now, [event.startHm, event.endHm, event.title], 0.9,
        'NEXT', event.title, [time, 'From today\'s cached schedule']));
    }

    const rain = glance?.weather?.rain;
    if (rain) {
      const where = glance?.weather?.place || 'Today';
      const window = `${rain.startHm}${rain.endHm ? `-${rain.endHm}` : ' onward'}`;
      out.push(this.nudge('weather', now, [where, window, rain.probability], 1.0,
        'RAIN', `${rain.probability}% rain from ${rain.startHm}`, [where, `Window ${window}`]));
    }

    const usage = [...(glance?.usage ?? [])]
      .filter((row) => row.primaryPercent !== undefined || row.secondaryPercent !== undefined)
      .sort((a, b) => Math.max(b.primaryPercent ?? 0, b.secondaryPercent ?? 0)
        - Math.max(a.primaryPercent ?? 0, a.secondaryPercent ?? 0))[0];
    if (usage) {
      const percent = Math.max(usage.primaryPercent ?? 0, usage.secondaryPercent ?? 0);
      const context = [usage.stale ? 'Last known value' : 'Current provider budget'];
      if (usage.primaryResetHm) context.push(`Resets ${usage.primaryResetHm}`);
      out.push(this.nudge('usage', now, [usage.provider, percent, usage.primaryResetHm, usage.stale],
        percent >= 80 ? 0.85 : 0.45, 'BUDGET', `${usage.label} usage is ${percent}%`, context));
    }

    const alive = ctx.sessions.filter((session) => session.alive !== false);
    const waiting = alive.filter(waitingSession);
    if (waiting.length > 0) {
      out.push(this.nudge('attention', now, waiting.map((session) => session.id), 0.95,
        'NEEDS YOU', `${waiting.length} session${waiting.length === 1 ? '' : 's'} waiting`,
        waiting.slice(0, 3).map(sessionLabel)));
    }

    const working = alive.filter((session) => session.state === 'processing');
    if (working.length > 0) {
      out.push(this.nudge('progress', now, working.map((session) => [session.id, session.currentTool, session.currentTask]), 0.7,
        'IN MOTION', `${working.length} agent${working.length === 1 ? ' is' : 's are'} still working`,
        working.slice(0, 3).map((session) => `${sessionLabel(session)}${session.currentTool ? ` - ${session.currentTool}` : ''}`)));
    }

    const resumable = alive
      .filter((session) => session.state === 'idle' && (session.currentTask || session.activity))
      .sort((a, b) => (b.elapsedSec ?? 0) - (a.elapsedSec ?? 0))[0];
    if (resumable) {
      const checkpoint = resumable.currentTask || resumable.activity || 'Last checkpoint';
      out.push(this.nudge('resume', now, [resumable.id, checkpoint], 0.55,
        'PICK UP', `Return to ${sessionLabel(resumable)}?`, [checkpoint]));
    }

    if (alive.length > 0) {
      const projects = [...new Set(alive.map(sessionLabel))];
      out.push({
        module: 'pulse',
        kind: 'overview',
        priority: 0.35,
        draft: {
          key: candidateKey('overview', now, alive.map((session) => [session.id, session.state, session.currentTask])),
          actionClass: 'info',
          title: 'PULSE',
          question: `${projects.length} project${projects.length === 1 ? '' : 's'} across ${alive.length} open thread${alive.length === 1 ? '' : 's'}`,
          context: projects.slice(0, 4),
        },
      });
    }

    out.push({
      module: 'quest',
      kind: 'preference',
      priority: 2,
      draft: {
        key: candidateKey('preference', now, ['preference-v1']),
        actionClass: 'day',
        title: 'POCKET LAB',
        question: 'What should Pocket learn first?',
        context: ['It keeps exploring as your pattern changes.'],
        choices: [
          { id: 'work', label: 'Work flow', intent: 'affirm' },
          { id: 'day', label: 'My day', intent: 'affirm' },
          { id: 'surprise', label: 'Surprise me', intent: 'neutral' },
        ],
      },
    });
    return out;
  }

  private nudge(
    kind: Exclude<PocketContentKind, 'overview' | 'preference'>,
    now: number,
    identity: unknown,
    priority: number,
    title: string,
    question: string,
    context: string[],
  ): PocketCandidate {
    return {
      module: 'nudge',
      kind,
      priority,
      draft: {
        key: candidateKey(kind, now, identity),
        actionClass: 'day',
        title,
        question,
        context,
        choices: feedbackChoices,
      },
    };
  }

  private applyChoice(
    module: 'nudge' | 'quest',
    decision: OutboxDecision & { choiceId?: string },
    key: string,
    now: number,
  ): CardChoiceOutcome {
    const kind = kindFromKey(key);
    if (!kind) return { status: 'unknown_card', reason: 'unknown Pocket card key' };
    const choice = decision.choiceId;
    const cardId = `module:${module}:${key}`;
    if (this.state.answered[cardId]) return { status: 'applied' };
    if (module === 'quest') {
      if (choice !== 'work' && choice !== 'day' && choice !== 'surprise') {
        return { status: 'rejected', reason: 'unknown Pocket preference' };
      }
      if (choice === 'work') {
        for (const k of ['attention', 'progress', 'resume', 'overview'] as PocketContentKind[]) this.arm(k).positive += 2;
      } else if (choice === 'day') {
        for (const k of ['agenda', 'weather', 'usage'] as PocketContentKind[]) this.arm(k).positive += 2;
      } else {
        // Surprise keeps every arm close enough to the exploration frontier to
        // continue testing unfamiliar content instead of locking a category.
        for (const k of ['agenda', 'weather', 'usage', 'attention', 'progress', 'resume', 'overview'] as PocketContentKind[]) {
          this.arm(k).positive += 1;
        }
      }
      this.state.lastSurveyAt = now;
    } else {
      const arm = this.arm(kind);
      if (choice === 'useful') arm.positive += 1;
      else if (choice === 'more') arm.positive += 2;
      else if (choice === 'less') arm.negative += 2;
      else return { status: 'rejected', reason: 'unknown Pocket feedback' };
      const pending = this.state.pending.find((item) => item.cardId === `module:${module}:${key}`);
      if (pending && choice !== 'less') arm.hourPositive[pending.hourBucket] += choice === 'more' ? 2 : 1;
    }
    this.state.feedbackCount += 1;
    this.state.answered[cardId] = { choice: choice ?? '', at: now };
    this.state.pending = this.state.pending.filter((item) => item.cardId !== cardId);
    this.schedulePersist();
    return { status: 'applied' };
  }
}

/** Existing THREAD remains first; Pocket cards follow it. */
export function createAutonomousPocketModules(engine: AutonomousPocketEngine): CardModule[] {
  return engine.modules();
}
