import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODEX_APPROVAL_HOLD_HEADER,
  codexApprovalDecisionBody,
  codexApprovalReviewerFromRollout,
  codexApprovalHoldMs,
  codexHoldDecision,
  codexHoldPressDecision,
  codexHoldReleasedBy,
  type CodexApprovalOutcome,
  type CodexHoldEligibility,
  type CodexHoldPress,
} from '../codex-approval-hold.js';

const VECTORS = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../codex-approval-hold-vectors.json', import.meta.url)), 'utf8')) as {
  header: string;
  reviewerRecords: Array<{ name: string; records: unknown[]; turnId?: string; reviewer: string | null }>;
  decisions: Array<{ decision: CodexApprovalOutcome; body: unknown }>;
  budgets: Array<{ name: string; header: string; defaultMs: number; holdMs: number | null }>;
  eligibility: Array<{ name: string; input: Partial<CodexHoldEligibility>; hold: boolean; reason: string }>;
  eligibilityDefaults: CodexHoldEligibility;
  presses: Array<{ name: string; press: CodexHoldPress; decision: 'allow' | 'deny' | null }>;
  releasingEvents: string[];
  nonReleasingEvents: string[];
};

describe('Codex approval hold rules (shared vectors)', () => {
  for (const v of VECTORS.reviewerRecords) {
    it(`reviewer: ${v.name}`, () => {
      const text = ['torn line', ...v.records.map((r) => JSON.stringify(r)), '{incomplete'].join('\n');
      expect(codexApprovalReviewerFromRollout(text, v.turnId)).toBe(v.reviewer ?? undefined);
    });
  }

  it('names the header both daemons read', () => {
    expect(CODEX_APPROVAL_HOLD_HEADER).toBe(VECTORS.header);
  });

  for (const v of VECTORS.decisions) {
    it(`prints the ${v.decision} decision Codex reads`, () => {
      const body = codexApprovalDecisionBody(v.decision);
      if (v.body === null) expect(body).toBe('');
      else expect(JSON.parse(body)).toEqual(v.body);
    });
  }

  for (const v of VECTORS.budgets) {
    it(`budget: ${v.name}`, () => {
      expect(codexApprovalHoldMs(v.header, v.defaultMs)).toBe(v.holdMs);
    });
  }

  it('never holds a request that names no budget', () => {
    expect(codexApprovalHoldMs(undefined, 25_000)).toBeNull();
  });

  for (const v of VECTORS.eligibility) {
    it(`eligibility: ${v.name}`, () => {
      expect(codexHoldDecision({ ...VECTORS.eligibilityDefaults, ...v.input })).toEqual({ hold: v.hold, reason: v.reason });
    });
  }

  for (const v of VECTORS.presses) {
    it(`press: ${v.name}`, () => {
      expect(codexHoldPressDecision(v.press)).toBe(v.decision);
    });
  }

  for (const event of VECTORS.releasingEvents) {
    it(`releases an open hold on ${event}`, () => {
      expect(codexHoldReleasedBy(event)).toBe(true);
    });
  }

  for (const event of VECTORS.nonReleasingEvents) {
    it(`leaves an open hold alone on ${event}`, () => {
      expect(codexHoldReleasedBy(event)).toBe(false);
    });
  }
});
