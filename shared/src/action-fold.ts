/**
 * action-fold.ts — the SINGLE source of truth for folding a task's tool
 * activity into one summary line: `Edit×9 Read×24 Bash×11 +2 · 3 files`.
 *
 * A task detail used to enumerate turns and steps; a list row has no room for
 * that, and a bare total ("44 tools") says nothing about the SHAPE of the
 * work. The fold is a pure projection over per-tool counts the store already
 * holds (sample_events kind='tool' grouped by tool_name) — no schema change,
 * no new collection.
 *
 * Consumers (keep in the same commit):
 *   - GET /apme/tasks response `actionFold` field (bridge/src/apme/http.ts)
 */

export interface ActionFoldInput {
  /** Per-tool call counts, any order. Names are the raw tool names the agent
   *  reported (`Read`, `Bash`, `mcp__server__tool`). */
  tools: ReadonlyArray<{ name: string; count: number }>;
  /** Distinct files the task touched (modified + created), when known. */
  filesTouched?: number | null;
}

/** How many named tools the fold shows before collapsing the rest to `+N`.
 *  Four keeps the line inside one row beside its chips at the dashboard's
 *  default width. */
export const ACTION_FOLD_MAX_TOOLS = 4;

/** `mcp__claude-in-chrome__navigate` → `navigate`: the server prefix is
 *  provenance, not shape, and at row width it would crowd out every other
 *  tool. Non-MCP names pass through unchanged. */
export function foldToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().startsWith('mcp__')) return trimmed;
  const segments = trimmed.split('__').filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : trimmed;
}

/** Tool names that DISPATCH another agent (fan-out). Measured on the real
 *  store 2026-08-28: `Agent` (Claude Code subagent tool, 126 calls), `Task`
 *  (its pre-rename spelling), `task` (OpenCode's), `Workflow` (multi-agent
 *  orchestration — counted as ONE dispatch per call even though it fans out
 *  internally, because parent-side hooks see only the call). TaskCreate /
 *  TaskUpdate and friends are todo bookkeeping, not dispatch. */
export const DISPATCH_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task', 'task', 'Workflow']);

/** Tool names that MESSAGE another agent (peer/teammate traffic). */
export const MESSAGING_TOOL_NAMES: ReadonlySet<string> = new Set(['SendMessage']);

export interface AgentCoordinationSummary {
  /** Subagent/workflow dispatch calls in this task. */
  dispatches: number;
  /** Agent-to-agent messages sent from this task. */
  messages: number;
}

/**
 * Count the coordination shape of a task from its per-tool counts: how often
 * it fanned out to other agents and how often it messaged them. Returns null
 * when the task did neither, so a plain single-agent task renders no
 * coordination chip at all. Matches on RAW tool names (before `foldToolName`),
 * since the dispatch/messaging sets are exact names, not display shapes.
 */
export function agentCoordinationSummary(
  tools: ReadonlyArray<{ name: string; count: number }>,
): AgentCoordinationSummary | null {
  let dispatches = 0;
  let messages = 0;
  for (const t of tools) {
    if (!(t.count > 0)) continue;
    if (DISPATCH_TOOL_NAMES.has(t.name.trim())) dispatches += t.count;
    if (MESSAGING_TOOL_NAMES.has(t.name.trim())) messages += t.count;
  }
  if (dispatches === 0 && messages === 0) return null;
  return { dispatches, messages };
}

/**
 * Fold tool counts into the summary line. Returns null when there is nothing
 * to say (no tools and no files) — callers render nothing rather than an
 * empty string, matching the retain-on-absent display rules elsewhere.
 *
 * Determinism: ties sort by name so the same task always folds to the same
 * line (renderer output is used as identity in dedup paths — see the
 * session-slot renderer rule in AGENTS.md). The tie-break is a plain
 * code-unit compare, NOT localeCompare: localeCompare's order depends on the
 * host locale (and case-folds, so `Bash` vs `apply` flips), which both breaks
 * determinism across machines and cannot be mirrored by Swift's `<`.
 */
export function foldActionCounts(input: ActionFoldInput): string | null {
  const merged = new Map<string, number>();
  for (const t of input.tools) {
    const name = foldToolName(t.name);
    if (!name || !(t.count > 0)) continue;
    merged.set(name, (merged.get(name) ?? 0) + t.count);
  }
  const sorted = [...merged.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts: string[] = [];
  if (sorted.length > 0) {
    const shown = sorted.slice(0, ACTION_FOLD_MAX_TOOLS);
    const rest = sorted.length - shown.length;
    parts.push(shown.map(([name, count]) => `${name}×${count}`).join(' ') + (rest > 0 ? ` +${rest}` : ''));
  }
  const files = input.filesTouched ?? 0;
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}
