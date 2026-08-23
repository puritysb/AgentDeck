/**
 * Timeline rows read from OpenClaw's OWN on-disk session store.
 *
 * WHY THIS EXISTS. OpenClaw reaches this daemon through the Gateway WebSocket
 * event stream and nothing else — the adapter's whole RPC surface is `connect`
 * / `sessions.list` / `chat.send` / `chat.abort` / `exec.approval.*`. That
 * stream carries the prompt, the final response, and the approvals it has to
 * block on. It does NOT carry the individual tool calls, so the timeline showed
 * "OpenClaw said something" with no account of what it actually did, and the
 * only tools that ever appeared were the ones that happened to need approval —
 * a biased sample, not a log.
 *
 * OpenClaw writes a full transcript per session (measured 2026-08-23 against
 * OpenClaw 2026.7.1-2). This reads it, exactly the way `kiro-transcript-timeline`
 * reads Kiro's — an agent that pushes nothing still has a producer.
 *
 * **Scope is deliberately the complement of the Gateway stream, not a
 * duplicate of it.** Only `tool_exec` rows are emitted here. Prompts, responses
 * and approval rows already arrive live over the Gateway and re-deriving them
 * would double every turn in the strip.
 *
 * The record shapes below were copied off a real store, never invented — this
 * repo has a specific history of parsers written against imagined fixtures that
 * passed their tests and matched nothing real, so the test file pins the
 * measured shape verbatim:
 *
 *   {"type":"session","version":3,"id":"fef73899-…","timestamp":"2026-08-22T23:52:16.443Z",
 *    "cwd":"/Users/x/.openclaw/workspace"}
 *   {"type":"message","id":"577c04b8","parentId":"40296bc1",
 *    "timestamp":"2026-08-22T23:52:23.315Z",
 *    "message":{"role":"assistant","content":[
 *      {"type":"thinking","thinking":"…"},
 *      {"type":"toolCall","id":"38e16c61-…","name":"exec",
 *       "arguments":{"command":"ls ~/github/OpenClaw && …"}}],
 *     "provider":"openrouter","model":"stealth/ox-alpha","usage":{…}}}
 *   {"type":"message","id":"53079fbe","timestamp":"2026-08-22T23:52:23.376Z",
 *    "message":{"role":"toolResult","toolCallId":"38e16c61-…","toolName":"exec",
 *     "content":[{"type":"text","text":"CAPTURE_GUIDE.md\n…"}],
 *     "details":{"status":"completed","exitCode":0,"durationMs":13},"isError":false}}
 *
 * Three properties of that shape drive the code:
 *  - A line carries an ISO `timestamp` AND `message.timestamp` in epoch-ms.
 *    They agree; the ISO one is used, with the epoch one as the fallback,
 *    because a row with no time cannot be ordered against the live stream.
 *  - A tool call and its result are SEPARATE lines linked by `toolCallId`. The
 *    call names what was attempted and only the result knows whether it worked,
 *    so a row is emitted once, at the call, and completed from the result.
 *  - `isError` and `details.exitCode` disagree in the interesting direction: a
 *    command can exit 0 while the tool reports an error (and vice versa), so
 *    both are consulted rather than picking one.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { TimelineEntry } from '@agentdeck/shared';
import { debug } from './logger.js';

/** Cap on transcript bytes read, matching the Claude/Kiro readers' posture. */
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** Agent directories scanned under `~/.openclaw/agents`. */
const MAX_AGENT_DIRS = 32;
/** Row text budgets — these land on 144×144 keys and 120-byte firmware buffers. */
const RAW_MAX = 160;
const DETAIL_MAX = 400;

export interface OpenClawStoreOptions {
  /** Injectable for tests; defaults to `~/.openclaw`. */
  stateDir?: string;
}

export interface OpenClawTimelineOptions extends OpenClawStoreOptions {
  /** Epoch-ms lower bound; rows at or before it are dropped. */
  since?: number;
  /** Newest N rows kept. */
  limit?: number;
}

