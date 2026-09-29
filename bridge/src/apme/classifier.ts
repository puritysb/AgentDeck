/**
 * APME Task Classifier — 2-layer: signal vector + derived label.
 *
 * Layer 1: `computeSignals()` aggregates steps into a fixed-shape TaskSignals
 * object that is stored as JSON on `runs.task_signals`. The signals are
 * agent-agnostic so the same shape works for Claude Code, Codex, OpenCode,
 * and OpenClaw runs alike.
 *
 * Layer 2: `classify()` maps a TaskSignals object to a task_category label
 * via a priority-ordered rule table. Users can override with `agentdeck apme
 * tag <id> <category>`. The taxonomy is intentionally simple — the raw
 * signals are always available for re-classification with a smarter model.
 */

import type { ApmeStore } from './store.js';
import {
  loadMlxSettings,
  guardedMlxFetch,
  mlxBaseUrl,
  APME_CLASSIFIER_SYSTEM_PROMPT,
  APME_CLASSIFIER_MAX_TOKENS,
  APME_CLASSIFIER_TIMEOUT_MS,
  APME_CLASSIFIER_BACKEND_ORDER,
  buildClassifierUserMessage,
  normalizeClassifierLabel,
  type ApmeClassifierBackend,
} from '@agentdeck/shared';
import { callFoundationModelsHelper } from '../foundation-models-helper.js';
import { isPrunedPayload } from './payload-prune.js';

// ─── TaskSignals — agent-agnostic feature vector ─────────────────────────────

export interface TaskSignals {
  toolCounts: Record<string, number>;
  dominantTool: string | null;
  totalToolCalls: number;

  turnCount: number;
  sessionDurationSec: number;
  promptLengthChars: number;

  planModeUsed: boolean;
  permissionRequests: number;
  diffReviews: number;
  filesCreated: number;
  filesModified: number;
  testCommandsRun: number;
  webSearches: number;
  agentDelegations: number;

  isAutomated?: boolean;
  ocToolNames?: string[];
}

// ─── Taxonomy ────────────────────────────────────────────────────────────────

export type TaskCategory =
  | 'planning'
  | 'research'
  | 'coding'
  | 'debugging'
  | 'refactoring'
  | 'review'
  | 'ops'
  | 'conversation'
  | 'multi_agent'
  | 'unknown';

export const TASK_CATEGORIES: readonly TaskCategory[] = [
  'planning', 'research', 'coding', 'debugging', 'refactoring',
  'review', 'ops', 'conversation', 'multi_agent', 'unknown',
];

// ─── Signal computation ─────────────────────────────────────────────────────

const TEST_PATTERNS = /\b(test|vitest|jest|pytest|cargo\s+test|go\s+test|xcodebuild\s+test|gradlew\s+test|pnpm\s+test|npm\s+test)\b/i;

export function computeSignals(store: ApmeStore, runId: string): TaskSignals {
  const run = store.getRun(runId);
  const steps = store.listSteps(runId);

  const toolCounts: Record<string, number> = {};
  let turnCount = 0;
  let planModeUsed = false;
  let permissionRequests = 0;
  let diffReviews = 0;
  let filesCreated = 0;
  let filesModified = 0;
  let testCommandsRun = 0;
  let webSearches = 0;
  let agentDelegations = 0;
  let isAutomated: boolean | undefined;
  const ocToolNames = new Set<string>();

  for (const step of steps) {
    // A pruned row (#302) is still valid JSON, so an unguarded JSON.parse
    // below would silently read the marker's `pruned`/`prunedAt`/`bytes`
    // keys as "this step had no command / no mode / no OpenClaw flags" —
    // true by accident, not by measurement. `kind`-only counters (turn
    // count, permission/diff prompts) don't read the payload at all and
    // stay correct either way; only content extraction is skipped here.
    const contentAvailable = !isPrunedPayload(step.payload);

    if (step.kind === 'PreToolUse' && step.toolName) {
      toolCounts[step.toolName] = (toolCounts[step.toolName] ?? 0) + 1;

      if (step.toolName === 'Write') filesCreated++;
      if (step.toolName === 'Edit') filesModified++;
      if (step.toolName === 'WebSearch' || step.toolName === 'WebFetch') webSearches++;
      if (step.toolName === 'Agent') agentDelegations++;
      if (step.toolName === 'Bash' && contentAvailable) {
        try {
          const payload = JSON.parse(step.payload);
          const cmd = typeof payload.command === 'string' ? payload.command : '';
          if (TEST_PATTERNS.test(cmd)) testCommandsRun++;
        } catch { /* ignore */ }
      }
    }

    if (step.kind === 'UserPromptSubmit') turnCount++;
    if (step.kind === 'permission_prompt') permissionRequests++;
    if (step.kind === 'diff_prompt') diffReviews++;

    // State-based signals from step payloads
    if (contentAvailable) {
      try {
        const payload = JSON.parse(step.payload);
        if (payload.mode === 'plan' || step.kind === 'mode_change') {
          if (typeof payload.mode === 'string' && payload.mode === 'plan') planModeUsed = true;
        }
        // OpenClaw signals
        if (typeof payload.chatIsAutomated === 'boolean') isAutomated = payload.chatIsAutomated;
        if (Array.isArray(payload.chatToolNames)) {
          for (const t of payload.chatToolNames) {
            if (typeof t === 'string') ocToolNames.add(t);
          }
        }
      } catch { /* ignore */ }
    }
  }

  const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  let dominantTool: string | null = null;
  let maxCount = 0;
  for (const [tool, count] of Object.entries(toolCounts)) {
    if (count > maxCount) { maxCount = count; dominantTool = tool; }
  }

  const sessionDurationSec = run?.endedAt && run?.startedAt
    ? Math.round((run.endedAt - run.startedAt) / 1000)
    : 0;

  return {
    toolCounts,
    dominantTool,
    totalToolCalls,
    turnCount,
    sessionDurationSec,
    promptLengthChars: run?.taskPrompt?.length ?? 0,
    planModeUsed,
    permissionRequests,
    diffReviews,
    filesCreated,
    filesModified,
    testCommandsRun,
    webSearches,
    agentDelegations,
    isAutomated: isAutomated ?? undefined,
    ocToolNames: ocToolNames.size > 0 ? [...ocToolNames] : undefined,
  };
}

