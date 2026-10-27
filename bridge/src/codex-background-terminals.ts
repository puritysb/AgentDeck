/** Codex background terminals: unified-exec processes still running after a
 * turn. Codex's hooks say nothing about them (`Stop` carries no task list, and
 * nothing fires when one exits), so the count comes from the rollout:
 *
 *  - a still-running process is announced by its tool output — the code-mode
 *    `exec` result JSON with a `session_id` and no `exit_code`, or the legacy
 *    `exec_command`/`write_stdin` text `Process running with session ID <n>`;
 *  - its end is the `CommandExecution` `item_completed` whose `process_id` is
 *    that id, written even when it lands after `task_complete` (measured
 *    2026-10-11 on codex-cli 0.160.1: `sleep 15` finished 11 s after the turn).
 *
 * The completion is written by the Codex process itself, so a Codex that dies
 * (crash, SIGKILL, closed laptop) leaves its terminals "running" in the rollout
 * forever, and the id is Codex's own counter, not an OS pid (measured: id 63748
 * while the shell was pid 10484). So a count is only claimed while the Codex
 * process that posted the hook (`agentdeck_pid`) is alive; a definitely-gone
 * process means 0, an unknown pid means no claim at all.
 *
 * The rollout is read as a bounded tail, so the set of running terminals is
 * carried between reads: a terminal enters when a window shows it running and
 * leaves only on its completion record. A start that scrolls out of the window
 * is therefore not mistaken for a finish.
 *
 * This is one adapter of the agent-agnostic `BackgroundWorkTracker`
 * (shared/src/background-work.ts): every read feeds it a full snapshot. The
 * window reducer and adapter are mirrored in Swift (`CodexBackgroundTerminals`
 * in CoordinationTracker.swift) and both replay
 * `shared/codex-background-terminal-vectors.json`.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { BackgroundWorkTracker } from '@agentdeck/shared';
import { locateCodexRollout } from './codex-rollout-response.js';

export const CODEX_BACKGROUND_POLICY = {
  /** Bytes of rollout tail read per refresh. */
  tailBytes: 512 * 1024,
  pollMs: 3_000,
  /** Sessions watched at once. */
  maxWatches: 64,
  /** More than this in one session is not a plausible reading. */
  maxTerminals: 256,
  /** Polls that may fail to read, or find liveness unknown and nothing new,
   *  before the watch stops (the next Codex hook resumes it). */
  giveUpReads: 20,
  /** Items not re-asserted by a live poll expire, so a stopped watch (give-up,
   *  eviction, a Codex whose death could not be seen) cannot latch a count. */
  staleMs: 10 * 60_000,
  /** Hook events after which the rollout is read. */
  reads: ['codex_stop', 'codex_turn_complete', 'codex_interrupt'],
  /** Hook events that reset the session's count. */
  resets: ['codex_session_start', 'codex_session_end'],
} as const;

/** The legacy header line, matched only in the header Codex writes before the
 *  command's own output (`Output:\n`), never in what the command printed. */
const RUNNING_LINE = /^Process running with session ID ([0-9]+)$/m;
const OUTPUT_MARK = 'Output:\n';

function idOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  return undefined;
}

function runningFromText(text: string, mark: (id: string) => void): void {
  const cut = text.indexOf(OUTPUT_MARK);
  const header = cut >= 0 ? text.slice(0, cut) : text;
  const m = RUNNING_LINE.exec(header);
  if (m) mark(m[1]);
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return;
  try {
    // Only Codex's own exec result shape counts: a command that merely echoes
    // `{"session_id":…}` is not a running terminal.
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || typeof obj.chunk_id !== 'string'
      || typeof obj.wall_time_seconds !== 'number' || 'exit_code' in obj) return;
    const id = idOf(obj.session_id);
    if (id !== undefined) mark(id);
  } catch { /* not a tool result object */ }
}

/** Records after which a resumed Codex process's own history begins. */
const BOUNDARY_TYPES = new Set(['session_meta', 'turn_context']);

/** Index of the last `session_meta`/`turn_context` record, or -1. */
export function lastBoundaryIndex(lines: readonly string[]): number {
  let last = -1;
  lines.forEach((line, i) => {
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec && typeof rec === 'object' && BOUNDARY_TYPES.has(rec.type as string)) last = i;
    } catch { /* skip */ }
  });
  return last;
}

export type CodexTerminalStatus = 'running' | 'finished';

/** Each terminal's last status in a window of rollout JSONL lines, in file
 *  order (a later record wins), or undefined when no line parsed (no
 *  information). A terminal the window never mentions is absent: its start may
 *  have scrolled out, so absence is not completion. */
