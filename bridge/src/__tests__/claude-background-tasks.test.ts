import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_WORK_POLICY } from '@agentdeck/shared';
import { ClaudeBackgroundTasks, claudeBackgroundTaskCount } from '../claude-background-tasks.js';
import { HookClaudeSessions } from '../hook-claude-sessions.js';
import { activityFor } from '../session-activity.js';

const task = (id: string, type = 'shell', status = 'running') => ({ id, type, status });
const events: { event: string; payload: Record<string, unknown>; expected: string }[] = [
  { event: 'Stop', payload: { background_tasks: [task('render')] }, expected: 'processing' },
  // An idle notification has no snapshot. Absence is not a completion.
  { event: 'Notification', payload: { notification_type: 'idle_prompt' }, expected: 'processing' },
  { event: 'Stop', payload: { background_tasks: null }, expected: 'processing' },
  { event: 'Stop', payload: { background_tasks: [task('future', 'shell', 'unknown')] }, expected: 'processing' },
  { event: 'Stop', payload: { agent_id: 'child', background_tasks: [] }, expected: 'processing' },
  { event: 'Stop', payload: { session_id: 'other', background_tasks: [] }, expected: 'processing' },
  { event: 'Stop', payload: { background_tasks: [task('render', 'shell', 'completed')] }, expected: 'idle' },
  { event: 'Stop', payload: { background_tasks: [task('a', 'subagent'), task('b', 'subagent')] }, expected: 'processing' },
  { event: 'SubagentStop', payload: { agent_id: 'a', background_tasks: [task('a', 'subagent'), task('b', 'subagent')] }, expected: 'processing' },
  { event: 'SubagentStop', payload: { agent_id: 'b', background_tasks: [task('b', 'subagent')] }, expected: 'idle' },
  { event: 'StopFailure', payload: { background_tasks: [task('render')] }, expected: 'processing' },
  { event: 'SessionEnd', payload: {}, expected: 'idle' },
  { event: 'Stop', payload: { background_tasks: [task('render')] }, expected: 'processing' },
  { event: 'SessionStart', payload: {}, expected: 'idle' },
  { event: 'Stop', payload: {}, expected: 'idle' },
];

