/** Read-only HTTP projections shared by the worker and route fixtures. */
import { agentCoordinationSummary, deriveTaskTitle, foldActionCounts, EVAL_SCHEMA_VERSION, COLLABORATION_PRESENTATION } from '@agentdeck/shared';
import type { ApmeTaskView } from '@agentdeck/shared';
import type { ApmeStore } from './store.js';
import { readNotGradeable } from './task-gradeability.js';

export type HistoryKind = 'tasks' | 'communications';
const TASK_VIEWS: readonly ApmeTaskView[] = ['attention', 'inprogress', 'judged', 'reported', 'orphaned'];

export function historyProjection(store: ApmeStore, kind: HistoryKind, params: URLSearchParams): unknown {
  if (!store.enabled) throw new Error('APME history store unavailable');
  if (kind === 'communications') {
    const policy = COLLABORATION_PRESENTATION.network;
    const capturedAt = Date.now();
    const since = capturedAt - policy.historyWindowMs;
    const events = store.listCommunicationEvents(since, policy.eventLimit + 1, capturedAt);
    return { schema: 'agentdeck-communications/v1', capturedAt, since,
      truncated: events.length > policy.eventLimit,
      events: events.slice(0, policy.eventLimit).map(e => ({ ...e,
        detail: typeof e.detail === 'string' ? [...e.detail].slice(0, policy.detailCharacters).join('') : null,
      })) };
  }
  const limit = clampInt(params.get('limit'), 1, 500, 50);
  const offset = clampInt(params.get('offset'), 0, 1_000_000, 0);
  const stateParam = params.get('state');
  const viewParam = params.get('view');
  const view = TASK_VIEWS.find((v) => v === viewParam);
  const filters = {
    ...(params.get('agent') ? { agentType: params.get('agent')! } : {}),
    ...(params.get('session') ? { sessionId: params.get('session')! } : {}),
    ...(params.get('project') ? { projectName: params.get('project')! } : {}),
    ...(params.get('category') ? { category: params.get('category')! } : {}),
    ...(params.get('outcome') ? { outcome: params.get('outcome')! } : {}),
    ...(params.get('q') ? { q: params.get('q')! } : {}),
  };
  const { total, tasks } = store.listTaskPage({
    limit, offset,
    ...filters,
    ...(stateParam === 'closed' || stateParam === 'open' ? { state: stateParam } : {}),
    ...(view ? { view } : {}),
    // Attention-first is the Work board's ordering and ONLY the Work
    // board's — every other listTaskPage consumer keeps pure recency.
    ...(params.get('sort') === 'attention' ? { order: 'attention' as const } : {}),
  });
  // Work-board display projections, enriched here so the store keeps
  // returning raw facts: intent title (deriveTaskTitle SSOT — the same
  // rules that name the timeline's task_start header, over the task's OWN
  // first prompt, never the run fallback) and the folded action line
  // (foldActionCounts SSOT) over one grouped tool query.
  const toolCounts = store.toolCountsForTasks(tasks.map((t) => t.id));
  const enriched = tasks.map((t) => {
    const tools = toolCounts.get(t.id) ?? [];
    return {
      ...t,
      title: deriveTaskTitle(t.ownFirstPrompt),
      actionFold: foldActionCounts({ tools, filesTouched: t.filesTouched }),
      coordination: agentCoordinationSummary(tools),
      // Why the judge declined, when it did — so "unjudged" never reads
      // as a backlog for a task nobody can score.
      notGradeable: readNotGradeable((t as { notesJson?: unknown }).notesJson),
    };
  });
  return {
    schema: EVAL_SCHEMA_VERSION,
    total, limit, offset, tasks: enriched,
    facets: store.taskFacets(),
    // Badges honor the same narrowing filters as the rows.
    viewCounts: store.taskViewCounts(filters),
  };
}

function clampInt(s: string | null, min: number, max: number, dflt: number): number {
  if (!s) return dflt;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}
