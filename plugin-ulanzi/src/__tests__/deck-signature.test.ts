import { describe, expect, it } from 'vitest';
import { deckSignature } from '../deck-signature.js';

/**
 * The signature exists to skip repaints. Its only failure mode is a
 * render-affecting field that ISN'T in it: two visibly different states then
 * compare equal, the repaint is swallowed, and the device keeps showing the old
 * frame — which reads as a dead button rather than a stale image. Each case
 * below is a state pair that must NOT compare equal.
 */
describe('D200H deckSignature — every render-affecting change must be visible', () => {
  const base = {
    state: 'awaiting_option',
    allSessions: [{
      id: 'observed:claude:abc',
      state: 'awaiting_option',
      question: 'Pick a language',
      options: [{ label: 'TypeScript' }, { label: 'Swift' }],
      liveAnswerable: true,
    }],
  };

  const differsFrom = (patch: Record<string, unknown>) => {
    const changed = { ...base, allSessions: [{ ...base.allSessions[0], ...patch }] };
    return deckSignature(base) !== deckSignature(changed);
  };

  it('is stable when nothing changed', () => {
    expect(deckSignature(base)).toBe(deckSignature({ ...base, allSessions: [...base.allSessions] }));
  });

  it('changes when a multi-question prompt advances to the next question', () => {
    // The whole point: `state` stays awaiting_option and `currentTool` stays
    // empty across the swap, so only the question/options/group index move.
    expect(differsFrom({
      question: 'Pick a target',
      options: [{ label: 'macOS' }, { label: 'Android' }],
      askGroupIndex: 1,
    })).toBe(true);
  });

  it('changes when only the question text moves', () => {
    expect(differsFrom({ question: 'Ship it?' })).toBe(true);
  });

  it('changes when only the option labels move', () => {
    expect(differsFrom({ options: [{ label: 'Rust' }, { label: 'Go' }] })).toBe(true);
  });

  it('changes when only the group index moves', () => {
    expect(differsFrom({ askGroupIndex: 2 })).toBe(true);
  });

  it('changes when answerability flips (dead-button regression)', () => {
    expect(differsFrom({ liveAnswerable: false })).toBe(true);
  });

  it('changes when the prompt shape flips to multi-select', () => {
    expect(differsFrom({ promptType: 'multi_select' })).toBe(true);
  });

  it('changes on review badge transitions', () => {
    expect(differsFrom({ reviewStatus: 'running' })).toBe(true);
    expect(differsFrom({ reviewRisk: 'high', reviewFindings: 2 })).toBe(true);
  });

  it('changes on usage-only updates (quota gauges ride a separate event)', () => {
    expect(deckSignature(base)).not.toBe(deckSignature({ ...base, fiveHourPercent: 42 }));
    expect(deckSignature(base)).not.toBe(deckSignature({
      ...base, codexRateLimits: { primary: { usedPercent: 10 } },
    }));
  });
});
