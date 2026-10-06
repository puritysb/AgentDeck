/** BLE expression policy SSOT. Swift constants/frames are generated; sequence tests
 * execute both engines. Animation is expressive motion, not a quota alarm. */
export const MATRIX_RULES = {
  frameMs: 750, frames: 8, arrivalMs: 6000, resultMs: 90000,
  responseMs: 6000, historyLimit: 96, rosterDots: 8, seenLimit: 1024,
  // A conversation is what the reader came to see: an agent's reply to a turn
  // holds the stage briefly, and an open question keeps its agent listening
  // until the reply lands (bounded, so a lost reply cannot pin the scene).
  replyMs: 6000, askMs: 600000, attentionMs: 6000,
} as const;
export const MATRIX_POLICY = {
  awaitingPrefix: 'awaiting', stateKinds: { error: 'error', processing: 'working' },
  resultTypes: ['chat_response', 'task_end'], rejectedStatuses: ['abandoned', 'denied', 'pending'],
  replyTypes: ['chat_response'], askTypes: ['chat_start'], closeTypes: ['chat_end', 'chat_response', 'task_end'],
  priority: ['waiting', 'error', 'done', 'working', 'idle'], urgent: ['waiting', 'error'],
  summaryKinds: ['waiting', 'working', 'done', 'idle'],
  // Timebox face only (the 32×32 world keeps the kinds above). One needs-you
  // face per awaiting state, in a fixed order so two kinds of question never
  // alternate on a timer; a CI wait is its own axis (`shared/src/ci-wait.ts`):
  // pending phases need an explicit agentWaiting, and unknown is never success.
  awaitingFaces: [['awaiting_permission', 'waiting'], ['awaiting_option', 'choosing'], ['awaiting_diff', 'reviewing']],
  ciFaces: [['queued', 'ci'], ['running', 'ci'], ['unknown', 'ci-unknown']],
  gatewayAgent: 'openclaw',
} as const;
export const MATRIX_AGENTS: Record<string, string> = {
  'claude-code': 'claudeCode', 'codex-cli': 'codex', 'codex-app': 'codex',
  opencode: 'openCode', openclaw: 'openClaw', antigravity: 'antigravity',
  'kiro-cli': 'kiro', 'kiro-ide': 'kiro', hermes: 'hermes',
};
export const MATRIX_KINDS = ['waiting', 'error', 'done', 'working', 'idle', 'unknown', 'arrival', 'asked', 'reply'] as const;
export type MatrixKind = typeof MATRIX_KINDS[number];
/**
 * The Timebox Mini's 11×11 robot face. It reads more of the desk than the
 * 32×32 kinds: which question is pending, a CI wait (neither PERM nor
 * WORKING), children working under an idle parent, a Gateway health error
 * and an empty roster. Quota is deliberately absent — it is not a session
 * state and has its own steady surfaces (DESIGN.md §2.8).
 */
export const MATRIX_FACES = ['unknown', 'empty', 'idle', 'working', 'delegating', 'ci', 'ci-unknown',
  'waiting', 'choosing', 'reviewing', 'error', 'done', 'arrival', 'asked', 'reply'] as const;
export type MatrixFace = typeof MATRIX_FACES[number];
/** Faces whose class can hold several sessions show a count of pips. */
export const MATRIX_FACE_PIPS: Partial<Record<MatrixFace, number>> = {
  // Minimum count that earns pips. Children are the delegating face's whole
  // meaning, so even one is shown; elsewhere one session is the default case.
  idle: 2, working: 2, delegating: 1, ci: 2, 'ci-unknown': 2, waiting: 2, choosing: 2, reviewing: 2, error: 2,
};
export interface MatrixSession {
  id: string; alive: boolean; state?: string; agentType?: string;
  waitingOn?: { phase?: string; agentWaiting?: boolean } | null;
  subagents?: { active?: number };
}
export interface MatrixResult { ts: number; type: string; status?: string; sessionId?: string; automated?: boolean }
export interface MatrixBroadcast {
  type: string; sessions?: MatrixSession[]; entries?: MatrixResult[];
  entry?: MatrixResult; upsert?: boolean; status?: string; gatewayHasError?: boolean;
}
export interface MatrixScene {
  kind: MatrixKind; count: number; glyph: string; frame: number; roster: MatrixKind[]; counts: number[];
  /** Timebox face and its session count (pips). Optional for callers that
   *  build a 32×32 scene by hand; the 11×11 renderer falls back to `kind`. */
  face?: MatrixFace; pips?: number;
}
export function matrixState(state?: string): MatrixKind {
  return state?.startsWith(MATRIX_POLICY.awaitingPrefix) ? 'waiting'
    : (MATRIX_POLICY.stateKinds as Record<string, MatrixKind>)[state ?? ''] ?? 'idle';
}
/** The CI face a session's wait earns, or null (no wait, a terminal verdict,
 * or a pending phase without an explicit agentWaiting). */
