/**
 * APME Evaluation Runner — two-layer pipeline executed after a run closes.
 *
 * Layer 1 (deterministic): detect project language from the run's projectPath,
 * run lint/build/test in-place with a hard timeout, normalize each outcome to
 * 0/1 in `evals` (metrics: lint_clean, build_ok, tests_pass).
 *
 * Layer 2 (llm_judge): G-Eval style rubric against the latest `rubrics` row.
 * Backend is pluggable — default is local MLX (cost-free), API/OpenClaw are
 * opt-in via `~/.agentdeck/settings.json`. Gated by `shouldJudge()` so the
 * common "clear pass" case skips layer 2 entirely.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { debug } from '../logger.js';
import type { ApmeStore } from './store.js';
import type { ApmeConfig, ApmeJudgeConfig, ApmeJudgeBackend } from './settings.js';
import { loadApmeConfig, shouldJudge, DEFAULT_APME_CONFIG } from './settings.js';
import { loadMlxSettings, mlxChatUrl } from '@agentdeck/shared';
import type { SessionSample, TrajectoryEvent } from '@agentdeck/shared';
import { runSampleScorers } from './scorers/index.js';
import type { ApmeRunRow, ParsedJudge } from './types.js';
import { execSync } from 'child_process';

export interface EvalJob {
  runId: string;
  /** Optional project path override; falls back to the run row. */
  projectPath?: string;
}

export interface EvalJobResult {
  runId: string;
  turnId?: string;   // set for turn-level evals
  taskId?: string;   // set for task-level evals
  layer1Ran: boolean;
  layer2Ran: boolean;
  overall?: number;
}

/**
 * Emitted after `runTaskEval` writes the task_judge axis scores + summary +
 * compositeScore. Carries enough context for the timeline layer to upsert the
 * existing `task_end` row with the verdict (score + outcome class + category +
 * summary) so dashboard task headers can render the score badge.
 */
export interface TaskEvaluatedEvent {
  runId: string;
  taskId: string;
  sessionId: string;
  agentType?: string;
  projectName?: string;
  startedAt: number;
  endedAt: number;
  compositeScore: number | null;
  /** Coarse outcome class. Normally derived from `compositeScore`:
   *  - `'success'`  (≥0.75)
   *  - `'partial'`  (≥0.50)
   *  - `'fail'`     (<0.50)
   *  - `'pending'`  (judge produced no score)
   *  May also be `'abandoned'` when the user manually closed the task
   *  via `agentdeck task cancel` (or the macOS detail-pane button) — that
   *  outcome takes priority and is never overwritten by the judge.
   *  Distinct from the run-level git outcome (`committed | abandoned |
   *  iterated`) which lives on the parent `runs` row.
   */
  outcome: 'success' | 'partial' | 'fail' | 'pending' | 'abandoned';
  taskCategory?: string;
  summary?: string;
  boundarySignal: string;
}

function deriveTaskOutcome(score: number | null | undefined): TaskEvaluatedEvent['outcome'] {
  if (score == null) return 'pending';
  if (score >= 0.75) return 'success';
  if (score >= 0.5) return 'partial';
  return 'fail';
}

/** Narrow an arbitrary DB `outcome` string to the typed union, so a row
 *  written via the manual path (`closeTaskExternal` outcome override) can
 *  flow back into `TaskEvaluatedEvent` without losing type-safety. */
function isPreservableOutcome(value: string | null): value is TaskEvaluatedEvent['outcome'] {
  return value === 'success' || value === 'partial' || value === 'fail'
      || value === 'pending' || value === 'abandoned';
}

type Lang = 'typescript' | 'swift' | 'kotlin';

interface DetStepResult {
  metric: 'lint_clean' | 'build_ok' | 'tests_pass';
  score: 0 | 1;
  exitCode: number;
  durationMs: number;
  outputTail: string;
  command: string;
}

const DEFAULT_COMMANDS: Record<Lang, { lint?: string; build?: string; test?: string | ((cwd: string) => string | null) }> = {
  typescript: {
    lint: 'pnpm -w lint',
    build: 'pnpm -r build',
    test: 'pnpm -w test',
  },
  swift: {
    test: (cwd: string) => {
      // Auto-detect scheme from the project — don't hardcode "AgentDeck".
      const scheme = detectSwiftScheme(cwd);
      return scheme ? `xcodebuild test -scheme ${scheme} -quiet` : null;
    },
  },
  kotlin: {
    test: './gradlew testDebugUnitTest',
  },
};

// ─── Runner ────────────────────────────────────────────────────────────────────

export class ApmeRunner {
  private queue: EvalJob[] = [];
  private drainPromise: Promise<void> | null = null;
  private readonly queuedRunIds = new Set<string>();
  private readonly runningRunIds = new Set<string>();
  private readonly runningTurnIds = new Set<string>();
  private readonly runningTaskIds = new Set<string>();
  private readonly listeners = new Set<(r: EvalJobResult) => void>();
  private readonly taskListeners = new Set<(e: TaskEvaluatedEvent) => void>();
  private configOverride: ApmeConfig | null = null;
  private judgeOverride: ((prompt: string, judgeCfg: ApmeJudgeConfig) => Promise<string>) | null = null;
  private detOverride: ((runRow: ApmeRunRow, cfg: ApmeConfig) => Promise<DetStepResult[]>) | null = null;

  /** Cached startup judge readiness probe. Populated by `refreshBackendProbe`,
   *  surfaced on /health. Null until the first probe completes. */
  public lastBackendProbe: JudgeBackendStatus | null = null;

  constructor(private readonly store: ApmeStore) {}

  /** Probe the configured judge backend and cache the result. Safe to call
   *  fire-and-forget at daemon startup — failures don't throw. */
  async refreshBackendProbe(cfg: ApmeJudgeConfig): Promise<JudgeBackendStatus> {
    this.lastBackendProbe = await probeJudgeBackend(cfg);
    return this.lastBackendProbe;
  }

  _setConfig(cfg: ApmeConfig): void { this.configOverride = cfg; }
  _setJudgeFn(fn: ((prompt: string, judgeCfg: ApmeJudgeConfig) => Promise<string>) | null): void {
    this.judgeOverride = fn;
  }
  _setDeterministicFn(fn: ((runRow: ApmeRunRow, cfg: ApmeConfig) => Promise<DetStepResult[]>) | null): void {
    this.detOverride = fn;
  }

