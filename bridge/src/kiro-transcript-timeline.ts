/**
 * Detail-view timeline rows for a passively-observed Kiro session, read from
 * Kiro's own transcript.
 *
 * Why this exists: an observed Kiro session shows up in `sessions_list` (so the
 * deck and the boards can render it) but produces **no timeline rows at all**.
 * Two independent reasons, both measured on 2026-08-17:
 *
 *  - No `kiro_*` hook has ever reached this daemon. The v3 hook file is
 *    installed, but the count in the daemon log is zero — v2 has no global
 *    standalone hook surface at all, so a v2 session is process/store observed
 *    and silent by construction.
 *  - The existing fallback (`transcriptTimelineForSession`) searches
 *    `~/.claude/projects/**` only, so for a Kiro session it can never hit.
 *
 * The result was a Detail view that stayed empty no matter what the session
 * did. Fixing the id normalization (#216) was necessary and not sufficient:
 * ids matched afterwards, and there was still nothing to match them against.
 *
 * Scope: Kiro CLI **v3**, whose sessions are JSONL under
 * `KIRO_HOME/sessions/**\/<uuid>.jsonl`. v2 keeps its conversations in
 * `kiro-cli/data.sqlite3` and is NOT read here — a v2 session returns nothing,
 * exactly as before, rather than a guess.
 *
 * The record shapes below were read off a real transcript, never invented.
 * This repo has a specific history of Kiro parsers written against imagined
 * fixtures that passed their tests and matched nothing real, so the test file
 * for this module pins the measured shape:
 *
 *   {"version":"v1","kind":"Prompt","data":{"message_id":…,
 *     "content":[{"kind":"text","data":"hi"}],"meta":{"timestamp":1786933404}}}
 *   {"version":"v1","kind":"AssistantMessage","data":{"message_id":…,
 *     "content":[{"kind":"thinking",…},{"kind":"text","data":"Hi! …"}]}}
 *   {"version":"v1","kind":"ToolResults","data":{"content":[{"kind":"toolResult",…}]}}
 *
 * Two properties of that shape drive the code:
 *  - `meta.timestamp` is in **SECONDS**, and TimelineEntry.ts is milliseconds.
 *  - Only `Prompt` carries a timestamp. An `AssistantMessage` has none, so its
 *    row is stamped with the prompt it answers — the turn's time, which is the
 *    only defensible reading — plus a 1 ms nudge so it sorts after it.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { TimelineEntry } from '@agentdeck/shared';
import { rawSessionId } from '@agentdeck/shared';
import { kiroV3SessionsRoot } from './kiro-session.js';
import { debug } from './logger.js';

/** Cap on transcript bytes read, matching the Claude reader's posture. */
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Directories scanned under the sessions root (workspace-hash dirs + `cli`). */
const MAX_SCAN_DIRS = 250;

export interface KiroTimelineOptions {
  /** Epoch-ms lower bound; rows at or before it are dropped. */
  since?: number;
  /** Newest N rows kept. */
  limit?: number;
  /** Injectable for tests. */
  sessionsRoot?: string;
}

/** Locate `<uuid>.jsonl` under the v3 sessions root. */
function locateKiroTranscript(uuid: string, root: string): string | null {
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: 'utf-8' }).slice(0, MAX_SCAN_DIRS);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(root, entry.name, `${uuid}.jsonl`);
    try {
      const st = statSync(candidate);
      if (st.isFile() && st.size <= MAX_TRANSCRIPT_BYTES) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { kind?: string; data?: unknown };
    // `thinking` blocks carry an object and are not user-facing; `text` blocks
    // carry the string. Anything else (toolResult…) is not a chat row.
    if (b.kind === 'text' && typeof b.data === 'string') parts.push(b.data);
  }
  return parts.join('\n').trim();
}

function firstLine(text: string, cap = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

/**
 * Chat rows for one Kiro session, oldest-first. Returns `[]` for anything it
 * cannot read — a missing transcript, a v2 session, an unparseable line — so
 * the caller falls back to "no recent activity" rather than to a guess.
 */
export function kiroTimelineForSession(
  sessionId: string,
  opts: KiroTimelineOptions = {},
): TimelineEntry[] {
  const uuid = rawSessionId(sessionId);
  if (!uuid) return [];
  const root = opts.sessionsRoot ?? kiroV3SessionsRoot();
  const path = locateKiroTranscript(uuid, root);
  if (!path) {
    debug('daemon', `kiro-timeline: no v3 transcript for ${uuid}`);
    return [];
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    debug('daemon', `kiro-timeline read failed: ${String(err)}`);
    return [];
  }

  const rows: TimelineEntry[] = [];
  // Carried across records: an AssistantMessage has no timestamp of its own, so
  // it is stamped with the prompt it answers.
  let turnTs = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: { kind?: string; data?: { content?: unknown; meta?: { timestamp?: unknown } } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a truncated tail line is normal on a live session
    }
    const content = rec.data?.content;
    if (rec.kind === 'Prompt') {
      const stamp = rec.data?.meta?.timestamp;
      // Seconds on the wire, milliseconds in TimelineEntry.
      if (typeof stamp === 'number' && Number.isFinite(stamp)) turnTs = stamp * 1000;
      const text = textOf(content);
      if (!turnTs || !text) continue;
      rows.push({
        ts: turnTs,
        type: 'chat_start',
        raw: firstLine(text),
        detail: text.slice(0, 4000),
        agentType: 'kiro-cli',
        sessionId: uuid,
      });
    } else if (rec.kind === 'AssistantMessage') {
      const text = textOf(content);
      if (!turnTs || !text) continue;
      rows.push({
        ts: turnTs + 1, // sorts after its prompt; the record carries no time
        type: 'chat_response',
        raw: firstLine(text),
        detail: text.slice(0, 4000),
        agentType: 'kiro-cli',
        sessionId: uuid,
        summaryKind: 'heuristic',
      });
    }
  }

  const since = opts.since;
  const filtered = since == null ? rows : rows.filter((r) => r.ts > since);
  filtered.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const limit = opts.limit ?? 16;
  return filtered.slice(-limit);
}
