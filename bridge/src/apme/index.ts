/**
 * APME module — public surface for the bridge/daemon.
 *
 * Usage:
 *   const apme = await initApme();  // may return null if disabled
 *   apme?.collector.openRun({...});
 *   apme?.collector.ingestHook(sessionId, 'PreToolUse', data);
 *   apme?.collector.closeRun(sessionId, exitCode);
 *
 * The module is intentionally boot-safe: if better-sqlite3 can't load, all
 * methods still exist but are no-ops, and `initApme()` returns null.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logError } from '../logger.js';
import { ApmeStore } from './store.js';
import { apmeDashboardHtml } from './dashboard-html.js';
import { ApmeCollector } from './collector.js';
import { ApmeRunner } from './runner.js';
import { ApmeHwSampler } from './hw-sampler.js';
import { ApmeRecommender } from './recommend.js';
import { sampleEventToTimeline } from './sample-to-timeline.js';
import { formatDurationSec } from '@agentdeck/shared';
import type { TimelineEntry } from '@agentdeck/shared';

/** Task boundary rows read "<signal> · <N> turns · <duration>" — the turn
 *  count says what the boundary covered, the human duration replaces the
 *  raw "3672s" second counts. */
function taskEndRowText(signalLabel: string, turns: number | undefined, durationSec: number): string {
  const parts = [signalLabel];
  if (turns && turns > 0) parts.push(turns === 1 ? '1 turn' : `${turns} turns`);
  parts.push(formatDurationSec(durationSec));
  return parts.join(' · ');
}

export interface ApmeModule {
  store: ApmeStore;
  collector: ApmeCollector;
  runner: ApmeRunner;
  hwSampler: ApmeHwSampler;
  recommender: ApmeRecommender;
}

export interface InitApmeOptions {
  /** Where to forward task hierarchy entries so they show up in the dashboard
   *  timeline. Optional — when absent, task tracking still works for eval but
   *  the dashboard sees only turn-level rows. */
  emitTimeline?: (entry: TimelineEntry) => void;
  /** When true, the timeline becomes a *projection* of the canonical
   *  SessionSample: each typed trajectory event is projected to a single
   *  TimelineEntry via `sampleEventToTimeline`. Off by default during the
   *  incremental cutover — adapters still emit chat/tool rows directly until
   *  every surface (incl. the Swift daemon) is migrated, to avoid double rows.
   *  When enabled, the caller should also suppress locally-emitted chat/tool
   *  rows (`BridgeTimelineStore.setSuppressLocalChatTool`). */
  projectSampleTimeline?: boolean;
  /** Emit a projected (chat/tool) timeline entry, bypassing the suppression
   *  filter. Defaults to `emitTimeline` when not provided. */
  emitProjectedTimeline?: (entry: TimelineEntry) => void;
}

let singleton: ApmeModule | null = null;
let lastInitFailure: string | null = null;

/** Last boot failure retained for `/health` and CLI diagnostics. The ApmeStore
 * instance that owns the detailed native-load error otherwise becomes
 * unreachable when initApme returns null. */
export function getApmeInitFailure(): string | null {
  return lastInitFailure;
}

/** Initialize the APME subsystem. Returns null if the SQLite store can't open.
 *  When null, the failure reason is logged at ERROR level — silent disable was
 *  the dominant cause of multi-day data outages observed in user telemetry. */