export function codexBackgroundTerminalStatuses(lines: readonly string[], afterBoundary = false): Map<string, CodexTerminalStatus> | undefined {
  const statuses = new Map<string, CodexTerminalStatus>();
  const set = (id: string, status: CodexTerminalStatus) => { statuses.delete(id); statuses.set(id, status); };
  // After a pid change, running records before the new process's first
  // boundary record belong to the dead process. With no boundary in view at
  // all, none can be trusted yet (an undercount, never a phantom).
  let gate = afterBoundary;
  const running = (id: string) => { if (!gate) set(id, 'running'); };
  let parsed = false;
  const lastBoundary = afterBoundary ? lastBoundaryIndex(lines) : -1;
  for (const [index, line] of lines.entries()) {
    if (afterBoundary && index === lastBoundary) gate = false;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    parsed = true;
    const { type, payload } = rec as Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const p = payload as Record<string, unknown>;
    if (type === 'response_item' && p.type === 'function_call_output') {
      if (typeof p.output === 'string') runningFromText(p.output, running);
    } else if (type === 'response_item' && p.type === 'custom_tool_call_output') {
      if (typeof p.output === 'string') runningFromText(p.output, running);
      else if (Array.isArray(p.output)) {
        for (const part of p.output) {
          const text = part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined;
          if (typeof text === 'string') runningFromText(text, running);
        }
      }
    } else if (type === 'event_msg' && p.type === 'item_completed') {
      const item = p.item as Record<string, unknown> | undefined;
      const id = item && typeof item === 'object' && item.type === 'CommandExecution' ? idOf(item.process_id) : undefined;
      if (id !== undefined) set(id, 'finished');
    }
  }
  return parsed ? statuses : undefined;
}

/** Running terminals after applying one window to what was already known, or
 *  undefined when the window says nothing (unreadable, or implausibly large). */
export function mergeCodexBackgroundTerminals(known: ReadonlySet<string>, lines: readonly string[], afterBoundary = false): Set<string> | undefined {
  const statuses = codexBackgroundTerminalStatuses(lines, afterBoundary);
  if (!statuses) return undefined;
  const next = new Set(known);
  for (const [id, status] of statuses) {
    if (status === 'running') next.add(id); else next.delete(id);
  }
  return next.size > CODEX_BACKGROUND_POLICY.maxTerminals ? undefined : next;
}

export interface CodexBackgroundIO {
  /** Last `bytes` of the file as whole lines, or null when unreadable. */
  readTail(path: string, bytes: number): string[] | null;
  /** Size and mtime, or null when the file cannot be stat'ed. */
  stat(path: string): { size: number; mtimeMs: number } | null;
  locate(sessionId: string): string | null;
  /** true alive, false definitely gone, undefined could not tell. */
  isAlive(pid: number): boolean | undefined;
  onChange(): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

export function readRolloutTailLines(path: string, bytes: number): string[] | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // a seeked window begins mid-line
    return lines.filter(Boolean);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Three answers: ESRCH is gone, success is alive, anything else (EPERM) is unknown. */
export function processLiveness(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined;
  }
}

function defaultIO(): CodexBackgroundIO {
  return {
    readTail: readRolloutTailLines,
    stat: path => { try { const s = statSync(path); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } },
    locate: sid => locateCodexRollout(sid),
    isAlive: processLiveness,
    onChange: () => {},
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearInterval: h => clearInterval(h as NodeJS.Timeout),
    now: Date.now,
  };
}

interface Watch {
  path: string;
  pid: number;
  running: Set<string>;
  /** A new Codex process took over this session (resume): trust running
   *  records only after its first boundary record. */
  afterBoundary: boolean;
  /** Size/mtime at the last parse; unchanged means nothing new to read. */
  parsedAt?: string;
  /** Consecutive polls that read nothing or could not see liveness. */
  idle: number;
}

export class CodexBackgroundTerminals {
  private readonly watches = new Map<string, Watch>();
  /** Last Codex pid per session, kept past its watch so a resume is seen. */
  private readonly pids = new Map<string, number>();
  private timer: unknown;
  private readonly io: CodexBackgroundIO;

  constructor(io: Partial<CodexBackgroundIO> = {},
    private readonly work: BackgroundWorkTracker = new BackgroundWorkTracker()) {
    this.io = { ...defaultIO(), ...io };
  }

