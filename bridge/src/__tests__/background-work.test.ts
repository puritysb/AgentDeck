import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKGROUND_WORK_HOOKS,
  BACKGROUND_WORK_POLICY,
  BackgroundWorkTracker,
  applyBackgroundWorkHookOp,
  backgroundWorkHookOp,
  isBackgroundWorkHookEvent,
} from '@agentdeck/shared';
import { BACKGROUND_WORK_BLOCK, emitBackgroundWorkSwift } from '../../../scripts/generate-background-work.mjs';

interface Step {
  event?: string; payload?: Record<string, unknown>; now?: number; reap?: number;
  consumed?: boolean; changed?: boolean; expect: (Record<string, unknown> | null)[];
}
const vectors = JSON.parse(readFileSync('shared/background-work-vectors.json', 'utf8')) as { sessions: string[]; steps: Step[] };
const SWIFT = 'apple/AgentDeck/Daemon/Apme/CoordinationTracker.swift';

function replayNode(): unknown[] {
  const work = new BackgroundWorkTracker();
  return vectors.steps.map(step => {
    let consumed: boolean | null = null;
    let changed: boolean | null = null;
    if (step.reap !== undefined) work.reap(step.reap);
    else {
      const op = backgroundWorkHookOp(step.event!, step.payload!);
      changed = op ? applyBackgroundWorkHookOp(work, op, step.now!) : false;
      consumed = isBackgroundWorkHookEvent(step.event!);
    }
    const at = step.now ?? step.reap!;
    return [consumed, changed, ...vectors.sessions.map(sid => work.project(sid, { state: 'idle' }, at))];
  });
}

describe('background work tracker', () => {
  it('keeps the generated Swift tracker and hook vocabulary in sync with the TS source', () => {
    const source = readFileSync('shared/src/background-work.ts', 'utf8');
    const block = emitBackgroundWorkSwift(BACKGROUND_WORK_POLICY, source, BACKGROUND_WORK_HOOKS);
    expect(readFileSync(SWIFT, 'utf8').match(BACKGROUND_WORK_BLOCK)?.[0]).toBe(block);
  });

  it('replays the shared vectors: start/finish/snapshot, child stops, stale reaping, resets', () => {
    const actual = replayNode();
    vectors.steps.forEach((step, i) => {
      const [consumed, changed, ...rows] = actual[i] as [boolean | null, boolean | null, ...Record<string, unknown>[]];
      const label = JSON.stringify(step.event ?? { reap: step.reap });
      if (step.consumed !== undefined) expect(consumed, label).toBe(step.consumed);
      if (step.changed !== undefined) expect(changed, label).toBe(step.changed);
      rows.forEach((row, j) => expect(row, `${label} → ${vectors.sessions[j]}`).toEqual(step.expect[j] ?? { state: 'idle' }));
    });
  });

  it('never covers foreground, approval, question or offline states', () => {
    const work = new BackgroundWorkTracker();
    work.snapshot('s', ['a'], 0, { noun: 'process' });
    for (const state of ['processing', 'awaiting_permission', 'awaiting_option', 'disconnected', undefined]) {
      expect(work.project('s', { state, activity: 'Existing' }, 0)).toEqual({ state, activity: 'Existing', backgroundTaskCount: 1, backgroundStandbyCount: 0 });
    }
    expect(work.finish('unknown', 'a')).toBe(false);
    expect(work.project('unknown', { state: 'idle' }, 0)).toEqual({ state: 'idle' });
  });

  it('puts a long-running process on standby without ever aging a job', () => {
    const after = BACKGROUND_WORK_POLICY.standbyAfterMs;
    const work = new BackgroundWorkTracker();
    work.snapshot('s', ['server', 'agent'], 0, { kinds: { server: 'process' } });
    expect(work.split('s', after - 1)).toEqual({ active: 2, standby: 0 });
    // Re-asserting the set keeps the first sighting: a 3 s poll must not
    // restart the clock, or a dev server would never go on standby.
    work.snapshot('s', ['server', 'agent'], after - 1, { kinds: { server: 'process' } });
    expect(work.split('s', after)).toEqual({ active: 1, standby: 1 });
    expect(work.project('s', { state: 'idle' }, 10 * after)).toMatchObject({ state: 'processing', backgroundTaskCount: 1, backgroundStandbyCount: 1 });
    expect(work.snapshot('s', ['server'], 10 * after)).toBe(true);
    expect(work.project('s', { state: 'idle' }, 10 * after)).toEqual({ state: 'idle', backgroundTaskCount: 0, backgroundStandbyCount: 1 });
    // Same count, different split: the old server left and a new build began.
    expect(work.snapshot('s', ['build'], 10 * after, { kind: 'process' })).toBe(true);
    expect(work.split('s', 10 * after)).toEqual({ active: 1, standby: 0 });
    expect(work.snapshot('s', ['build'], 10 * after + 1, { kind: 'process' })).toBe(false);
  });

  it('reports a standby crossing from reap exactly once', () => {
    const after = BACKGROUND_WORK_POLICY.standbyAfterMs;
    const work = new BackgroundWorkTracker();
    work.start('s', 'server', 0, { kind: 'process' });
    expect(work.reap(after - 1)).toEqual([]);
    expect(work.reap(after)).toEqual(['s']);
    expect(work.reap(after + 5_000)).toEqual([]);
  });

  it('bounds sessions and items', () => {
    const work = new BackgroundWorkTracker();
    expect(work.snapshot('s', Array.from({ length: BACKGROUND_WORK_POLICY.maxItems + 1 }, (_, i) => `i${i}`), 0)).toBe(false);
    expect(work.count('s')).toBeUndefined();
    for (let i = 0; i <= BACKGROUND_WORK_POLICY.maxSessions; i++) work.start(`s${i}`, 'x', 0);
    expect(work.count('s0')).toBeUndefined();
    expect(work.count(`s${BACKGROUND_WORK_POLICY.maxSessions}`)).toBe(1);
  });

  it.runIf(process.platform === 'darwin')('replays the same vectors through the generated Swift block', () => {
    const block = readFileSync(SWIFT, 'utf8').match(BACKGROUND_WORK_BLOCK)![0];
    const dir = mkdtempSync(join(tmpdir(), 'background-work-'));
    try {
      writeFileSync(join(dir, 'vectors.json'), JSON.stringify(vectors));
      writeFileSync(join(dir, 'main.swift'), `import Foundation\n${block}
let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let sessions = input["sessions"] as! [String]
var work = BackgroundWorkTracker()
for step in input["steps"] as! [[String: Any]] {
    var row: [Any] = []
    if let reap = step["reap"] as? Double {
        _ = work.reap(now: reap)
        row = [NSNull(), NSNull()]
    } else {
        let event = step["event"] as! String
        var changed = false
        if let op = BackgroundWorkHooks.op(event, payload: step["payload"] as! [String: Any]) {
            changed = BackgroundWorkHooks.apply(op, to: &work, now: step["now"] as! Double)
        }
        row = [BackgroundWorkHooks.isEvent(event), changed]
    }
    let at = (step["now"] as? Double) ?? (step["reap"] as! Double)
    for sid in sessions { row.append(work.project(sid, session: ["state": "idle"], now: at)) }
    print(String(data: try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
}
`);
      const actual = execFileSync('swift', [join(dir, 'main.swift'), join(dir, 'vectors.json')], { encoding: 'utf8', timeout: 60_000 })
        .trim().split('\n').map(line => JSON.parse(line));
      expect(actual).toEqual(replayNode());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);
});