export async function initApme(
  dbPath?: string,
  opts: InitApmeOptions = {},
): Promise<ApmeModule | null> {
  if (singleton) return singleton;
  const store = new ApmeStore(dbPath);
  const ok = await store.init();
  if (!ok) {
    const runtime = `${process.version} ABI ${process.versions.modules} at ${process.execPath}`;
    lastInitFailure =
      `${store.lastInitError ?? 'unknown init failure'}; runtime ${runtime}. ` +
      'Run `agentdeck diag native`, then re-run `npx @agentdeck/setup --yes` with Node 22, 24, or 26.';
    logError(`APME disabled — ${lastInitFailure} Agent runs will not be measured.`);
    return null;
  }
  lastInitFailure = null;
  const hwSampler = new ApmeHwSampler();
  const collector = new ApmeCollector(store, hwSampler);
  const runner = new ApmeRunner(store);
  const recommender = new ApmeRecommender(store);
  singleton = { store, collector, runner, hwSampler, recommender };

  const emitTimeline = opts.emitTimeline;

  // An OpenClaw run's projectName is its Gateway session key
  // (`agent:main:main`) so the store can tell a model-eval run from a chat —
  // but on the timeline every OpenClaw row is labelled "OpenClaw" (the key
  // rides in `detail`; see openclaw-timeline-feed.ts). Task headers used the
  // raw key, so one conversation showed under two project labels.
  const timelineProjectName = (agentType: string | null | undefined, projectName: string | null | undefined): string | undefined =>
    agentType === 'openclaw' ? 'OpenClaw' : (projectName ?? undefined);

  // Task headers are DEFERRED (collector emits `task_start` only once a task
  // proves itself multi-turn). Track which task ids actually reached the
  // timeline so the async judge re-emit (`onTaskEvaluated`, below) can skip
  // unpromoted single-turn tasks — otherwise it would insert an orphan
  // `task_end` with a score badge under no header. `onTaskOpened` fires at the
  // deferred promotion moment, so membership here == "header is on the timeline".
  const promotedTaskIds = new Set<string>();

  // Wire task-level judge: whenever the collector closes a task (TodoWrite
  // all-completed / /clear / session_end), enqueue a task_rollup judge call.
  // Kept here — not in the collector constructor — so the collector has no
  // hard dependency on the runner.
  collector.onTaskClosed = ({
    taskId, runId, sessionId, agentType, projectName,
    startedAt, endedAt, boundarySignal, taskCategory, turns, timelineEmitted,
  }) => {
    runner.enqueueTask({
      runId,
      taskId,
      category: taskCategory ?? undefined,
      boundarySignal,
    });

    // Gate the `task_end` row on the header having been emitted — an
    // unpromoted single-turn task shows only its chat rows, never a bare
    // "Task end" marker. The eval enqueue above runs regardless.
    if (emitTimeline && timelineEmitted) {
      const durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
      const signalLabel = boundarySignal === 'todo_complete' ? 'TODO done'
        : boundarySignal === 'clear' ? '/clear'
        : boundarySignal === 'session_end' ? 'Session end'
        : 'Task end';
      emitTimeline({
        ts: endedAt,
        type: 'task_end',
        raw: taskEndRowText(signalLabel, turns, durationSec),
        agentType: agentType ?? undefined,
        projectName: timelineProjectName(agentType, projectName),
        sessionId,
        runId,
        taskId,
        boundarySignal,
        startedAt,
        endedAt,
      });
    }
  };

  // Wire the SessionSample → Timeline projection. When enabled, the timeline
  // is a projection of the canonical sample (one row per typed trajectory
  // event), replacing display-time grouping + the race-sensitive dedup window.
  if (emitTimeline && opts.projectSampleTimeline) {
    const emitProjected = opts.emitProjectedTimeline ?? emitTimeline;
    collector.onSampleEvent = ({ event, sessionId, runId, taskId, agentType, projectName }) => {
      const entry = sampleEventToTimeline(event, { sessionId, runId, taskId, agentType, projectName });
      if (entry) emitProjected(entry);
    };
  }

  // Wire task-start emission. The runner has no opinion on opens — only the
  // dashboard does — so we keep this strictly local to the timeline path.
  if (emitTimeline) {
    collector.onTaskOpened = ({
      taskId, runId, sessionId, agentType, projectName, taskIndex, startedAt, title,
    }) => {
      promotedTaskIds.add(taskId);
      emitTimeline({
        ts: startedAt,
        type: 'task_start',
        // Intent-derived title (first user prompt, `deriveTaskTitle` SSOT).
        // The `Task N` fallback is deliberately the display SSOT's
        // "non-meaningful" shape, so an unnamed header keeps today's
        // judge-summary-as-title behavior downstream.
        raw: title ?? `Task ${taskIndex + 1}`,
        agentType: agentType ?? undefined,
        projectName: timelineProjectName(agentType, projectName),
        sessionId,
        runId,
        taskId,
        startedAt,
      });
    };
  }

  // Wire the mid-task completion milestone. TodoWrite-all-completed is a
  // non-segmenting soft hint (fires ~18% of the time on Claude Code v2.1), so
  // it must not split the task — but when it DOES fire it is a strong "the
  // agent declared this chunk done" signal, and long sessions otherwise show
  // no completion marks until /clear or session_end.
  if (emitTimeline) {
    collector.onTaskMilestone = ({
      taskId, runId, sessionId, agentType, projectName, todoCount, at,
    }) => {
      emitTimeline({
        ts: at,
        type: 'task_milestone',
        raw: todoCount ? `Todos done (${todoCount})` : 'Todos done',
        agentType: agentType ?? undefined,
        projectName: timelineProjectName(agentType, projectName),
        sessionId,
        runId,
        taskId,
      });
    };
  }

  // Wire task-eval completion → re-emit `task_end` with score + outcome.
  // The original `task_end` (above) fires synchronously on closeTask so the
  // boundary is visible immediately; the judge runs async and may take
  // 5-30 s. When it resolves, this listener emits a second `task_end` with
  // the same `taskId`. Timeline stores upsert by (type='task_end', taskId)
  // and merge the new score fields onto the existing row, so dashboard task
  // headers get the score badge as soon as the judge returns.
  if (emitTimeline) {
    runner.onTaskEvaluated((e) => {
      // Skip the score re-emit for tasks whose header never reached the
      // timeline (single-turn Q&A). Without this the merge-or-insert
      // timeline store would insert a fresh orphan `task_end` here. Consume
      // the id so the set doesn't grow unbounded across a long-lived daemon.
      if (!promotedTaskIds.delete(e.taskId)) return;
      const durationSec = Math.max(0, Math.round((e.endedAt - e.startedAt) / 1000));
      const signalLabel = e.boundarySignal === 'todo_complete' ? 'TODO done'
        : e.boundarySignal === 'clear' ? '/clear'
        : e.boundarySignal === 'session_end' ? 'Session end'
        : e.boundarySignal === 'manual' ? 'Manual'
        : e.boundarySignal === 'idle_gap' ? 'Idle gap'
        : 'Task end';
      emitTimeline({
        ts: e.endedAt,
        type: 'task_end',
        raw: taskEndRowText(signalLabel, e.turns, durationSec),
        agentType: e.agentType,
        projectName: timelineProjectName(e.agentType, e.projectName),
        sessionId: e.sessionId,
        runId: e.runId,
        taskId: e.taskId,
        boundarySignal: e.boundarySignal,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        taskScore: e.compositeScore ?? undefined,
        taskOutcome: e.outcome,
        taskCategory: e.taskCategory,
        taskSummary: e.summary,
      });
    });
  }

  // Write dashboard HTML for Swift daemon to pick up.
  try {
    const dataDir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
    writeFileSync(join(dataDir, 'apme-dashboard.html'), apmeDashboardHtml(), 'utf-8');
  } catch { /* best-effort */ }

  // Auto-enqueue eval on run close: collectors call `closeRun()` and we
  // forward the returned runId here when wired into the bridge.

  return singleton;
}

