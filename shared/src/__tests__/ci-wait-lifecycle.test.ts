import { describe, expect, it } from 'vitest';
import { CiWaitTracker, CI_WAIT_LIFECYCLE } from '../ci-wait.js';
import vectors from '../../ci-wait-lifecycle-vectors.json';
import { renderSessionSlot } from '../svg-renderers/session-slot-renderer.js';

describe('CI wait lifecycle', () => {
  for (const vector of vectors) it(vector.name, () => {
    const tracker = new CiWaitTracker();
    for (const step of vector.steps) {
      tracker.note('session', step.event, step.payload, step.at);
      expect(tracker.snapshot('session', step.at)).toEqual(step.expected);
    }
  });
  it('ignores an asynchronous result from a previous visit and never merges sessions', () => {
    const tracker = new CiWaitTracker();
    const input = { tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'gh run watch 42', run_in_background: true } };
    tracker.note('one', 'tool_start', input, 10);
    const previousToken = tracker.tokenFor('one');
    tracker.note('one', 'user_prompt_submit', {}, 10);
    tracker.note('one', 'tool_start', input, 10);
    expect(tracker.applyPhase('one', previousToken, 'passed')).toBe(false);
    expect(tracker.snapshot('two', 30)).toBeNull();
    expect(tracker.snapshot('one', 30)?.phase).toBe('unknown');
    expect(tracker.snapshot('one', 30 + CI_WAIT_LIFECYCLE.maxAgeMs)).toBeNull();
  });
  it('shows CI beside idle without disguising a real permission request', () => {
    const waitingOn = { kind: 'ci', provider: 'github-actions', phase: 'unknown', agentWaiting: true, evidence: 'tool_input', openedAt: 1 } as const;
    const session = { id: 's', port: 0, alive: true, projectName: 'demo', state: 'idle', waitingOn };
    expect(renderSessionSlot(session, false, 0)).toContain('CI WAIT');
    expect(renderSessionSlot({ ...session, state: 'awaiting_permission' }, false, 0)).toContain('PERMIT?');
    expect(renderSessionSlot({ ...session, waitingOn: null }, false, 0)).not.toContain('CI WAIT');
  });
});
