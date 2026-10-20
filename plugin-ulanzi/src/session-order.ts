/**
 * Sticky list order for the Ulanzi deck: a session keeps the slot it first took.
 *
 * `sortSessions` (shared) ranks by weight, then agent kind, then name, so a new
 * Claude session lands ahead of a Codex session that was already on the deck and
 * every key after it shifts — Ulanzi QA read that as keys jumping (item 3.2,
 * 2026-10-19). Other surfaces depend on that global order, so it stays; this
 * plugin passes its own order instead (`DeckView.sessionOrder`): the sequence in
 * which it first saw each session id. Sessions that arrive together are seeded in
 * `sortSessions` order, so the first frame after start looks exactly as before.
 * An explicit `weight` still outranks this order inside the layout engine.
 *
 * Ids that leave the roster keep their place for a while, so a session that
 * blinks out of one `sessions_list` (a daemon handover, an observer rescan) comes
 * back to the same key; the memory is bounded by dropping the oldest absent ids.
 */
import { sortSessions } from '@agentdeck/shared';

interface OrderableSession {
  id: string;
  projectName?: string;
  agentType?: string;
  startedAt?: string;
  weight?: number;
  state?: string;
  foldedSessionIds?: string[];
}

export const STICKY_ORDER_MAX_IDS = 256;

export class StickySessionOrder {
  private readonly firstSeen = new Map<string, number>();
  private nextSeq = 0;

  /** Record the roster and return every present id in first-seen order. */
  update(sessions: readonly OrderableSession[]): string[] {
    const present = new Set<string>();
    for (const s of sessions) {
      present.add(s.id);
      for (const id of s.foldedSessionIds ?? []) present.add(id);
    }
    const fresh = sortSessions(sessions.filter((s) => !this.firstSeen.has(s.id)) as OrderableSession[]);
    for (const s of fresh) this.firstSeen.set(s.id, this.nextSeq++);
    for (const s of sessions) {
      for (const id of s.foldedSessionIds ?? []) {
        if (!this.firstSeen.has(id)) this.firstSeen.set(id, this.firstSeen.get(s.id)!);
      }
    }
    this.prune(present);
    return [...present]
      .filter((id) => this.firstSeen.has(id))
      .sort((a, b) => this.firstSeen.get(a)! - this.firstSeen.get(b)!);
  }

  private prune(present: Set<string>): void {
    if (this.firstSeen.size <= STICKY_ORDER_MAX_IDS) return;
    const absent = [...this.firstSeen.entries()]
      .filter(([id]) => !present.has(id))
      .sort((a, b) => a[1] - b[1]);
    for (const [id] of absent) {
      if (this.firstSeen.size <= STICKY_ORDER_MAX_IDS) break;
      this.firstSeen.delete(id);
    }
  }
}
