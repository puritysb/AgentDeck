/**
 * Background work: what a session keeps running after its turn ends — a
 * Claude background task, a Codex background terminal, an OpenCode background
 * subagent, a Hermes background process. Every agent's adapter translates its
 * own real signal into these events; this tracker owns the rules they share.
 *
 *   snapshot  the complete current set (explicit [] = finished, count 0)
 *   start     one item began
 *   finish    one item ended (a finish for an unknown session claims nothing)
 *   reset     the session boundary: back to "unknown" (no count on the wire)
 *
 * The wire contract is `SessionInfo.backgroundTaskCount`: a number is the
 * current count, an explicit 0 means "finished", absent means "no information"
 * and clients retain. `project()` keeps an idle parent visibly working while
 * its count is above zero; it never reopens a turn and never covers an
 * approval, question or offline state.
 *
 * A lost finish must not latch a creature "working" forever, so a session fed
 * by start/finish events carries a stale bound (`staleMs`): an item not
 * re-asserted within it is dropped by `reap()`. Snapshot-fed adapters that
 * re-assert on every read may pass `null` (no bound).
 *
 * SSOT for the Swift `BackgroundWorkTracker` generated into
 * apple/AgentDeck/Daemon/Apme/CoordinationTracker.swift by
 * `pnpm generate-background-work`; both suites replay
 * shared/background-work-vectors.json.
 */

export const BACKGROUND_WORK_POLICY = {
  maxSessions: 4096,
  maxItems: 4096,
  /** Wire `currentTool` while background work holds an idle parent working. */
  tool: 'Background tasks',
  /** [singular, plural] per item kind. */
  nouns: {
    task: ['background task', 'background tasks'],
    terminal: ['background terminal', 'background terminals'],
    process: ['background process', 'background processes'],
  },
} as const;

export type BackgroundWorkNoun = keyof typeof BACKGROUND_WORK_POLICY.nouns;

/**
 * The generic hook vocabulary any observer plugin can speak:
 *   `<agent>_background_start`    { session_id, item_id }
 *   `<agent>_background_finish`   { session_id, item_id }
 *   `<agent>_background_snapshot` { session_id, items: string[] }
 * plus the agent's own session-boundary events (reset) and child-stop event
 * (a finish for an item that is a child session). Agents whose signal is not a
 * hook (Claude's Stop snapshot, Codex's rollout) have their own adapters.
 * `staleMs` bounds start/finish-fed items whose finish could be lost.
 */
export const BACKGROUND_WORK_HOOKS = {
  opencode: {
    noun: 'task',
    staleMs: 6 * 60 * 60 * 1000,
    resets: ['opencode_session_start', 'opencode_session_end'],
    childStop: 'opencode_subagent_stop',
    events: ['start', 'finish'],
  },
  hermes: {
    noun: 'process',
    staleMs: null,
    resets: ['hermes_session_start', 'hermes_session_end'],
    childStop: null,
    // Snapshot-only: with no stale bound, a lost start/finish would latch.
    events: ['snapshot'],
  },
} as const satisfies Record<string, {
  noun: BackgroundWorkNoun; staleMs: number | null; resets: readonly string[]; childStop: string | null;
  events: readonly ('start' | 'finish' | 'snapshot')[];
}>;

export type BackgroundWorkHookOp =
  | { kind: 'start' | 'finish'; sessionId: string; item: string; noun: BackgroundWorkNoun; staleMs: number | null }
  | { kind: 'snapshot'; sessionId: string; items: string[]; noun: BackgroundWorkNoun; staleMs: number | null }
  | { kind: 'reset'; sessionId: string };

const MAX_ITEM_ID = 256;

function itemId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ITEM_ID ? value : undefined;
}

/** True for the three generic background events, which carry no other meaning
 *  and must be consumed before any session/timeline pipeline sees them. */
export function isBackgroundWorkHookEvent(event: string): boolean {
  return /^[a-z]+_background_(start|finish|snapshot)$/.test(event);
}

/** Normalize one hook into a tracker operation, or null when it says nothing. */
export function backgroundWorkHookOp(event: string, payload: Record<string, unknown>): BackgroundWorkHookOp | null {
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  for (const [agent, rule] of Object.entries(BACKGROUND_WORK_HOOKS)) {
    if ((rule.resets as readonly string[]).includes(event)) return { kind: 'reset', sessionId };
    const base = { sessionId, noun: rule.noun as BackgroundWorkNoun, staleMs: rule.staleMs as number | null };
    if (rule.childStop !== null && event === rule.childStop) {
      const item = itemId(payload.agent_id);
      return item ? { kind: 'finish', item, ...base } : null;
    }
    const allowed = rule.events as readonly string[];
    if ((event === `${agent}_background_start` && allowed.includes('start'))
      || (event === `${agent}_background_finish` && allowed.includes('finish'))) {
      const item = itemId(payload.item_id);
      if (!item) return null;
      return { kind: event.endsWith('_start') ? 'start' : 'finish', item, ...base };
    }
    if (event === `${agent}_background_snapshot` && allowed.includes('snapshot')) {
      const raw = payload.items;
      if (!Array.isArray(raw) || raw.length > BACKGROUND_WORK_POLICY.maxItems) return null;
      const items: string[] = [];
      for (const value of raw) {
        const item = itemId(value);
        if (!item) return null;
        if (!items.includes(item)) items.push(item);
      }
      return { kind: 'snapshot', items, ...base };
    }
  }
  return null;
}

