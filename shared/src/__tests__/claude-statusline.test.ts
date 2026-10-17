import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_STATUSLINE_FRESH_MS,
  claudeOAuthCarryOverFresh,
  claudeStatuslineChanged,
  claudeStatuslineProgressRegressed,
  classifyClaudeStatuslineAge,
  parseClaudeStatusline,
  preserveClaudeUsageOnOAuth,
  shouldAcceptClaudeStatusline,
  shouldPollClaudeOAuth,
  type ClaudeStatuslineReading,
  type ClaudeStatuslineWindow,
  type ClaudeUsageSource,
} from '../claude-statusline.js';

interface WindowVector { usedPercent: number; resetsAt: string | null }
interface ReadingVector {
  fiveHour?: WindowVector | null;
  sevenDay?: WindowVector | null;
  sessionId?: string | null;
  model?: string | null;
  version?: string | null;
  receivedAt?: number;
  durationMs?: number | null;
  apiDurationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

const vectors = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../claude-statusline-vectors.json', import.meta.url)), 'utf8',
)) as {
  now: number;
  parse: Array<{ name: string; payload: unknown; expected: null | (ReadingVector & { sessionId: string | null; model: string | null; version: string | null }) }>;
  age: Array<{ name: string; receivedAt: number | null; age: string }>;
  poll: Array<{ name: string; statuslineReceivedAt: number | null; lastOAuthFetchAt: number | null; oauthHasScopedLimits: boolean; poll: boolean }>;
  carry: Array<{ name: string; lastOAuthFetchAt: number | null; carry: boolean }>;
  oauthOrdering: Array<{ name: string; currentFetchedAt: number; nextFetchedAt: number; fresh: boolean; statuslineLive: boolean; preserve: boolean }>;
  changed: Array<{ name: string; prev: ReadingVector | null; next: ReadingVector; changed: boolean }>;
  accept: Array<{ name: string; previousForSession: ReadingVector | null; current: ReadingVector | null; currentSource?: ClaudeUsageSource; next: ReadingVector; accepted: boolean; regressed: boolean }>;
};

const RECEIVED_AT = 1792108799000;

function reading(v: ReadingVector): ClaudeStatuslineReading {
  const win = (w: WindowVector | null): ClaudeStatuslineWindow | null => (w ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt } : null);
  return {
    sessionId: null, model: null, version: null, receivedAt: RECEIVED_AT,
    durationMs: null, apiDurationMs: null, inputTokens: null, outputTokens: null,
    ...v, fiveHour: win(v.fiveHour ?? null), sevenDay: win(v.sevenDay ?? null),
  };
}

describe('claude status-line relay rules (shared vectors)', () => {
  it('has vectors in every section', () => {
    for (const section of ['parse', 'age', 'poll', 'carry', 'changed', 'accept', 'oauthOrdering'] as const) {
      expect(vectors[section].length, section).toBeGreaterThan(0);
    }
  });

  describe('parse', () => {
    for (const v of vectors.parse) {
      it(v.name, () => {
        const got = parseClaudeStatusline(v.payload, RECEIVED_AT);
        if (v.expected === null) {
          expect(got).toBeNull();
          return;
        }
        expect(got).toEqual(reading(v.expected));
      });
    }
  });

  describe('age', () => {
    for (const v of vectors.age) {
      it(v.name, () => expect(classifyClaudeStatuslineAge(v.receivedAt, vectors.now)).toBe(v.age));
    }
    it('fresh bound is the exported constant', () => {
      expect(classifyClaudeStatuslineAge(vectors.now - CLAUDE_STATUSLINE_FRESH_MS, vectors.now)).toBe('fresh');
      expect(classifyClaudeStatuslineAge(vectors.now - CLAUDE_STATUSLINE_FRESH_MS - 1, vectors.now)).toBe('aged');
    });
  });

  describe('OAuth poll decision', () => {
    for (const v of vectors.poll) {
      it(v.name, () => expect(shouldPollClaudeOAuth({
        statuslineReceivedAt: v.statuslineReceivedAt,
        lastOAuthFetchAt: v.lastOAuthFetchAt,
        oauthHasScopedLimits: v.oauthHasScopedLimits,
        now: vectors.now,
      })).toBe(v.poll));
    }
  });

  describe('OAuth carry-over', () => {
    for (const v of vectors.carry) {
      it(v.name, () => expect(claudeOAuthCarryOverFresh(v.lastOAuthFetchAt, vectors.now)).toBe(v.carry));
    }
  });

  describe('OAuth observation ordering', () => {
    for (const v of vectors.oauthOrdering) {
      it(v.name, () => expect(preserveClaudeUsageOnOAuth(
        v.currentFetchedAt, v.nextFetchedAt, v.fresh, v.statuslineLive,
      )).toBe(v.preserve));
    }
  });

  describe('changed', () => {
    for (const v of vectors.changed) {
      it(v.name, () => expect(claudeStatuslineChanged(v.prev ? reading(v.prev) : null, reading(v.next))).toBe(v.changed));
    }
  });

  describe('acceptance and session ordering', () => {
    for (const v of vectors.accept) {
      it(v.name, () => {
        const previous = v.previousForSession ? reading(v.previousForSession) : null;
        const current = v.current ? reading(v.current) : null;
        const next = reading(v.next);
        expect(claudeStatuslineProgressRegressed(previous, next)).toBe(v.regressed);
        expect(shouldAcceptClaudeStatusline(previous, current, next, v.currentSource ?? null)).toBe(v.accepted);
      });
    }
  });
});