// ─── Rule-based classifier ──────────────────────────────────────────────────

function toolPct(signals: TaskSignals, ...tools: string[]): number {
  if (signals.totalToolCalls === 0) return 0;
  const sum = tools.reduce((a, t) => a + (signals.toolCounts[t] ?? 0), 0);
  return sum / signals.totalToolCalls;
}

type Rule = { category: TaskCategory; test: (s: TaskSignals) => boolean };

const RULES: Rule[] = [
  // Highest-signal categories first — these have unambiguous markers.
  {
    category: 'multi_agent',
    test: (s) => s.agentDelegations >= 2,
  },
  {
    category: 'planning',
    test: (s) => s.planModeUsed,
  },
  {
    category: 'conversation',
    test: (s) => s.totalToolCalls <= 2 && s.sessionDurationSec < 120,
  },
  {
    category: 'planning',
    test: (s) => s.turnCount >= 1 && s.turnCount <= 3 && s.totalToolCalls <= 5 && s.filesModified === 0 && s.filesCreated === 0,
  },
  {
    category: 'research',
    test: (s) => s.webSearches > 0 || (toolPct(s, 'Grep', 'Glob') > 0.4 && s.filesModified === 0 && s.filesCreated === 0),
  },
  {
    category: 'debugging',
    test: (s) => s.testCommandsRun >= 1 && (s.filesModified > 0 || s.filesCreated > 0) && toolPct(s, 'Bash') > 0.2,
  },
  {
    category: 'refactoring',
    test: (s) => toolPct(s, 'Edit') > 0.5 && s.filesCreated === 0 && s.filesModified >= 3,
  },
  {
    category: 'coding',
    test: (s) => toolPct(s, 'Edit', 'Write') > 0.3 && (s.filesModified >= 1 || s.filesCreated >= 1),
  },
  {
    category: 'review',
    test: (s) => toolPct(s, 'Read') > 0.5 && s.totalToolCalls >= 5 && s.filesModified <= 1 && s.filesCreated === 0,
  },
  {
    category: 'ops',
    test: (s) => toolPct(s, 'Bash') > 0.5 && toolPct(s, 'Edit', 'Write') < 0.2,
  },
];

export function classify(signals: TaskSignals): TaskCategory {
  for (const rule of RULES) {
    if (rule.test(signals)) return rule.category;
  }
  return 'unknown';
}

/** Compute signals + classify in one call, return both. */
export function classifyRun(store: ApmeStore, runId: string): { signals: TaskSignals; category: TaskCategory } {
  const signals = computeSignals(store, runId);
  const category = classify(signals);
  return { signals, category };
}

// ─── LLM-assisted classification (local-only, never a paid backend) ────────
//
// Prompt text, label vocabulary, output cap, timeout and backend try-order
// are the SSOT in shared/src/apme-classifier-rules.ts, generated into Swift
// as ApmeClassifierRules.generated.swift. `task_category` selects the judge
// rubric downstream, so the two daemons picking a different category for the
// same task is a score difference — see #299. `APME_CLASSIFIER_BACKEND_ORDER`
// never contains `api`/`openai`: classification runs on every closed task
// with `unknown` rules, so routing it through a paid backend would bill the
// user for a call the eval pipeline makes silently, whatever judge backend
// they configured for actual eval scoring.