/** One session as the index describes it. */
export interface OpenClawStoreSession {
  /** `agent:main:main`, `agent:main:cron:<uuid>`, `agent:main:eval-…__r2`. */
  sessionKey: string;
  sessionId: string;
  agent: string;
  updatedAt: number;
}

export function openClawStateDir(opts: OpenClawStoreOptions = {}): string {
  return opts.stateDir ?? join(homedir(), '.openclaw');
}

/**
 * Sessions across every agent, newest-first.
 *
 * Reads each agent's `sessions.json`, whose keys ARE the session keys — the one
 * fact that says whether a given piece of OpenClaw activity is the chat the
 * user is looking at (`agent:main:main`), a scheduled job
 * (`agent:main:cron:<id>`) or a model-eval run (`agent:main:eval-…__r2`). All
 * three arrive at AgentDeck as the single literal "OpenClaw", which is why an
 * approval raised by an eval harness looked like it came from a conversation
 * the user could not find.
 */
export function listOpenClawSessions(opts: OpenClawStoreOptions = {}): OpenClawStoreSession[] {
  const agentsRoot = join(openClawStateDir(opts), 'agents');
  let agents: string[];
  try {
    agents = readdirSync(agentsRoot, { withFileTypes: true, encoding: 'utf-8' })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .slice(0, MAX_AGENT_DIRS)
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: OpenClawStoreSession[] = [];
  for (const agent of agents) {
    const indexPath = join(agentsRoot, agent, 'sessions', 'sessions.json');
    let parsed: unknown;
    try {
      const st = statSync(indexPath);
      if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) continue;
      parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    for (const [sessionKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const rec = value as { sessionId?: unknown; updatedAt?: unknown };
      if (typeof rec.sessionId !== 'string' || !rec.sessionId) continue;
      out.push({
        sessionKey,
        sessionId: rec.sessionId,
        agent,
        updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Join detail parts into LINES, flattening each one but keeping the breaks.
 *
 * `detail` is ordered most-decisive-first precisely so a narrow surface can
 * take its head line, and every consumer does exactly that (`split('\n')[0]`).
 * Running the whole block through `clip` collapses those breaks and there is no
 * head line left to take — the ordering becomes decorative and the surface
 * shows the first 22 characters of a run-on string instead.
 */
function clipLines(parts: Array<string | undefined>, max: number): string {
  const lines: string[] = [];
  let budget = max;
  for (const part of parts) {
    if (!part) continue;
    for (const raw of part.split('\n')) {
      if (budget <= 1) return lines.join('\n');
      const line = clip(raw, budget);
      if (!line) continue;
      lines.push(line);
      budget -= line.length + 1;
    }
  }
  return lines.join('\n');
}

/** Epoch-ms for a store line. */
function lineTs(line: { timestamp?: unknown; message?: { timestamp?: unknown } }): number | null {
  if (typeof line.timestamp === 'string') {
    const parsed = Date.parse(line.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  const inner = line.message?.timestamp;
  if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
  return null;
}

/**
 * The one line that says what a tool call is going to do.
 *
 * `exec` is the overwhelming majority and its `command` is the whole story.
 * Anything else falls back to the first string-valued argument, then to the
 * argument names — a tool this build has never seen must degrade to something
 * true ("browser · url, selector") rather than render as nothing.
 */
export function summarizeToolArguments(args: unknown): string {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const rec = args as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script', 'query', 'path', 'file', 'url', 'prompt']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const names = Object.keys(rec);
  return names.length > 0 ? names.join(', ') : '';
}

interface PendingCall {
  index: number;
  toolName: string;
}

/**
 * `tool_exec` rows for one session's transcript, oldest-first.
 *
 * Emitted at the CALL, then completed in place from the matching result: the
 * call is when the work started and is what orders correctly against the live
 * Gateway rows, while only the result knows the outcome. Building the row at
 * the result instead would stamp every tool with the time it finished and lose
 * any call still running when the read happened.
 */
export function openClawTimelineForSession(
  sessionId: string,
  opts: OpenClawTimelineOptions = {},
): TimelineEntry[] {
  const path = join(openClawStateDir(opts), 'agents');
  let transcript: string | null = null;
  let agents: string[] = [];
  try {
    agents = readdirSync(path, { withFileTypes: true, encoding: 'utf-8' })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .slice(0, MAX_AGENT_DIRS)
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const agent of agents) {
    const candidate = join(path, agent, 'sessions', `${sessionId}.jsonl`);
    try {
      const st = statSync(candidate);
      if (st.isFile() && st.size <= MAX_TRANSCRIPT_BYTES) {
        transcript = candidate;
        break;
      }
    } catch {
      // not this agent's session
    }
  }
  if (!transcript) return [];

  let text: string;
  try {
    text = readFileSync(transcript, 'utf-8');
  } catch (err) {
    debug('daemon', `openclaw transcript read failed for ${sessionId}: ${String(err)}`);
    return [];
  }

  const rows: TimelineEntry[] = [];
  const pending = new Map<string, PendingCall>();
  let model: string | undefined;
  let provider: string | undefined;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== 'message') continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const ts = lineTs(rec as { timestamp?: unknown; message?: { timestamp?: unknown } });
    if (ts === null) continue;

    if (msg.role === 'assistant') {
      // Carried onto the rows this turn produces: which weights actually ran is
      // the fact an eval session exists to vary, and the Gateway stream reports
      // one model for the whole hub.
      if (typeof msg.model === 'string' && msg.model) model = msg.model;
      if (typeof msg.provider === 'string' && msg.provider) provider = msg.provider;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p.type !== 'toolCall') continue;
        const toolName = typeof p.name === 'string' && p.name ? p.name : 'tool';
        const summary = summarizeToolArguments(p.arguments);
        const detailParts = [
          model ? `model: ${provider ? `${provider}/${model}` : model}` : '',
        ].filter(Boolean);
        rows.push({
          ts,
          type: 'tool_exec',
          raw: clip(summary ? `${toolName} · ${summary}` : toolName, RAW_MAX),
          ...(detailParts.length > 0 ? { detail: clipLines(detailParts, DETAIL_MAX) } : {}),
          agentType: 'openclaw',
        });
        if (typeof p.id === 'string' && p.id) {
          pending.set(p.id, { index: rows.length - 1, toolName });
        }
      }
      continue;
    }

    if (msg.role === 'toolResult') {
      const callId = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
      const target = callId ? pending.get(callId) : undefined;
      if (!target) continue;
      pending.delete(callId);
      const details = (msg.details ?? {}) as Record<string, unknown>;
      const exitCode = typeof details.exitCode === 'number' ? details.exitCode : undefined;
      const durationMs = typeof details.durationMs === 'number' ? details.durationMs : undefined;
      // `isError` and a non-zero exit are independent signals — a tool can fail
      // to run at all (isError, no exit code) and a command can fail while the
      // tool call itself succeeded. Either one means this did not go well.
      const failed = msg.isError === true || (exitCode !== undefined && exitCode !== 0);
      const first = Array.isArray(msg.content)
        ? (msg.content.find(
          (c) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text',
        ) as Record<string, unknown> | undefined)
        : undefined;
      const output = typeof first?.text === 'string' ? first.text : '';
      const outcome = [
        failed ? 'failed' : 'ok',
        exitCode !== undefined ? `exit ${exitCode}` : '',
        durationMs !== undefined ? `${durationMs}ms` : '',
      ].filter(Boolean).join(' · ');
      const existing = rows[target.index];
      // Outcome, then the model, then the output. The first two are short and
      // decisive; the output is unbounded, so putting it ahead of the model
      // pushed "which weights ran" past the clip on any tool that printed more
      // than a line — the one fact an eval session exists to vary.
      rows[target.index] = {
        ...existing,
        detail: clipLines([outcome, existing.detail, output], DETAIL_MAX),
        ...(failed ? { status: 'denied' as const } : {}),
      };
    }
  }

  const since = opts.since;
  const filtered = typeof since === 'number' ? rows.filter((r) => r.ts > since) : rows;
  const limit = opts.limit;
  return typeof limit === 'number' && limit >= 0 ? filtered.slice(-limit) : filtered;
}