  onResult(fn: (r: EvalJobResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to per-task judge completions. The event fires AFTER the
   *  task_judge axis scores and summary are persisted, so listeners can read
   *  the final state directly from the event payload without re-querying.
   *  Used by the timeline emitter to upsert the corresponding `task_end` row
   *  with score + outcome metadata. */
  onTaskEvaluated(fn: (e: TaskEvaluatedEvent) => void): () => void {
    this.taskListeners.add(fn);
    return () => this.taskListeners.delete(fn);
  }

  enqueue(job: EvalJob): void {
    if (!this.store.enabled) return;
    if (this.queuedRunIds.has(job.runId) || this.runningRunIds.has(job.runId)) {
      debug('APME', `skip duplicate eval enqueue runId=${job.runId}`);
      return;
    }
    this.queuedRunIds.add(job.runId);
    this.queue.push(job);
    debug('APME', `enqueue eval runId=${job.runId} (queue=${this.queue.length})`);
    void this.drain();
  }

  /** Immediately judge a single completed turn (mid-session eval).
   *  Used for non-code categories where turn prompt+response is the eval unit.
   *  Fires-and-forgets; result is stored and notified via onResult listeners. */
  enqueueTurn(job: { runId: string; turnId: string; category?: string }): void {
    if (!this.store.enabled) return;
    if (this.runningTurnIds.has(job.turnId)) {
      debug('APME', `skip duplicate turn eval turnId=${job.turnId}`);
      return;
    }
    this.runningTurnIds.add(job.turnId);
    void this.runTurnEval(job).finally(() => {
      this.runningTurnIds.delete(job.turnId);
    });
  }

  /** Judge a closed task (group of turns between hard boundary signals —
   *  manual, /clear, session_end, idle_gap). Fires-and-forgets;
   *  task-level summary and axis scores are persisted in tasks + evals. */
  enqueueTask(job: { runId: string; taskId: string; category?: string; boundarySignal?: string }): void {
    if (!this.store.enabled) return;
    if (this.runningTaskIds.has(job.taskId)) {
      debug('APME', `skip duplicate task eval taskId=${job.taskId}`);
      return;
    }
    this.runningTaskIds.add(job.taskId);
    void this.runTaskEval(job).finally(() => {
      this.runningTaskIds.delete(job.taskId);
    });
  }

  private async runTaskEval({ runId, taskId, category, boundarySignal }: { runId: string; taskId: string; category?: string; boundarySignal?: string }): Promise<void> {
    const cfg = this.configOverride ?? loadApmeConfig();
    if (!cfg.enabled) return;

    const task = this.store.getTask(taskId);
    if (!task) return;
    const turns = this.store.listTurnsForTask(taskId);
    if (turns.length === 0) return;

    // Skip tasks whose turns carry no meaningful text — all tool_only/empty.
    const anyText = turns.some((t) => {
      const kind = readResponseKind(t);
      if (kind === 'text') return true;
      const prompt = typeof t.prompt === 'string' ? t.prompt.trim() : '';
      return prompt.length > 0;
    });
    if (!anyText) {
      debug('APME', `runTaskEval skip task=${taskId.slice(0, 8)} — no text`);
      return;
    }

    // Select rubric: task_rollup preferred, fall back to category, then general.
    const rubric = this.store.getCurrentRubric('task_rollup')
      ?? (category ? this.store.getCurrentRubric(category) : null)
      ?? this.store.getCurrentRubric('general');
    if (!rubric) return;

    const TURN_CAP = 10;
    const clipped = turns.slice(0, TURN_CAP);
    const lines: string[] = [];
    for (const t of clipped) {
      const idx = t.turn_index as number;
      const prompt = ((t.prompt as string | null) ?? '').slice(0, 1500);
      const response = ((t.response as string | null) ?? '').slice(0, 2500);
      lines.push(`[Turn ${idx}] User: ${prompt || '(empty)'}`);
      if (response) lines.push(`Agent: ${response}`);
    }
    if (turns.length > TURN_CAP) {
      lines.push(`… (${turns.length - TURN_CAP} more turns omitted)`);
    }

    // The canonical SessionSample gives the judge the typed tool trajectory
    // (req #5/#6) and per-sample cost (req #7) — context the turn rows lack.
    const sample = this.store.getSample(taskId);
    const trajectoryLines = sample ? buildTrajectoryLines(sample) : [];
    const costLine = sample
      ? `cost: ${sample.cost.inputTokens}in/${sample.cost.outputTokens}out tok, $${sample.cost.costUsd.toFixed(4)}, model ${sample.model.modelId}`
      : '';

    const judgePrompt = [
      rubric.prompt,
      '',
      '--- TASK CONTEXT ---',
      `task_category: ${category ?? task.taskCategory ?? 'unknown'}`,
      `turn_count: ${turns.length}`,
      `boundary_signal: ${boundarySignal ?? task.boundarySignal}`,
      ...(costLine ? [costLine] : []),
      '',
      '--- TURNS ---',
      ...lines,
      ...(trajectoryLines.length ? ['', '--- TOOL TRAJECTORY ---', ...trajectoryLines] : []),
      '',
      'Respond with strict JSON only.',
    ].join('\n');

    try {
      // callJudgeWithMeta carries the effective backend label across the
      // FM→MLX fallback path. Without it, eval rows produced by the MLX
      // fallback would be misattributed to foundationModels in the DB.
      const judgeResult = this.judgeOverride
        ? { text: await this.judgeOverride(judgePrompt, cfg.judge), effectiveLabel: effectiveJudgeModelTag(cfg.judge) }
        : await callJudgeWithMeta(judgePrompt, cfg.judge);
      const parsed = parseJudgeJson(judgeResult.text);
      if (!parsed) {
        debug('APME', `runTaskEval parse failed task=${taskId.slice(0, 8)}`);
        return;
      }

      const now = Date.now();
      const judgeModel = judgeResult.effectiveLabel;
      for (const [axis, score] of Object.entries(parsed.scores)) {
        this.store.insertEvalForTask({
          id: 0,
          runId, taskId,
          layer: 'task_judge',
          metric: axis,
          score,
          raw: axis === 'overall'
            ? JSON.stringify({
                summary: parsed.summary,
                reasoning: parsed.reasoning,
                done: parsed.done,
                missed: parsed.missed,
              })
            : null,
          rubricVer: rubric.version,
          judgeModel,
          createdAt: now,
        });
      }

      // Pure sample-trajectory scorers (tool churn, error rate) — they add
      // signal the LLM judge can miss and are cheap/deterministic. Stored under
      // layer='trajectory' so they don't collide with task_judge axes.
      if (sample) {
        try {
          for (const r of runSampleScorers(sample)) {
            this.store.insertEvalForTask({
              id: 0, runId, taskId,
              layer: r.layer,
              metric: r.metric,
              score: r.score,
              raw: r.reasoning ? JSON.stringify({ reasoning: r.reasoning, scorer: r.scorer }) : null,
              rubricVer: null,
              judgeModel: `scorer:${r.scorer}`,
              createdAt: now,
            });
          }
        } catch (err) { debug('APME', `sample scorers failed task=${taskId.slice(0, 8)}: ${String(err)}`); }
      }

      const compositeScore = parsed.scores.overall ?? null;
      const derivedOutcome = deriveTaskOutcome(compositeScore);
      // Preserve a previously-set outcome — that only happens when the user
      // explicitly closed the task via `agentdeck task done/cancel` (or the
      // macOS detail-pane button) with an outcome override. Without this
      // guard the async judge resolves 5–30 s after the manual close and
      // overwrites e.g. `abandoned` with `partial`, silently losing the
      // user's gesture. `closeTask` itself never writes outcome — only the
      // manual path does — so a non-null read here is unambiguous.
      const existingOutcome = this.store.getTask(taskId)?.outcome ?? null;
      const taskOutcome: TaskEvaluatedEvent['outcome'] = isPreservableOutcome(existingOutcome)
        ? existingOutcome
        : derivedOutcome;
      this.store.updateTask(taskId, {
        summary: parsed.summary ?? null,
        compositeScore,
        outcome: taskOutcome,
        notesJson: JSON.stringify({
          reasoning: parsed.reasoning,
          done: parsed.done,
          missed: parsed.missed,
        }),
      });

      debug('APME', `task eval ${taskId.slice(0, 8)}: overall=${compositeScore} outcome=${taskOutcome} summary=${parsed.summary?.slice(0, 40) ?? '-'}`);
      for (const fn of this.listeners) {
        try { fn({ runId, taskId, layer1Ran: false, layer2Ran: true, overall: compositeScore ?? undefined }); }
        catch { /* ignore */ }
      }

      if (this.taskListeners.size > 0) {
        const run = this.store.getRun(runId);
        const updatedTask = this.store.getTask(taskId) ?? task;
        const event: TaskEvaluatedEvent = {
          runId,
          taskId,
          sessionId: run?.sessionId ?? '',
          agentType: run?.agentType ?? undefined,
          projectName: run?.projectName ?? undefined,
          startedAt: updatedTask.startedAt,
          endedAt: updatedTask.endedAt ?? Date.now(),
          compositeScore,
          outcome: taskOutcome,
          taskCategory: category ?? updatedTask.taskCategory ?? undefined,
          summary: parsed.summary ?? undefined,
          boundarySignal: boundarySignal ?? updatedTask.boundarySignal,
        };
        for (const fn of this.taskListeners) {
          try { fn(event); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      debug('APME', `task eval error taskId=${taskId.slice(0, 8)}: ${String(err)}`);
    }
  }

  private async runTurnEval({ runId, turnId, category }: { runId: string; turnId: string; category?: string }): Promise<void> {
    const cfg = this.configOverride ?? loadApmeConfig();
    if (!cfg.enabled) return;

    const turn = this.store.getTurn(turnId);
    if (!turn) return;
    const prompt = (turn.prompt as string | null) ?? '';
    const response = (turn.response as string | null) ?? '';
    if (!prompt && !response) return; // nothing to judge
    // Skip turns the agent answered with tool calls only (or not at all) —
    // the rubric prompt can't score "silence" meaningfully and doing so
    // generates noise scores. `tool_only` / `empty` tags are set by the
    // collector in turns.efficiency_json.
    const kind = readResponseKind(turn);
    if (kind === 'tool_only' || kind === 'empty') {
      debug('APME', `runTurnEval skip turn=${turnId.slice(0,8)} kind=${kind}`);
      return;
    }

    // Select rubric by category (conversation/planning/research/review)
    const rubric = (category ? this.store.getCurrentRubric(category) : null)
      ?? this.store.getCurrentRubric('conversation'); // sensible fallback
    if (!rubric) return;

    const judgePrompt = [
      rubric.prompt,
      '',
      '--- TURN CONTEXT ---',
      `task_category: ${category ?? 'conversation'}`,
      '',
      '--- USER PROMPT ---',
      prompt.slice(0, 2000) || '(not captured)',
      '',
      '--- AGENT RESPONSE ---',
      response.slice(0, 4000) || '(not captured)',
      '',
      'Respond with strict JSON only.',
    ].join('\n');

    try {
      // Same fallback-aware labelling rule as runTaskEval — see comment there.
      const judgeResult = this.judgeOverride
        ? { text: await this.judgeOverride(judgePrompt, cfg.judge), effectiveLabel: effectiveJudgeModelTag(cfg.judge) }
        : await callJudgeWithMeta(judgePrompt, cfg.judge);
      const parsed = parseJudgeJson(judgeResult.text);
      if (!parsed) return;

      const now = Date.now();
      const judgeModel = judgeResult.effectiveLabel;
      for (const [axis, score] of Object.entries(parsed.scores)) {
        this.store.insertEvalForTurn({
          runId, turnId,
          id: 0, // autoincrement
          layer: 'turn_judge',
          metric: axis,
          score,
          raw: axis === 'overall'
            ? JSON.stringify({ reasoning: parsed.reasoning, done: parsed.done, missed: parsed.missed })
            : null,
          rubricVer: rubric.version,
          judgeModel,
          createdAt: now,
        });
      }
      debug('APME', `turn eval ${turnId.slice(0, 8)}: overall=${parsed.scores.overall}`);
      // Notify listeners with turnId so daemon can broadcast turn eval
      for (const fn of this.listeners) {
        fn({ runId, turnId, layer1Ran: false, layer2Ran: true, overall: parsed.scores.overall });
      }
    } catch (err) {
      debug('APME', `turn eval error turnId=${turnId.slice(0, 8)}: ${String(err)}`);
    }
  }

  /** Runs the queue until empty. Awaitable — callers can join the current drain. */
  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.doDrain();
    try { await this.drainPromise; }
    finally { this.drainPromise = null; }
  }

  private async doDrain(): Promise<void> {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.queuedRunIds.delete(job.runId);
      this.runningRunIds.add(job.runId);
      try {
        const result = await this.runOne(job);
        if (!result.layer1Ran && !result.layer2Ran && result.overall === undefined) {
          debug('APME', `runner no-op runId=${job.runId} (no eval rows produced)`);
          continue;
        }
        for (const fn of this.listeners) {
          try { fn(result); } catch { /* ignore */ }
        }
      } catch (err) {
        debug('APME', `runner error runId=${job.runId}: ${String(err)}`);
      } finally {
        this.runningRunIds.delete(job.runId);
      }
    }
  }

  private async runOne(job: EvalJob): Promise<EvalJobResult> {
    const cfg = this.configOverride ?? loadApmeConfig();
    const run = this.store.getRun(job.runId);
    if (!run) {
      debug('APME', `runOne: run ${job.runId} not found`);
      return { runId: job.runId, layer1Ran: false, layer2Ran: false };
    }
    if (this.store.listEvalsForRun(run.id).length > 0) {
      debug('APME', `runOne: run ${run.id} already has eval rows; skip duplicate`);
      return { runId: job.runId, layer1Ran: false, layer2Ran: false };
    }

    // ── Layer 1 — deterministic ───────────────────────────────────────────────
    let layer1Ran = false;
    let layer1Passed: boolean | null = null;
    if (cfg.deterministic.enabled) {
      try {
        const results = this.detOverride
          ? await this.detOverride(run, cfg)
          : await runDeterministic(run, cfg);
        for (const r of results) {
          this.store.insertEval({
            runId: run.id,
            layer: 'deterministic',
            metric: r.metric,
            score: r.score,
            raw: JSON.stringify({
              command: r.command,
              exitCode: r.exitCode,
              durationMs: r.durationMs,
              outputTail: r.outputTail,
            }),
            createdAt: Date.now(),
          });
        }
        if (results.length > 0) {
          layer1Ran = true;
          // Aggregate: pass only if every step passed.
          layer1Passed = results.every((r) => r.score === 1);
        }
        debug('APME', `runOne layer1 runId=${run.id} results=${results.length} passed=${layer1Passed}`);
      } catch (err) {
        debug('APME', `layer1 error runId=${run.id}: ${String(err)}`);
      }
    }

    // ── Layer 2 — llm_judge (gated) ───────────────────────────────────────────
    let layer2Ran = false;
    let overall: number | undefined;
    if (cfg.enabled && shouldJudge(cfg.judge, layer1Passed)) {
      // Select category-specific rubric, fall back to 'general'
      const rubric = (run.taskCategory ? this.store.getCurrentRubric(run.taskCategory) : null)
        ?? this.store.getCurrentRubric('general');
      if (rubric) {
        try {
          const prompt = buildJudgePrompt(run, rubric.prompt, layer1Passed, this.store);
          // Same fallback-aware labelling rule as runTaskEval — see comment there.
          const judgeResult = this.judgeOverride
            ? { text: await this.judgeOverride(prompt, cfg.judge), effectiveLabel: effectiveJudgeModelTag(cfg.judge) }
            : await callJudgeWithMeta(prompt, cfg.judge);
          const parsed = parseJudgeJson(judgeResult.text);
          if (parsed) {
            const now = Date.now();
            const judgeModel = judgeResult.effectiveLabel;
            for (const [axis, score] of Object.entries(parsed.scores)) {
              this.store.insertEval({
                runId: run.id,
                layer: 'llm_judge',
                metric: axis,
                score,
                raw: axis === 'overall' ? JSON.stringify({ reasoning: parsed.reasoning, done: parsed.done, missed: parsed.missed }) : null,
                rubricVer: rubric.version,
                judgeModel,
                createdAt: now,
              });
            }
            overall = parsed.scores.overall;
            layer2Ran = true;
            // Re-compute composite score with judge contribution
            try {
              const { recomputeComposite } = await import('./outcome.js');
              recomputeComposite(this.store, run.id);
            } catch { /* ignore — outcome may not have run yet */ }
          } else {
            debug('APME', `judge response unparseable runId=${run.id}`);
          }
        } catch (err) {
          // Per cost-sensitive-defaults memory: never silently fall back from MLX to API.
          debug('APME', `layer2 error runId=${run.id} (skipping, no fallback): ${String(err)}`);
        }
      }
    }

    return { runId: job.runId, layer1Ran, layer2Ran, overall };
  }
}

// ─── Language detection ───────────────────────────────────────────────────────

/** Auto-detect the first testable Xcode scheme from a project directory. */
function detectSwiftScheme(cwd: string): string | null {
  try {
    const out = execSync('xcodebuild -list -json', {
      cwd, encoding: 'utf-8', timeout: 10_000,
      maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const json = JSON.parse(out) as { project?: { schemes?: string[] } };
    const schemes = json.project?.schemes;
    if (!schemes || schemes.length === 0) return null;
    // Prefer schemes with "Test" or matching directory name.
    const dirName = cwd.split('/').pop() ?? '';
    const testScheme = schemes.find((s) => s.toLowerCase().includes('test'));
    const matchScheme = schemes.find((s) => dirName.toLowerCase().includes(s.toLowerCase().replace(/_/g, '')));
    return matchScheme ?? testScheme ?? schemes[0];
  } catch {
    return null;
  }
}

export function detectLanguage(projectPath: string | null | undefined): Lang | null {
  if (!projectPath || !existsSync(projectPath)) return null;
  try {
    const entries = readdirSync(projectPath);
    if (entries.includes('package.json') || entries.some((e) => e.endsWith('.ts') || e.endsWith('.tsx'))) {
      return 'typescript';
    }
    if (entries.some((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'))) {
      return 'swift';
    }
    if (entries.includes('build.gradle') || entries.includes('build.gradle.kts') || entries.includes('settings.gradle.kts')) {
      return 'kotlin';
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Layer 1 execution ────────────────────────────────────────────────────────

export async function runDeterministic(run: ApmeRunRow, cfg: ApmeConfig): Promise<DetStepResult[]> {
  const cwd = run.projectPath;
  if (!cwd) return [];
  const lang = detectLanguage(cwd);
  if (!lang) return [];

  // Only run deterministic checks when there are actual changes from this run.
  // If gitBefore == gitAfter and no uncommitted diff, the agent didn't produce
  // code — running tests gives stale baseline data, so skip.
  if (!hasChanges(run)) {
    debug('APME', `runDeterministic skipped runId=${run.id} — no git diff`);
    return [];
  }

  const override = cfg.deterministic.commands[lang] ?? {};
  const defaults = DEFAULT_COMMANDS[lang];
  const rawSteps: Array<{ metric: DetStepResult['metric']; cmd: string | ((cwd: string) => string | null) | undefined }> = [
    { metric: 'lint_clean', cmd: override.lint ?? defaults.lint },
    { metric: 'build_ok',   cmd: override.build ?? defaults.build },
    { metric: 'tests_pass', cmd: override.test  ?? defaults.test },
  ];

  const results: DetStepResult[] = [];
  for (const s of rawSteps) {
    // Resolve command: may be a string or a function(cwd) → string|null.
    const command = typeof s.cmd === 'function' ? s.cmd(cwd) : s.cmd;
    if (!command) continue;
    const r = await runCommand(command, cwd, cfg.deterministic.timeoutSec * 1000);
    results.push({
      metric: s.metric,
      command,
      score: r.exitCode === 0 ? 1 : 0,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      outputTail: r.outputTail,
    });
  }
  return results;
}

function hasChanges(run: ApmeRunRow): boolean {
  if (!run.projectPath) return false;
  if (run.gitBefore && run.gitAfter && run.gitBefore !== run.gitAfter) return true;
  // Check uncommitted diff (dirty worktree).
  try {
    const status = execSync('git status --porcelain', {
      cwd: run.projectPath, encoding: 'utf-8', timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim().length > 0;
  } catch {
    // Not a git repo — assume changes exist so we don't silently skip everything.
    return true;
  }
}

interface CmdResult { exitCode: number; durationMs: number; outputTail: string }

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: { ...process.env, CI: '1', APME_EVAL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let done = false;
    const cap = 32 * 1024; // keep last 32KB
    const onData = (buf: Buffer) => {
      chunks.push(buf);
      let total = chunks.reduce((n, b) => n + b.length, 0);
      while (total > cap * 2 && chunks.length > 1) {
        const head = chunks.shift()!;
        total -= head.length;
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const combined = Buffer.concat(chunks).toString('utf-8');
      const tail = combined.length > cap ? combined.slice(combined.length - cap) : combined;
      resolve({
        exitCode: typeof code === 'number' ? code : (signal ? 137 : 1),
        durationMs: Date.now() - start,
        outputTail: tail,
      });
    });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: 127, durationMs: Date.now() - start, outputTail: `spawn failed: ${command}` });
    });
  });
}

// ─── Layer 2 execution ────────────────────────────────────────────────────────

/** Render a SessionSample's typed trajectory as compact judge-prompt lines.
 *  Gives the judge tool-call sequences + model usage the turn rows omit. */
export function buildTrajectoryLines(sample: SessionSample, cap = 30): string[] {
  const lines: string[] = [];
  const events: TrajectoryEvent[] = sample.events.slice(0, cap);
  for (const e of events) {
    switch (e.kind) {
      case 'tool': {
        let input = '';
        try { input = e.input == null ? '' : JSON.stringify(e.input).slice(0, 120); } catch { input = ''; }
        lines.push(`  tool ${e.name}(${input})${e.status ? ` → ${e.status}` : ''}${e.error ? ` [err: ${String(e.error).slice(0, 80)}]` : ''}`);
        break;
      }
      case 'model':
        lines.push(`  model ${e.model}: ${e.inputTokens}in/${e.outputTokens}out tok${e.costUsd ? ` ($${e.costUsd.toFixed(4)})` : ''}`);
        break;
      case 'state':
        lines.push(`  state → ${e.to}`);
        break;
      default:
        break; // user/assistant messages already shown in the TURNS section
    }
  }
  if (sample.events.length > cap) lines.push(`  … (${sample.events.length - cap} more events)`);
  return lines;
}

// `ParsedJudge` is the canonical eval v1 type imported from `@agentdeck/shared`.

const NON_CODE_CATEGORIES = new Set(['conversation', 'planning', 'research', 'review']);

export function buildJudgePrompt(
  run: ApmeRunRow, rubricPrompt: string, layer1Passed: boolean | null,
  store?: import('./store.js').ApmeStore,
): string {
  const task = (run.taskPrompt ?? '').slice(0, 4_000);
  const det = layer1Passed === null ? 'unknown' : layer1Passed ? 'passed' : 'failed';
  const isNonCode = run.taskCategory && NON_CODE_CATEGORIES.has(run.taskCategory);

  const sections: string[] = [
    rubricPrompt,
    '',
    '--- RUN CONTEXT ---',
    `agent_type: ${run.agentType}`,
    `model: ${run.modelId ?? 'unknown'}`,
    `project: ${run.projectName ?? 'unknown'}`,
    `task_category: ${run.taskCategory ?? 'unknown'}`,
    `deterministic_checks: ${det}`,
    '',
    '--- TASK PROMPT ---',
    task || '(not captured)',
  ];

  if (isNonCode && store) {
    // Non-code categories: include turns (prompt + response) instead of diff
    const turns = store.listTurns(run.id);
    sections.push('', '--- CONVERSATION ---');
    for (const t of turns.slice(0, 10)) {
      const prompt = ((t.prompt as string) ?? '').slice(0, 2000);
      const response = ((t.response as string) ?? '').slice(0, 3000);
      sections.push(`[Turn ${t.turn_index}] User: ${prompt}`);
      if (response) sections.push(`Agent: ${response}`);
    }
  } else {
    // Code categories: include git diff
    const diff = collectDiff(run);
    sections.push('', '--- DIFF (truncated) ---', diff || '(no diff captured)');
  }

  sections.push('', 'Respond with strict JSON only.');
  return sections.join('\n');
}

/** Response classification stored by ApmeCollector under turns.efficiency_json.response_kind.
 *  Drives which turns make it to the LLM judge — `tool_only` / `empty` are silence
 *  to the judge and produce noise scores. Fallback is 'text' when the tag is missing
 *  (older rows) but response content is non-trivial. */
export type ResponseKind = 'text' | 'tool_only' | 'empty';

export function readResponseKind(turn: Record<string, unknown>): ResponseKind {
  const raw = turn.efficiency_json;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as { response_kind?: unknown };
      const k = parsed.response_kind;
      if (k === 'text' || k === 'tool_only' || k === 'empty') return k;
    } catch { /* fall through */ }
  }
  const response = typeof turn.response === 'string' ? turn.response.trim() : '';
  const toolCalls = typeof turn.tool_calls === 'number' ? turn.tool_calls : 0;
  if (response.length >= 1) return 'text';
  return toolCalls > 0 ? 'tool_only' : 'empty';
}

function collectDiff(run: ApmeRunRow): string {
  if (!run.projectPath) return '';
  try {
    const args = run.gitBefore && run.gitAfter && run.gitBefore !== run.gitAfter
      ? ['diff', '--unified=2', `${run.gitBefore}..${run.gitAfter}`]
      : ['diff', '--unified=2', 'HEAD'];
    const out = execSync(`git ${args.join(' ')}`, {
      cwd: run.projectPath, encoding: 'utf-8', timeout: 4000,
      maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.length > 12_000 ? out.slice(0, 12_000) + '\n...[truncated]' : out;
  } catch {
    return '';
  }
}

/**
 * Build the `judgeModel` DB tag. For MLX backend the effective model is the
 * llm.mlx pin when set — otherwise cfg.judge.model (may still be the legacy
 * "qwen3-30b" placeholder). Non-MLX backends use cfg.judge.model verbatim.
 */
export function effectiveJudgeModelTag(cfg: ApmeJudgeConfig): string {
  if (cfg.backend === 'mlx') {
    const pinned = loadMlxSettings().model;
    return `mlx:${pinned ?? cfg.model}`;
  }
  // Must stay byte-identical with Swift's `ApmeJudgeFoundationModels.judgeModelLabel`
  // so analytics queries aggregate FM evals across the Node and Swift stacks.
  if (cfg.backend === 'foundationModels') return 'foundationModels:apple-intelligence';
  return `${cfg.backend}:${cfg.model}`;
}

/** Strip backend-specific fields when forcing a cfg through a different
 *  adapter. Without this, a FM cfg (`endpoint:"http://.../apme/judge/foundation-models"`,
 *  `model:"apple-intelligence"`) handed to `callMlx` would POST to the FM URL
 *  and request a model the MLX server has never heard of — silent failure.
 *  Mirrors the `resetBackendCoupledFields` path inside `loadApmeConfig`. */
export function sanitizeForMlx(judgeCfg: ApmeJudgeConfig): ApmeJudgeConfig {
  if (judgeCfg.backend === 'mlx' && !judgeCfg.endpoint && (!judgeCfg.model || judgeCfg.model === DEFAULT_APME_CONFIG.judge.model)) {
    return judgeCfg;
  }
  return {
    ...judgeCfg,
    backend: 'mlx',
    endpoint: undefined,
    model: DEFAULT_APME_CONFIG.judge.model,
  };
}

/** Result of a judge call that knows which backend ACTUALLY produced the
 *  text — important when the FM→MLX fallback path runs, because the caller
 *  needs the effective label (not the original cfg.backend) for the
 *  `evals.judge_model` column. Otherwise eval rows are misattributed to FM
 *  even though MLX produced them. */
export interface JudgeResult {
  text: string;
  /** Backend that actually generated `text` (after any fallback). */
  effectiveBackend: ApmeJudgeBackend;
  /** `judge_model` column value derived from the effective backend + cfg.
   *  Use this verbatim when writing to the DB. */
  effectiveLabel: string;
}

/** Like `callJudge`, but returns the effective backend + label so callers
 *  can record `judge_model` correctly across fallback paths. */
export async function callJudgeWithMeta(prompt: string, judgeCfg: ApmeJudgeConfig): Promise<JudgeResult> {
  if (judgeCfg.backend === 'foundationModels') {
    try {
      const text = await callFoundationModels(prompt, judgeCfg);
      return { text, effectiveBackend: 'foundationModels', effectiveLabel: effectiveJudgeModelTag(judgeCfg) };
    } catch (err) {
      // Cost-sensitive default: do not silently route to a network backend.
      // Only retry via MLX when the user explicitly opts in — otherwise
      // propagate the error so the runner's try/catch skips this eval.
      if (judgeCfg.fallbackToMlx) {
        debug('APME', `foundationModels unavailable, fallback to MLX: ${String(err)}`);
        // sanitizeForMlx wipes the FM-specific endpoint/model so callMlx
        // never POSTs to the FM endpoint or asks MLX for `apple-intelligence`.
        // We then derive the label from the SANITIZED cfg — recording the
        // effective backend, not the cfg the user originally requested.
        const mlxCfg = sanitizeForMlx(judgeCfg);
        const text = await callMlx(prompt, mlxCfg);
        return { text, effectiveBackend: 'mlx', effectiveLabel: effectiveJudgeModelTag(mlxCfg) };
      }
      throw err;
    }
  }
  let text: string;
  if (judgeCfg.backend === 'mlx') text = await callMlx(prompt, judgeCfg);
  else if (judgeCfg.backend === 'openclaw') text = await callOpenClaw(prompt, judgeCfg);
  else if (judgeCfg.backend === 'api') text = await callApi(prompt, judgeCfg);
  else throw new Error(`unknown judge backend: ${String(judgeCfg.backend)}`);
  return { text, effectiveBackend: judgeCfg.backend, effectiveLabel: effectiveJudgeModelTag(judgeCfg) };
}

/** Backwards-compatible thin wrapper. Internal callers that need the actual
 *  effective backend (for DB labelling) should call `callJudgeWithMeta`. */
export async function callJudge(prompt: string, judgeCfg: ApmeJudgeConfig): Promise<string> {
  return (await callJudgeWithMeta(prompt, judgeCfg)).text;
}

// ─── Backend readiness probe ──────────────────────────────────────────────────
//
// Lightweight reachability check used at daemon startup so silent judge
// outages (the dominant cause of the 11-day stall in 2026-04 user data) show
// up in /health and startup logs instead of presenting as "evals just don't
// happen". Every backend has its own probe shape; failures are downgraded to
// `unavailable` with a reason rather than throwing — the deterministic layer
// must keep running regardless.
export interface JudgeBackendStatus {
  backend: ApmeJudgeBackend;
  status: 'ready' | 'unavailable' | 'unknown';
  latencyMs?: number;
  model?: string;
  endpoint?: string;
  reason?: string;
  checkedAt: number;
}

export async function probeJudgeBackend(cfg: ApmeJudgeConfig): Promise<JudgeBackendStatus> {
  const start = Date.now();
  const checkedAt = start;
  // Each branch must establish that the backend can ACTUALLY produce a judge
  // response — not just that some HTTP port answers. Reachability without a
  // usable model / SDK / on-device LLM yields false-positive "ready" that
  // hides the real failure mode (silent eval skip later). Follow the rule:
  // either invoke (cheap ping) or downgrade to `unavailable` with a reason.
  try {
    if (cfg.backend === 'mlx') {
      const mlx = loadMlxSettings();
      const url = cfg.endpoint ?? mlx.endpoint;
      const base = url.replace(/\/v1\/chat\/completions$/, '').replace(/\/chat\/completions$/, '');
      let model: string | undefined;
      let modelsReachable = false;
      for (const path of ['/v1/models', '/models']) {
        const resp = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (resp?.ok) {
          modelsReachable = true;
          const json = await resp.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
          model = json.data?.find(m => m.id && !m.id.toLowerCase().includes('nanollava'))?.id;
          break;
        }
      }
      if (!modelsReachable) {
        return {
          backend: 'mlx', status: 'unavailable',
          reason: `MLX server unreachable at ${base}. Start with \`mlx_lm.server\` or set apme.judge.endpoint.`,
          endpoint: base, checkedAt,
        };
      }
      // Pinned/configured model overrides catalog discovery — the real call uses
      // the same fallback chain as callMlx().
      const pickedModel = mlx.model ?? cfg.model ?? model;
      if (!pickedModel) {
        return {
          backend: 'mlx', status: 'unavailable',
          reason: `MLX server reachable at ${base} but advertises no chat-capable model (only nanollava-class found). Load a chat model with \`mlx_lm.server --model …\`.`,
          endpoint: base, checkedAt,
        };
      }
      // Cheapest possible inference probe: max_tokens=1, temperature=0. If MLX
      // accepts this without a model error, callMlx() will succeed too.
      const ping = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: pickedModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1, temperature: 0,
        }),
        signal: AbortSignal.timeout(8000),
      }).catch((e) => ({ ok: false, status: 0, statusText: String(e).slice(0, 80) } as Response));
      if (!ping.ok) {
        const detail = ping.status ? `HTTP ${ping.status}` : (ping as { statusText?: string }).statusText ?? 'no response';
        return {
          backend: 'mlx', status: 'unavailable',
          reason: `MLX inference failed for model "${pickedModel}" (${detail}). Check that the model is actually loaded.`,
          endpoint: base, model: pickedModel, checkedAt,
        };
      }
      return { backend: 'mlx', status: 'ready', latencyMs: Date.now() - start, model: pickedModel, endpoint: base, checkedAt };
    }
    if (cfg.backend === 'openclaw') {
      // OpenClaw Gateway: /health proves the gateway socket is up but does NOT
      // prove /chat will route. The bridge's own gateway adapter performs an
      // Ed25519 handshake against the same gateway; we don't replicate it
      // here, but we DO require both /health AND a model catalog response so
      // a stub gateway with /health = 200 doesn't pass.
      const url = cfg.endpoint ?? 'http://127.0.0.1:18789';
      const base = url.replace(/\/chat$/, '');
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!health?.ok) {
        return {
          backend: 'openclaw', status: 'unavailable',
          reason: `OpenClaw Gateway /health unreachable at ${base}.`,
          endpoint: base, checkedAt,
        };
      }
      const models = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!models?.ok) {
        return {
          backend: 'openclaw', status: 'unavailable',
          reason: `OpenClaw Gateway /health responds but /models does not — gateway not fully initialised. Wait for handshake or check apme.judge.endpoint.`,
          endpoint: base, checkedAt,
        };
      }
      const json = await models.json().catch(() => ({})) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
      const list = json.data ?? json.models ?? [];
      const requested = cfg.model;
      if (requested && !list.some(m => m.id === requested)) {
        return {
          backend: 'openclaw', status: 'unavailable',
          reason: `OpenClaw Gateway is up but model "${requested}" is not advertised. Available: ${list.slice(0, 5).map(m => m.id).join(', ')}`,
          endpoint: base, checkedAt,
        };
      }
      return {
        backend: 'openclaw', status: 'ready',
        latencyMs: Date.now() - start,
        model: requested ?? list[0]?.id, endpoint: base, checkedAt,
      };
    }
    if (cfg.backend === 'foundationModels') {
      // Mirror callFoundationModels: explicit endpoint wins over auto-resolve.
      const url = cfg.endpoint ?? await resolveFoundationModelsUrl();
      if (!url) {
        return {
          backend: 'foundationModels', status: 'unavailable',
          reason: 'Swift daemon not found. Foundation Models is App Store macOS only.',
          checkedAt,
        };
      }
      // Foundation Models adapter on the Swift side returns either { text }
      // (ready) or { error: "unavailable", reason } (Apple Intelligence not
      // downloaded, model still warming, etc). A trivial ping forces that
      // signal up to us so we don't claim ready when the on-device LLM is
      // actually unusable.
      const ping = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'ping' }),
        signal: AbortSignal.timeout(8000),
      }).catch((e) => ({ ok: false, status: 0, statusText: String(e).slice(0, 80) } as Response));
      if (!ping.ok) {
        const detail = ping.status ? `HTTP ${ping.status}` : (ping as { statusText?: string }).statusText ?? 'no response';
        return {
          backend: 'foundationModels', status: 'unavailable',
          reason: `Swift daemon FM endpoint did not accept probe (${detail}).`,
          endpoint: url, checkedAt,
        };
      }
      const json = await (ping as Response).json().catch(() => ({})) as { text?: string; error?: string; reason?: string };
      if (json.error) {
        return {
          backend: 'foundationModels', status: 'unavailable',
          reason: `Foundation Models ${json.error}: ${json.reason ?? 'no reason given'}. Apple Intelligence may not be downloaded yet.`,
          endpoint: url, checkedAt,
        };
      }
      return { backend: 'foundationModels', status: 'ready', latencyMs: Date.now() - start, endpoint: url, checkedAt };
    }
    if (cfg.backend === 'api') {
      // The 'api' backend is currently a STUB — callApi() always throws,
      // regardless of ANTHROPIC_API_KEY or @anthropic-ai/sdk presence. A probe
      // that returned 'ready' here would be a lie: the next judge call still
      // throws. Per cost-sensitive-defaults policy (memory:
      // feedback_cost_sensitive_defaults.md), local MLX is the supported path;
      // wiring real API judging is deliberately deferred. Surface that gap
      // honestly so users redirect to MLX/OpenClaw instead of debugging a
      // never-firing eval.
      const hasKey = !!process.env.ANTHROPIC_API_KEY;
      let sdkPresent = false;
      try {
        const r = createRequire(import.meta.url);
        r.resolve('@anthropic-ai/sdk');
        sdkPresent = true;
      } catch { /* not installed */ }
      const env = hasKey
        ? (sdkPresent ? 'key+SDK present' : 'key set, SDK missing')
        : 'no ANTHROPIC_API_KEY';
      return {
        backend: 'api', status: 'unavailable',
        reason: `Anthropic API judge backend is not implemented — callApi() is a stub that always throws. Switch apme.judge.backend to "mlx" or "openclaw". Environment: ${env}.`,
        checkedAt,
      };
    }
    return { backend: cfg.backend, status: 'unknown', checkedAt };
  } catch (err) {
    return {
      backend: cfg.backend, status: 'unavailable',
      reason: String(err).slice(0, 200),
      latencyMs: Date.now() - start,
      checkedAt,
    };
  }
}

