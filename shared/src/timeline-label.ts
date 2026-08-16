// timeline-label.ts — the SINGLE source of truth for turning a TimelineEntry
// into its attributed, human-readable row text ("agent · project · task ·
// text").
//
// Before this file, shared/src exposed `agentBrandColor` but NO agent
// display-name function, so every surface (Swift ×5, Kotlin ×2, ESP32 ×4,
// plugin) hand-rolled the same `claude-code → "Claude"` map and its own
// separator convention, and they drifted. The mirrors (Swift
// `SessionFormatters.displayAgentLabel`, Kotlin `EinkFormatUtils`, C++
// `agent_label.h`) must match `agentDisplayLabel` below exactly.
//
// Design: `timelineRowAttribution` returns the STRUCTURED pieces so a
// space-constrained surface (ESP32 ticker, iPhone) can pick which fields to
// show, while roomy surfaces render all four. `formatTimelineRowLabel` joins
// them with the one canonical separator.

import type { TimelineEntry } from './timeline.js';

/** Canonical agent → display-name map. The ONLY place this mapping lives on
 *  the TS side; language mirrors copy it verbatim. Never abbreviate
 *  "OpenClaw" (see memory `brand-direction.md`). */
export function agentDisplayLabel(agentType: string | undefined | null): string {
  switch (agentType) {
    case 'claude-code': return 'Claude';
    case 'openclaw':    return 'OpenClaw';
    case 'codex-cli':   return 'Codex CLI';
    case 'codex-app':   return 'Codex App';
    case 'opencode':    return 'OpenCode';
    case 'antigravity': return 'Antigravity';
    case 'kiro-cli':    return 'Kiro CLI';
    case 'kiro-ide':    return 'Kiro IDE';
    case 'monitor':     return 'Monitor';
    case 'daemon':      return 'Daemon';
    default:
      if (!agentType) return 'Agent';
      // Unknown but non-empty: titlecase the slug so a new agent still reads
      // sensibly instead of collapsing to a generic "Agent".
      return agentType
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/** Compact agent → display-name for very tight surfaces (LED matrix, ticker
 *  when width is scarce). Keeps the brand distinct without the CLI/App suffix. */
export function agentShortLabel(agentType: string | undefined | null): string {
  switch (agentType) {
    case 'codex-cli':
    case 'codex-app':   return 'Codex';
    case 'kiro-cli':
    case 'kiro-ide':    return 'Kiro';
    default:            return agentDisplayLabel(agentType);
  }
}

export interface TimelineRowAttribution {
  /** Resolved agent display name, or undefined when no agent is attributed. */
  agent?: string;
  /** Project / worktree name. */
  project?: string;
  /** Task label — the APME task summary when present, else the task row's
   *  own label; undefined for rows outside a task. */
  task?: string;
  /** The already-summarized row body (`entry.raw`). */
  text: string;
}

/** The task pieces vary: a `task_start`/`task_end` row's own `raw` is the task
 *  label ("Task 1"); a turn row inside a task carries `taskId` but no inline
 *  label, so callers that want a task chip use `taskSummary` when the eval has
 *  produced one. Returns the best available task descriptor. */
function taskDescriptor(entry: TimelineEntry): string | undefined {
  const summary = entry.taskSummary?.trim();
  if (summary) return summary;
  if (entry.type === 'task_start' || entry.type === 'task_end') {
    return entry.raw?.trim() || undefined;
  }
  return undefined;
}

/** Decompose a TimelineEntry into its attributed pieces. Every surface builds
 *  its displayed row from this, so agent/project/task/text stay consistent. */
export function timelineRowAttribution(entry: TimelineEntry): TimelineRowAttribution {
  const agent = entry.agentType ? agentDisplayLabel(entry.agentType) : undefined;
  const project = entry.projectName?.trim() || undefined;
  const task = taskDescriptor(entry);
  const text = (entry.raw ?? '').trim();
  return {
    ...(agent ? { agent } : {}),
    ...(project ? { project } : {}),
    ...(task ? { task } : {}),
    text,
  };
}

export interface FormatTimelineRowOptions {
  /** Which attribution parts to prepend before the text, in order. Defaults
   *  to agent + project (the common glance form). */
  parts?: Array<'agent' | 'project' | 'task'>;
  /** Include the row body text after the attribution. Default true. */
  includeText?: boolean;
  /** Use the compact agent name (ticker/matrix). Default false. */
  short?: boolean;
  /** Separator between attribution parts. Default " · ". */
  separator?: string;
}

/** Canonical joined label. Replaces the divergent "[project] Agent" vs
 *  "project · tag" conventions with one separator (" · ") and an explicit,
 *  caller-chosen part order. Example: "Claude · AgentDeck · Fix eink ticker". */
export function formatTimelineRowLabel(
  entry: TimelineEntry,
  opts: FormatTimelineRowOptions = {},
): string {
  const { parts = ['agent', 'project'], includeText = true, short = false, separator = ' · ' } = opts;
  const attr = timelineRowAttribution(entry);
  const agentText = short ? agentShortLabel(entry.agentType) : attr.agent;
  const pieces: string[] = [];
  for (const p of parts) {
    if (p === 'agent' && agentText) pieces.push(agentText);
    else if (p === 'project' && attr.project) pieces.push(attr.project);
    else if (p === 'task' && attr.task) pieces.push(attr.task);
  }
  if (includeText && attr.text) pieces.push(attr.text);
  return pieces.join(separator);
}