  /** Feed a routed `codex_*` hook. Returns whether the projected count changed. */
  note(event: string, payload: Record<string, unknown>): boolean {
    const sid = payload.session_id;
    if (typeof sid !== 'string' || !sid.trim()) return false;
    if ((CODEX_BACKGROUND_POLICY.resets as readonly string[]).includes(event)) return this.forget(sid);
    if (!(CODEX_BACKGROUND_POLICY.reads as readonly string[]).includes(event)) return false;
    const pid = payload.agentdeck_pid;
    // No process to vouch for the terminals: make no claim. A dead Codex
    // cannot write its completions, so a count without liveness can latch.
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
    const tp = payload.transcript_path;
    const path = typeof tp === 'string' && tp.endsWith('.jsonl') ? tp : this.io.locate(sid);
    if (!path) return false;
    const prior = this.watches.get(sid);
    const lastPid = this.pids.get(sid);
    const same = prior !== undefined && prior.pid === pid && prior.path === path;
    this.watches.delete(sid);
    this.watches.set(sid, same ? { ...prior, idle: 0, parsedAt: undefined }
      : { path, pid, running: new Set(), afterBoundary: lastPid !== undefined && lastPid !== pid, idle: 0 });
    this.pids.delete(sid);
    this.pids.set(sid, pid);
    while (this.pids.size > CODEX_BACKGROUND_POLICY.maxWatches * 4) this.pids.delete(this.pids.keys().next().value!);
    // An evicted watch keeps its tracker items only until they go stale.
    while (this.watches.size > CODEX_BACKGROUND_POLICY.maxWatches) this.watches.delete(this.watches.keys().next().value!);
    return this.refresh(sid);
  }

  /** Re-read one watched session. Returns whether its count changed. */
  refresh(sid: string): boolean {
    const watch = this.watches.get(sid);
    if (!watch) return false;
    const alive = this.io.isAlive(watch.pid);
    let running: Set<string> | undefined;
    let learned = false;
    if (alive === false) {
      running = new Set();
      learned = true;
    } else {
      const st = this.io.stat(watch.path);
      const stamp = st ? `${st.size}:${st.mtimeMs}` : undefined;
      if (stamp !== undefined && stamp === watch.parsedAt) {
        running = watch.running; // nothing appended since the last parse
      } else if (stamp !== undefined) {
        const lines = this.io.readTail(watch.path, CODEX_BACKGROUND_POLICY.tailBytes);
        running = lines ? mergeCodexBackgroundTerminals(watch.running, lines, watch.afterBoundary) : undefined;
        if (running) {
          watch.parsedAt = stamp;
          learned = true;
          if (watch.afterBoundary && lastBoundaryIndex(lines!) >= 0) watch.afterBoundary = false;
        }
      }
    }
    // Liveness unknown and nothing new, or nothing readable: count it, and stop
    // watching after a bound (items then age out; the next hook resumes).
    if (!running || (alive === undefined && !learned)) {
      if (++watch.idle >= CODEX_BACKGROUND_POLICY.giveUpReads) this.watches.delete(sid);
      if (!running) { this.arm(); return false; }
    } else {
      watch.idle = 0;
    }
    watch.running = running;
    if (running.size === 0) this.watches.delete(sid);
    // Only a live process or a new record re-asserts the items; an unknown
    // liveness with nothing new lets them age toward the stale bound.
    const changed = alive === true || learned
      ? this.work.snapshot(sid, [...running], this.io.now(), { noun: 'terminal', kind: 'process', staleMs: CODEX_BACKGROUND_POLICY.staleMs })
      : false;
    this.arm();
    return changed;
  }

  forget(sid: string): boolean {
    this.watches.delete(sid);
    const had = this.work.reset(sid);
    this.arm();
    return had;
  }

  /** Presentation only, the shared `BackgroundWorkTracker.project` rule. */
  project<T extends { state?: string; currentTool?: string; currentTask?: string; activity?: string }>(sid: string, session: T, now: number): T & { backgroundTaskCount?: number; backgroundStandbyCount?: number } {
    return this.work.project(sid, session, now);
  }

  private readonly poll = (): void => {
    let changed = false;
    for (const sid of [...this.watches.keys()]) changed = this.refresh(sid) || changed;
    if (changed) this.io.onChange();
  };

  private arm(): void {
    if (this.watches.size > 0 && this.timer === undefined) {
      this.timer = this.io.setInterval(this.poll, CODEX_BACKGROUND_POLICY.pollMs);
    } else if (this.watches.size === 0 && this.timer !== undefined) {
      this.io.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.watches.clear();
    this.arm();
  }
}
