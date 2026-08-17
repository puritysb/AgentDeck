/**
 * Read the most recent turn's assistant text from a Claude Code transcript
 * JSONL file (path comes from the Stop hook's `transcript_path` field).
 *
 * Why this exists: the `last_assistant_message` field on the Stop hook payload
 * is only ~18% reliable (see DEVELOPMENT_LOG.md note). Pure-tool turns often
 * emit no assistant text, and text-bearing turns sometimes drop the field on
 * the hook boundary. The transcript JSONL is the authoritative source Claude
 * Code itself writes, with one JSON object per line capturing every user /
 * assistant / tool_use / tool_result event.
 *
 * Scope: CLI bridge only. The App Store Swift daemon runs under a sandbox
 * that only grants security-scoped access to `~/.claude/settings.json` — not
 * the per-session `~/.claude/projects/<proj>/<session>.jsonl` files. For that
 * build, Task 2's `response_kind` heuristic (empty text + tool_calls > 0 →
 * `tool_only`) is the fallback.
 */

import { readFileSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { debug } from '../logger.js';
import { isClaudeInterruptRecord } from '../claude-interrupt-marker.js';

export interface LastTurnExcerpt {
  userPrompt: string;
  assistantText: string;
  toolUseCount: number;
  /** Whether the last assistant block(s) contained any `text` content. */
  hasAssistantText: boolean;
}

type JsonlRecord = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

/**
 * Parse the last user→assistant turn from a Claude Code transcript JSONL.
 *
 * Returns `null` on any parse failure (file missing, no user/assistant
 * entries, malformed JSON). Callers treat `null` as "use the other source"
 * — this function never throws.
 *
 * Implementation: read the full file (capped size), walk lines in reverse
 * to find the last `user` role entry, then scan forward collecting the
 * `assistant` entries that follow. `content` on each message is either a
 * string (legacy shape) or an array of blocks with `type: 'text' | 'tool_use'`.
 */
export function readLastTurn(transcriptPath: string): LastTurnExcerpt | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch (err) {
    debug('APME', `transcript read failed: ${String(err)}`);
    return null;
  }
  // Cap the scan to the trailing 512 KB — transcripts can grow large but the
  // last turn is always at the tail. This also bounds worst-case memory.
  const MAX_TAIL = 512 * 1024;
  const tail = raw.length > MAX_TAIL ? raw.slice(raw.length - MAX_TAIL) : raw;
  const lines = tail.split('\n');

  // Walk forward parsing records; we keep the last `user` record index and
  // accumulate assistant records that follow it.
  const records: JsonlRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as JsonlRecord);
    } catch { /* skip malformed line */ }
  }
  if (records.length === 0) return null;

  // Find the last `user` role record by scanning backwards.
  let lastUserIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const role = records[i]?.message?.role;
    if (role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return null;

  const userPrompt = contentToString(records[lastUserIdx]?.message?.content);

  let assistantText = '';
  let toolUseCount = 0;
  for (let i = lastUserIdx + 1; i < records.length; i++) {
    const role = records[i]?.message?.role;
    if (role !== 'assistant') continue;
    const content = records[i]?.message?.content;
    const { text, toolUses } = extractAssistantBlocks(content);
    if (text) {
      assistantText = assistantText ? `${assistantText}\n${text}` : text;
    }
    toolUseCount += toolUses;
  }

  return {
    userPrompt: userPrompt.slice(0, 8_000),
    assistantText: assistantText.slice(0, 10_000),
    toolUseCount,
    hasAssistantText: assistantText.trim().length > 0,
  };
}

/**
 * Extract the model id from a Claude Code transcript JSONL — the last
 * assistant record's `message.model`. Returns `null` when unavailable.
 *
 * Why this exists: direct `claude` runs reach the daemon only via hook POSTs,
 * which never carry the model. Without this, every such run persisted
 * `model_id=NULL` (the bulk of the "unknown" rows in the APME scorecard). The
 * transcript is the authoritative source Claude writes. Never throws.
 */
export function readModelFromTranscript(transcriptPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
  const MAX_TAIL = 512 * 1024;
  const tail = raw.length > MAX_TAIL ? raw.slice(raw.length - MAX_TAIL) : raw;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { message?: { role?: string; model?: string } };
      const model = rec?.message?.model;
      if (rec?.message?.role === 'assistant' && typeof model === 'string' && model) {
        return model;
      }
    } catch { /* skip malformed line */ }
  }
  return null;
}

export interface TurnEndProbe {
  /** Role of the last message-bearing JSONL record. */
  role: string;
  /** `message.stop_reason` on that record (null when absent). */
  stopReason: string | null;
  /** Record `timestamp` in epoch ms (null when absent/unparseable). */
  timestampMs: number | null;
  /** That record is Claude Code's ESC/interrupt marker — the turn is over,
   *  cancelled by the user, and no Stop hook will ever arrive for it. */
  interrupted: boolean;
}

/** `stop_reason` Claude Code writes when the CLIENT ended the turn instead of
 *  the model: usage limit, expired auth, credit limit, an API 429/529. The
 *  record carries the user-facing message ("You've hit your session limit ·
 *  resets 5:50pm") and NO Stop hook follows it — so a turn that ends this way
 *  owes no Stop and must not be charged to the dropped-hook rate.
 *
 *  Measured before it was trusted: across 211 local transcripts holding 61,281
 *  assistant records, `stop_reason` was `tool_use` 58,765 times, `end_turn`
 *  2,513 times, and `stop_sequence` 37 times — every one of those 37 a client
 *  abort message, none followed by a `stop_hook_summary` record, and none
 *  followed by further assistant work in the same turn. There is no benign
 *  shape to confuse it with. */