async function callMlx(prompt: string, cfg: ApmeJudgeConfig): Promise<string> {
  // MLX server speaks OpenAI chat-completions. The llm.mlx pin (shared with
  // timeline/label summarizers) is the source of truth; cfg.endpoint/model
  // override only when the user explicitly set apme.judge.* in settings.json.
  const mlx = loadMlxSettings();
  const url = cfg.endpoint ?? mlxChatUrl();
  // Pin > cfg.model > probe auto-detect > cfg.model (final fallback).
  let model = mlx.model ?? cfg.model;
  if (!model || model === 'qwen3-30b') {
    try {
      const base = (cfg.endpoint ?? mlx.endpoint).replace(/\/chat\/completions$/, '').replace(/\/v1\/chat\/completions$/, '');
      for (const path of ['/v1/models', '/models']) {
        const mResp = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (mResp?.ok) {
          const mJson = await mResp.json() as { data?: Array<{ id?: string }> };
          const first = mJson.data?.find(m => m.id && !m.id.toLowerCase().includes('nanollava'))?.id;
          if (first) { model = first; break; }
        }
      }
    } catch { /* use configured model */ }
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an exacting code evaluator. Reply with strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.0,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`MLX judge HTTP ${resp.status}`);
  const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('MLX judge returned empty content');
  }
  return text;
}

