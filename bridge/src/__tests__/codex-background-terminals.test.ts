import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexBackgroundTerminals,
  mergeCodexBackgroundTerminals,
  type CodexBackgroundIO,
  CODEX_BACKGROUND_POLICY,
} from '../codex-background-terminals.js';
import { BACKGROUND_WORK_POLICY, BackgroundWorkTracker } from '@agentdeck/shared';

interface VectorWindow { lines: string[]; known: string[]; afterBoundary?: boolean; running: string[] | null }
const vectors = JSON.parse(readFileSync('shared/codex-background-terminal-vectors.json', 'utf8')) as {
  cases: { name: string; windows: VectorWindow[] }[];
};
const windows = vectors.cases.flatMap(c => c.windows.map(w => ({ name: c.name, ...w })));
const sorted = (s: Set<string> | undefined) => (s ? [...s].sort() : null);

/** A scripted lifecycle both implementations replay: each step either feeds a
 *  hook (with the rollout window and liveness the IO will answer) or polls. */
const code = vectors.cases[0].windows[1].lines;
const steps: { kind: 'note' | 'poll'; event?: string; payload?: Record<string, unknown>; lines?: string[] | null; alive?: boolean | null }[] = [
  // No pid: Codex could die without writing completions, so no claim at all.
  { kind: 'note', event: 'codex_stop', payload: { transcript_path: '/r.jsonl' }, lines: code.slice(0, 3), alive: true },
  { kind: 'note', event: 'codex_stop', payload: { transcript_path: '/r.jsonl', agentdeck_pid: 4242 }, lines: code.slice(0, 3), alive: true },
  // Unreadable rollout and unknown liveness keep the last answer.
  { kind: 'poll', lines: null, alive: null },
  // The window moved past the start: absence is not completion.
  { kind: 'poll', lines: code.slice(2, 3), alive: true },
  { kind: 'poll', lines: code, alive: true },
  { kind: 'note', event: 'codex_stop', payload: { transcript_path: '/r.jsonl', agentdeck_pid: 4242 }, lines: code.slice(0, 3), alive: true },
  // A Codex that is definitely gone cannot have terminals.
  { kind: 'poll', lines: code.slice(0, 3), alive: false },
  { kind: 'note', event: 'codex_stop', payload: { transcript_path: '/r.jsonl', agentdeck_pid: 4243 }, lines: code.slice(0, 3), alive: true },
  { kind: 'note', event: 'codex_session_start', payload: {}, lines: code, alive: true },
  { kind: 'note', event: 'codex_user_prompt_submit', payload: { agentdeck_pid: 4243 }, lines: code.slice(0, 3), alive: true },
];
const STATES = ['idle', 'processing', 'awaiting_permission', 'disconnected'];

