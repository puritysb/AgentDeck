/**
 * APME Collector — the ingestion boundary.
 *
 * Responsibilities:
 *   - openRun(session): create a `runs` row when a bridge session starts
 *   - ingestHook(evt): write a `steps` row for every hook POST
 *   - updateUsage(snapshot): keep token/cost columns in sync
 *   - closeRun(session, exitCode): finalize the row, capture git SHA, enqueue eval
 *
 * The collector is lazy — it's created once at daemon/bridge startup and gated on
 * `store.enabled`. All methods are no-ops if the store failed to initialize
 * (e.g. better-sqlite3 missing), so the rest of the bridge never needs to care.
 */

import { randomUUID, createHash } from 'crypto';
import { execSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { debug } from '../logger.js';
import { resolveProjectName } from '../utils/project-name.js';
import type { UsageSnapshot } from '../types.js';
import type { SessionEntry } from '../session-registry.js';
import type { ApmeStore } from './store.js';
import type { ApmeRunRow, ApmeTaskRow } from './types.js';
import type { AgentType, TelemetrySpan, ApmeSampleEventRow, SampleModelConfig, TrajectoryEventKind, TurnEndSource } from '@agentdeck/shared';
import { AGENT_IDLE_GAP_MS, deriveTaskTitle, isPricedModel, normalizeModelProvider, priceUsd } from '@agentdeck/shared';
import type { ApmeHwSampler } from './hw-sampler.js';
import { classifyRunSmart, computeSignals, classify } from './classifier.js';
import { readOpenTurnEvidence, claudeTurnCompletionSince, type OpenTurnEvidence, type ClaudeTurnCompletion } from './claude-transcript-reader.js';
import { codexTurnCompletionSince, type CodexTurnCompletion } from '../codex-rollout-response.js';
import type { SubagentSampleEvent } from '../subagent-timeline.js';

export interface OpenRunInput {
  sessionId: string;
  agentType: AgentType;
  modelId?: string;
  projectName?: string;
  projectPath?: string;
  taskPrompt?: string;
}

interface ActiveTurn {
  id: string;
  runId: string;
  index: number;
  startedAt: number;
  toolCalls: number;
  filesModified: number;
  filesCreated: number;
  gitBefore: string | null;
  /** Prompt that opened this turn — used by the duplicate-open guard. */
  prompt: string | null;
  /** True once setTurnResponse landed on this turn (a same-prompt re-send
   *  after a response is a genuine new turn, not an echo). */
  hasResponse: boolean;
}

/** A turn_start with the same prompt landing on a fresh, still-empty turn
 *  within this window is treated as a transport echo (e.g. OpenClaw
 *  `chat.send` span + the gateway's `session.message` role=user re-delivery
 *  of the same text), not a new turn. */
const DUPLICATE_TURN_OPEN_WINDOW_MS = 15_000;

/** Clock slack when asking whether an interrupt marker belongs to THIS turn.
 *  The turn's `startedAt` is the daemon's clock at the hook POST while the
 *  marker carries Claude Code's own record timestamp; without a little give,
 *  a cancel milliseconds into a turn reads as belonging to the previous one.
 *  Matches the watchdog's `TURN_OPEN_SLACK_MS` — same comparison, same risk. */
const TURN_INTERRUPT_SLACK_MS = 2_000;

/** How long after a turn closed a late-arriving reply may still be attached
 *  to it once the run itself is gone from memory — the deferred transcript
 *  re-read tops out at 7.5 s; a minute leaves room for a slow disk. */
const LATE_REPLY_WINDOW_MS = 60_000;

/** What the next prompt learns about the turn it displaces. */
interface DisplacedTurnVerdict {
  source: TurnEndSource;
  /** The agent's own end time for the turn, when its record carries one. */
  endedAt?: number;
  /** The reply the agent's record holds for the turn, when the Stop lost it. */
  response?: string;
}

/** The constant (and its measurement) lives in the shared SSOT — both daemons
 *  enforce it. The timer here is armed in `closeTurn` (work finished, idle
 *  begins) and cleared on the next turn open, so it can never fire mid-turn
 *  however long the agent works. It is deliberately generic across agents:
 *  OpenClaw/OpenCode close earlier via their adapter-owned 90 s timers (those
 *  ride an explicit idle event; this one rides the absence of one), after
 *  which this timer finds no active task and no-ops. */

interface ActiveTask {
  id: string;
  runId: string;
  index: number;
  startedAt: number;
  /** turn_index of the first turn attached to this task (null until first turn). */
  firstTurnIndex: number | null;
  /** turn_index of the last turn attached; updated on every insertTurn. */
  lastTurnIndex: number | null;
  /** First user prompt attached to this task — the material `deriveTaskTitle`
   *  turns into the task's display title at promotion time. */
  firstPrompt: string | null;
  /** Whether the `task_start` timeline row has been emitted yet. Deferred:
   *  a single-turn Q&A never trips this, so it produces no TASK header on the
   *  dashboard (just its chat rows). Promoted to true by
   *  `emitDeferredTaskStartIfNeeded` on the second turn / first TodoWrite plan.
   *  `closeTask` gates the `task_end` emit on this so an unpromoted task never
   *  leaves an orphan end row. Mirrors ApmeCollector.swift `timelineEmitted`. */
  timelineEmitted: boolean;
}

/** Where a trajectory event attaches. `turnIndex` is the run-scoped ordering key
 *  the dedup hash is built from; `turnId` is the event→turn edge a graph
 *  projection follows directly, and is optional only because a few late events
 *  arrive with no turn in scope at all. */
interface SampleCtx {
  taskId: string;
  runId: string;
  turnIndex: number;
  turnId?: string | undefined;
}

export type TaskBoundarySignal = 'todo_complete' | 'clear' | 'session_end' | 'manual' | 'idle_gap';

/** Callback fired after a task is closed in DB. Used to enqueue task-level eval
 *  without creating a direct dependency from collector → runner. */
export type OnTaskClosed = (args: {
  taskId: string;
  runId: string;
  sessionId: string;
  agentType: AgentType | null;
  projectName: string | null;
  startedAt: number;
  endedAt: number;
  boundarySignal: TaskBoundarySignal;
  taskCategory: string | null;
  /** Number of turns the task spanned (≥1 — empty tasks are dropped before
   *  this fires). The timeline emitter puts it in the task_end row text so
   *  the boundary says what it covered, not just when it happened. */
  turns: number;
  /** True when this task's `task_start` row reached the timeline. The timeline
   *  emitter gates the `task_end` row on this so an unpromoted single-turn task
   *  never leaves an orphan end row; the eval enqueue runs regardless. */
  timelineEmitted: boolean;
}) => void;

/** Fired after a typed trajectory event is appended to a sample. The timeline
 *  projection (Phase 3) wires this to emit a single TimelineEntry per event —
 *  making the timeline a projection of the sample rather than a parallel
 *  emitter. `event` carries the assembled sample-event facts. */
export type OnSampleEvent = (args: {
  taskId: string;
  runId: string;
  sessionId: string;
  agentType: AgentType | null;
  projectName: string | null;
  event: ApmeSampleEventRow;
}) => void;

/** Callback fired after a task is opened. Used by the timeline emitter to
 *  insert a `task_start` row so the dashboard sees task hierarchy. */
export type OnTaskOpened = (args: {
  taskId: string;
  runId: string;
  sessionId: string;
  agentType: AgentType | null;
  projectName: string | null;
  taskIndex: number;
  startedAt: number;
  /** Display title derived from the task's first user prompt
   *  (`deriveTaskTitle` SSOT), or null when the prompt yields nothing
   *  meaningful — consumers keep their `Task N` fallback on null. */
  title: string | null;
}) => void;

/** Callback fired when the agent declares its todos done mid-task (the
 *  TodoWrite-all-completed soft hint). Non-segmenting — the task stays open —
 *  but the timeline emitter surfaces it as a `task_milestone` row so long
 *  sessions show WHERE work units completed without waiting for `/clear` or
 *  `session_end`. */
export type OnTaskMilestone = (args: {
  taskId: string;
  runId: string;
  sessionId: string;
  agentType: AgentType | null;
  projectName: string | null;
  turnIndex: number;
  todoCount: number | null;
  at: number;
}) => void;

/**
 * Is `echo` the same user prompt as `original`, arriving a second time?
 *
 * Two producers open a turn for one prompt: our own `chat.send` span, which
 * carries the text verbatim, and the Gateway's `session.message`(user) echo,
 * which has been trimmed, envelope-stripped and capped at 8,000 characters
 * before it reaches us. Exact equality therefore misses on inputs as ordinary
 * as a trailing newline — and a miss is not benign: the duplicate then closes
 * the open turn with `resolveDisplacedTurnSource`, which for a non-`claude-code`
 * agent returns `next_prompt`, i.e. the unrecovered-Stop-loss bucket. A stray
 * "\n" would invent a Stop loss for an agent that has no Stop hook at all,
 * strand an empty turn, and shift every later `turn_index`.
 *
 * Comparing TRIMMED is the whole fix, and deliberately all of it. A first pass
 * here also allowed a prefix match when the shorter side sat at the Gateway's
 * 8,000-character cap — that branch could never fire: both operands reach this
 * function through the caller's own `slice(0, 8_000)`, so "the shorter one is
 * at 8,000" forces both to be exactly 8,000 characters, and two equal-length
 * strings where one is a prefix of the other are identical, which the equality
 * check above already answered. Reintroducing truncation tolerance means
 * comparing BEFORE that slice, not adding a branch after it.
 *
 * Known and NOT closed by this: because the caller slices first, two genuinely
 * different prompts that share their first 8,000 characters compare equal and
 * collapse into one turn — an eval harness sending a long fixed preamble with a
 * differing tail is exactly that shape. That predates this comparison and is
 * fixed by keying on a hash of the unsliced prompt, not here.
 */
function samePromptEcho(original: string, echo: string): boolean {
  return original.trim() === echo.trim();
}

export class ApmeCollector {
  private readonly sessionToRun = new Map<string, string>(); // sessionId → runId
  private readonly sessionToAgentType = new Map<string, AgentType>(); // sessionId → agentType (survives closeRun for late-attributed timeline rows)
  private readonly sessionToTurn = new Map<string, ActiveTurn>(); // sessionId → current turn
  private readonly sessionToLastTurnId = new Map<string, string>(); // survives closeTurn()
  private readonly sessionToTask = new Map<string, ActiveTask>(); // sessionId → current task
  private readonly runTaskCount = new Map<string, number>();      // runId → next task_index
  private readonly sessionToUsage = new Map<string, { in: number; out: number; cost: number | null }>(); // last cumulative usage
  /** Running cost total for producers that report PER-MESSAGE cost.
   *  Separate from `sessionToUsage` because `updateUsage` writes the cost
   *  column absolutely and would otherwise stamp one message's cost as the
   *  run's. `seen` keeps a reported ZERO distinct from nothing reported —
   *  glm-5.2 answers `usage.cost.total = 0` on every message, so folding the
   *  two would record "free" as "unknown" for a whole class of run. */
  private readonly sessionToCostTotal = new Map<string, { total: number; seen: boolean }>();

  /** Optional listener fired after `closeTask` persists the row. The runner
   *  wires this to enqueue a task-level judge call. */
  public onTaskClosed: OnTaskClosed | null = null;

  /** Optional listener fired after `openTaskIfNone` inserts a fresh task row.
   *  The dashboard timeline emitter wires this to push a `task_start` entry. */
  public onTaskOpened: OnTaskOpened | null = null;

  /** Optional listener fired after a typed trajectory event is persisted.
   *  The timeline projection (Phase 3) consumes this. */
  public onSampleEvent: OnSampleEvent | null = null;

  /** Optional listener fired on the TodoWrite-all-completed soft hint.
   *  The timeline emitter wires this to push a `task_milestone` row. */
  public onTaskMilestone: OnTaskMilestone | null = null;

  /** Last milestone key (`taskId:turnIndex`) per session — a turn can carry
   *  several all-completed TodoWrite calls; surface only the first. */
  private readonly sessionToLastMilestone = new Map<string, string>();

  /** Per-session idle-gap timers — armed in `closeTurn`, cleared on the next
   *  turn open / task close. See `AGENT_IDLE_GAP_MS` for the measurement the
   *  constant rests on. */
  private readonly sessionToIdleGapTimer = new Map<string, ReturnType<typeof setTimeout>>();

  /** Sessions whose run was re-adopted from the store at startup — lets a
   *  newer open run for the same session replace the older one during the
   *  same rehydrate pass without touching runs opened live since. */
  private readonly rehydratedSessions = new Set<string>();

  constructor(
    private readonly store: ApmeStore,
    private readonly hwSampler?: ApmeHwSampler,
    /** What the transcript proves about a turn open since a timestamp — cancel,
     *  client abort, or never having run at all. Injectable for tests; the
     *  default reads the Claude transcript tail once for all three. */
    private readonly openTurnProbe: (transcriptPath: string, sinceMs: number) => OpenTurnEvidence | null = readOpenTurnEvidence,
    /** Injectable for tests only — production call sites take the default. */
    private readonly idleGapMs: number = AGENT_IDLE_GAP_MS,
    /** Whether a Codex turn open at startup completed per its rollout — see
     *  `rehydrateOpenRuns`. Injectable for tests; the default reads the
     *  rollout tail under `~/.codex/sessions`. */
    private readonly codexCompletionProbe: (sessionId: string, sinceMs: number) => CodexTurnCompletion | null = codexTurnCompletionSince,
    /** Whether a Claude turn open at startup ended per its transcript — the
     *  Claude half of the same question. Injectable for tests; the default
     *  locates the transcript under `~/.claude/projects` by session id. */
    private readonly claudeCompletionProbe: (sessionId: string, projectPath: string | null, sinceMs: number) => ClaudeTurnCompletion | null = claudeTurnCompletionSince,
  ) {}

  /** Re-adopt every run the store still holds open, so the daemon that just
   *  started continues them instead of stranding them.
   *
   *  The collector's whole state is in-memory maps, and a daemon restart drops
   *  all of it while the sessions it was observing carry on. Before this, the
   *  next hook from such a session found no run, opened a fresh one, and the
   *  old one sat open until the abandoned-run reaper closed it two hours
   *  later — its task `orphaned`, its open turn's tool counters at zero, and
   *  the Stop that did arrive discarded for want of a turn to close. Measured
   *  over 5.5 days (2026-09-03) on a dev machine that restarted the daemon 40
   *  times: 60 of the 68 tasks the reaper closed straddled a restart, and the
   *  idle-gap boundary that had just been added could not fire for any of
   *  them, since its timer lived in the process that died.
   *
   *  Per open run, in store order: the session→run edge is restored; the open
   *  task (if any) is rebuilt with its real turn span and first prompt; an
   *  open turn is rebuilt with its counters recovered from the trajectory it
   *  wrote; and when there is no open turn but a closed one, the idle-gap
   *  timer is armed for whatever remains of the gap — zero if it already
   *  elapsed during the downtime, which closes the task on the next tick as
   *  the `idle_gap` it always was. A Codex turn still open is checked once
   *  against its rollout: a `task_complete` newer than the turn is the Stop
   *  this daemon never received, and closes it as `synthetic_stop` with the
   *  reply the rollout recorded.
   *
   *  Two runs open under one session id (an older defect's residue) resolve
   *  to the newest; the rest stay for the reaper. Must run before the first
   *  hook is served, and only in the process that owns the hook port — a
   *  session bridge adopting the daemon's runs would steal them. */
  rehydrateOpenRuns(now: number = Date.now()): { runs: number; tasks: number; turns: number; armed: number; recovered: number } {
    const out = { runs: 0, tasks: 0, turns: 0, armed: 0, recovered: 0 };
    if (!this.store.enabled) return out;
    let runs: ApmeRunRow[];
    try { runs = this.store.listOpenRuns(); } catch (err) {
      debug('APME', `rehydrate: listOpenRuns failed: ${String(err)}`);
      return out;
    }
    for (const run of runs) {
      // Newest run per session wins; store order is oldest-first, so a later
      // row simply replaces the mapping an earlier one set.
      if (this.sessionToRun.has(run.sessionId) && !this.rehydratedSessions.has(run.sessionId)) continue;
      this.rehydratedSessions.add(run.sessionId);
      this.sessionToRun.set(run.sessionId, run.id);
      this.sessionToAgentType.set(run.sessionId, run.agentType);
      out.runs++;
      let turns: Array<Record<string, unknown>> = [];
      let tasks: ApmeTaskRow[] = [];
      try {
        turns = this.store.listTurns(run.id);
        tasks = this.store.listTasksForRun(run.id);
      } catch (err) {
        debug('APME', `rehydrate: run ${run.id.slice(0, 8)} unreadable: ${String(err)}`);
        continue;
      }
      this.runTaskCount.set(run.id, tasks.length);
      const lastTurn = turns.length > 0 ? turns[turns.length - 1]! : null;
      if (lastTurn) this.sessionToLastTurnId.set(run.sessionId, String(lastTurn.id));

      const openTask = tasks.find((t) => t.endedAt == null) ?? null;
      let activeTask: ActiveTask | null = null;
      if (openTask) {
        const taskTurns = turns.filter((t) => t.task_id === openTask.id);
        const first = taskTurns[0];
        const firstIndex = openTask.firstTurnIndex ?? (first ? Number(first.turn_index) : null);
        const lastIndex = taskTurns.length > 0
          ? Number(taskTurns[taskTurns.length - 1]!.turn_index)
          : (openTask.lastTurnIndex ?? firstIndex);
        activeTask = {
          id: openTask.id,
          runId: run.id,
          index: openTask.taskIndex,
          startedAt: openTask.startedAt,
          firstTurnIndex: firstIndex,
          lastTurnIndex: lastIndex,
          firstPrompt: typeof first?.prompt === 'string' ? first.prompt : null,
          // The header is promoted on the second turn; a task that already
          // has two either emitted it or is owed it — either way the closure
          // row must be allowed to render. Single-turn tasks stay deferred.
          timelineEmitted: taskTurns.length >= 2,
        };
        this.sessionToTask.set(run.sessionId, activeTask);
        out.tasks++;
      }
      this.sessionToUsage.delete(run.sessionId);

      const openTurn = lastTurn && lastTurn.ended_at == null ? lastTurn : null;
      if (openTurn) {
        const index = Number(openTurn.turn_index);
        const counters = activeTask
          ? this.store.countToolEventsForTurn(activeTask.id, index)
          : { toolCalls: 0, filesModified: 0, filesCreated: 0 };
        this.sessionToTurn.set(run.sessionId, {
          id: String(openTurn.id),
          runId: run.id,
          index,
          startedAt: Number(openTurn.started_at),
          toolCalls: counters.toolCalls,
          filesModified: counters.filesModified,
          filesCreated: counters.filesCreated,
          gitBefore: typeof openTurn.git_before === 'string' ? openTurn.git_before : null,
          prompt: typeof openTurn.prompt === 'string' ? openTurn.prompt : null,
          hasResponse: typeof openTurn.response === 'string' && openTurn.response.length > 0,
        });
        out.turns++;
        // The agent's own record says whether the Stop this turn was owed
        // ever happened. Closed at the RECORD's time, not now: the daemon was
        // down in between, and that gap is nobody's turn duration.
        if (run.agentType === 'codex-cli') {
          let completion: CodexTurnCompletion | null = null;
          try { completion = this.codexCompletionProbe(run.sessionId, Number(openTurn.started_at)); }
          catch { completion = null; }
          if (completion) {
            if (completion.text) this.setTurnResponse(run.sessionId, completion.text);
            // A turn Codex itself failed (usage limit, dead endpoint) fires no
            // Stop and is not a dropped hook.
            const source: TurnEndSource = completion.error ? 'aborted' : 'synthetic_stop';
            this.closeTurn(run.sessionId, source, completion.completedAt);
            out.recovered++;
            debug('APME', `rehydrate: codex turn ${String(openTurn.id).slice(0, 8)} ${completion.error ? 'failed' : 'completed'} at ${new Date(completion.completedAt).toISOString()} per rollout — closed as ${source}`);
          }
        } else if (run.agentType === 'claude-code') {
          let completion: ClaudeTurnCompletion | null = null;
          try { completion = this.claudeCompletionProbe(run.sessionId, run.projectPath ?? null, Number(openTurn.started_at)); }
          catch { completion = null; }
          if (completion) {
            if (completion.text) this.setTurnResponse(run.sessionId, completion.text);
            this.closeTurn(run.sessionId, completion.source, completion.endedAt);
            out.recovered++;
            debug('APME', `rehydrate: claude turn ${String(openTurn.id).slice(0, 8)} ended at ${new Date(completion.endedAt).toISOString()} per transcript — closed as ${completion.source}`);
          }
        }
      } else if (activeTask && lastTurn) {
        const lastEnd = Number(lastTurn.ended_at);
        const remaining = Math.max(0, this.idleGapMs - Math.max(0, now - lastEnd));
        this.armIdleGapTimer(run.sessionId, remaining);
        out.armed++;
      }
    }
    if (out.runs > 0) {
      debug('APME', `rehydrated ${out.runs} open run(s): ${out.tasks} task(s), ${out.turns} open turn(s), ${out.armed} idle timer(s) re-armed, ${out.recovered} turn(s) closed from the agent's own record`);
    }
    return out;
  }

  /** Start a new run and return its id. Safe to call if store disabled (returns ''). */
  openRun(input: OpenRunInput): string {
    if (!this.store.enabled) return '';
    const runId = randomUUID();
    const gitBefore = readGitHead(input.projectPath);
    const row: ApmeRunRow = {
      id: runId,
      sessionId: input.sessionId,
      agentType: input.agentType,
      modelId: input.modelId ?? null,
      provider: input.modelId ? normalizeModelProvider(undefined, input.modelId) : null,
      projectName: input.projectName ?? (input.projectPath ? resolveProjectName({ cwd: input.projectPath }) : null),
      projectPath: input.projectPath ?? null,
      taskPrompt: input.taskPrompt ?? null,
      startedAt: Date.now(),
      gitBefore,
    };
    try {
      this.store.insertRun(row);
      this.sessionToRun.set(input.sessionId, runId);
      this.sessionToAgentType.set(input.sessionId, input.agentType);
      debug('APME', `openRun ${runId} session=${input.sessionId} agent=${input.agentType} model=${input.modelId ?? '-'}`);
    } catch (err) {
      debug('APME', `openRun failed: ${String(err)}`);
    }
    return runId;
  }

  /** Record a hook event as a step + manage turn lifecycle.
   *
   *  `event` is normalized up-front so callers may pass EITHER the PascalCase
   *  hook name (`UserPromptSubmit`, managed session bridge + span ingest) OR
   *  the snake_case name the daemon's `/hooks/` handler maps to
   *  (`user_prompt_submit`, `tool_start`, `tool_end`). Before this, snake_case
   *  silently fell through every branch — the daemon's direct-`claude` hooks
   *  never opened a turn, so those sessions produced no tasks and the device
   *  timeline showed every prompt as a bare top-level chat. Making the matcher
   *  case-tolerant means no caller can quietly no-op the segmentation. */
  ingestHook(sessionId: string, rawEvent: string, data: Record<string, unknown>): void {
    if (!this.store.enabled) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    this.heard(sessionId);
    const event = normalizeHookEventName(rawEvent);
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : null;

    // ── Turn management ──
    if (event === 'UserPromptSubmit') {
      // Claude Code sends { message: { content: "..." } }, legacy sends { prompt: "..." }
      const rawPrompt = typeof data.prompt === 'string' ? data.prompt
        : (typeof (data as Record<string, unknown>).message === 'object'
          ? ((data as Record<string, unknown>).message as Record<string, unknown>)?.content as string | undefined
          : undefined);
      const prompt = typeof rawPrompt === 'string' ? rawPrompt.slice(0, 8_000) : null;
      // Duplicate-open guard: one user prompt can reach the collector more
      // than once within moments. Closing and reopening here would strand an
      // empty phantom turn and shift every later turn_index, so an identical
      // prompt landing on a fresh, still-empty turn is a no-op.
      const openTurn = this.sessionToTurn.get(sessionId);
      if (
        openTurn && prompt !== null && openTurn.prompt !== null &&
        samePromptEcho(openTurn.prompt, prompt) &&
        openTurn.toolCalls === 0 && !openTurn.hasResponse &&
        Date.now() - openTurn.startedAt < DUPLICATE_TURN_OPEN_WINDOW_MS
      ) {
        debug('APME', `duplicate turn_start ignored (echo) turn=${openTurn.id.slice(0, 8)}`);
        return;
      }
      // Close previous turn if open. Resolve prevIndex carefully: the active
      // turn may already have been closed by an explicit closeTurnForSession
      // (Codex `codex_stop` hook), in which case sessionToTurn is empty. Fall
      // back to the last closed turn's row in the store so subsequent turns
      // keep monotonically increasing turn_index instead of resetting to 0.
      let prevIndex = this.sessionToTurn.get(sessionId)?.index ?? -1;
      if (prevIndex === -1) {
        const lastTurnId = this.sessionToLastTurnId.get(sessionId);
        if (lastTurnId) {
          const lastIdx = this.store.getTurn(lastTurnId)?.turn_index;
          if (typeof lastIdx === 'number') prevIndex = lastIdx;
        }
      }
      // A turn still open when the NEXT prompt arrives never got its Stop —
      // and no watchdog recovered it either, or the synthetic Stop would have
      // closed it already. That is the unrecovered-loss bucket, UNLESS the
      // user cancelled it, in which case no Stop was ever owed.
      const displaced = this.resolveDisplacedTurn(sessionId, data);
      if (displaced.response) this.setTurnResponse(sessionId, displaced.response);
      this.closeTurn(sessionId, displaced.source, displaced.endedAt);
      // Open new turn
      const turnIndex = prevIndex + 1;
      const run = this.store.getRun(runId);
      const projectPath = run?.projectPath ?? undefined;
      const turnId = randomUUID();
      const turn: ActiveTurn = {
        id: turnId, runId, index: turnIndex,
        startedAt: Date.now(), toolCalls: 0,
        filesModified: 0, filesCreated: 0,
        gitBefore: readGitHead(projectPath),
        prompt, hasResponse: false,
      };
      this.sessionToTurn.set(sessionId, turn);
      // A new turn is the "still working" signal the idle-gap timer waits on.
      this.clearIdleGapTimer(sessionId);
      // Ensure an active task exists so this turn can attach to it. Tasks group
      // consecutive turns between boundary signals (TodoWrite all-completed,
      // /clear, session_end). First turn in a run opens task 0.
      const task = this.openTaskIfNone(sessionId, runId);
      if (task) {
        const wasFirstTurn = task.firstTurnIndex === null;
        if (wasFirstTurn) {
          task.firstTurnIndex = turnIndex;
          task.firstPrompt = prompt ?? null;
        }
        task.lastTurnIndex = turnIndex;
        // Second (or later) turn on the same task proves it's a real,
        // multi-turn work unit → promote the deferred TASK header so the
        // follow-up prompts render grouped under one row instead of as
        // separate top-level chats. Single-turn Q&A never reaches here.
        if (!wasFirstTurn) this.emitDeferredTaskStartIfNeeded(sessionId);
      }
      try {
        this.store.insertTurn({
          id: turnId, runId, taskId: task?.id ?? null, turnIndex,
          prompt: prompt ?? undefined,
          startedAt: turn.startedAt, gitBefore: turn.gitBefore ?? undefined,
        });
      } catch (err) { debug('APME', `insertTurn failed: ${String(err)}`); }
      // Sample trajectory: the user message opens the turn's typed event log.
      if (task) {
        this.appendSampleEvent(
          { taskId: task.id, runId, turnIndex, turnId },
          { kind: 'user_message', ts: turn.startedAt, dedupCore: hashCore(prompt ?? `turn${turnIndex}`), payloadObj: { text: prompt ?? '' } },
        );
      }
      // Also set run's task_prompt from first prompt
      try {
        if (run && !run.taskPrompt && prompt) {
          this.store.updateRun(runId, { taskPrompt: prompt });
        }
      } catch { /* ignore */ }
    }

    // Track tool calls on the active turn
    const activeTurn = this.sessionToTurn.get(sessionId);
    if (activeTurn && (event === 'PreToolUse' || event === 'tool_start')) {
      activeTurn.toolCalls++;
      if (toolName === 'Edit') activeTurn.filesModified++;
      if (toolName === 'Write') activeTurn.filesCreated++;
      // Sample trajectory: a tool call starts as a pending ToolEvent; its
      // PostToolUse result resolves the SAME row (one row, not two).
      const task = this.sessionToTask.get(sessionId);
      if (task && toolName) {
        this.appendSampleEvent(
          { taskId: task.id, runId, turnIndex: activeTurn.index, turnId: activeTurn.id },
          {
            kind: 'tool', toolName, toolStatus: 'pending',
            dedupCore: `${toolName}:${activeTurn.toolCalls}`,
            payloadObj: { input: extractToolInput(data) },
          },
        );
      }
    }

    // Sample trajectory: resolve the pending ToolEvent on PostToolUse / tool_result.
    if ((event === 'PostToolUse' || event === 'tool_result') && toolName) {
      const task = this.sessionToTask.get(sessionId);
      const turnIndex = this.sessionToTurn.get(sessionId)?.index;
      if (task && turnIndex !== undefined) {
        const isError = Boolean((data as Record<string, unknown>).is_error || (data as Record<string, unknown>).error);
        const output = extractToolOutput(data);
        const pending = this.store.findPendingToolEvent(task.id, turnIndex, toolName);
        if (pending?.id != null) {
          let payload = pending.payload;
          try {
            const obj = pending.payload ? JSON.parse(pending.payload) as Record<string, unknown> : {};
            if (output !== undefined) obj.output = output;
            payload = safeStringify(obj);
          } catch { /* keep existing payload */ }
          this.store.updateSampleEvent(pending.id, {
            toolStatus: isError ? 'error' : 'success',
            toolError: isError ? String((data as Record<string, unknown>).error ?? 'error').slice(0, 500) : null,
            payload,
          });
        } else {
          // No pending row (PostToolUse without a matching PreToolUse) — record
          // a resolved tool event directly.
          this.appendSampleEvent(
            { taskId: task.id, runId, turnIndex, turnId: this.turnIdFor(sessionId) },
            {
              kind: 'tool', toolName,
              toolStatus: isError ? 'error' : 'success',
              toolError: isError ? String((data as Record<string, unknown>).error ?? 'error').slice(0, 500) : null,
              dedupCore: `${toolName}:resolved:${turnIndex}:${this.store.nextSampleSeq(task.id)}`,
              payloadObj: { output },
            },
          );
        }
      }
    }

    // ── Task boundary HINT: TodoWrite all-completed ──
    // Demoted from a hard boundary to a non-segmenting hint (2026-06).
    // TodoWrite-all-complete fires unreliably (~18% on Claude Code v2.1) and,
    // when it did fire, fragmented a single logical task into several units.
    // Tasks now segment only on EXPLICIT boundaries (`/task close`, `/clear`)
    // or `session_end` — a stable, user-controlled unit. We still record the
    // milestone in the trajectory so the task rollup can see that the agent
    // declared its todos done, without splitting the task.
    if (event === 'PostToolUse' && toolName === 'TodoWrite') {
      const todos = extractTodos(data);
      if (todos && todos.length > 0 && todos.every((t) => t.status === 'completed')) {
        const task = this.sessionToTask.get(sessionId);
        const turnIndex = this.sessionToTurn.get(sessionId)?.index;
        if (task && turnIndex !== undefined) {
          this.appendSampleEvent(
            { taskId: task.id, runId, turnIndex, turnId: this.turnIdFor(sessionId) },
            { kind: 'state', dedupCore: `todos_complete:${turnIndex}:${todos.length}`, payloadObj: { state: 'todos_completed', count: todos.length } },
          );
          this.fireTaskMilestone(sessionId, task.id, runId, turnIndex, todos.length);
        }
      }
    }

    // Record step
    try {
      this.store.insertStep({
        runId, ts: Date.now(), kind: event,
        toolName, payload: safeStringify(data),
      });
    } catch (err) {
      debug('APME', `ingestHook failed: ${String(err)}`);
    }
  }

  /** Public wrapper for the private `closeTurn`. Used by adapters that
   *  see an explicit turn-end signal (Codex `codex_stop` hook) and want
   *  to finalize the turn row immediately rather than wait for the next
   *  UserPromptSubmit / closeRun to flush endedAt + buffered counters.
   *  Idempotent — no-op when no active turn for the session. */
  closeTurnForSession(sessionId: string, source: TurnEndSource = 'stop'): void {
    this.closeTurn(sessionId, source);
  }

  /** The agent reported its turn finished (Claude `Stop`, real or synthetic).
   *
   *  Two jobs, both of which need to happen at the Stop and not one prompt
   *  later. First, `ended_at` is stamped HERE, so a turn's duration is the
   *  agent's working time instead of that plus however long the user took to
   *  type the next thing — before this, an overnight gap between prompts was
   *  indistinguishable from a 5-hour turn, and every duration-derived
   *  efficiency number was reading user think time. Second, `end_source`
   *  records WHICH signal closed it, which is the whole Stop-delivery
   *  instrument: a turn that reaches the next prompt still open is a Stop that
   *  was lost, and one closed by `synthetic_stop` is a Stop that was lost and
   *  recovered. Neither is visible if every turn closes the same way.
   *
   *  Callers must record the response BEFORE calling this — `setTurnResponse`
   *  does fall back to the last-closed turn, but the sample trajectory and the
   *  `response_kind` tag read cleaner while the turn is still active.
   *
   *  Idempotent: a duplicate or late Stop finds no active turn and no-ops, so
   *  a synthetic Stop racing a real one cannot overwrite the real attribution. */
  noteTurnStop(sessionId: string, opts: { synthetic?: boolean; interrupted?: boolean; aborted?: boolean } = {}): void {
    if (!this.store.enabled) return;
    this.heard(sessionId);
    // `interrupted` and `aborted` both outrank `synthetic`: neither ending
    // produces a real Stop, so each can only ever arrive AS a synthetic one,
    // and reading the flags the other way round would file every user cancel
    // and every usage-limit abort as a dropped hook. Cancel wins over abort on
    // the impossible both-set case, for the same reason it wins over synthetic
    // — it is the narrower, user-caused claim.
    const source: TurnEndSource = opts.interrupted ? 'interrupted'
      : opts.aborted ? 'aborted'
        : opts.synthetic ? 'synthetic_stop'
          : 'stop';
    this.closeTurn(sessionId, source);
  }

  /** Attribute a turn that is still open when the next prompt arrives.
   *
   *  `next_prompt` is the only bucket that means "a Stop was owed and never
   *  came", so everything that reaches here for some other reason has to be
   *  told apart before it inflates the very loss rate this instrument
   *  measures. Three do, and one bounded tail read answers all three — on this
   *  path only, since a healthy turn is closed by its Stop long before this
   *  runs:
   *
   *   - A CANCEL. The watchdog catches one only while the interrupt marker is
   *     still the transcript's tail; the commonest ESC shape — cancel, then
   *     retype straight away — buries it under the new user message in seconds
   *     and fires a fresh `UserPromptSubmit`.
   *   - A CLIENT ABORT (usage limit, expired auth, API error). The watchdog
   *     closes those at +15s, but not if it was swept for idleness first
   *     (30 min) or the daemon restarted mid-turn — and an abort is exactly
   *     the shape that then sits open for hours.
   *   - A turn that NEVER RAN. Queued prompts and `<task-notification>`
   *     injections arrive in pairs ~130 ms apart; Claude serves both with one
   *     model turn and owes exactly one Stop, which closes the LAST of them.
   *     A displaced row with no assistant record behind it at all is that
   *     artifact, not a lost hook. */
  private resolveDisplacedTurn(sessionId: string, data: Record<string, unknown>): DisplacedTurnVerdict {
    const turn = this.sessionToTurn.get(sessionId);
    // No open turn: closeTurn no-ops, so the value is immaterial.
    if (!turn) return { source: 'next_prompt' };
    const agentType = this.sessionToAgentType.get(sessionId);
    // Codex: the rollout is the record. Measured over one week (2026-09-03),
    // 23 codex turns reached the next prompt open; the rollout held a
    // completed reply for 16 of them (the Stop alone was lost), a failure for
    // 2 (a dead endpoint — no Stop is ever fired for those), and nothing for
    // 5. Only the last five were dropped hooks; the rest are recovered here
    // with the reply and Codex's own end time, the way the watchdog recovers
    // a Claude turn.
    if (agentType === 'codex-cli') {
      try {
        const completion = this.codexCompletionProbe(sessionId, turn.startedAt - TURN_INTERRUPT_SLACK_MS);
        if (!completion) return { source: 'next_prompt' };
        if (completion.error) return { source: 'aborted', endedAt: completion.completedAt };
        return { source: 'synthetic_stop', endedAt: completion.completedAt, response: completion.text || undefined };
      } catch {
        return { source: 'next_prompt' };
      }
    }
    // Claude: the marker and the JSONL shape are Claude Code's.
    if (agentType !== 'claude-code') return { source: 'next_prompt' };
    const transcriptPath = typeof data.transcript_path === 'string' ? data.transcript_path : '';
    if (!transcriptPath) return { source: 'next_prompt' };
    try {
      const evidence = this.openTurnProbe(transcriptPath, turn.startedAt - TURN_INTERRUPT_SLACK_MS);
      // An unreadable transcript is no evidence of anything — never guess.
      if (!evidence) return { source: 'next_prompt' };
      if (evidence.interruptedAt != null) return { source: 'interrupted' };
      if (evidence.abortedAt != null) return { source: 'aborted' };
      // Ordered last on purpose: a cancelled or aborted turn that also wrote
      // nothing is still a cancel or an abort, not a superseded prompt.
      //
      // Two independent facts must agree before a turn is called one that
      // never ran, because the transcript walk alone is not quite enough for
      // this claim: it stops at the first record older than the window, and
      // Claude Code's JSONL is not strictly ordered (auxiliary records land
      // tens of ms out of sequence), so one inverted stamp near the tail could
      // truncate the walk and hide the assistant work behind it. A turn that
      // called tools demonstrably ran whatever the transcript says.
      if (!evidence.sawAssistant && turn.toolCalls === 0) return { source: 'superseded' };
      return { source: 'next_prompt' };
    } catch {
      return { source: 'next_prompt' };
    }
  }

  /** Close the current turn for a session (called on Stop, new prompt, or
   *  session end). `source` records which of those it was — see
   *  `TurnEndSource`. */
  private closeTurn(sessionId: string, source: TurnEndSource, endedAt: number = Date.now()): void {
    const turn = this.sessionToTurn.get(sessionId);
    if (!turn) return;
    this.sessionToLastTurnId.set(sessionId, turn.id);
    this.sessionToTurn.delete(sessionId);
    const run = this.store.getRun(turn.runId);
    const projectPath = run?.projectPath ?? undefined;
    const gitAfter = readGitHead(projectPath);
    try {
      this.store.updateTurn(turn.id, {
        endedAt,
        toolCalls: turn.toolCalls,
        filesModified: turn.filesModified,
        filesCreated: turn.filesCreated,
        gitAfter,
        endSource: source,
      });
      debug('APME', `closeTurn ${turn.id.slice(0, 8)} index=${turn.index} tools=${turn.toolCalls} src=${source}`);
    } catch (err) {
      debug('APME', `closeTurn failed: ${String(err)}`);
    }
    // Idle starts when the turn ends — at the turn's OWN end time, so a turn
    // closed from the agent's record after the fact (rehydrate, next-prompt
    // recovery) is already as idle as the record says it is. The timer is
    // cleared by the next turn open (still working) or by closeTask
    // (boundary reached another way).
    this.armIdleGapTimer(sessionId, Math.max(0, this.idleGapMs - Math.max(0, Date.now() - endedAt)));
  }

  /** Get the current active turn ID for a session (if any). */
  getActiveTurnId(sessionId: string): string | null {
    return this.sessionToTurn.get(sessionId)?.id ?? null;
  }

  /** Get the current active task ID for a session (if any). Exposed for tests. */
  getActiveTaskId(sessionId: string): string | null {
    return this.sessionToTask.get(sessionId)?.id ?? null;
  }

  /** Fire the `onTaskMilestone` listener for a TodoWrite-all-completed hint,
   *  at most once per (task, turn) — the agent may rewrite an all-completed
   *  todo list several times inside one turn. */
  private fireTaskMilestone(
    sessionId: string,
    taskId: string,
    runId: string,
    turnIndex: number,
    todoCount: number | null,
  ): void {
    if (!this.onTaskMilestone) return;
    const key = `${taskId}:${turnIndex}`;
    if (this.sessionToLastMilestone.get(sessionId) === key) return;
    this.sessionToLastMilestone.set(sessionId, key);
    // A TodoWrite plan implies a task worth showing — promote the deferred
    // task_start first so the milestone row never renders orphaned above a
    // task with no header.
    this.emitDeferredTaskStartIfNeeded(sessionId);
    const run = this.store.getRun(runId);
    try {
      this.onTaskMilestone({
        taskId,
        runId,
        sessionId,
        agentType: (run?.agentType ?? null) as AgentType | null,
        projectName: run?.projectName ?? null,
        turnIndex,
        todoCount,
        at: Date.now(),
      });
    } catch (err) {
      debug('APME', `onTaskMilestone listener threw: ${String(err)}`);
    }
  }

  /** Open a new task if none is active for this session. Returns the active
   *  task (new or existing), or null if no run is open. Idempotent: repeat
   *  calls while a task is already active are no-ops.
   *
   *  The `task_start` timeline row is NOT emitted here — it is deferred to
   *  `emitDeferredTaskStartIfNeeded`, fired when a "real task" signal lands
   *  (a second turn on the same task, or a TodoWrite plan). Short single-turn
   *  conversations therefore never produce a TASK header on the dashboard,
   *  keeping the timeline focused on the turn rows worth evaluating. The DB
   *  `tasks` row is inserted immediately so eval/analytics see every unit.
   *  Mirrors ApmeCollector.swift `openTaskIfNone` + `emitDeferredTaskStartIfNeeded`. */
  private openTaskIfNone(sessionId: string, runId: string): ActiveTask | null {
    const existing = this.sessionToTask.get(sessionId);
    if (existing) return existing;
    const nextIndex = this.runTaskCount.get(runId) ?? 0;
    this.runTaskCount.set(runId, nextIndex + 1);
    const task: ActiveTask = {
      id: randomUUID(),
      runId,
      index: nextIndex,
      startedAt: Date.now(),
      firstTurnIndex: null,
      lastTurnIndex: null,
      firstPrompt: null,
      timelineEmitted: false,
    };
    this.sessionToTask.set(sessionId, task);
    try {
      this.store.insertTask({
        id: task.id,
        runId,
        taskIndex: task.index,
        boundarySignal: 'open',
        startedAt: task.startedAt,
      });
    } catch (err) {
      debug('APME', `insertTask failed: ${String(err)}`);
    }

    return task;
  }

  /** Emit the deferred `task_start` timeline row for the session's active task,
   *  once. Idempotent — repeat calls after the first are no-ops. Uses the
   *  task's original `startedAt` as the row ts so the TASK header anchors above
   *  the first turn it groups instead of jumping in mid-conversation. Called
   *  when a task proves itself "real" (second turn, or TodoWrite plan).
   *  Mirrors ApmeCollector.swift `emitDeferredTaskStartIfNeeded`. */
  private emitDeferredTaskStartIfNeeded(sessionId: string): void {
    const task = this.sessionToTask.get(sessionId);
    if (!task || task.timelineEmitted) return;
    task.timelineEmitted = true;
    if (!this.onTaskOpened) return;
    const run = this.store.getRun(task.runId);
    try {
      this.onTaskOpened({
        taskId: task.id,
        runId: task.runId,
        sessionId,
        agentType: (run?.agentType ?? null) as AgentType | null,
        projectName: run?.projectName ?? null,
        taskIndex: task.index,
        startedAt: task.startedAt,
        title: deriveTaskTitle(task.firstPrompt),
      });
    } catch (err) {
      debug('APME', `onTaskOpened listener threw: ${String(err)}`);
    }
  }

  /** Arm the per-session idle-gap timer. Called from `closeTurn` — the turn
   *  just finished, so the gap being measured is genuine idle time, never the
   *  agent's own working time. Re-arming replaces any previous timer. */
  private armIdleGapTimer(sessionId: string, delayMs: number = this.idleGapMs): void {
    this.clearIdleGapTimer(sessionId);
    const timer = setTimeout(() => {
      this.sessionToIdleGapTimer.delete(sessionId);
      // A turn opened since (and its clear lost a race), or work is mid-turn:
      // never split under an active turn.
      if (this.sessionToTurn.has(sessionId)) return;
      if (!this.sessionToTask.has(sessionId)) return;
      debug('APME', `idle gap (${Math.round(this.idleGapMs / 1000)}s) → closing task for ${sessionId.slice(0, 8)}`);
      this.closeTask(sessionId, 'idle_gap');
    }, delayMs);
    // Never hold the process open for an idle bookkeeping timer.
    timer.unref?.();
    this.sessionToIdleGapTimer.set(sessionId, timer);
  }

  private clearIdleGapTimer(sessionId: string): void {
    const timer = this.sessionToIdleGapTimer.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.sessionToIdleGapTimer.delete(sessionId);
    }
  }

  /** Public wrapper for closeTask. Used by the manual-boundary CLI /
   *  HTTP route + the macOS detail-pane button — lets the user declare
   *  "this task is done" without `/clear` (which would also split the
   *  run). No-op when no task is active. Passing `outcome` overrides the
   *  judge's coarse score-derived class — handy for `task cancel` where
   *  the user wants the row tagged "abandoned" regardless of partial
   *  progress. */
  closeTaskExternal(
    sessionId: string,
    boundarySignal: TaskBoundarySignal = 'manual',
    outcome?: 'success' | 'fail' | 'partial' | 'abandoned',
  ): boolean {
    const task = this.sessionToTask.get(sessionId);
    if (!task) return false;
    this.closeTask(sessionId, boundarySignal);
    if (outcome) {
      try { this.store.updateTask(task.id, { outcome }); }
      catch (err) { debug('APME', `manual outcome write failed: ${String(err)}`); }
    }
    return true;
  }

  /** Close the current task for a session, persisting boundary metadata.
   *  No-op if no task is active. Fires `onTaskClosed` so the runner can
   *  enqueue a task-level judge call. Tasks that never saw a turn
   *  (firstTurnIndex === null) are deleted rather than left as noise. */
  private closeTask(sessionId: string, boundarySignal: TaskBoundarySignal): void {
    const task = this.sessionToTask.get(sessionId);
    if (!task) return;
    this.sessionToTask.delete(sessionId);
    this.sessionToLastMilestone.delete(sessionId);
    this.clearIdleGapTimer(sessionId);

    // Empty task: no turns ever attached. Drop the row so the dashboard
    // doesn't show phantom entries from back-to-back boundary signals.
    if (task.firstTurnIndex === null) {
      try {
        // Direct delete — no DAO for it; tasks FK is ON DELETE CASCADE.
        // We reach through the store via a raw statement to avoid adding
        // a dedicated method for this edge case.
        (this.store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } | null }).db
          ?.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
      } catch { /* ignore */ }
      debug('APME', `closeTask ${task.id.slice(0, 8)} — empty, dropped`);
      return;
    }

    // Category, present-at-close. Prefer the run's already-resolved category;
    // otherwise classify synchronously from the run's signals so the task row
    // (and its rollup judge rubric) always carries a stable category. The
    // async run-level classifier (classifyRunSmart at closeRun) frequently
    // resolves AFTER the task has already closed — leaving taskCategory null
    // and the judge falling back to the wrong generic rubric.
    const run = this.store.getRun(task.runId);
    let taskCategory = run?.taskCategory ?? null;
    if (!taskCategory || taskCategory === 'unknown') {
      try {
        const signals = computeSignals(this.store, task.runId);
        // run.endedAt is still null at session_end close (updateRun runs after
        // closeTask), so sessionDurationSec would be 0 and skew the duration
        // rules — derive it from the task span instead.
        if (signals.sessionDurationSec === 0) {
          signals.sessionDurationSec = Math.max(0, Math.round((Date.now() - task.startedAt) / 1000));
        }
        const category = classify(signals);
        if (category && category !== 'unknown') taskCategory = category;
      } catch (err) {
        debug('APME', `closeTask classify failed: ${String(err)}`);
      }
    }

    try {
      this.store.updateTask(task.id, {
        endedAt: Date.now(),
        // `first_turn_index` too, not just the last. The task row is INSERTed
        // from inside the turn_start handler, i.e. before the turn exists, so
        // it is written NULL and the real index only ever landed in memory —
        // 294 of 1080 closed claude-code tasks carry NULL here, and the task
        // rollup the layer-2 judge reads is keyed on these two columns.
        // `reapAbandonedRun` already COALESCEs a value in at reap time, which
        // is this defect's workaround rather than its fix.
        firstTurnIndex: task.firstTurnIndex,
        lastTurnIndex: task.lastTurnIndex ?? task.firstTurnIndex,
        boundarySignal,
        taskCategory,
      });
    } catch (err) {
      debug('APME', `updateTask failed: ${String(err)}`);
    }

    debug('APME', `closeTask ${task.id.slice(0, 8)} signal=${boundarySignal} turns=${task.firstTurnIndex}..${task.lastTurnIndex}`);

    // Notify listeners (runner enqueueTask + timeline emitter wired via apme/index.ts).
    if (this.onTaskClosed) {
      try {
        this.onTaskClosed({
          taskId: task.id,
          runId: task.runId,
          sessionId,
          agentType: (run?.agentType ?? null) as AgentType | null,
          projectName: run?.projectName ?? null,
          startedAt: task.startedAt,
          endedAt: Date.now(),
          boundarySignal,
          taskCategory,
          turns: (task.lastTurnIndex ?? task.firstTurnIndex ?? 0) - (task.firstTurnIndex ?? 0) + 1,
          timelineEmitted: task.timelineEmitted,
        });
      } catch (err) {
        debug('APME', `onTaskClosed listener threw: ${String(err)}`);
      }
    }
  }

  /** Get the current run ID for a session (if any). */
  getRunId(sessionId: string): string | null {
    return this.sessionToRun.get(sessionId) ?? null;
  }

  /** True while this collector still owns `runId` — some session maps to it and
   *  will close it normally. The abandoned-run reaper consults this before
   *  finalizing anything: an inactivity window alone would reap a live session
   *  whose user simply stepped away mid-turn, and the row would then be closed
   *  underneath the collector that is still writing to it. */
  isLiveRun(runId: string): boolean {
    for (const [sessionId, id] of this.sessionToRun) {
      if (id !== runId) continue;
      // Adoption at startup is PROVISIONAL: a run re-adopted from the store
      // whose session has not sent a single hook since is owned in name only.
      // Counting it live forever meant a session that ended while the daemon
      // was down could never be reaped — its run had no Stop coming, no idle
      // timer (those arm on turn close), and a reaper that deferred to us.
      // Measured 2026-09-03: two such runs open 17 hours after the restart.
      return !this.rehydratedSessions.has(sessionId);
    }
    return false;
  }

  /** Drop every in-memory edge to `runId` after the reaper closed it in the
   *  store, so a hook that arrives later opens a fresh run instead of writing
   *  turns into a row that is already finalised. */
  releaseRun(runId: string): void {
    for (const [sessionId, id] of [...this.sessionToRun]) {
      if (id !== runId) continue;
      this.clearIdleGapTimer(sessionId);
      this.sessionToRun.delete(sessionId);
      this.sessionToTask.delete(sessionId);
      this.sessionToTurn.delete(sessionId);
      this.sessionToLastTurnId.delete(sessionId);
      this.rehydratedSessions.delete(sessionId);
    }
    this.runTaskCount.delete(runId);
  }

  /** The session spoke: an adopted run is now owned for real. */
  private heard(sessionId: string): void {
    this.rehydratedSessions.delete(sessionId);
  }

  /** Agent type established for a session at `openRun` (survives closeRun so a
   *  late-attributed timeline row still resolves its brand). This is the single
   *  authoritative agentType source the timeline attributor backfills from, so
   *  every timeline entry ships with an agentType regardless of which emitter
   *  produced it (observed hook `chat_start`, relayed managed `tool_exec`, …). */
  getRunAgentType(sessionId: string): AgentType | null {
    return this.sessionToAgentType.get(sessionId) ?? null;
  }

  // ─── SessionSample trajectory (the normalizer's typed event log) ────────────

  /** Resolve the (taskId, runId, turnIndex) a sample event should attach to.
   *  Prefers the active task/turn; falls back to a turn row in the DB when the
   *  task already closed (e.g. PTY response captured after session_end). */
  private sampleCtxForTurn(
    sessionId: string,
    turnId?: string,
  ): SampleCtx | null {
    const active = this.sessionToTask.get(sessionId);
    if (turnId) {
      const row = this.store.getTurn(turnId);
      const taskId = (row?.task_id as string | undefined) ?? active?.id;
      const runId = (row?.run_id as string | undefined) ?? active?.runId;
      const turnIndex = (row?.turn_index as number | undefined)
        ?? this.sessionToTurn.get(sessionId)?.index ?? active?.lastTurnIndex ?? 0;
      if (taskId && runId) return { taskId, runId, turnIndex, turnId };
    }
    if (active) {
      const turnIndex = this.sessionToTurn.get(sessionId)?.index ?? active.lastTurnIndex ?? 0;
      return { taskId: active.id, runId: active.runId, turnIndex, turnId: this.sessionToTurn.get(sessionId)?.id };
    }
    return null;
  }

  /** The active turn's id, for stamping the event→turn edge on sample rows.
   *  Falls back to the last closed turn so a trailing event (a PostToolUse that
   *  lands after the turn rotated) still carries an edge instead of a null. */
  private turnIdFor(sessionId: string): string | undefined {
    return this.sessionToTurn.get(sessionId)?.id ?? this.sessionToLastTurnId.get(sessionId);
  }

  /** Append one typed trajectory event to the active sample. Storage-time dedup
   *  is handled by the UNIQUE (task_id, dedup_key) index. Fires `onSampleEvent`
   *  only when a row was actually inserted (not a dup), so the timeline
   *  projection never double-emits. */
  private appendSampleEvent(
    ctx: SampleCtx,
    ev: {
      kind: TrajectoryEventKind;
      dedupCore: string;
      ts?: number;
      model?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      costUsd?: number | null;
      costKnown?: boolean | null;
      latencyMs?: number | null;
      toolName?: string | null;
      toolStatus?: string | null;
      toolError?: string | null;
      payloadObj?: Record<string, unknown>;
    },
  ): void {
    if (!this.store.enabled) return;
    const dedupKey = createHash('sha1').update(`${ev.kind}|${ctx.turnIndex}|${ev.dedupCore}`).digest('hex').slice(0, 24);
    const row: ApmeSampleEventRow = {
      taskId: ctx.taskId,
      runId: ctx.runId,
      turnIndex: ctx.turnIndex,
      turnId: ctx.turnId ?? null,
      seq: this.store.nextSampleSeq(ctx.taskId),
      ts: ev.ts ?? Date.now(),
      kind: ev.kind,
      model: ev.model ?? null,
      inputTokens: ev.inputTokens ?? null,
      outputTokens: ev.outputTokens ?? null,
      costUsd: ev.costUsd ?? null,
      costKnown: ev.costKnown ?? null,
      latencyMs: ev.latencyMs ?? null,
      toolName: ev.toolName ?? null,
      toolStatus: ev.toolStatus ?? null,
      toolError: ev.toolError ?? null,
      payload: ev.payloadObj ? safeStringify(ev.payloadObj) : null,
      dedupKey,
    };
    let inserted = false;
    try { inserted = this.store.insertSampleEvent(row); }
    catch (err) { debug('APME', `appendSampleEvent failed: ${String(err)}`); return; }
    if (inserted && this.onSampleEvent) {
      const run = this.store.getRun(ctx.runId);
      try {
        this.onSampleEvent({
          taskId: ctx.taskId, runId: ctx.runId,
          sessionId: this.runToSessionId(ctx.runId),
          agentType: (run?.agentType ?? null) as AgentType | null,
          projectName: run?.projectName ?? null,
          event: row,
        });
      } catch (err) { debug('APME', `onSampleEvent listener threw: ${String(err)}`); }
    }
  }

  /** Persist a child-agent lifecycle event on its parent task. Child hooks are
   *  deliberately consumed before ordinary APME ingestion so they cannot
   *  mutate parent state or controls; SubagentTimelineTracker explicitly
   *  hands just this observation-safe evidence back to the collector.
   *
   *  This is the producer for SampleModelConfig.subagents. The richer event
   *  also powers the judge rollup and Graph node without promoting a child to
   *  a separately steerable session. Returns false when no parent task is
   *  active, which is honest: there is no task edge to guess. */
  noteSubagentLifecycle(sessionId: string, event: SubagentSampleEvent): boolean {
    if (!this.store.enabled) return false;
    const ctx = this.sampleCtxForTurn(sessionId);
    if (!ctx) return false;
    const task = this.store.getTask(ctx.taskId);
    if (!task) return false;

    const name = event.name.trim();
    if (!name) return false;
    try {
      this.store.updateTask(ctx.taskId, {
        modelConfig: this.mergedTaskModelConfig(task, undefined, undefined, name),
      });
    } catch { /* keep the lifecycle event even if the header update failed */ }

    const durationMs = event.startedAt == null
      ? null
      : Math.max(0, event.ts - event.startedAt);
    this.appendSampleEvent(ctx, {
      kind: 'subagent',
      ts: event.ts,
      dedupCore: `${event.phase}:${event.id}`,
      payloadObj: {
        id: event.id,
        name,
        phase: event.phase,
        ...(event.summary ? { summary: event.summary } : {}),
        ...(durationMs == null ? {} : { durationMs }),
      },
    });
    return true;
  }

  /** Persist a free-form annotation on the session's active task (a task-list
   *  item checked off, a team event without a child identity). Returns false
   *  when no task is open — there is nothing honest to attach it to. */
  noteInfo(sessionId: string, event: { label: string; detail?: string | null; ts?: number }): boolean {
    if (!this.store.enabled) return false;
    const label = event.label.trim();
    if (!label) return false;
    const ctx = this.sampleCtxForTurn(sessionId);
    if (!ctx) return false;
    const ts = event.ts ?? Date.now();
    this.appendSampleEvent(ctx, {
      kind: 'info',
      ts,
      dedupCore: `${label}:${ts}:${event.detail ?? ''}`,
      payloadObj: { label, ...(event.detail ? { detail: event.detail } : {}) },
    });
    return true;
  }

  /** Persist a cross-session coordination observation (`RelationEvent`) on
   *  the session's active task. Like child lifecycle, this is evidence for the
   *  work board and the collaboration lens, never a steerable session or a
   *  parent link guessed from project membership: the producer
   *  (`CoordinationTracker`) only calls this with what a process table, a
   *  SendMessage tool call or a cross-session envelope actually said. */
  noteRelation(sessionId: string, event: {
    relation: 'spawned' | 'messaged' | 'waiting_on';
    direction: 'in' | 'out';
    phase: 'open' | 'closed';
    peerSessionId?: string | null;
    peerName?: string | null;
    evidence: string;
    detail?: string | null;
    ts?: number;
    /** Identity the dedup key is built on — the peer pid / session / message
     *  hash — so a re-scan does not append the same open relation twice. */
    key: string;
  }): boolean {
    if (!this.store.enabled) return false;
    const ctx = this.sampleCtxForTurn(sessionId);
    if (!ctx) return false;
    const ts = event.ts ?? Date.now();
    this.appendSampleEvent(ctx, {
      kind: 'relation',
      ts,
      dedupCore: `${event.relation}:${event.direction}:${event.phase}:${event.key}`,
      payloadObj: {
        relation: event.relation,
        direction: event.direction,
        phase: event.phase,
        ...(event.peerSessionId ? { peerSessionId: event.peerSessionId } : {}),
        ...(event.peerName ? { peerName: event.peerName } : {}),
        evidence: event.evidence,
        ...(event.detail ? { detail: event.detail } : {}),
      },
    });
    return true;
  }

  /** Merge instead of replacing the sample identity header. Model updates can
   *  arrive after subagent starts (and vice versa); overwriting model_config
   *  here was why a future subagents producer would have appeared to work and
   *  then silently vanished on the next usage/model hook. */
  private mergedTaskModelConfig(
    task: ApmeTaskRow,
    modelId?: string | null,
    provider?: string | null,
    subagent?: string,
  ): string {
    let previous: Partial<SampleModelConfig> = {};
    if (task.modelConfig) {
      try {
        const parsed = JSON.parse(task.modelConfig) as unknown;
        if (parsed && typeof parsed === 'object') previous = parsed as Partial<SampleModelConfig>;
      } catch { /* malformed legacy value: rebuild from row columns */ }
    }
    const subagents = new Set(
      Array.isArray(previous.subagents)
        ? previous.subagents.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [],
    );
    if (subagent) subagents.add(subagent);
    return JSON.stringify({
      ...previous,
      modelId: modelId ?? task.modelId ?? previous.modelId ?? 'unknown',
      provider: provider === undefined ? (task.provider ?? previous.provider ?? null) : provider,
      ...(subagents.size > 0 ? { subagents: [...subagents].sort() } : {}),
    });
  }

  /** Reverse-lookup sessionId for a runId (best-effort; only the live map). */
  private runToSessionId(runId: string): string {
    for (const [sid, rid] of this.sessionToRun) if (rid === runId) return sid;
    return '';
  }

  /** Store Claude's response text on the current turn.
   *  Falls back to the last closed turn if closeTurn() already ran (race with session exit).
   *  Tags turns.efficiency_json.response_kind so the runner can skip tool-only / empty
   *  turns — judging silence produces noise scores. */
  setTurnResponse(
    sessionId: string,
    response: string,
    source: 'chat_final' | 'session_message_projection' | 'direct' = 'direct',
  ): void {
    if (!this.store.enabled) return;
    const turn = this.sessionToTurn.get(sessionId);
    const turnId = turn?.id ?? this.sessionToLastTurnId.get(sessionId);
    debug('APME', `setTurnResponse session=${sessionId.slice(0,8)} turnId=${turnId?.slice(0,8) ?? 'null'} respLen=${response.length}`);
    if (!turnId) return;
    const existingTurn = this.store.getTurn(turnId);
    const existingMeta = parseEfficiencyJson(existingTurn);
    const existingSource = typeof existingMeta.response_source === 'string'
      ? existingMeta.response_source
      : (existingTurn?.response ? 'direct' : undefined);
    if (responseSourcePriority(source) < responseSourcePriority(existingSource)) {
      debug('APME', `setTurnResponse ignored lower-priority source=${source} existing=${existingSource}`);
      return;
    }
    const trimmedLen = response.trim().length;
    // Active-turn toolCalls is authoritative; after closeTurn() the counter is
    // already flushed to the DB row, so we fetch from there instead.
    const toolCalls = turn?.toolCalls
      ?? ((existingTurn?.tool_calls as number | undefined) ?? 0);
    const kind: 'text' | 'tool_only' | 'empty' = trimmedLen >= 1
      ? 'text'
      : (toolCalls > 0 ? 'tool_only' : 'empty');
    const efficiencyJson = mergeEfficiencyJson(existingTurn, {
      response_kind: kind,
      response_source: source,
    });
    try {
      this.store.updateTurn(turnId, {
        response: response.slice(0, 10_000),
        efficiencyJson,
      });
      if (turn) turn.hasResponse = true;
    } catch (err) { debug('APME', `setTurnResponse failed: ${String(err)}`); }
    // Sample trajectory: the assistant response closes the turn's event arc.
    const ctx = this.sampleCtxForTurn(sessionId, turnId);
    if (ctx) {
      const payload = safeStringify({ text: response.slice(0, 10_000), responseKind: kind });
      const existingEvent = this.store.findAssistantMessageEvent(ctx.taskId, turnId);
      if (existingEvent?.id != null) {
        this.store.updateSampleEvent(existingEvent.id, { payload, ts: Date.now() });
      } else {
        this.appendSampleEvent(ctx, {
          kind: 'assistant_message',
          dedupCore: `turn:${turnId}`,
          payloadObj: { text: response.slice(0, 10_000), responseKind: kind },
        });
      }
    }
  }

  /** Apply response to the last closed turn if it has no response yet.
   *  Used as fallback when Stop hook doesn't fire (PTY output capture). */
  setLastClosedTurnResponse(sessionId: string, response: string): void {
    if (!this.store.enabled) return;
    // The in-memory edge is dropped at closeRun, and a one-turn session
    // (`claude -p`, a spawned worker) sends its SessionEnd 80–130 ms after
    // its Stop — before the deferred transcript re-read (1.5 s) that exists
    // because the Stop's own read found nothing. The reply then arrived to
    // no turn and was dropped: 6 of 13 such sessions in one day (2026-09-03).
    // The store still knows the turn; a bounded window keeps a late reply
    // from landing on a session's turn from an earlier life.
    const turnId = this.sessionToLastTurnId.get(sessionId)
      ?? this.store.latestClosedTurnIdForSession(sessionId, Date.now() - LATE_REPLY_WINDOW_MS)
      ?? undefined;
    if (!turnId) return;
    const existing = this.store.getTurn(turnId);
    if (existing?.response) return;
    const trimmedLen = response.trim().length;
    const toolCalls = (existing?.tool_calls as number | undefined) ?? 0;
    const kind: 'text' | 'tool_only' | 'empty' = trimmedLen >= 1
      ? 'text'
      : (toolCalls > 0 ? 'tool_only' : 'empty');
    const efficiencyJson = mergeEfficiencyJson(existing, { response_kind: kind });
    try {
      this.store.updateTurn(turnId, {
        response: response.slice(0, 10_000),
        efficiencyJson,
      });
    } catch { /* ignore */ }
    const ctx = this.sampleCtxForTurn(sessionId, turnId);
    if (ctx) {
      this.appendSampleEvent(ctx, {
        kind: 'assistant_message',
        dedupCore: hashCore(response.slice(0, 400)),
        payloadObj: { text: response.slice(0, 10_000), responseKind: kind },
      });
    }
  }

  /** Single-entrypoint ingestion using the shared TelemetrySpan envelope.
   *
   *  Adapters in `bridge/src/apme/adapters/*` translate per-source events
   *  (Claude hooks / PTY parser / OpenClaw timeline / Codex) into spans;
   *  this method dispatches each span to the appropriate legacy collector
   *  method so existing race-handling and step-row insertion logic stays
   *  intact. New ingestion paths should prefer this entrypoint over
   *  `ingestHook` / `setTurnResponse` directly. */
  ingestSpan(sessionId: string, span: TelemetrySpan): void {
    if (!this.store.enabled) return;
    const a = span.attributes;
    switch (span.kind) {
      case 'turn_start': {
        const prompt = (a['agentdeck.prompt_text'] as string | undefined) ?? '';
        // Reuse the canonical UserPromptSubmit path so step row, prev-turn close,
        // task auto-open, and run.task_prompt seeding all behave identically.
        this.ingestHook(sessionId, 'UserPromptSubmit', { message: { content: prompt } });
        return;
      }
      case 'turn_response': {
        const text = (a['agentdeck.response_text'] as string | undefined) ?? '';
        const source = (a['agentdeck.response_source'] as 'chat_final' | 'session_message_projection' | 'direct' | undefined) ?? 'direct';
        const fallback = a['agentdeck.fallback_to_last_closed'] === true;
        if (fallback) this.setLastClosedTurnResponse(sessionId, text);
        else this.setTurnResponse(sessionId, text, source);
        return;
      }
      case 'turn_end': {
        // An explicit close, from a source that HAS a stop signal of its own.
        // This used to be a no-op on the theory that turns auto-close on the
        // next `turn_start` — which is true, and is exactly the shape the
        // `end_source` column exists to avoid: closing at the next prompt puts
        // the user's thinking time inside the turn's duration, and a
        // conversation with one turn never closes it at all. OpenClaw is the
        // first emitter (its `chat.final` is the stop signal); every other
        // adapter still auto-closes, unchanged.
        const source = (a['agentdeck.turn_end_source'] as TurnEndSource | undefined) ?? 'stop';
        this.closeTurn(sessionId, source);
        return;
      }
      case 'tool_call': {
        const toolName = (a['gen_ai.tool.name'] ?? a['agentdeck.tool_name']) as string | undefined;
        const raw = (a['agentdeck.raw_payload'] as Record<string, unknown> | undefined) ?? {};
        this.ingestHook(sessionId, 'PreToolUse', { tool_name: toolName, ...raw });
        return;
      }
      case 'tool_result': {
        const toolName = (a['gen_ai.tool.name'] ?? a['agentdeck.tool_name']) as string | undefined;
        const raw = (a['agentdeck.raw_payload'] as Record<string, unknown> | undefined) ?? {};
        // PostToolUse + TodoWrite all-completed → existing ingestHook path
        // detects todo_complete boundary automatically, so adapters don't
        // need to emit a separate task_boundary span for that case.
        this.ingestHook(sessionId, 'PostToolUse', { tool_name: toolName, ...raw });
        return;
      }
      case 'task_boundary': {
        const signal = a['agentdeck.boundary_signal'] as string | undefined;
        if (signal === 'clear') {
          this.splitRun(sessionId, (a['agentdeck.cwd'] as string | undefined));
          return;
        }
        // Adapter-emitted boundaries (OpenClaw chat.aborted → 'manual',
        // OpenClaw idle-gap timer → 'idle_gap') close the active task.
        // `session_end` is intentionally excluded: closeRun fires that
        // path itself, and a duplicate here would double-emit onTaskClosed.
        if (signal === 'manual' || signal === 'idle_gap') {
          this.closeTask(sessionId, signal);
          return;
        }
        // `todo_complete` is a soft hint, not a boundary (see ingestHook
        // TodoWrite handling) — record it in the trajectory without splitting
        // the task. OpenCode's TodoWrite-all-completed routes here.
        if (signal === 'todo_complete') {
          const task = this.sessionToTask.get(sessionId);
          const turnIndex = this.sessionToTurn.get(sessionId)?.index;
          if (task && turnIndex !== undefined) {
            this.appendSampleEvent(
              { taskId: task.id, runId: task.runId, turnIndex, turnId: this.turnIdFor(sessionId) },
              { kind: 'state', dedupCore: `todos_complete:${turnIndex}`, payloadObj: { state: 'todos_completed' } },
            );
            this.fireTaskMilestone(sessionId, task.id, task.runId, turnIndex, null);
          }
          return;
        }
        debug('APME', `task_boundary span dropped: unknown signal=${signal ?? '<none>'}`);
        return;
      }
      case 'session_meta': {
        const model = a['gen_ai.request.model'] as string | undefined;
        const rawProvider = a['gen_ai.system'] as string | undefined;
        if (model || rawProvider) this.updateTurnIdentity(sessionId, model, rawProvider);
        const inputTokens = a['agentdeck.usage.input_tokens'] as number | undefined;
        const outputTokens = a['agentdeck.usage.output_tokens'] as number | undefined;
        const costUsd = a['agentdeck.usage.cost_usd'] as number | undefined;
        if (inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined) {
          // PER-MESSAGE numbers, not a running total — see `addUsageIncrement`.
          this.addUsageIncrement(sessionId, {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            costUsd: costUsd ?? null,
          });
        }
        return;
      }
      case 'agent_error': {
        // Record the failure in the trajectory. Deliberately does NOT close
        // the turn or the task: the agent may retry the same prompt, and the
        // adapter owns the boundary (OpenClaw re-arms its idle-gap timer).
        // Without this the judge sees a turn_start with no response and no
        // reason — indistinguishable from a dropped event.
        const label = (a['agentdeck.error_label'] as string | undefined)?.trim();
        if (!label) return;
        const detail = (a['agentdeck.error_detail'] as string | undefined)?.trim();
        const task = this.sessionToTask.get(sessionId);
        const turnIndex = this.sessionToTurn.get(sessionId)?.index;
        if (!task || turnIndex === undefined) {
          debug('APME', `agent_error span dropped: no open task/turn for ${sessionId}`);
          return;
        }
        this.appendSampleEvent(
          { taskId: task.id, runId: task.runId, turnIndex, turnId: this.turnIdFor(sessionId) },
          {
            kind: 'info',
            dedupCore: `agent_error:${label}`,
            payloadObj: { label, ...(detail ? { detail } : {}) },
          },
        );
        return;
      }
      case 'raw_step': {
        const event = (a['agentdeck.raw_event'] as string | undefined) ?? 'raw';
        const payload = (a['agentdeck.raw_payload'] as Record<string, unknown> | undefined) ?? {};
        this.ingestHook(sessionId, event, payload);
        return;
      }
    }
  }

  /** Ingest a generic timeline-style event (non-hook). */
  ingestStep(sessionId: string, kind: string, payload: Record<string, unknown>, toolName?: string): void {
    if (!this.store.enabled) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    try {
      this.store.insertStep({
        runId, ts: Date.now(), kind,
        toolName: toolName ?? null,
        payload: safeStringify(payload),
      });
    } catch { /* ignore */ }
  }

  /** Update token / cost columns from the bridge's UsageTracker snapshot.
   *  Snapshots carry CUMULATIVE session totals, so we emit a priced ModelEvent
   *  for the delta and attribute it to the active task (the SessionSample cost
   *  is the sum of its ModelEvents). */
  /**
   * Record usage a producer reports for ONE message.
   *
   * `updateUsage` is cumulative by contract: it assigns `inputTokens` to the run
   * row absolutely and derives its per-task ModelEvent as `max(0, cur - prev)`.
   * Its original and only other caller is the PTY poller's `UsageTracker`
   * snapshot, which really is a running total.
   *
   * A `session.message`(assistant) frame reports THIS message's tokens, and those
   * are not monotonic — measured on a real OpenClaw session: 30302, 21375, 335,
   * 96, 114. Fed to `updateUsage` directly, the run row ends at the LAST
   * message's count (114 for a session that consumed 52,222), every decrease
   * clamps its delta to 0 so most messages append no ModelEvent at all, and
   * `recomputeSampleCost` then prices the run from what survives. Two messages
   * sharing an `(in,out)` pair are additionally deduped away, because the dedup
   * key assumes cumulative values are unique.
   *
   * So convert here rather than at each producer: keep the running total and
   * hand `updateUsage` the cumulative series its arithmetic is written for.
   */
  addUsageIncrement(
    sessionId: string,
    delta: { inputTokens: number; outputTokens: number; costUsd: number | null },
  ): void {
    if (!this.store.enabled) return;
    // ONE guard for both accumulators. `updateUsage` drops everything when the
    // session has no open run, so advancing the cost total before that check
    // let cost count messages the token total did not: a span arriving before
    // the run opened, then one after, recorded 7 tokens at $10.50. Two
    // accumulators with different failure modes is the same defect shape as a
    // guard cleared only by a `defer` it shares a failure mode with.
    if (!this.sessionToRun.get(sessionId)) return;
    const prev = this.sessionToUsage.get(sessionId) ?? { in: 0, out: 0, cost: null };
    const prevCost = this.sessionToCostTotal.get(sessionId) ?? { total: 0, seen: false };
    const reported = typeof delta.costUsd === 'number';
    const cost = { total: prevCost.total + (reported ? delta.costUsd as number : 0),
                   seen: prevCost.seen || reported };
    this.sessionToCostTotal.set(sessionId, cost);
    this.updateUsage(sessionId, {
      // The clamp is deliberate, not defensive: `updateUsage` derives its
      // ModelEvent as `max(0, cur - prev)`, so the series handed to it must be
      // monotonic. No producer here reports a negative correction; if one ever
      // does, it needs its own path rather than silently shrinking the total.
      inputTokens: prev.in + Math.max(0, delta.inputTokens),
      outputTokens: prev.out + Math.max(0, delta.outputTokens),
      estimatedCostUsd: cost.seen ? cost.total : null,
    } as unknown as UsageSnapshot);
  }

  updateUsage(sessionId: string, snapshot: UsageSnapshot): void {
    if (!this.store.enabled) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    const curIn = snapshot.inputTokens ?? 0;
    const curOut = snapshot.outputTokens ?? 0;
    const prev = this.sessionToUsage.get(sessionId) ?? { in: 0, out: 0, cost: null };
    const hadPreviousUsage = prev.in > 0 || prev.out > 0;
    const dIn = Math.max(0, curIn - prev.in);
    const dOut = Math.max(0, curOut - prev.out);
    const run = this.store.getRun(runId);
    const turnId = this.turnIdFor(sessionId);
    const turn = turnId ? this.store.getTurn(turnId) : null;
    const model = (turn?.model_id as string | null | undefined) ?? run?.modelId ?? null;
    const reportedTotal = snapshot.estimatedCostUsd ?? snapshot.costSpent ?? null;
    const reportedDelta = reportedTotal == null
      ? null
      : Math.max(0, reportedTotal - (prev.cost ?? 0));
    const priced = isPricedModel(model);
    const eventCostKnown = priced || (reportedDelta != null && reportedDelta > 0);
    const eventCost = reportedDelta ?? priceUsd(model, dIn, dOut);
    const hasUsageDelta = dIn > 0 || dOut > 0;
    const hasAccountingDelta = hasUsageDelta || (reportedDelta ?? 0) > 0;
    const runCostKnown = !hasAccountingDelta
      ? Boolean(run?.costKnown)
      : hadPreviousUsage
        ? Boolean(run?.costKnown) && eventCostKnown
        : eventCostKnown;
    const runCost = reportedTotal ?? (priced ? priceUsd(model, curIn, curOut) : null);
    this.sessionToUsage.set(sessionId, { in: curIn, out: curOut, cost: reportedTotal });
    try {
      this.store.updateRun(runId, {
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        costUsd: runCost,
        costKnown: runCostKnown,
      });
    } catch { /* ignore */ }

    // ── Per-task ModelEvent from the cumulative delta ──
    if (dIn === 0 && dOut === 0) return;
    const task = this.sessionToTask.get(sessionId);
    if (!task) return;
    const provider = (turn?.provider as string | null | undefined)
      ?? run?.provider
      ?? normalizeModelProvider(undefined, model);
    const taskRow = this.store.getTask(task.id);
    if (!taskRow) return;
    const taskModel = !model
      ? taskRow.modelId
      : !taskRow.modelId || taskRow.modelId === model
        ? model
        : 'mixed';
    const taskProvider = !provider || provider === 'unknown'
      ? taskRow.provider
      : !taskRow.provider || taskRow.provider === provider
        ? provider
        : 'mixed';
    const turnIndex = this.sessionToTurn.get(sessionId)?.index ?? task.lastTurnIndex ?? 0;
    this.appendSampleEvent(
      { taskId: task.id, runId, turnIndex, turnId },
      {
        kind: 'model', model: model ?? undefined, inputTokens: dIn, outputTokens: dOut,
        costUsd: eventCost, costKnown: eventCostKnown,
        latencyMs: 0, dedupCore: `${curIn}:${curOut}`,
      },
    );
    try {
      this.store.updateTask(task.id, {
        modelId: taskModel,
        provider: taskProvider,
        modelConfig: this.mergedTaskModelConfig(
          taskRow, taskModel ?? 'unknown', taskProvider ?? null,
        ),
      });
      this.store.recomputeSampleCost(task.id);
    } catch { /* ignore */ }
  }

  /** Split the current run — closes the active run and opens a fresh one.
   *  Triggered on `/clear` or other context-reset events so each logical
   *  conversation gets its own evaluation unit. */
  splitRun(sessionId: string, projectPath?: string): string | null {
    if (!this.store.enabled) return null;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return null;
    const run = this.store.getRun(runId);
    if (!run) return null;
    // The active task (if any) belongs to the run being closed; mark it as
    // boundary=clear before closeRun tears everything down.
    this.closeTask(sessionId, 'clear');
    // Close current run (no exitCode — session is still alive)
    this.closeRun(sessionId, undefined, projectPath, 'clear');
    // Open a new run with the same session parameters, pointing back at the run
    // it continues. `/clear` resets the agent's context, not the user's work —
    // without this edge one conversation becomes N disconnected runs (a live
    // session here had 127), and nothing downstream can tell a genuine new
    // session from the same session after a context reset.
    const nextRunId = this.openRun({
      sessionId,
      agentType: run.agentType,
      modelId: run.modelId ?? undefined,
      projectName: run.projectName ?? undefined,
      projectPath: run.projectPath ?? undefined,
    });
    if (nextRunId) {
      try { this.store.updateRun(nextRunId, { parentRunId: runId }); } catch { /* ignore */ }
    }
    return nextRunId;
  }

  /** Update model id when the bridge resolves which model is in use. */
  updateModel(sessionId: string, modelId: string | undefined | null): void {
    if (!this.store.enabled || !modelId) return;
    if (!this.sessionToRun.has(sessionId)) return;
    // The TURN is the scorecard's identity source (`turns.model_id`), and
    // this used to write the run only — so every hook-observed Claude and
    // Codex turn carried NULL there (465 + 183 in one week, 2026-09-03) and
    // the per-model scorecard ranked nothing. The run keeps its
    // latest-observed value for legacy readers.
    this.updateTurnIdentity(sessionId, modelId);
  }

  /** Persist the model/provider on the assistant message's own turn.
   * `session_meta` can arrive after `chat.final` closed that turn, so the same
   * current→last fallback used by setTurnResponse is required here too. */
  private updateTurnIdentity(
    sessionId: string,
    reportedModel?: string,
    reportedProvider?: string,
  ): void {
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    const turnId = this.turnIdFor(sessionId);
    const turn = turnId ? this.store.getTurn(turnId) : null;
    const run = this.store.getRun(runId);
    const model = reportedModel ?? (turn?.model_id as string | undefined) ?? run?.modelId ?? undefined;
    if (!model && !reportedProvider) return;
    const normalized = normalizeModelProvider(reportedProvider, model);
    const provider = normalized === 'unknown' ? null : normalized;

    if (turnId) {
      try {
        this.store.updateTurn(turnId, {
          ...(model ? { modelId: model } : {}),
          provider,
        });
      } catch { /* ignore */ }
    }

    // Preserve the established run-level "latest observed model" contract for
    // legacy consumers. Scorecards no longer depend on it when a turn has its
    // own identity, so updating this compatibility fallback cannot reassign
    // earlier turns.
    if (run) {
      const patch: Partial<ApmeRunRow> = {
        ...(model ? { modelId: model } : {}),
        provider,
      };
      if (Object.keys(patch).length > 0) {
        try { this.store.updateRun(runId, patch); } catch { /* ignore */ }
      }
    }

    const taskId = (turn?.task_id as string | undefined) ?? this.sessionToTask.get(sessionId)?.id;
    if (!taskId || !model) return;
    const task = this.store.getTask(taskId);
    if (!task) return;
    const taskModel = !task.modelId || task.modelId === model ? model : 'mixed';
    const taskProvider = !provider
      ? task.provider
      : task.provider == null || task.provider === provider
        ? provider
        : 'mixed';
    try {
      this.store.updateTask(taskId, {
        modelId: taskModel,
        provider: taskProvider,
        modelConfig: this.mergedTaskModelConfig(task, taskModel, taskProvider),
      });
    } catch { /* ignore */ }
  }

  /** Finalize a run. Returns the runId so callers can enqueue evaluation.
   *  Empty runs (no prompts, no steps, no turns) are deleted — they're just
   *  connection noise and clutter the dashboard. */
  closeRun(
    sessionId: string,
    exitCode?: number,
    projectPath?: string,
    turnEndSource: TurnEndSource = 'session_end',
  ): string | null {
    if (!this.store.enabled) return null;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return null;
    // Close the last open turn + task before finalizing the run.
    this.closeTurn(sessionId, turnEndSource);
    // splitRun already called closeTask('clear') before us, so this is usually
    // a no-op in the split path. Direct closeRun (session exit) still needs it.
    this.closeTask(sessionId, 'session_end');
    this.sessionToRun.delete(sessionId);
    this.sessionToLastTurnId.delete(sessionId);
    this.runTaskCount.delete(runId);
    this.sessionToUsage.delete(sessionId);
    this.sessionToCostTotal.delete(sessionId);

    // Mark empty runs so the dashboard can filter them out.
    // Don't delete — FK constraints and concurrent access make deletion risky.
    const run = this.store.getRun(runId);
    const steps = this.store.listSteps(runId);
    const meaningfulSteps = steps.filter(s =>
      s.kind !== 'SessionEnd' && s.kind !== 'session_end' && s.kind !== 'session_start' && s.kind !== 'SessionStart'
    );
    const isEmpty = !run?.taskPrompt && meaningfulSteps.length === 0;
    const gitAfter = readGitHead(projectPath);
    try {
      this.store.updateRun(runId, {
        endedAt: Date.now(),
        exitCode: exitCode ?? null,
        gitAfter,
        // Tag empty runs so dashboard can filter them
        ...(isEmpty ? { taskCategory: '_empty' } : {}),
      });
      if (isEmpty) {
        debug('APME', `closeRun ${runId} — empty (no prompt, no steps)`);
        return runId;
      }
      debug('APME', `closeRun ${runId} exit=${exitCode ?? '-'} gitAfter=${gitAfter ?? '-'}`);
    } catch (err) {
      debug('APME', `closeRun failed: ${String(err)}`);
    }
    // Capture hardware profile asynchronously — don't block shutdown.
    if (this.hwSampler) {
      this.hwSampler.snapshot().then((snap) => {
        try { this.store.updateRun(runId, { hwProfile: JSON.stringify(snap) }); }
        catch { /* ignore */ }
      }).catch(() => { /* ignore */ });
    }
    // Classify the run — rule-based first, LLM fallback if unknown.
    // Fire-and-forget since classifyRunSmart is async (LLM call).
    void classifyRunSmart(this.store, runId).then(({ signals, category, source }) => {
      this.store.updateRun(runId, {
        taskSignals: JSON.stringify(signals),
        taskCategory: category,
        taskCategorySource: source,
      });
      debug('APME', `classified ${runId} as ${category} (${source})`);
    }).catch((err) => {
      debug('APME', `classify failed: ${String(err)}`);
    });
    // Save git diff as artifact (best-effort, capped at 1MB).
    this.saveDiffArtifact(runId, projectPath);
    return runId;
  }

  /** Save the git diff produced by this run as an artifact file. */
  private saveDiffArtifact(runId: string, projectPath?: string): void {
    if (!projectPath) return;
    try {
      const run = this.store.getRun(runId);
      if (!run) return;
      // --no-ext-diff / --no-textconv: same rule as runner.ts collectDiff —
      // user diff drivers (e.g. a Java xlsx comparator with multi-second JVM
      // startup) must never run inside this synchronous daemon-side spawn.
      const args = run.gitBefore && run.gitAfter && run.gitBefore !== run.gitAfter
        ? `diff --no-ext-diff --no-textconv ${run.gitBefore}..${run.gitAfter}`
        : 'diff --no-ext-diff --no-textconv HEAD';
      const diff = execSync(`git ${args}`, {
        cwd: projectPath, encoding: 'utf-8', timeout: 5000,
        maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      });
      if (!diff || diff.length < 10) return;
      const hash = createHash('sha256').update(diff).digest('hex').slice(0, 16);
      const artifactDir = getArtifactDir(runId);
      mkdirSync(artifactDir, { recursive: true });
      const filePath = join(artifactDir, `${hash}.diff`);
      writeFileSync(filePath, diff, 'utf-8');
      this.store.insertArtifact({
        runId, kind: 'diff', path: filePath,
        sha256: createHash('sha256').update(diff).digest('hex'),
        bytes: Buffer.byteLength(diff, 'utf-8'),
      });
    } catch { /* ignore — artifact storage is best-effort */ }
  }

  /** Translate a `SessionEntry` + optional extras into an OpenRunInput. */
  static fromSessionEntry(entry: SessionEntry, extras: { modelId?: string; projectPath?: string } = {}): OpenRunInput {
    return {
      sessionId: entry.id,
      agentType: (entry.agentType ?? 'claude-code') as AgentType,
      modelId: extras.modelId,
      projectName: entry.projectName,
      projectPath: extras.projectPath,
    };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────────

interface TodoItem { status: string; content?: string; activeForm?: string }

/** Extract the todos array from a TodoWrite PostToolUse payload. Returns null
 *  if the shape doesn't match (payload malformed, older CC versions). Accepts
 *  `tool_input.todos` (hook standard) and `todos` (legacy flat shape). */
/** Canonicalize a hook event name to the PascalCase form `ingestHook` matches
 *  on. Accepts the daemon's snake_case (`user_prompt_submit`, `tool_start`,
 *  `tool_end`, `pre/post_tool_use`) and passes PascalCase / span aliases
 *  (`tool_result`) through unchanged. Keeps segmentation working regardless of
 *  which surface (managed bridge, daemon `/hooks/`, OTel span) drives it. */
function normalizeHookEventName(event: string): string {
  switch (event) {
    case 'user_prompt_submit': return 'UserPromptSubmit';
    case 'tool_start':
    case 'pre_tool_use': return 'PreToolUse';
    case 'tool_end':
    case 'post_tool_use': return 'PostToolUse';
    default: return event;
  }
}

function extractTodos(data: Record<string, unknown>): TodoItem[] | null {
  const fromToolInput = (data.tool_input as Record<string, unknown> | undefined)?.todos;
  const fromFlat = (data as Record<string, unknown>).todos;
  const raw = fromToolInput ?? fromFlat;
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const status = typeof e.status === 'string' ? e.status : '';
    if (!status) continue;
    items.push({
      status,
      content: typeof e.content === 'string' ? e.content : undefined,
      activeForm: typeof e.activeForm === 'string' ? e.activeForm : undefined,
    });
  }
  return items;
}