async function callOpenClaw(prompt: string, cfg: ApmeJudgeConfig): Promise<string> {
  // OpenClaw Gateway exposes the user's configured models. Route through it
  // when the user wants to reuse their existing subscription models for judge.
  const url = cfg.endpoint ?? 'http://127.0.0.1:18789/chat';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, prompt, temperature: 0, max_tokens: 800 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`OpenClaw judge HTTP ${resp.status}`);
  const json = await resp.json() as { text?: string };
  if (typeof json.text !== 'string') throw new Error('OpenClaw judge missing text');
  return json.text;
}

/**
 * Route a judge call to the Swift daemon's Foundation Models adapter.
 *
 * The actual on-device LLMSession lives in
 * `apple/AgentDeck/Daemon/Apme/ApmeJudgeFoundationModels.swift`; this TS path
 * just forwards the prompt. Available only when a Swift in-process daemon is
 * running on the same machine (App Store macOS build). Node-only setups don't
 * ship Foundation Models — callers should either opt into `fallbackToMlx` or
 * accept the resulting eval skip.
 *
 * Shape contract:
 *   Request  : POST /apme/judge/foundation-models { prompt: string }
 *   Response : { text: string } | { error: "unavailable", reason: string }
 */
async function callFoundationModels(prompt: string, cfg: ApmeJudgeConfig): Promise<string> {
  const url = cfg.endpoint ?? await resolveFoundationModelsUrl();
  if (!url) throw new Error('foundationModels: no Swift daemon found — FM is only available in App Store macOS builds');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`foundationModels HTTP ${resp.status}`);
  const json = await resp.json() as { text?: string; error?: string; reason?: string };
  if (json.error) {
    throw new Error(`foundationModels ${json.error}: ${json.reason ?? 'no reason'}`);
  }
  if (typeof json.text !== 'string' || json.text.length === 0) {
    throw new Error('foundationModels returned empty text');
  }
  return json.text;
}

