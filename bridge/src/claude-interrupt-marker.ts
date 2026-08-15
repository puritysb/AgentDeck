/**
 * Claude Code's user-interrupt (ESC) marker — the single predicate.
 *
 * Pressing ESC mid-turn fires NO lifecycle hook at all: no PostToolUse, no
 * Stop, no UserPromptSubmit (verified 2026-07-18, and the reason the awaiting
 * overlay had to fall back to transcript recency). The transcript is therefore
 * the only place a cancel is observable, and it lands as a `user` record whose
 * content is a single text block reading `[Request interrupted by user]` or
 * `[Request interrupted by user for tool use]`.
 *
 * Two consumers need to recognize it — the passive observer (a marker record
 * must not read as a fresh user turn) and the turn watchdog / APME collector
 * (a turn the user cancelled is over, and its missing Stop is a cancel rather
 * than a dropped hook) — so the rule lives here instead of being spelled twice.
 *
 * Text blocks ONLY. A `tool_result` block can quote the marker verbatim (any
 * session that greps its own transcripts produces one), and matching raw line
 * text would turn that quote into a phantom cancel.
 */

const INTERRUPT_MARKER = /\[Request interrupted by user/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Concatenated `text` blocks of a Claude message (string content passes
 *  through). Non-text blocks — `tool_result` above all — are dropped. */
export function claudeMessageText(message: unknown): string {
  if (!isRecord(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => isRecord(b) && b.type === 'text')
    .map((b) => (typeof (b as Record<string, unknown>).text === 'string' ? (b as Record<string, unknown>).text as string : ''))
    .join(' ');
}

/** Does this `message` carry the interrupt marker rather than user prose? */
export function isClaudeInterruptMessage(message: unknown): boolean {
  return INTERRUPT_MARKER.test(claudeMessageText(message));
}

/** Does this transcript RECORD represent a user interrupt? Newer Claude Code
 *  builds also stamp `interruptedMessageId` on the record, which is a
 *  structural signal the marker text cannot drift away from; older ones only
 *  wrote the text, so both are accepted. The role check is what keeps an
 *  assistant quoting the marker from counting. */
export function isClaudeInterruptRecord(record: unknown): boolean {
  if (!isRecord(record)) return false;
  const message = isRecord(record.message) ? record.message : null;
  if (!message || message.role !== 'user') return false;
  if (typeof record.interruptedMessageId === 'string' && record.interruptedMessageId) return true;
  return isClaudeInterruptMessage(message);
}
