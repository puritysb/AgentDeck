import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dotInteractionTransition, type DotInteraction } from '@agentdeck/shared';
import { LIMITS, interactionOutput, validate } from './contracts.js';
import type { OAuthState, OAuthStorage } from './local-oauth.js';

export interface Subscription {
  id: string; owner: string; profile: string; url: string; secret: string;
  expiresAt: number; verifiedUntil: number; previous?: { secret: string; until: number };
}
export interface Briefing {
  id: string; owner: string; profile: string; key: string; fingerprint: string;
  context: string; capturedAt: number; createdAt: number; expiresAt: number;
  eventId: string; subscriptionId: string; delivery: 'pending' | 'accepted' | 'failed' | 'expired' | 'cancelled';
  attempts: number; nextAttemptAt: number;
  claim?: { id: string; key: string; expiresAt: number };
  report?: { sequence: number; state: string; summary: string; receivedAt: number };
  reportKeys: Record<string, string>;
  interactions?: DotInteraction[];
  interactionKeys?: Record<string, string>;
}
export interface State { oauth?: OAuthState; version: 1; subscriptions: Subscription[]; requests: Briefing[]; revoked: string[] }
const empty = (): State => ({ version: 1, subscriptions: [], requests: [], revoked: [] });

/** Single-process experimental store. A second owner fails closed; no stale-lock guessing. */
export class Store {
  private state: State;
  private lock: number;
  private closed = false;
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lock = openSync(`${path}.lock`, 'wx', 0o600);
    try {
      if (existsSync(path) && statSync(path).size > LIMITS.records * LIMITS.bodyBytes) throw new Error('Relay state exceeds storage budget');
      this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : empty();
      if (this.state.version !== 1 || !Array.isArray(this.state.subscriptions)
          || !Array.isArray(this.state.requests) || !Array.isArray(this.state.revoked)
          || this.state.requests.length > LIMITS.records) throw new Error('Invalid relay state');
      const stamp = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
      if (this.state.subscriptions.length > LIMITS.records || this.state.revoked.length > LIMITS.records
        || this.state.revoked.some(v => typeof v !== 'string')
        || this.state.requests.some(r => !r || typeof r.id !== 'string' || typeof r.owner !== 'string'
          || typeof r.context !== 'string' || [...r.context].length > LIMITS.contextCharacters || typeof r.profile !== 'string'
          || ![r.createdAt, r.capturedAt, r.expiresAt, r.nextAttemptAt].every(stamp)
          || !Number.isInteger(r.attempts) || r.attempts < 0 || r.attempts > LIMITS.attempts
          || !['pending', 'accepted', 'failed', 'expired', 'cancelled'].includes(r.delivery)
          || (r.interactions !== undefined && (!Array.isArray(r.interactions) || r.interactions.length > LIMITS.interactionEvents))
          || (r.interactionKeys !== undefined && (typeof r.interactionKeys !== 'object' || r.interactionKeys === null || Object.keys(r.interactionKeys).length > LIMITS.interactionEvents))
          || !r.reportKeys || typeof r.reportKeys !== 'object' || Object.keys(r.reportKeys).length > LIMITS.reportKeys)
        || this.state.subscriptions.some(s => !s || typeof s.id !== 'string' || typeof s.owner !== 'string'
          || typeof s.profile !== 'string' || typeof s.url !== 'string' || typeof s.secret !== 'string'
          || !stamp(s.expiresAt) || !stamp(s.verifiedUntil))) throw new Error('Invalid persisted relay data');
      for (const row of this.state.requests) {
        const seen = new Map<string, DotInteraction>();
        for (const event of row.interactions ?? []) {
          validate(interactionOutput, event);
          if (!dotInteractionTransition(seen.get(event.relationId), event)) throw new Error('Invalid persisted interaction history');
          seen.set(event.relationId, event);
        }
      }
    } catch (e) { this.close(); throw e; }
  }
  read(): State { return structuredClone(this.state); }
  change<T>(fn: (state: State) => T): T {
    if (this.closed) throw new Error('Store closed');
    const next = this.read();
    const result = fn(next);
    // Atomic replacement: failed persistence never becomes an acknowledged in-memory write.
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, this.path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.state = next;
    return structuredClone(result);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.lock);
    unlinkSync(`${this.path}.lock`);
  }
}

export function oauthStorage(store: Store): OAuthStorage {
  return {
    read: () => store.read().oauth ?? { version: 1, grants: [], tokens: [] },
    change: fn => store.change(s => fn(s.oauth ??= { version: 1, grants: [], tokens: [] })),
  };
}