/** Best-effort resolver for the Swift daemon's FM endpoint. Returns null when
 *  no Swift daemon (httpPort ≠ port) is reachable. */
async function resolveFoundationModelsUrl(): Promise<string | null> {
  // Lazy-require to avoid pulling session-registry into every test bundle
  // that imports runner.ts for its pure helpers.
  const { findDaemonPortAsync } = await import('../session-registry.js');
  const info = await findDaemonPortAsync();
  if (!info) return null;
  const port = info.httpPort ?? info.port;
  return `http://127.0.0.1:${port}/apme/judge/foundation-models`;
}

async function callApi(_prompt: string, _cfg: ApmeJudgeConfig): Promise<string> {
  // Anthropic API judging is NOT implemented on the Node bridge. The macOS
  // Swift daemon (apple/AgentDeck/Daemon/Apme/ApmeJudgeApi.swift) is the only
  // place this backend works today. `loadApmeConfig` silently downgrades
  // settings.json `backend:"api"` to `"mlx"`, so reaching this stub means
  // either (a) a programmatic caller bypassed loadApmeConfig, or (b) something
  // raced between settings load and dispatch. Either way, throw with the
  // SAME diagnostic the probe surfaces so logs remain consistent.
  throw new Error(
    'APME judge backend "api" is a stub on the Node bridge — callApi() always throws. ' +
    'Use the macOS app for Anthropic API judging, or set apme.judge.backend to "mlx" / "openclaw" / "foundationModels".',
  );
}

