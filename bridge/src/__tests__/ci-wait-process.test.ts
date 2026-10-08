import { describe, expect, it } from 'vitest';
import { CiWaitProcesses } from '../ci-wait-process.js';
import type { CiWaitStatus } from '@agentdeck/shared';
const wait: CiWaitStatus = { kind: 'ci', provider: 'github-actions', phase: 'unknown', agentWaiting: true, evidence: 'tool_input', openedAt: 1, runId: 42 };
const parent = { pid: 10, ppid: 1, rssKb: 0, command: 'claude' };
const child = { pid: 11, ppid: 10, rssKb: 0, command: 'gh run watch 42' };
describe('CI watcher ownership', () => {
  it('closes only an observed owned watcher after a newer successful snapshot loses it', () => {
    const tracker = new CiWaitProcesses();
    const waits: [string, CiWaitStatus][] = [['s', wait]];
    const owners = new Map([['s', 10]]);
    expect(tracker.ended(waits, owners, { processes: [parent, child], capturedAt: 2 })).toEqual([]);
    expect(tracker.ended(waits, owners, { processes: [], capturedAt: 0 })).toEqual([]);
    expect(tracker.ended(waits, owners, { processes: [], capturedAt: 2 })).toEqual([]);
    expect(tracker.ended(waits, owners, { processes: [parent], capturedAt: 3 })).toEqual(['s']);
  });
  it('does not assign ambiguous same-process sessions or another process tree', () => {
    const tracker = new CiWaitProcesses();
    const waits: [string, CiWaitStatus][] = [['s', wait], ['other', wait]];
    const owners = new Map([['s', 10], ['other', 10]]);
    tracker.ended(waits, owners, { processes: [parent, child], capturedAt: 2 });
    expect(tracker.ended(waits, owners, { processes: [parent], capturedAt: 3 })).toEqual([]);
  });
});
