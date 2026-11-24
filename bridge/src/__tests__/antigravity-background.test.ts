import { describe, it, expect } from 'vitest';
import { BackgroundWorkTracker, CiWaitTracker } from '@agentdeck/shared';
import { AntigravityBackgroundFeed } from '../antigravity-background.js';

const sid = 'conversation-A';
const task = (n: number, command?: string) => ({ id: `${sid}/task-${n}`, ...(command ? { command } : {}) });

describe('Antigravity background feed', () => {
  it('projects background commands like hook agents: task count, standby, and a CI wait', () => {
    const feed = new AntigravityBackgroundFeed();
    const work = new BackgroundWorkTracker();
    const ci = new CiWaitTracker();
    const t0 = 1_800_000_000_000;
    let out = feed.sync(new Map([[sid, [task(1, 'gh run watch 123 --exit-status'), task(2, 'pnpm build')]]]), work, ci, t0);
    expect(out.changed).toBe(true);
    expect(work.split(sid, t0)).toEqual({ active: 2, standby: 0 });
    expect(work.project(sid, { state: 'idle' }, t0)).toMatchObject({ backgroundTaskCount: 2 });
    expect(ci.snapshot(sid, t0)).toMatchObject({ phase: 'unknown', agentWaiting: true });
    // Long-running commands go on standby rather than holding WORKING forever.
    expect(work.split(sid, t0 + 600_001)).toEqual({ active: 0, standby: 2 });

    // Re-reading the same transcript changes nothing.
    expect(feed.sync(new Map([[sid, [task(1, 'gh run watch 123 --exit-status'), task(2, 'pnpm build')]]]), work, ci, t0 + 5000).changed).toBe(false);

    // The build finishes: one task left, the CI wait untouched.
    out = feed.sync(new Map([[sid, [task(1, 'gh run watch 123 --exit-status')]]]), work, ci, t0 + 10_000);
    expect(out).toEqual({ changed: true, unconfirmed: [] });
    expect(ci.snapshot(sid, t0 + 10_000)).not.toBeNull();

    // The watcher ends before GitHub evidence arrived: closed, unconfirmed.
    out = feed.sync(new Map(), work, ci, t0 + 20_000);
    expect(out).toEqual({ changed: true, unconfirmed: [sid] });
    expect(ci.snapshot(sid, t0 + 20_000)).toBeNull();
    expect(work.split(sid, t0 + 20_000)).toEqual({ active: 0, standby: 0 });
    expect(feed.sync(new Map(), work, ci, t0 + 25_000)).toEqual({ changed: false, unconfirmed: [] });
  });

  it('keeps a settled CI result for its display window and never opens a wait for an ordinary command', () => {
    const feed = new AntigravityBackgroundFeed();
    const work = new BackgroundWorkTracker();
    const ci = new CiWaitTracker();
    feed.sync(new Map([[sid, [task(1, 'gh pr checks 42 --watch')]]]), work, ci, 1);
    ci.applyPhase(sid, ci.tokenFor(sid), 'passed');
    expect(feed.sync(new Map(), work, ci, 2).unconfirmed).toEqual([]);
    expect(ci.snapshot(sid, 2)).toMatchObject({ phase: 'passed' });

    const other = new CiWaitTracker();
    feed.sync(new Map([['conversation-B', [{ id: 'conversation-B/task-3', command: 'sleep 100' }]]]), work, other, 3);
    expect(other.snapshot('conversation-B', 3)).toBeNull();
    expect(work.split('conversation-B', 3)).toEqual({ active: 1, standby: 0 });
  });
});