export function matrixCiFace(session: MatrixSession): MatrixFace | null {
  const wait = session.waitingOn;
  if (!wait || wait.agentWaiting !== true) return null;
  return (MATRIX_POLICY.ciFaces.find(([phase]) => phase === wait.phase)?.[1] ?? null) as MatrixFace | null;
}
/** Face-level session class: a CI wait outranks the session's own working
 * state (it is not WORKING), never its question or failure. */
export function matrixFaceState(session: MatrixSession): MatrixKind | 'ci' {
  const state = matrixState(session.state);
  if (state === 'waiting' || state === 'error') return state;
  return matrixCiFace(session) ? 'ci' : state;
}
export function matrixResults(timeline: MatrixResult[], now: number): MatrixResult[] {
  return timeline.filter(e => (MATRIX_POLICY.resultTypes as readonly string[]).includes(e.type) &&
    !(MATRIX_POLICY.rejectedStatuses as readonly string[]).includes(e.status ?? '') &&
    Number.isFinite(e.ts) && now >= e.ts && now - e.ts < MATRIX_RULES.resultMs);
}
/**
 * The conversation on stage, if any: an agent's reply to a turn (held
 * replyMs), else an open user question to a live session (until its reply,
 * at most askMs). Automated turns are not conversations.
 */
export function matrixInteraction(timeline: MatrixResult[], live: MatrixSession[], now: number):
    { kind: 'asked' | 'reply'; sessionId?: string; ts: number } | null {
  const conversational = (e: MatrixResult) => e.automated !== true && Number.isFinite(e.ts) && now >= e.ts;
  const reply = timeline.filter(e => conversational(e) && live.some(s => s.id === e.sessionId) &&
      !timeline.some(next => next.sessionId === e.sessionId && next.ts > e.ts && next.ts <= now &&
        (MATRIX_POLICY.askTypes as readonly string[]).includes(next.type)) &&
      (MATRIX_POLICY.replyTypes as readonly string[]).includes(e.type) &&
      !(MATRIX_POLICY.rejectedStatuses as readonly string[]).includes(e.status ?? '') &&
      now - e.ts < MATRIX_RULES.replyMs)
    .sort((a, b) => b.ts - a.ts)[0];
  if (reply) return { kind: 'reply', sessionId: reply.sessionId, ts: reply.ts };
  const ask = timeline.filter(e => conversational(e) && e.sessionId != null &&
      (MATRIX_POLICY.askTypes as readonly string[]).includes(e.type) && now - e.ts < MATRIX_RULES.askMs)
    .sort((a, b) => b.ts - a.ts)[0];
  if (!ask || !live.some(s => s.id === ask.sessionId && matrixState(s.state) === 'working')) return null;
  const answered = timeline.some(e => e.sessionId === ask.sessionId && e.ts >= ask.ts && e.ts <= now &&
    (MATRIX_POLICY.closeTypes as readonly string[]).includes(e.type));
  return answered ? null : { kind: 'asked', sessionId: ask.sessionId, ts: ask.ts };
}

