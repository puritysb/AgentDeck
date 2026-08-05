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
import type { ApmeRunRow } from './types.js';
import type { AgentType, TelemetrySpan, ApmeSampleEventRow, TrajectoryEventKind } from '@agentdeck/shared';
import { priceUsd, providerFor } from '@agentdeck/shared';
import type { ApmeHwSampler } from './hw-sampler.js';
import { classifyRunSmart, computeSignals, classify } from './classifier.js';

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

interface ActiveTask {
  id: string;
  runId: string;
  index: number;
  startedAt: number;
  /** turn_index of the first turn attached to this task (null until first turn). */
  firstTurnIndex: number | null;
  /** turn_index of the last turn attached; updated on every insertTurn. */
  lastTurnIndex: number | null;
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

export class ApmeCollector {
  private readonly sessionToRun = new Map<string, string>(); // sessionId → runId
  private readonly sessionToAgentType = new Map<string, AgentType>(); // sessionId → agentType (survives closeRun for late-attributed timeline rows)
  private readonly sessionToTurn = new Map<string, ActiveTurn>(); // sessionId → current turn
  private readonly sessionToLastTurnId = new Map<string, string>(); // survives closeTurn()
  private readonly sessionToTask = new Map<string, ActiveTask>(); // sessionId → current task
  private readonly runTaskCount = new Map<string, number>();      // runId → next task_index
  private readonly sessionToUsage = new Map<string, { in: number; out: number }>(); // last cumulative usage

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

  constructor(
    private readonly store: ApmeStore,
    private readonly hwSampler?: ApmeHwSampler,
  ) {}

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
        openTurn && prompt !== null && openTurn.prompt === prompt &&
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
      this.closeTurn(sessionId);
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
      // Ensure an active task exists so this turn can attach to it. Tasks group
      // consecutive turns between boundary signals (TodoWrite all-completed,
      // /clear, session_end). First turn in a run opens task 0.
      const task = this.openTaskIfNone(sessionId, runId);
      if (task) {
        const wasFirstTurn = task.firstTurnIndex === null;
        if (wasFirstTurn) task.firstTurnIndex = turnIndex;
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
  closeTurnForSession(sessionId: string): void {
    this.closeTurn(sessionId);
  }

  /** Close the current turn for a session (called on new prompt or session end). */
  private closeTurn(sessionId: string): void {
    const turn = this.sessionToTurn.get(sessionId);
    if (!turn) return;
    this.sessionToLastTurnId.set(sessionId, turn.id);
    this.sessionToTurn.delete(sessionId);
    const run = this.store.getRun(turn.runId);
    const projectPath = run?.projectPath ?? undefined;
    const gitAfter = readGitHead(projectPath);
    try {
      this.store.updateTurn(turn.id, {
        endedAt: Date.now(),
        toolCalls: turn.toolCalls,
        filesModified: turn.filesModified,
        filesCreated: turn.filesCreated,
        gitAfter,
      });
      debug('APME', `closeTurn ${turn.id.slice(0, 8)} index=${turn.index} tools=${turn.toolCalls}`);
    } catch (err) {
      debug('APME', `closeTurn failed: ${String(err)}`);
    }
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
      });
    } catch (err) {
      debug('APME', `onTaskOpened listener threw: ${String(err)}`);
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
    for (const id of this.sessionToRun.values()) if (id === runId) return true;
    return false;
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

  /** Reverse-lookup sessionId for a runId (best-effort; only the live map). */
  private runToSessionId(runId: string): string {
    for (const [sid, rid] of this.sessionToRun) if (rid === runId) return sid;
    return '';
  }

  /** Store Claude's response text on the current turn.
   *  Falls back to the last closed turn if closeTurn() already ran (race with session exit).
   *  Tags turns.efficiency_json.response_kind so the runner can skip tool-only / empty
   *  turns — judging silence produces noise scores. */
  setTurnResponse(sessionId: string, response: string): void {
    if (!this.store.enabled) return;
    const turn = this.sessionToTurn.get(sessionId);
    const turnId = turn?.id ?? this.sessionToLastTurnId.get(sessionId);
    debug('APME', `setTurnResponse session=${sessionId.slice(0,8)} turnId=${turnId?.slice(0,8) ?? 'null'} respLen=${response.length}`);
    if (!turnId) return;
    const trimmedLen = response.trim().length;
    // Active-turn toolCalls is authoritative; after closeTurn() the counter is
    // already flushed to the DB row, so we fetch from there instead.
    const toolCalls = turn?.toolCalls
      ?? ((this.store.getTurn(turnId)?.tool_calls as number | undefined) ?? 0);
    const kind: 'text' | 'tool_only' | 'empty' = trimmedLen >= 1
      ? 'text'
      : (toolCalls > 0 ? 'tool_only' : 'empty');
    const efficiencyJson = mergeEfficiencyJson(this.store.getTurn(turnId), { response_kind: kind });
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
      this.appendSampleEvent(ctx, {
        kind: 'assistant_message',
        dedupCore: hashCore(response.slice(0, 400)),
        payloadObj: { text: response.slice(0, 10_000), responseKind: kind },
      });
    }
  }

