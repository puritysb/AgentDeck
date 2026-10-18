import { describe, expect, it } from 'vitest';
import { harnessQueuedMessageTag, isHarnessQueuedMessage } from '../harness-queued-message.js';

describe('harnessQueuedMessageTag', () => {
  it('names the envelope that opens a queued prompt', () => {
    expect(harnessQueuedMessageTag('<task-notification>\n<task-id>bg1</task-id>')).toBe('task-notification');
    expect(harnessQueuedMessageTag('<agent-message from="worker">done</agent-message>')).toBe('agent-message');
    expect(harnessQueuedMessageTag('<cross-session-message from="lead">re-run it</cross-session-message>'))
      .toBe('cross-session-message');
  });

  it('skips leading whitespace and reports the tag in its canonical case', () => {
    expect(harnessQueuedMessageTag('\n  <task-notification>')).toBe('task-notification');
    expect(harnessQueuedMessageTag('<TASK-NOTIFICATION id="bg3">')).toBe('task-notification');
    expect(harnessQueuedMessageTag('<task-notification ')).toBe('task-notification');
  });

  it('a prompt a person typed is not one', () => {
    expect(harnessQueuedMessageTag('why did <task-notification> fire twice?')).toBeNull();
    expect(harnessQueuedMessageTag('<task-notifications>bg4</task-notifications>')).toBeNull();
    expect(harnessQueuedMessageTag('<task-notification')).toBeNull();
    expect(harnessQueuedMessageTag('')).toBeNull();
    expect(harnessQueuedMessageTag(null)).toBeNull();
    expect(harnessQueuedMessageTag(42)).toBeNull();
  });

  it('isHarnessQueuedMessage answers the same question as a boolean', () => {
    expect(isHarnessQueuedMessage('<agent-message from="worker">')).toBe(true);
    expect(isHarnessQueuedMessage('fix the flaky test')).toBe(false);
    expect(isHarnessQueuedMessage(undefined)).toBe(false);
  });
});