export function deskSignal(sessions: MatrixSession[] | null, timeline: MatrixResult[], now: number) {
  if (sessions === null) return { kind: 'unknown' as MatrixKind, count: 0 };
  const live = sessions.filter(s => s.alive);
  const counts: Record<string, number> = {
    waiting: live.filter(s => matrixState(s.state) === 'waiting').length,
    error: live.filter(s => matrixState(s.state) === 'error').length,
    done: matrixResults(timeline, now).length,
    working: live.filter(s => matrixState(s.state) === 'working').length,
    idle: live.length,
  };
  const kind = MATRIX_POLICY.priority.find(kind => counts[kind] > 0) ?? 'idle';
  return { kind: kind as MatrixKind, count: counts[kind] };
}

/** Mutate on broadcasts, never on frame requests. Initial/reconnected rosters
 * establish a baseline; only a subsequent genuinely new live id earns an entrance. */
export class MatrixExpression {
  private sessions: MatrixSession[] | null = null;
  private timeline: MatrixResult[] = [];
  private seen = new Set<string>();
  private arrival: { id: string; ts: number } | null = null;
  private gatewayHasError = false;
  reset(): void {
    this.sessions = null; this.timeline = []; this.arrival = null; this.seen.clear(); this.gatewayHasError = false;
  }
  updateSessions(sessions: MatrixSession[], now: number): void {
    if (this.sessions !== null) {
      const known = this.seen;
      const added = sessions.filter(s => s.alive && !known.has(s.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      // A burst coalesces to one bounded entrance, never a stale animation queue.
      if (added.length) this.arrival = { id: added[0].id, ts: now };
    }
    for (const session of sessions) this.seen.add(session.id);
    while (this.seen.size > MATRIX_RULES.seenLimit) this.seen.delete(this.seen.values().next().value!);
    this.sessions = sessions.map(s => ({ ...s }));
  }
  updateTimeline(entries: MatrixResult[]): void {
    // Tool-event bursts must not evict a response before its retention window.
    // Keep rejected results too, so an upsert can retract a previous success.
    this.timeline = entries.filter(e => (MATRIX_POLICY.closeTypes as readonly string[]).includes(e.type) ||
        (MATRIX_POLICY.askTypes as readonly string[]).includes(e.type))
      .slice(-MATRIX_RULES.historyLimit);
  }
  ingest(event: MatrixBroadcast, now: number): void {
    if (event.type === 'sessions_list' && event.sessions) this.updateSessions(event.sessions, now);
    else if (event.type === 'connection' && event.status === 'disconnected') this.reset();
    // Retain-on-absent: only an explicit boolean changes the Gateway verdict.
    else if (event.type === 'state_update' && typeof event.gatewayHasError === 'boolean') this.gatewayHasError = event.gatewayHasError;
    else if (event.type === 'timeline_history') {
      this.updateTimeline([...(event.entries ?? [])].sort((a, b) => a.ts - b.ts));
    } else if (event.type === 'timeline_event' && event.entry) {
      const entry = event.entry;
      const index = event.upsert ? this.timeline.findIndex(e => e.ts === entry.ts && e.type === entry.type && e.sessionId === entry.sessionId) : -1;
      if (index >= 0) this.timeline[index] = entry; else this.timeline.push(entry);
      this.updateTimeline(this.timeline.sort((a, b) => a.ts - b.ts));
    }
  }
  scene(now: number): MatrixScene {
    const signal = deskSignal(this.sessions, this.timeline, now);
    let kind = signal.kind;
    const live = (this.sessions ?? []).filter(s => s.alive).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const arrival = this.arrival && now >= this.arrival.ts && now - this.arrival.ts < MATRIX_RULES.arrivalMs
      ? live.find(s => s.id === this.arrival!.id) : undefined;
    let glyph = 'summary';
    let responseAt: number | undefined;
    const glyphOf = (sessionId?: string) =>
      MATRIX_AGENTS[live.find(s => s.id === sessionId)?.agentType ?? ''] ?? 'neutral';
    const interaction = matrixInteraction(this.timeline, live, now);
    if ((MATRIX_POLICY.urgent as readonly string[]).includes(kind)) {
      const attention = live.filter(s => matrixState(s.state) === kind);
      const hero = attention[Math.floor(Math.max(0, now) / MATRIX_RULES.attentionMs) % attention.length];
      glyph = glyphOf(hero?.id);
    } else if (this.sessions !== null) {
      if (interaction) {
        kind = interaction.kind; glyph = glyphOf(interaction.sessionId); responseAt = interaction.ts;
      } else if (arrival) { kind = 'arrival'; glyph = MATRIX_AGENTS[arrival.agentType ?? ''] ?? 'neutral'; }
      else if (kind === 'done') {
        const latest = matrixResults(this.timeline, now).sort((a, b) => b.ts - a.ts)[0];
        if (latest && now - latest.ts < MATRIX_RULES.responseMs) {
          const hero = live.find(s => s.id === latest.sessionId);
          glyph = MATRIX_AGENTS[hero?.agentType ?? ''] ?? 'neutral';
          responseAt = latest.ts;
        }
      }
    }
    const { face, pips } = this.face(live, kind, now);
    const frameTime = kind === 'arrival' ? now - this.arrival!.ts : responseAt == null ? now : now - responseAt;
    return { kind, count: kind === 'arrival' || kind === 'asked' || kind === 'reply' ? live.length : signal.count,
      glyph, face, pips,
      frame: Math.floor(Math.max(0, frameTime) / MATRIX_RULES.frameMs) % MATRIX_RULES.frames,
      roster: live.map(s => matrixState(s.state)),
      // Fixed semantic rows: waiting, working, explicit results, live (or errors).
      counts: [live.filter(s => matrixState(s.state) === 'waiting').length,
        live.filter(s => matrixState(s.state) === 'working').length,
        matrixResults(this.timeline, now).length,
        live.filter(s => matrixState(s.state) === 'error').length || live.length] };
  }
  /** Timebox face priority: no roster → needs-you → failure → conversation /
   * entrance / fresh result → working → children under an idle parent → CI
   * wait → a result within its window → empty roster → idle. */
  private face(live: MatrixSession[], kind: MatrixKind, now: number): { face: MatrixFace; pips: number } {
    if (this.sessions === null) return { face: 'unknown', pips: 0 };
    const waiting = live.filter(s => matrixState(s.state) === 'waiting');
    if (waiting.length) {
      const face = MATRIX_POLICY.awaitingFaces.find(([state]) => waiting.some(s => s.state === state))?.[1] ?? 'waiting';
      return { face, pips: waiting.length };
    }
    // A Gateway health error is shown only while the daemon emits the OpenClaw
    // session (presence SSOT); it never invents a resident or double-counts one.
    const errors = live.filter(s => matrixState(s.state) === 'error').length +
      (this.gatewayHasError && live.some(s => s.agentType === MATRIX_POLICY.gatewayAgent && matrixState(s.state) !== 'error') ? 1 : 0);
    if (errors) return { face: 'error', pips: errors };
    if (kind === 'asked' || kind === 'reply' || kind === 'arrival') return { face: kind, pips: 0 };
    const results = matrixResults(this.timeline, now);
    if (results.some(e => now - e.ts < MATRIX_RULES.responseMs)) return { face: 'done', pips: 0 };
    const working = live.filter(s => matrixFaceState(s) === 'working').length;
    if (working) return { face: 'working', pips: working };
    const children = live.reduce((sum, s) => {
      const active = s.subagents?.active;
      return sum + (typeof active === 'number' && Number.isFinite(active) && active > 0 ? Math.floor(active) : 0);
    }, 0);
    if (children) return { face: 'delegating', pips: children };
    const ci = live.map(matrixCiFace).filter((f): f is MatrixFace => f !== null);
    if (ci.length) return { face: ci.includes('ci') ? 'ci' : 'ci-unknown', pips: ci.length };
    // An older result is still news on a quiet desk, never over live work.
    if (results.length) return { face: 'done', pips: 0 };
    return live.length ? { face: 'idle', pips: live.length } : { face: 'empty', pips: 0 };
  }
}