export function getApme(): ApmeModule | null {
  return singleton;
}

/** Phase 6 cutover switch (default OFF). Set `AGENTDECK_TIMELINE_PROJECTION=1`
 *  to make the timeline a projection of the canonical SessionSample. Read at
 *  daemon/session-bridge startup so it can be flipped without a recompile. */
export function isTimelineProjectionEnabled(): boolean {
  return process.env.AGENTDECK_TIMELINE_PROJECTION === '1';
}

export { loadApmeConfig, shouldJudge, DEFAULT_APME_CONFIG } from './settings.js';
export type { ApmeConfig, ApmeJudgeConfig, ApmeJudgeBackend } from './settings.js';
export { ApmeStore } from './store.js';
export { ApmeCollector } from './collector.js';
export { ApmeRunner } from './runner.js';
export { ApmeHwSampler } from './hw-sampler.js';
export { ApmeRecommender } from './recommend.js';
export { classifyRun, classifyRunSmart, classifyWithLlm, classify, computeSignals, TASK_CATEGORIES } from './classifier.js';
export { evaluateOutcome, detectOutcome, computeEfficiency, computeComposite } from './outcome.js';
export type { Outcome, OutcomeResult, EfficiencyMetrics, CompositeBreakdown } from './outcome.js';
export type { TaskSignals, TaskCategory } from './classifier.js';
export type * from './types.js';