export function parseJudgeJson(text: string): ParsedJudge | null {
  // Models often wrap JSON in prose or code fences — grab the first {...} block.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(match[0]); }
  catch { return null; }

  // Accept any numeric axis — category-specific rubrics define their own
  // (conversation: accuracy/helpfulness/conciseness; research: thoroughness/…;
  // planning: completeness/feasibility/clarity; etc.) A hardcoded whitelist
  // silently drops those, leaving only `overall` on turn_judge rows.
  const scores: Record<string, number> = {};
  const RESERVED = new Set(['reasoning', 'done', 'missed', 'notes', 'summary']);
  for (const [axis, v] of Object.entries(obj)) {
    if (RESERVED.has(axis)) continue;
    if (typeof v === 'number' && isFinite(v)) {
      scores[axis] = clamp01(v);
    }
  }
  // Must at least have overall to be useful.
  if (scores.overall === undefined) return null;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
  const done = Array.isArray(obj.done) ? (obj.done as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;
  const missed = Array.isArray(obj.missed) ? (obj.missed as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;
  // `summary` is produced by the task_rollup rubric; one-line past-tense sentence.
  // Clip defensively so a runaway model can't blow up the tasks.summary column.
  const summary = typeof obj.summary === 'string' && obj.summary.trim().length > 0
    ? obj.summary.trim().slice(0, 280)
    : undefined;
  return { scores, reasoning, done, missed, summary };
}

function clamp01(n: number): number {
  if (n > 1 && n <= 10) n = n / 10; // accept 0-10 scale and rescale
  if (n > 1) n = 1;
  if (n < 0) n = 0;
  return n;
}