function runNode(): Record<string, unknown>[] {
  let lines: string[] | null = null;
  let alive: boolean | undefined;
  const io: Partial<CodexBackgroundIO> = {
    readTail: () => lines,
    stat: () => (lines ? { size: JSON.stringify(lines).length, mtimeMs: 0 } : null),
    locate: () => null,
    isAlive: () => alive,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const tracker = new CodexBackgroundTerminals(io);
  const out: Record<string, unknown>[] = [];
  for (const step of steps) {
    lines = step.lines ?? null;
    alive = step.alive ?? undefined;
    if (step.kind === 'note') tracker.note(step.event!, { session_id: 'thread', ...step.payload });
    else tracker.refresh('thread');
    for (const state of STATES) out.push(tracker.project('thread', { state }));
  }
  return out;
}

describe('Codex background terminals', () => {
  it('replays real rollout windows: running until its CommandExecution completion, retained when the start scrolls out', () => {
    for (const w of windows) {
      expect(sorted(mergeCodexBackgroundTerminals(new Set(w.known), w.lines, w.afterBoundary ?? false)), w.name).toEqual(w.running);
    }
  });

  it('projects an idle Codex row as working only while terminals run, and never covers other states', () => {
    const out = runNode();
    const at = (step: number, state: string) => out[step * STATES.length + STATES.indexOf(state)];
    expect(at(0, 'idle')).toEqual({ state: 'idle' });
    expect(at(1, 'idle')).toEqual({
      state: 'processing', backgroundTaskCount: 1, currentTool: BACKGROUND_WORK_POLICY.tool,
      currentTask: 'Waiting for 1 background terminal', activity: 'Waiting for 1 background terminal',
    });
    expect(at(1, 'awaiting_permission')).toEqual({ state: 'awaiting_permission', backgroundTaskCount: 1 });
    expect(at(2, 'idle')).toMatchObject({ backgroundTaskCount: 1 });
    expect(at(3, 'idle')).toMatchObject({ backgroundTaskCount: 1 });
    expect(at(4, 'idle')).toEqual({ state: 'idle', backgroundTaskCount: 0 });
    expect(at(5, 'idle')).toMatchObject({ backgroundTaskCount: 1 });
    expect(at(6, 'idle')).toEqual({ state: 'idle', backgroundTaskCount: 0 });
    // A new pid is a resumed Codex: the old process's running record is not
    // trusted until the new process writes a boundary record.
    expect(at(7, 'idle')).toEqual({ state: 'idle', backgroundTaskCount: 0 });
    expect(at(8, 'idle')).toEqual({ state: 'idle' });
    expect(at(9, 'idle')).toEqual({ state: 'idle' });
  });

  it('polls only while a session has terminals and stops when the last one finishes', () => {
    let lines: string[] | null = code.slice(0, 3);
    const timers: (() => void)[] = [];
    let changes = 0;
    const tracker = new CodexBackgroundTerminals({
      readTail: () => lines, locate: () => null, isAlive: () => true,
      stat: () => (lines ? { size: JSON.stringify(lines).length, mtimeMs: 0 } : null),
      onChange: () => { changes++; },
      setInterval: fn => { timers.push(fn); return timers.length; },
      clearInterval: () => { timers.length = 0; },
    });
    expect(tracker.note('codex_stop', { session_id: 't', agentdeck_pid: 7, transcript_path: '/r.jsonl' })).toBe(true);
    expect(timers).toHaveLength(1);
    lines = code;
    timers[0]();
    expect(changes).toBe(1);
    expect(timers).toHaveLength(0);
    expect(tracker.project('t', { state: 'idle' })).toEqual({ state: 'idle', backgroundTaskCount: 0 });
  });

  it('stops watching when liveness cannot be seen and nothing is appended, and lets the count expire', () => {
    const timers: (() => void)[] = [];
    let clock = 0;
    const work = new BackgroundWorkTracker();
    const tracker = new CodexBackgroundTerminals({
      readTail: () => code.slice(0, 3), stat: () => ({ size: 1, mtimeMs: 1 }), locate: () => null,
      isAlive: () => undefined, now: () => clock,
      setInterval: fn => { timers.push(fn); return timers.length; },
      clearInterval: () => { timers.length = 0; },
    }, work);
    tracker.note('codex_stop', { session_id: 't', agentdeck_pid: 7, transcript_path: '/r.jsonl' });
    expect(work.count('t')).toBe(1);
    for (let i = 0; i < CODEX_BACKGROUND_POLICY.giveUpReads && timers.length; i++) { clock += 3_000; timers[0](); }
    expect(timers).toHaveLength(0);
    expect(work.reap(CODEX_BACKGROUND_POLICY.staleMs + 1)).toEqual(['t']);
    expect(work.project('t', { state: 'idle' })).toEqual({ state: 'idle', backgroundTaskCount: 0 });
  });

  it.runIf(process.platform === 'darwin')('replays the same windows and lifecycle through the Swift mirror', () => {
    const file = readFileSync('apple/AgentDeck/Daemon/Apme/CoordinationTracker.swift', 'utf8');
    const swift = [
      file.match(/\/\/ BEGIN GENERATED BACKGROUND WORK[\s\S]*?\/\/ END GENERATED BACKGROUND WORK/)![0],
      file.match(/\/\/ BEGIN CODEX BACKGROUND TERMINALS[\s\S]*?\/\/ END CODEX BACKGROUND TERMINALS/)![0],
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'codex-background-'));
    try {
      writeFileSync(join(dir, 'input.json'), JSON.stringify({ windows, steps }));
      writeFileSync(join(dir, 'main.swift'), `import Foundation\n${swift}
let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
func emit(_ v: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys, .fragmentsAllowed]), encoding: .utf8)!) }
for w in input["windows"] as! [[String: Any]] {
    let known = Set(w["known"] as! [String])
    if let next = CodexBackgroundTerminals.merge(known, w["lines"] as! [String], afterBoundary: (w["afterBoundary"] as? Bool) ?? false) { emit(next.sorted()) } else { emit(NSNull()) }
}
var lines: [String]? = nil
var alive: Bool? = nil
let io = CodexBackgroundTerminalIO(readTail: { _, _ in lines },
    stat: { _ in lines.map { String($0.joined(separator: "\\n").count) + ":0" } },
    locate: { _ in nil }, isAlive: { _ in alive })
var tracker = CodexBackgroundTerminals()
var work = BackgroundWorkTracker()
for step in input["steps"] as! [[String: Any]] {
    lines = step["lines"] as? [String]
    alive = step["alive"] as? Bool
    if step["kind"] as! String == "note" {
        var payload = step["payload"] as! [String: Any]
        payload["session_id"] = "thread"
        tracker.note(step["event"] as! String, payload: payload, io: io, work: &work, now: 0)
    } else {
        tracker.refresh("thread", io: io, work: &work, now: 0)
    }
    for state in ${JSON.stringify(STATES)} { emit(work.project("thread", session: ["state": state])) }
}
`);
      const actual = execFileSync('swift', [join(dir, 'main.swift'), join(dir, 'input.json')], { encoding: 'utf8', timeout: 60_000 })
        .trim().split('\n').map(line => JSON.parse(line));
      const expected = [
        ...windows.map(w => sorted(mergeCodexBackgroundTerminals(new Set(w.known), w.lines, w.afterBoundary ?? false))),
        ...runNode(),
      ];
      expect(actual).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);
});
