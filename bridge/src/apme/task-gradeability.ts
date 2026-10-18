/**
 * Which closed tasks the judge may score at all.
 *
 * The task rollup judge used to run on anything that carried text, and "text"
 * included the user's own prompts — so a task whose agent never answered was
 * scored against silence, a task whose only turn ended in a usage-limit abort
 * was scored on the abort notice ("Failed to send notifications due to
 * repeated session limits", 0%), and a `hello` was scored as a failed
 * planning task. Measured over one week (2026-09-03): 69 of 182 judged tasks
 * held no agent reply, at a mean 0.59 that then ranked beside real work on
 * the scorecard and floated to the top of the Work board's attention sort.
 *
 * A verdict about the agent's work needs the agent's work. This is the ONE
 * place that says what counts, so the runner and the reaper's enqueue gate
 * cannot drift apart. Reasons are surfaced on the task row rather than
 * silently skipped — a task the judge declined must say why, or "unjudged"
 * reads as a backlog.
 */

import { harnessQueuedMessageTag, type HarnessQueuedMessageTag, type TurnEndSource } from '@agentdeck/shared';

export type NotGradeableReason =
  /** No turn carries an agent reply and the tool trajectory is too thin to
   *  stand in for one — nothing to judge. */
  | 'no_reply'
  /** Every turn ended in a client abort (usage limit, auth, API error); the
   *  only "reply" is the abort notice, which is not the agent's work. */
  | 'aborted_only'
  /** A single tool-less exchange too short to be a task (a greeting). */
  | 'trivial'
  /** Every turn was opened by a `<task-notification>`: a background job the
   *  session started, reporting back after the task that started it had
   *  closed. Nobody asked for anything, so there is no request to grade the
   *  work against. */
  | 'notification_only';

export type TaskGradeability =
  | { gradeable: true }
  | { gradeable: false; reason: NotGradeableReason };

/** Turn rows as `listTurnsForTask` returns them (snake_case columns). */
export interface GradeabilityTurn {
  prompt?: unknown;
  response?: unknown;
  tool_calls?: unknown;
  files_modified?: unknown;
  files_created?: unknown;
  end_source?: unknown;
  efficiency_json?: unknown;
}

/** A task with no captured reply is still the agent's work when its tool
 *  trajectory says so: this many tool calls, or any file written. Headless
 *  and workflow agents (`claude -p`, subagents) routinely end on a Write or
 *  a Bash with no closing prose, and the judge reads their trajectory — the
 *  first cut of this rule declined 67 such tasks as "no reply" and withdrew
 *  verdicts that had been sound. */
export const WORK_EVIDENCE_MIN_TOOL_CALLS = 3;

/** Longest prompt AND longest reply, in characters, for a tool-less
 *  single-turn task to still count as a greeting rather than a task. Twelve
 *  covers "hello", "thanks", "안녕", "테스트" and stops short of the shortest
 *  real instruction seen ("add a feature", 13). */
export const TRIVIAL_PROMPT_MAX_CHARS = 12;
export const TRIVIAL_REPLY_MAX_CHARS = 200;

/** The queued envelope a finished background job arrives in. A task opened
 *  only by these has no request: measured over 30 days (2026-10-18), 70 of
 *  414 Claude tasks were notification-only and 64 of them had been judged, at
 *  a mean 0.77 against 0.91 for the rest. 81 of the 93 tasks made only of
 *  queued messages followed a task the 15-minute idle gap had closed while
 *  the background job it started was still running. A task opened by another
 *  session's message (`cross-session-message`) stays gradeable: that message
 *  is a request, from an agent. */
export const NOTIFICATION_ENVELOPE_TAG: HarnessQueuedMessageTag = 'task-notification';

const CLIENT_ENDED: ReadonlySet<TurnEndSource> = new Set(['aborted']);

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function toolCalls(t: GradeabilityTurn): number {
  return typeof t.tool_calls === 'number' ? t.tool_calls : 0;
}

function filesTouched(t: GradeabilityTurn): number {
  const m = typeof t.files_modified === 'number' ? t.files_modified : 0;
  const c = typeof t.files_created === 'number' ? t.files_created : 0;
  return m + c;
}

