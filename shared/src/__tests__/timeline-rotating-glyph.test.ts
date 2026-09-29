import { describe, it, expect } from 'vitest';
import {
  TIMELINE_ROTATING_ICON_KEY,
  timelineDisplayIconKey,
  timelineIconKey,
  isRotatingEntry,
} from '../timeline-icons.js';

const now = 1_700_000_000_000;
const entry = (over: Record<string, unknown> = {}) =>
  ({ type: 'task_start', taskId: 't1', sessionId: 's1', ts: now, ...over }) as never;

describe('rotating rows draw the running glyph, not their own', () => {
  it('an open task_start rotates and renders `running`, not `task`', () => {
    const e = entry();
    expect(isRotatingEntry(e, [], now)).toBe(true);
    // Its semantic key stays `task` — only what is DRAWN changes.
    expect(timelineIconKey(e)).toBe('task');
    expect(timelineDisplayIconKey(e, [], now)).toBe('running');
    expect(TIMELINE_ROTATING_ICON_KEY).toBe('running');
  });

  it('a closed task returns to its own `task` glyph', () => {
    const e = entry();
    const siblings = [{ type: 'task_end', taskId: 't1', sessionId: 's1', ts: now + 10 }] as never[];
    expect(isRotatingEntry(e, siblings, now)).toBe(false);
    expect(timelineDisplayIconKey(e, siblings, now)).toBe('task');
  });

  it('a non-rotating row is unchanged by the display key', () => {
    const e = entry({ type: 'tool_exec', taskId: undefined });
    expect(timelineIconKey(e)).toBe('tool');
    expect(timelineDisplayIconKey(e, [], now)).toBe('tool');
  });

  it('a stale orphaned task_start stops rotating and shows `task`', () => {
    const e = entry({ ts: now - 11 * 60 * 1000 });
    expect(timelineDisplayIconKey(e, [], now)).toBe('task');
  });
});

describe('an `error` closes a turn for rotation purposes', () => {
  const chat = { type: 'chat_start', taskId: undefined, sessionId: 's1', ts: now } as never;

  it('a later same-session error stops the spinner', () => {
    const siblings = [{ type: 'error', taskId: undefined, sessionId: 's1', ts: now + 5 }] as never[];
    expect(isRotatingEntry(chat, siblings, now)).toBe(false);
    // A chat_start's own key IS `running`, so the arrow stays — it just stops
    // spinning. The bug this guards is the spinner, not the glyph.
    expect(timelineDisplayIconKey(chat, siblings, now)).toBe('running');
  });

  it('an error in a DIFFERENT session leaves it spinning', () => {
    const siblings = [{ type: 'error', taskId: undefined, sessionId: 's2', ts: now + 5 }] as never[];
    expect(isRotatingEntry(chat, siblings, now)).toBe(true);
  });
});