function toolSummaryFor(signals: TaskSignals): string {
  return Object.entries(signals.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, c]) => `${t}×${c}`)
    .join(', ');
}

function classifierUserMessage(taskPrompt: string, signals: TaskSignals): string {
  return buildClassifierUserMessage({
    taskPrompt: taskPrompt.slice(0, 500),
    toolSummary: toolSummaryFor(signals),
    totalToolCalls: signals.totalToolCalls,
    filesModified: signals.filesModified,
    filesCreated: signals.filesCreated,
    sessionDurationSec: signals.sessionDurationSec,
    turnCount: signals.turnCount,
  });
}

/** On-device Apple Intelligence, via the bundled Node helper
 *  (`bridge/src/foundation-models-helper.ts`). Returns null on any failure —
 *  unavailable framework, timeout, out-of-vocabulary answer — never throws;
 *  the caller falls through to the next backend. */
async function classifyWithFoundationModels(userMsg: string): Promise<TaskCategory | null> {
  try {
    const raw = await callFoundationModelsHelper(userMsg, APME_CLASSIFIER_SYSTEM_PROMPT, {
      maxTokens: APME_CLASSIFIER_MAX_TOKENS,
      timeoutMs: APME_CLASSIFIER_TIMEOUT_MS,
    });
    return normalizeClassifierLabel(raw);
  } catch {
    return null;
  }
}

/** Local MLX server (default `http://127.0.0.1:8800`). Cost: $0 (the user
 *  has already paid in GPU watts). Returns null on any failure. */
async function classifyWithMlx(userMsg: string): Promise<TaskCategory | null> {
  try {
    const settings = loadMlxSettings();
    const base = mlxBaseUrl(settings.endpoint);
    const model = settings.model;

    const resp = await guardedMlxFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: APME_CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0,
        max_tokens: APME_CLASSIFIER_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(APME_CLASSIFIER_TIMEOUT_MS),
    });

    if (!resp.ok) return null;
    const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? '';
    return normalizeClassifierLabel(raw);
  } catch {
    return null;
  }
}

/** Dispatch one backend from `APME_CLASSIFIER_BACKEND_ORDER`. `'rules'` is
 *  not a network call — the caller treats a null return from ANY backend
 *  (including this one) as "try the next entry, or give up". Deliberately a
 *  closed switch over the SSOT's own union: adding a backend here means
 *  adding it to `ApmeClassifierBackend`, so `api`/`openai` cannot be reached
 *  without an explicit, reviewable change to this function. */
async function classifyWithBackend(
  backend: ApmeClassifierBackend,
  userMsg: string,
): Promise<TaskCategory | null> {
  switch (backend) {
    case 'foundationModels':
      return classifyWithFoundationModels(userMsg);
    case 'mlx':
      return classifyWithMlx(userMsg);
    case 'rules':
      return null;
    default:
      return null;
  }
}

/**
 * Classify a run using the LLM-assist backend order (SSOT: never `api`/
 * `openai`). Falls back to rule-based classification when every backend is
 * unavailable, unreachable, or answers outside the label vocabulary.
 */
export async function classifyWithLlm(
  taskPrompt: string,
  signals: TaskSignals,
): Promise<TaskCategory> {
  if (!taskPrompt || taskPrompt.trim().length < 5) return classify(signals);

  const userMsg = classifierUserMessage(taskPrompt, signals);
  for (const backend of APME_CLASSIFIER_BACKEND_ORDER) {
    if (backend === 'rules') break;
    const result = await classifyWithBackend(backend, userMsg);
    if (result) return result;
  }
  return classify(signals);
}

/** Classify with LLM if rule-based gives unknown, otherwise use rules. */
export async function classifyRunSmart(
  store: ApmeStore,
  runId: string,
): Promise<{ signals: TaskSignals; category: TaskCategory; source: 'rule' | 'llm' }> {
  const signals = computeSignals(store, runId);
  const ruleCategory = classify(signals);

  if (ruleCategory !== 'unknown') {
    return { signals, category: ruleCategory, source: 'rule' };
  }

  // Rule-based gave unknown — try LLM
  const run = store.getRun(runId);
  const prompt = run?.taskPrompt;
  if (!prompt) return { signals, category: 'unknown', source: 'rule' };

  const llmCategory = await classifyWithLlm(prompt, signals);
  return { signals, category: llmCategory, source: llmCategory !== 'unknown' ? 'llm' : 'rule' };
}
