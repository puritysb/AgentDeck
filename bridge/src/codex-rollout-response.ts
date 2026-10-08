/**
 * Extract a Codex turn's final response text from its rollout JSONL.
 *
 * Why this exists: observed (direct-run) Codex sessions reach the daemon
 * only through codex_* lifecycle hooks, and `codex_stop`'s stdin payload
 * does not reliably carry the assistant text (the Swift daemon probes
 * `last_assistant_message`/`response`/`output`/`result` and usually finds
 * nothing). The rollout Codex writes under `~/.codex/sessions/` DOES hold
 * it: `event_msg` records of type `agent_message` (`payload.message`) and,
 * at turn end, `task_complete` (`payload.last_agent_message`). This is the
 * Codex counterpart of `lastAssistantTextFromTranscript` for Claude —
 * hooks stay the boundary signal, the agent's own on-disk log supplies the
 * body, and nothing parses terminal output.
 *
 * Self-contained and read-only on purpose (mirrors
 * session-transcript-timeline.ts): never throws, returns '' when nothing
 * is found. Locating scans recent `~/.codex/sessions/<y>/<m>/<d>/` dirs
 * newest-first for `rollout-*-<sessionId>.jsonl` — the filename embeds the
 * session uuid, and scanning across day dirs (bounded) covers turns that
 * roll past midnight (memory: cross-day rollout selection).
 */