describe('Claude background work projection', () => {
  it('keeps work visible after Stop without reopening the parent turn or counting shell jobs as subagents', () => {
    const hooks = new HookClaudeSessions();
    const background = new ClaudeBackgroundTasks();
    const original = [{ id: 'observed:claude:parent', state: 'processing', currentTool: 'Bash' }];
    const payload = { session_id: 'parent', background_tasks: [task('render')] };
    hooks.note('Stop', payload);
    background.note('Stop', payload);
    const parent = hooks.applyTo(original)[0];
    expect(parent.state).toBe('idle');
    const displayed = background.project('parent', parent);
    expect(displayed).toMatchObject({ state: 'processing', currentTool: 'Background tasks', activity: 'Waiting for 1 background task', backgroundTaskCount: 1 });
    expect(activityFor({ ...displayed, port: 0, projectName: 'Demo', alive: true })).toBe('Waiting for 1 background task');
    expect(displayed).not.toHaveProperty('subagents');
    expect(parent.state).toBe('idle');
    expect(original[0].currentTool).toBe('Bash');
    background.note('Stop', { session_id: 'parent', background_tasks: [] });
    expect(background.project('parent', parent)).toEqual({ ...parent, backgroundTaskCount: 0, backgroundStandbyCount: 0 });
  });

  it('retains unknown snapshots and converges on explicit completion across interleaved sessions', () => {
    const tracker = new ClaudeBackgroundTasks();
    for (const step of events) {
      tracker.note(step.event, { session_id: 'parent', ...step.payload });
      expect(tracker.project('parent', { state: 'idle' }).state, JSON.stringify(step)).toBe(step.expected);
    }
  });

  it('never replaces foreground work, approval, questions, or offline state', () => {
    const tracker = new ClaudeBackgroundTasks();
    tracker.note('Stop', { session_id: 'parent', background_tasks: [task('render')] });
    for (const state of ['processing', 'awaiting_permission', 'awaiting_option', 'awaiting_diff', 'disconnected', undefined]) {
      const row = { state, currentTool: 'Read', activity: 'Existing activity' };
      expect(tracker.project('parent', row)).toEqual({ ...row, backgroundTaskCount: 1, backgroundStandbyCount: 0 });
    }
  });

  it('distinguishes absent/malformed data from zero, deduplicates IDs, and excludes the finishing child', () => {
    for (const background_tasks of [undefined, null, 2, {}, [null], [{ id: 'a' }], [task('a', 'shell', 'unknown')]]) {
      expect(claudeBackgroundTaskCount({ background_tasks })).toBeUndefined();
    }
    expect(claudeBackgroundTaskCount({ background_tasks: [] })).toBe(0);
    expect(claudeBackgroundTaskCount({ background_tasks: [task('a'), task('a'), task('b', 'subagent'), task('c', 'shell', 'failed')] }, 'b')).toBe(1);
  });

  it('puts open-ended task types on standby: an idle teammate or a dev server stops holding the parent working', () => {
    // Claude 2.1.311 lists a teammate idling between mailbox messages as
    // `running` (no idle bit), so the parent read "Waiting for 3 background
    // tasks" for a day. Open-ended types age; a subagent or an unknown type
    // is a job and keeps the parent working until it ends.
    let now = 0;
    const tracker = new ClaudeBackgroundTasks(undefined, () => now);
    const snapshot = [task('audit-a', 'teammate'), task('serve', 'shell'), task('watch', 'monitor'),
      task('cloud', 'cloud session'), task('review', 'subagent'), task('next', 'future type')];
    tracker.note('Stop', { session_id: 'parent', background_tasks: snapshot });
    expect(tracker.project('parent', { state: 'idle' })).toMatchObject({ state: 'processing', backgroundTaskCount: 6, backgroundStandbyCount: 0 });
    now = BACKGROUND_WORK_POLICY.standbyAfterMs;
    tracker.note('Stop', { session_id: 'parent', background_tasks: snapshot });
    expect(tracker.project('parent', { state: 'idle' })).toMatchObject({ state: 'processing', backgroundTaskCount: 2, backgroundStandbyCount: 4,
      activity: 'Waiting for 2 background tasks' });
    tracker.note('Stop', { session_id: 'parent', background_tasks: snapshot.slice(0, 4) });
    expect(tracker.project('parent', { state: 'idle' })).toEqual({ state: 'idle', backgroundTaskCount: 0, backgroundStandbyCount: 4 });
    // Raw discriminants (the fallback spelling) classify the same way.
    tracker.note('SessionStart', { session_id: 'raw' });
    tracker.note('Stop', { session_id: 'raw', background_tasks: [task('t', 'in_process_teammate'), task('b', 'local_bash')] });
    now += BACKGROUND_WORK_POLICY.standbyAfterMs;
    expect(tracker.project('raw', { state: 'idle' })).toEqual({ state: 'idle', backgroundTaskCount: 0, backgroundStandbyCount: 2 });
  });

  it('keeps the generated Swift reducer synchronized', () => {
    execFileSync(process.execPath, ['bridge/generate-claude-background.mjs', '--check']);
  });

  it.runIf(process.platform === 'darwin')('replays the same interleaved lifecycle through Swift and Node', () => {
    const file = readFileSync('apple/AgentDeck/Daemon/Apme/CoordinationTracker.swift', 'utf8');
    const swift = [
      file.match(/\/\/ BEGIN GENERATED BACKGROUND WORK[\s\S]*?\/\/ END GENERATED BACKGROUND WORK/)![0],
      file.match(/\/\/ BEGIN GENERATED CLAUDE BACKGROUND[\s\S]*?\/\/ END GENERATED CLAUDE BACKGROUND/)![0],
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'claude-background-'));
    try {
      const input = events.map(step => ({ ...step, payload: { session_id: 'parent', ...step.payload } }));
      writeFileSync(join(dir, 'events.json'), JSON.stringify(input));
      writeFileSync(join(dir, 'main.swift'), `import Foundation\n${swift}
let events = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
var work = BackgroundWorkTracker()
for event in events {
    ClaudeBackgroundTasks.note(event["event"] as! String, payload: event["payload"] as! [String: Any], into: &work, now: 0)
    for state in ["idle", "processing", "awaiting_permission", "awaiting_option", "disconnected"] {
        let result = work.project("parent", session: ["state": state], now: 0)
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
`);
      const actual = execFileSync('swift', [join(dir, 'main.swift'), join(dir, 'events.json')], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n').map(line => JSON.parse(line));
      const tracker = new ClaudeBackgroundTasks(undefined, () => 0);
      const expected = input.flatMap(step => {
        tracker.note(step.event, step.payload);
        return ['idle', 'processing', 'awaiting_permission', 'awaiting_option', 'disconnected'].map(state => tracker.project('parent', { state }));
      });
      expect(actual).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