export const CLIENT_ABORT_STOP_REASON = 'stop_sequence';

/** What a bounded backward walk from the transcript tail can prove about a turn
 *  that is still open. Every field answers a question the next-prompt close has
 *  to ask, and all three come from ONE tail read. */
export interface OpenTurnEvidence {
  /** Newest ESC/interrupt marker in the window (epoch ms), else null. */
  interruptedAt: number | null;
  /** Newest client-abort record in the window (epoch ms), else null. */
  abortedAt: number | null;
  /** Whether the assistant wrote ANYTHING since the window opened. False means
   *  the turn never ran — a second prompt displaced it first. */
  sawAssistant: boolean;
}

/**
 * Probe whether the transcript's most recent turn has finished. A completed
 * turn's last message-bearing record is `role: "assistant"` with
 * `stop_reason: "end_turn"`; mid-turn tails end in `stop_reason: "tool_use"`
 * or a `user` tool_result record. Non-message records (`type: "mode"` etc.)
 * can trail the assistant message, so the walk skips records without a
 * `message.role`. Never throws; returns null when unreadable/empty.
 *
 * The OTHER way a turn ends is the user pressing ESC, which produces no
 * assistant `end_turn` at all — just the interrupt marker record — so
 * `interrupted` is reported alongside, and a caller that only checked for
 * `end_turn` would wait forever on a turn nothing will ever close.
 *
 * Used by the turn watchdog to close a turn whose Stop hook was dropped —
 * the caller must additionally check `timestampMs` against its own turn-open
 * time, because at turn start the tail still shows the PREVIOUS turn's
 * `end_turn`.
 */
export function readTurnEndProbe(transcriptPath: string): TurnEndProbe | null {
  // Unlike the per-Stop readers above, this runs on a POLL (the missed-Stop
  // watchdog, every few seconds while a turn is quiet), and real transcripts
  // reach tens of MB — so read only the trailing bytes through a file
  // descriptor instead of slurping the whole file. Reading from a byte offset
  // can start mid-line; the backward walk already skips lines that fail to
  // parse, which covers the truncated head line.
  const PROBE_TAIL_BYTES = 256 * 1024;
  const tail = readTailString(transcriptPath, PROBE_TAIL_BYTES);
  if (tail == null) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec: {
      timestamp?: string;
      message?: { role?: string; stop_reason?: string | null };
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip malformed (possibly truncated) line
    }
    const role = rec?.message?.role;
    if (!role) continue;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    return {
      role,
      stopReason: rec.message?.stop_reason ?? null,
      timestampMs: Number.isFinite(ts) ? ts : null,
      interrupted: isClaudeInterruptRecord(rec),
    };
  }
  return null;
}

/**
 * Everything a bounded tail read can say about a turn that opened at `sinceMs`
 * and is still open. Returns null when the transcript is unreadable — the
 * absence of evidence, which callers must never resolve as a verdict.
 *
 * Three questions, one read, because the close path that runs at the next
 * prompt has to ask all of them and each answer is a different bucket:
 *
 *  - Did the user cancel? `readTurnEndProbe` only sees the ESC marker while it
 *    is still the tail, and the common shape is "cancel, then immediately
 *    retype", which buries it under the new user message within seconds.
 *  - Did the CLIENT abort (usage limit, auth, API error)? Same burial, and
 *    Claude Code owes no Stop for it either.
 *  - Did the assistant write anything at all? If not, this prompt never got a
 *    turn of its own — a second prompt landed first and one model turn served
 *    both, so the displaced row is a counting artifact, not a lost hook.
 *
 * The backward walk stops at the first record older than the window, so
 * evidence belonging to an earlier turn can neither be found nor paid for.
 */
export function readOpenTurnEvidence(transcriptPath: string, sinceMs: number): OpenTurnEvidence | null {
  const EVIDENCE_TAIL_BYTES = 256 * 1024;
  const tail = readTailString(transcriptPath, EVIDENCE_TAIL_BYTES);
  if (tail == null) return null;
  const evidence: OpenTurnEvidence = { interruptedAt: null, abortedAt: null, sawAssistant: false };
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec: { timestamp?: string; message?: { role?: string; stop_reason?: string | null } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip malformed (possibly truncated) line
    }
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    // A record with no usable timestamp cannot be placed in or out of the
    // window, so it is skipped rather than ending the walk — ending here
    // would let one stampless line hide every marker behind it.
    if (!Number.isFinite(ts)) continue;
    if (ts < sinceMs) break;
    if (evidence.interruptedAt == null && isClaudeInterruptRecord(rec)) evidence.interruptedAt = ts;
    if (rec.message?.role === 'assistant') {
      evidence.sawAssistant = true;
      if (evidence.abortedAt == null && rec.message?.stop_reason === CLIENT_ABORT_STOP_REASON) {
        evidence.abortedAt = ts;
      }
    }
  }
  return evidence;
}

/** Read at most `maxBytes` from the end of a file without loading the rest.
 *  Returns null when the file is unreadable. */
function readTailString(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    if (len === 0) return '';
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf-8');
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // User message `content` can also be an array of blocks (e.g. after a
  // tool_result from the previous turn). Pull out `text` blocks; ignore
  // tool_result payloads which are not the user's natural-language query.
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; content?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function extractAssistantBlocks(content: unknown): { text: string; toolUses: number } {
  if (typeof content === 'string') return { text: content, toolUses: 0 };
  if (!Array.isArray(content)) return { text: '', toolUses: 0 };
  const parts: string[] = [];
  let toolUses = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use') toolUses += 1;
  }
  return { text: parts.join('\n'), toolUses };
}