/** `response_kind` as the collector tagged it, else derived from the row. */
function hasTextReply(t: GradeabilityTurn): boolean {
  const raw = t.efficiency_json;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const k = (JSON.parse(raw) as { response_kind?: unknown }).response_kind;
      if (k === 'tool_only' || k === 'empty') return false;
      if (k === 'text') return text(t.response).length > 0;
    } catch { /* fall through */ }
  }
  return text(t.response).length > 0;
}

export function taskGradeability(turns: readonly GradeabilityTurn[]): TaskGradeability {
  if (turns.length === 0) return { gradeable: false, reason: 'no_reply' };
  if (turns.every((t) => harnessQueuedMessageTag(t.prompt) === NOTIFICATION_ENVELOPE_TAG)) {
    return { gradeable: false, reason: 'notification_only' };
  }
  const worked = turns.filter((t) => !CLIENT_ENDED.has(t.end_source as TurnEndSource));
  if (worked.length === 0) return { gradeable: false, reason: 'aborted_only' };
  const replied = worked.filter(hasTextReply);
  if (replied.length === 0) {
    const tools = worked.reduce((n, t) => n + toolCalls(t), 0);
    const files = worked.reduce((n, t) => n + filesTouched(t), 0);
    if (tools < WORK_EVIDENCE_MIN_TOOL_CALLS && files === 0) return { gradeable: false, reason: 'no_reply' };
  }
  if (
    worked.length === 1 &&
    toolCalls(worked[0]!) === 0 &&
    text(worked[0]!.prompt).length <= TRIVIAL_PROMPT_MAX_CHARS &&
    text(worked[0]!.response).length <= TRIVIAL_REPLY_MAX_CHARS
  ) {
    return { gradeable: false, reason: 'trivial' };
  }
  return { gradeable: true };
}

/** Withdraw every verdict in the window that the gradeability rule would not
 *  have allowed — the judge's own past output, re-read under the rule it now
 *  applies. Idempotent: a retracted row carries `notGradeable` and is not
 *  offered again. Returns how many were withdrawn, by reason. */
export function retractUngradeableVerdicts(
  store: {
    listJudgedTasks(sinceMs: number): Array<{ id: string }>;
    listDeclinedTasks(sinceMs: number): Array<{ id: string }>;
    listTurnsForTask(taskId: string): GradeabilityTurn[];
    retractTaskVerdict(taskId: string, reason: string): void;
    readmitTask(taskId: string): void;
  },
  sinceMs: number,
): Record<NotGradeableReason, number> & { readmitted: number } {
  const out = { no_reply: 0, aborted_only: 0, trivial: 0, notification_only: 0, readmitted: 0 };
  for (const { id } of store.listJudgedTasks(sinceMs)) {
    const g = taskGradeability(store.listTurnsForTask(id));
    if (g.gradeable) continue;
    store.retractTaskVerdict(id, g.reason);
    out[g.reason]++;
  }
  // The rule can also LOOSEN (it did once — see WORK_EVIDENCE_MIN_TOOL_CALLS):
  // a task declined under the stricter reading goes back to the backlog.
  for (const { id } of store.listDeclinedTasks(sinceMs)) {
    if (!taskGradeability(store.listTurnsForTask(id)).gradeable) continue;
    store.readmitTask(id);
    out.readmitted++;
  }
  return out;
}

/** What the Work board prints beside a task the judge declined. */
export const NOT_GRADEABLE_LABEL: Record<NotGradeableReason, string> = {
  no_reply: 'no reply captured',
  aborted_only: 'ended by the client (limit / auth / API)',
  trivial: 'trivial exchange',
  notification_only: 'background-task notice, no request',
};

/** The `notes_json` shape written for a declined task, so the row can say
 *  why. Kept separate from the judge's `{reasoning, done, missed}` shape. */
export function notGradeableNotes(reason: NotGradeableReason): string {
  return JSON.stringify({ notGradeable: reason });
}

/** Read the reason back off a task row's `notes_json`, if that is what it holds. */
export function readNotGradeable(notesJson: unknown): NotGradeableReason | null {
  if (typeof notesJson !== 'string' || notesJson.length === 0) return null;
  try {
    const r = (JSON.parse(notesJson) as { notGradeable?: unknown }).notGradeable;
    return r === 'no_reply' || r === 'aborted_only' || r === 'trivial' || r === 'notification_only' ? r : null;
  } catch {
    return null;
  }
}