import { readdirSync, readFileSync, openSync, readSync, closeSync, fstatSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { debug } from './logger.js';
import { open as openAsync, readdir as readdirAsync } from 'fs/promises';
import { CODEX_OTEL_METADATA_RULES, codexSessionMetaSubagentVerdict } from '@agentdeck/shared';

/** Max day directories to inspect, newest first. */
const MAX_DAY_DIRS = 30;
/** Tail window — final agent_message + task_complete land at the end. */
const TAIL_BYTES = 128 * 1024;

function numericDesc(names: string[]): string[] {
  return names
    .filter((n) => /^\d+$/.test(n))
    .sort((a, b) => Number(b) - Number(a));
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Locate `rollout-*-<sessionId>.jsonl` under the newest day dirs. */
export function locateCodexRollout(sessionId: string, sessionsRoot?: string): string | null {
  if (!sessionId || !/^[0-9a-f-]{8,}$/i.test(sessionId)) return null;
  const root = sessionsRoot ?? join(homedir(), '.codex', 'sessions');
  const suffix = `-${sessionId}.jsonl`;
  let dayDirsChecked = 0;
  for (const year of numericDesc(safeReaddir(root))) {
    for (const month of numericDesc(safeReaddir(join(root, year)))) {
      for (const day of numericDesc(safeReaddir(join(root, year, month)))) {
        if (++dayDirsChecked > MAX_DAY_DIRS) return null;
        const dir = join(root, year, month, day);
        for (const name of safeReaddir(dir)) {
          if (name.startsWith('rollout-') && name.endsWith(suffix)) {
            return join(dir, name);
          }
        }
      }
    }
  }
  return null;
}

/** OTel must not walk/read the rollout on the span dispatch executor. Read
 * only the immutable first line asynchronously; undefined means unreadable. */
export async function codexRolloutIsSubagent(sessionId: string, sessionsRoot?: string): Promise<boolean | undefined> {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return undefined;
  const root = sessionsRoot ?? join(homedir(), '.codex', 'sessions');
  const list = async (path: string): Promise<string[]> => readdirAsync(path).catch(() => []);
  let checked = 0;
  for (const year of numericDesc(await list(root))) {
    for (const month of numericDesc(await list(join(root, year)))) {
      for (const day of numericDesc(await list(join(root, year, month)))) {
        if (++checked > MAX_DAY_DIRS) return undefined;
        const dir = join(root, year, month, day);
        const name = (await list(dir)).find(name => name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`));
        if (!name) continue;
        try {
          const handle = await openAsync(join(dir, name), 'r');
          try {
            const buffer = Buffer.alloc(CODEX_OTEL_METADATA_RULES.headBytes);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const bytes = buffer.subarray(0, bytesRead);
            const newline = bytes.indexOf(10);
            if (newline < 0 && bytesRead === buffer.length) return undefined;
            const record = JSON.parse(bytes.subarray(0, newline < 0 ? bytesRead : newline).toString('utf8'));
            if (record?.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) return undefined;
            if (typeof record.payload.id !== 'string' || record.payload.id !== sessionId) return undefined;
            return codexSessionMetaSubagentVerdict(record.payload);
          } finally { await handle.close(); }
        } catch { return undefined; }
      }
    }
  }
  return undefined;
}

function readTail(path: string, maxBytes: number): string {
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    try {
      return readFileSync(path, 'utf-8').slice(-maxBytes);
    } catch {
      return '';
    }
  }
}

/**
 * What the rollout says happened on a turn.
 *
 * A turn ends one of two ways and the tail records both, but only one used to
 * be read. `text` is the assistant's reply; `error` is the failure Codex wrote
 * instead — quota exhausted, a model the account may not use, a stream that
 * died. Codex does not run its `Stop` hook on a failed turn, so this file is
 * the ONLY place the failure is observable, and dropping it is what left a
 * turn spinning with its cause sitting unread on disk (issue: "ChatGPT free
 * request fails, timeline stays in progress").
 */
export interface CodexTurnOutcome {
  /** Assistant reply, empty when the turn produced none. */
  text: string;
  /** Human-readable failure text, when the turn ended in one. */
  error?: string;
  /** Codex's own classification, e.g. `usage_limit_exceeded`. */
  errorKind?: string;
}

/** Longest error text worth carrying onto a timeline row. */
const MAX_ERROR_CHARS = 400;

function cleanErrorText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  if (!text) return undefined;
  // Codex nests the upstream JSON body inside `message` for HTTP failures.
  // The useful sentence is the inner `message`; the envelope is noise.
  if (text.startsWith('{')) {
    try {
      const inner = JSON.parse(text) as Record<string, unknown>;
      const nested = (inner.message ?? (inner.error as Record<string, unknown> | undefined)?.message);
      if (typeof nested === 'string' && nested.trim()) text = nested.trim();
    } catch { /* not JSON after all — keep the raw text */ }
  }
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/**
 * Parse the rollout tail for how the turn ended, newest record first.
 *
 * The scan stops at the turn's own opening record (`task_started` /
 * `user_message`). Without that stop a failed turn — which contributes no
 * `agent_message` of its own — kept walking into the PREVIOUS turn and
 * returned its reply as this one's, quietly attributing old text to a request
 * that never produced any.
 */
export function codexTurnOutcomeFromRollout(sessionId: string, sessionsRoot?: string): CodexTurnOutcome {
  const path = locateCodexRollout(sessionId, sessionsRoot);
  if (!path) return { text: '' };
  return codexTurnOutcomeFromRolloutPath(path);
}

/**
 * Same read, from a path the caller already holds. Codex's own hooks carry
 * `transcript_path`, and for Codex that path IS the rollout — so the daemon
 * need not locate it by id. (It used to hand that path to the CLAUDE
 * transcript reader instead, which returned '' for every Codex turn: 3 of
 * 128 codex stop-turns in a week held a response, measured 2026-09-03.)
 */
export function codexTurnOutcomeFromRolloutPath(path: string): CodexTurnOutcome {
  const lines = readTail(path, TAIL_BYTES).split('\n');
  let text = '';
  let error: string | undefined;
  let errorKind: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn first line of the tail window
    }
    if (record.type !== 'event_msg') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;

    // Turn boundary — everything above belongs to an earlier turn.
    if (payload.type === 'task_started' || payload.type === 'user_message') break;

    if (payload.type === 'error') {
      error ??= cleanErrorText(payload.message);
      if (typeof payload.codex_error_info === 'string') errorKind ??= payload.codex_error_info;
      continue;
    }

    if (payload.type === 'task_complete') {
      const failure = payload.error as Record<string, unknown> | undefined;
      if (failure && typeof failure === 'object') {
        error ??= cleanErrorText(failure.message);
        if (typeof failure.codex_error_info === 'string') errorKind ??= failure.codex_error_info;
      }
      if (typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
        return { text: payload.last_agent_message.trim(), error, errorKind };
      }
      continue;
    }

    if (!text && payload.type === 'agent_message'
        && typeof payload.message === 'string' && payload.message.trim()) {
      text = payload.message.trim();
      // task_complete always FOLLOWS agent_message, so scanning backwards past
      // this point can only reach older records.
      break;
    }
  }

  if (!text && !error) debug('codex-rollout', `no agent_message or error in tail of ${path}`);
  return { text, error, errorKind };
}

/** What the rollout proves about a turn that opened at or after `sinceMs`. */
export interface CodexTurnCompletion {
  /** Rollout record timestamp of the `task_complete`, epoch ms. */
  completedAt: number;
  /** `last_agent_message` of that record, empty when Codex wrote none. */
  text: string;
  /** The failure Codex wrote on that record, when the turn ended in one
   *  (an API 404, a usage limit). Such a turn fires no Stop hook at all —
   *  measured 2026-09-03, six consecutive turns against a dead endpoint all
   *  reached the next prompt open and read as dropped hooks. */
  error?: string;
  /** Codex's own classification of that failure, e.g. `usage_limit_exceeded`. */
  errorKind?: string;
}

/**
 * Did the turn that started at or after `sinceMs` COMPLETE, per the rollout?
 *
 * The rollout is Codex's own record of the turn, written by the process that
 * ran it, so it can answer a question no hook can: whether a turn whose Stop
 * never reached this daemon nevertheless finished. The daemon needs that
 * answer exactly once — at startup, for a turn it finds still open in the
 * store. Measured 2026-09-03: of 52 turns the reaper had closed under an open
 * state, 45 straddled a daemon restart, and the rollouts behind them held a
 * `task_complete` for every one; the Stop had been posted to a port nobody
 * was listening on.
 *
 * Reads the tail newest-first and stops at the first record older than
 * `sinceMs` (records carry their own ISO `timestamp`), so a completion
 * belonging to an EARLIER turn can never be returned for this one — the same
 * discipline as the Claude transcript probe. A `task_started` newer than the
 * completion means a further turn opened after it; the completion still
 * stands for the turn asked about. Never throws; null means "no evidence",
 * which callers must not resolve as a verdict.
 */
export function codexTurnCompletionSince(sessionId: string, sinceMs: number, sessionsRoot?: string): CodexTurnCompletion | null {
  const path = locateCodexRollout(sessionId, sessionsRoot);
  if (!path) return null;
  const lines = readTail(path, TAIL_BYTES).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn first line of the tail window
    }
    const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    // A record older than the turn: everything above it is older still.
    if (Number.isFinite(ts) && ts < sinceMs) return null;
    if (record.type !== 'event_msg') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object' || payload.type !== 'task_complete') continue;
    if (!Number.isFinite(ts)) continue; // a completion with no time cannot be placed
    const text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message.trim() : '';
    const failure = payload.error as Record<string, unknown> | undefined;
    const error = failure && typeof failure === 'object' ? cleanErrorText(failure.message) : undefined;
    const errorKind = failure && typeof failure === 'object' && typeof failure.codex_error_info === 'string'
      ? failure.codex_error_info
      : undefined;
    return { completedAt: ts, text, ...(error ? { error } : {}), ...(errorKind ? { errorKind } : {}) };
  }
  return null;
}

/**
 * Back-compat shim: the turn's reply text only.
 * Prefer `codexTurnOutcomeFromRollout`, which also reports failures.
 */
export function lastAgentMessageFromCodexRollout(sessionId: string, sessionsRoot?: string): string {
  return codexTurnOutcomeFromRollout(sessionId, sessionsRoot).text;
}