  /** Apply response to the last closed turn if it has no response yet.
   *  Used as fallback when Stop hook doesn't fire (PTY output capture). */
  setLastClosedTurnResponse(sessionId: string, response: string): void {
    if (!this.store.enabled) return;
    const turnId = this.sessionToLastTurnId.get(sessionId);
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
        const fallback = a['agentdeck.fallback_to_last_closed'] === true;
        if (fallback) this.setLastClosedTurnResponse(sessionId, text);
        else this.setTurnResponse(sessionId, text);
        return;
      }
      case 'turn_end':
        // No-op: turns auto-close on the next `turn_start` or session end.
        return;
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
        if (model) this.updateModel(sessionId, model);
        const inputTokens = a['agentdeck.usage.input_tokens'] as number | undefined;
        const outputTokens = a['agentdeck.usage.output_tokens'] as number | undefined;
        const costUsd = a['agentdeck.usage.cost_usd'] as number | undefined;
        if (inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined) {
          // Synthesize a UsageSnapshot-compatible shape. Missing fields stay null.
          this.updateUsage(sessionId, {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            estimatedCostUsd: costUsd ?? null,
          } as unknown as UsageSnapshot);
        }
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
  updateUsage(sessionId: string, snapshot: UsageSnapshot): void {
    if (!this.store.enabled) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    try {
      this.store.updateRun(runId, {
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        costUsd: snapshot.estimatedCostUsd ?? snapshot.costSpent ?? null,
      });
    } catch { /* ignore */ }

    // ── Per-task ModelEvent from the cumulative delta ──
    const curIn = snapshot.inputTokens ?? 0;
    const curOut = snapshot.outputTokens ?? 0;
    const prev = this.sessionToUsage.get(sessionId) ?? { in: 0, out: 0 };
    const dIn = Math.max(0, curIn - prev.in);
    const dOut = Math.max(0, curOut - prev.out);
    this.sessionToUsage.set(sessionId, { in: curIn, out: curOut });
    if (dIn === 0 && dOut === 0) return;

    const task = this.sessionToTask.get(sessionId);
    if (!task) return;
    const run = this.store.getRun(runId);
    const model = run?.modelId ?? null;
    const turnIndex = this.sessionToTurn.get(sessionId)?.index ?? task.lastTurnIndex ?? 0;
    // Prefer the agent-reported marginal cost when available, else price the delta.
    const cost = priceUsd(model, dIn, dOut);
    this.appendSampleEvent(
      { taskId: task.id, runId, turnIndex, turnId: this.turnIdFor(sessionId) },
      {
        kind: 'model', model: model ?? undefined, inputTokens: dIn, outputTokens: dOut,
        costUsd: cost, latencyMs: 0, dedupCore: `${curIn}:${curOut}`,
      },
    );
    try {
      this.store.updateTask(task.id, {
        modelId: model ?? undefined,
        modelConfig: JSON.stringify({ modelId: model ?? 'unknown', provider: providerFor(model) }),
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
    this.closeRun(sessionId, undefined, projectPath);
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
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    try { this.store.updateRun(runId, { modelId }); } catch { /* ignore */ }
  }

  /** Finalize a run. Returns the runId so callers can enqueue evaluation.
   *  Empty runs (no prompts, no steps, no turns) are deleted — they're just
   *  connection noise and clutter the dashboard. */
  closeRun(sessionId: string, exitCode?: number, projectPath?: string): string | null {
    if (!this.store.enabled) return null;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return null;
    // Close the last open turn + task before finalizing the run.
    this.closeTurn(sessionId);
    // splitRun already called closeTask('clear') before us, so this is usually
    // a no-op in the split path. Direct closeRun (session exit) still needs it.
    this.closeTask(sessionId, 'session_end');
    this.sessionToRun.delete(sessionId);
    this.sessionToLastTurnId.delete(sessionId);
    this.runTaskCount.delete(runId);
    this.sessionToUsage.delete(sessionId);

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
  return JSON.stringify({ ...base, ...patch });
}