/** Short stable hash for sample-event dedup keys (content-derived). */
function hashCore(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** Best-effort tool-input extraction from a hook/span payload. Claude Code
 *  hooks carry `tool_input`; spans pass the raw payload directly. Capped to
 *  keep the trajectory row small. */
function extractToolInput(data: Record<string, unknown>): unknown {
  const ti = (data.tool_input as unknown) ?? (data.input as unknown) ?? null;
  return clampPayload(ti);
}

/** Best-effort tool-output extraction. Claude Code PostToolUse carries
 *  `tool_response`; other sources use `output` / `result`. */
function extractToolOutput(data: Record<string, unknown>): unknown {
  const out = (data.tool_response as unknown) ?? (data.output as unknown) ?? (data.result as unknown);
  return out === undefined ? undefined : clampPayload(out);
}

/** Trim large tool payloads so a single event row stays bounded (≤4KB JSON). */
function clampPayload(v: unknown): unknown {
  if (v == null) return v;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length <= 4_000) return v;
    return (typeof v === 'string' ? v : s).slice(0, 4_000) + '…';
  } catch {
    return undefined;
  }
}

function readGitHead(cwd?: string): string | null {
  if (!cwd) return null;
  try {
    return execSync('git rev-parse HEAD', {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function getArtifactDir(runId: string): string {
  const dataDir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
  return join(dataDir, 'apme', 'artifacts', runId);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"<unserializable>"';
  }
}

/** Merge `patch` into an existing turns.efficiency_json string without losing
 *  sibling keys. Returns a JSON string suitable for the column. Unparseable
 *  existing values are replaced outright. */
function mergeEfficiencyJson(
  turn: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): string {
  const base = parseEfficiencyJson(turn);
  return JSON.stringify({ ...base, ...patch });
}

function parseEfficiencyJson(turn: Record<string, unknown> | null): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  const raw = turn?.efficiency_json;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch { /* replace */ }
  }
  return base;
}

/** Full/final responses outrank lossy session-message projections. Unknown
 *  historical provenance is treated as direct so a new projection cannot
 *  downgrade data written before source tracking existed. */
function responseSourcePriority(source: unknown): number {
  if (source === 'session_message_projection') return 1;
  if (source === 'chat_final') return 3;
  return source ? 2 : 0;
}
