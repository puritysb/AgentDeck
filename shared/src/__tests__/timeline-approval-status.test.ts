// Approval status → icon. The polarity is what matters here, not the icon set.
//
// Two defects of one shape: `tool_resolved` returned `success` unconditionally,
// so the single row whose whole job is to say how an approval ended drew a
// green check on a denial; and every non-approval closure wrote `denied`, so a
// refusal and a never-answered prompt were the same value.
import { describe, it, expect } from 'vitest';
import { timelineIconKey } from '../timeline-icons.js';

const req = (status?: string) =>
  timelineIconKey({ type: 'tool_request', status } as never);
const res = (status?: string) =>
  timelineIconKey({ type: 'tool_resolved', status } as never);

describe('approval status icons', () => {
  it('separates the three outcomes on the resolution row', () => {
    expect(res('approved')).toBe('success');
    expect(res('denied')).toBe('error');
    expect(res('abandoned')).toBe('awaiting');
  });

  it('never draws a denial or an abandonment as success', () => {
    expect(res('denied')).not.toBe('success');
    expect(res('abandoned')).not.toBe('success');
  });

  it('an abandonment is not an error — nobody refused it', () => {
    expect(req('abandoned')).not.toBe('error');
    expect(res('abandoned')).not.toBe('error');
  });

  it('pending and abandoned share the no-decision icon on the request row', () => {
    // The same fact at two points in time: still open, and closed unanswered.
    expect(req('pending')).toBe(req('abandoned'));
    expect(req('pending')).toBe('awaiting');
  });

  it('an unknown status degrades, it does not claim an outcome', () => {
    expect(req('something-new')).toBe('awaiting');
    expect(res(undefined)).toBe('success');
  });
});