/** Apply a normalized hook op. Returns whether the session's count changed. */
export function applyBackgroundWorkHookOp(work: BackgroundWorkTracker, op: BackgroundWorkHookOp, now: number): boolean {
  switch (op.kind) {
    case 'reset': return work.reset(op.sessionId);
    case 'finish': return work.finish(op.sessionId, op.item);
    case 'start': return work.start(op.sessionId, op.item, now, { noun: op.noun, staleMs: op.staleMs });
    case 'snapshot': return work.snapshot(op.sessionId, op.items, now, { noun: op.noun, staleMs: op.staleMs });
  }
}

export interface BackgroundWorkOptions {
  noun?: BackgroundWorkNoun;
  /** Drop an item not re-asserted within this many ms; null = never. */
  staleMs?: number | null;
}

interface SessionWork {
  items: Map<string, number>;
  noun: BackgroundWorkNoun;
  staleMs: number | null;
}

export interface BackgroundWorkRow {
  state?: string;
  currentTool?: string;
  currentTask?: string;
  activity?: string;
}

export class BackgroundWorkTracker {
  private readonly sessions = new Map<string, SessionWork>();

  count(sid: string): number | undefined {
    return this.sessions.get(sid)?.items.size;
  }

  /** Replace the session's set. Returns whether the count changed. */
  snapshot(sid: string, items: readonly string[], now: number, options: BackgroundWorkOptions = {}): boolean {
    if (!sid || items.length > BACKGROUND_WORK_POLICY.maxItems) return false;
    const before = this.count(sid);
    const work = this.touch(sid, options);
    work.items.clear();
    for (const item of items) if (item) work.items.set(item, now);
    this.evict();
    return before !== work.items.size;
  }

  start(sid: string, item: string, now: number, options: BackgroundWorkOptions = {}): boolean {
    if (!sid || !item) return false;
    const before = this.count(sid);
    const work = this.touch(sid, options);
    if (!work.items.has(item) && work.items.size >= BACKGROUND_WORK_POLICY.maxItems) return false;
    work.items.set(item, now);
    this.evict();
    return before !== work.items.size;
  }

  finish(sid: string, item: string): boolean {
    const work = this.sessions.get(sid);
    return work ? work.items.delete(item) : false;
  }

  reset(sid: string): boolean {
    return this.sessions.delete(sid);
  }

  /** Drop items past their session's stale bound. Returns the sessions whose count changed. */
  reap(now: number): string[] {
    const changed: string[] = [];
    for (const [sid, work] of this.sessions) {
      if (work.staleMs === null) continue;
      let removed = false;
      for (const [item, seen] of work.items) {
        if (now - seen > work.staleMs) { work.items.delete(item); removed = true; }
      }
      if (removed) changed.push(sid);
    }
    return changed;
  }

  project<T extends BackgroundWorkRow>(sid: string, session: T): T & { backgroundTaskCount?: number } {
    const work = this.sessions.get(sid);
    if (!work) return session;
    const count = work.items.size;
    const result = { ...session, backgroundTaskCount: count };
    if (session.state !== 'idle' || count === 0) return result;
    const activity = `Waiting for ${count} ${BACKGROUND_WORK_POLICY.nouns[work.noun][count === 1 ? 0 : 1]}`;
    return { ...result, state: 'processing', currentTool: BACKGROUND_WORK_POLICY.tool, currentTask: activity, activity };
  }

  /** Most recently fed session last; a new session or option change updates in place. */
  private touch(sid: string, options: BackgroundWorkOptions): SessionWork {
    const prior = this.sessions.get(sid);
    const work: SessionWork = prior ?? { items: new Map(), noun: 'task', staleMs: null };
    if (options.noun !== undefined) work.noun = options.noun;
    if (options.staleMs !== undefined) work.staleMs = options.staleMs;
    this.sessions.delete(sid);
    this.sessions.set(sid, work);
    return work;
  }

  private evict(): void {
    while (this.sessions.size > BACKGROUND_WORK_POLICY.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value!);
    }
  }
}
