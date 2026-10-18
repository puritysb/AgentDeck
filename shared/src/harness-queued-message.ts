/**
 * Prompts that nobody typed: messages Claude Code queues for a session.
 *
 * A background task finishing (`<task-notification>`), a subagent handing its
 * result back (`<agent-message from=…>`) and another session's SendMessage
 * (`<cross-session-message from=…>`) all reach the model as user prompts.
 * Claude Code queues each one and delivers it at the next tool boundary of a
 * RUNNING turn — or as a new turn when the session is idle — and fires
 * `UserPromptSubmit` either way. Measured 2026-10-18: a task notification
 * consumed mid-turn fired the hook at 00:32:53.826Z, and the transcript's
 * `queued_command` attachment for it was written only after the queue removal
 * at 00:32:54.302Z, so at hook time the envelope in the prompt is the only
 * evidence that the message was queued rather than typed.
 *
 * The envelope is matched at the very start of the prompt (after whitespace),
 * as a tag name followed by `>` or whitespace: a prompt that merely quotes one
 * of these tags further in is the user's own text.
 */

export const HARNESS_QUEUED_MESSAGE_TAGS = [
  'task-notification',
  'agent-message',
  'cross-session-message',
] as const;

export type HarnessQueuedMessageTag = typeof HARNESS_QUEUED_MESSAGE_TAGS[number];

const QUEUED_MESSAGE_RE = new RegExp(`^<(${HARNESS_QUEUED_MESSAGE_TAGS.join('|')})[\\s>]`, 'i');

/** Which queued envelope opens `prompt`, or null when a person typed it.
 *  Absent or non-string input is not one. */
export function harnessQueuedMessageTag(prompt: unknown): HarnessQueuedMessageTag | null {
  if (typeof prompt !== 'string') return null;
  const match = QUEUED_MESSAGE_RE.exec(prompt.trimStart());
  return match ? match[1]!.toLowerCase() as HarnessQueuedMessageTag : null;
}

/** True when `prompt` is a message Claude Code queued rather than one a
 *  person typed. Absent or non-string input is not one. */
export function isHarnessQueuedMessage(prompt: unknown): boolean {
  return harnessQueuedMessageTag(prompt) !== null;
}
