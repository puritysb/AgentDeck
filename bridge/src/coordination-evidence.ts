/**
 * Cross-session coordination evidence.
 *
 * A harness divides work in more ways than `SubagentStart`. Measured on
 * 2026-09-06 while a user asked why their epoch-of-tech creatures "looked
 * idle": the parent had closed its turn ("waiting for the matrix"), six
 * `claude -p --model glm-5.3` workers it launched from a background Bash had
 * each become a separate observed session with no link back, twelve
 * `SendMessage` calls had crossed between it and a sibling, and a 22-minute
 * `run_bot_matrix.sh` it would be re-invoked by was still running under
 * launchd with the parent's scratchpad path in its argv. Every surface showed
 * `idle`, and the collaboration lens drew one Explore branch.
 *
 * Each of those facts is OBSERVABLE without guessing, and this module turns
 * them into `RelationEvent`s plus a per-session `CoordinationSummary`:
 *
 *   - `spawned` — a peer session whose process is a descendant of this
 *     session's process (`process_ancestry`), or the intent to spawn one
 *     seen on a Bash tool call (`bash_claude_p`) before the child exists.
 *   - `messaged` — the sender's `SendMessage` tool input (`send_message_tool`)
 *     and the receiver's `<cross-session-message from="uds:…/<pid>.sock"
 *     from-name="…">` envelope (`cross_session_message`). The sender pid in
 *     the envelope resolves to a session through the process table.
 *   - `waiting_on` — a process (not itself an agent session) whose argv names
 *     this session's scratchpad directory (`background_process`), i.e. a
 *     `run_in_background` job the harness will re-invoke the session for.
 *
 * What it deliberately does not do: link two sessions because they share a
 * project, or read a "worker" out of prose. A relation whose peer cannot be
 * resolved carries only the name/pid the evidence itself had.
 */

export interface RelationObservation {
  sessionId: string;
  relation: 'spawned' | 'messaged' | 'waiting_on';
  direction: 'in' | 'out';
  phase: 'open' | 'closed';
  peerSessionId?: string | null;
  peerName?: string | null;
  evidence: string;
  detail?: string | null;
  ts: number;
  key: string;
}

export interface CoordinationSummaryLike {
  backgroundJobs: number;
  spawnedActive: number;
  spawnedCompleted: number;
  messagesIn: number;
  messagesOut: number;
  lastPeerName?: string;
  lastRelationAt?: number;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface ObservedPeer {
  /** Bare session id (uuid), never the `observed:<agent>:` form. */
  sessionId: string;
  pid: number;
}

/** What a receiver sees at the top of a cross-session prompt. Captured live
 *  from Claude Code 2.1.261 — the attribute order and the `uds:` socket path
 *  (whose basename is the SENDER's pid) are the real shape. */
export interface CrossSessionEnvelope {
  fromPid: number | null;
  fromName: string | null;
  fromMode: string | null;
  /** The message body after the harness preamble, capped. */
  body: string;
}

const ENVELOPE_RE = /<cross-session-message\b([^>]*)>/;
const ATTR_RE = /([a-z-]+)="([^"]*)"/g;
const UDS_PID_RE = /\/(\d+)\.sock\b/;
const MAX_DETAIL = 140;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) out[m[1]] = m[2];
  return out;
}

function pidFromUds(value: string | undefined): number | null {
  if (!value) return null;
  const m = UDS_PID_RE.exec(value);
  const pid = m ? Number(m[1]) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function clip(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trim()}…` : flat;
}

/** Parse a received prompt for the cross-session envelope; null when the
 *  prompt is an ordinary user turn. */
export function parseCrossSessionEnvelope(prompt: string): CrossSessionEnvelope | null {
  if (typeof prompt !== 'string') return null;
  const m = ENVELOPE_RE.exec(prompt);
  if (!m) return null;
  const a = attrs(m[1]);
  const after = prompt.slice(m.index + m[0].length);
  // The harness preamble ("This came from another Claude session — …") ends
  // at the first blank line; the body is what the peer actually wrote.
  const blank = after.search(/\n\s*\n/);
  const body = blank >= 0 ? after.slice(blank) : after;
  const closing = body.indexOf('</cross-session-message>');
  return {
    fromPid: pidFromUds(a.from),
    fromName: a['from-name']?.trim() || null,
    fromMode: a['from-mode']?.trim() || null,
    body: clip(closing >= 0 ? body.slice(0, closing) : body),
  };
}

export interface SendMessageTarget {
  peerName: string | null;
  peerPid: number | null;
  summary: string | null;
}

/** The `to` of a Claude Code `SendMessage` tool call: either a session name
 *  or a `uds:/…/<pid>.sock` address. */
export function parseSendMessageInput(input: unknown): SendMessageTarget | null {
  if (!input || typeof input !== 'object') return null;
  const to = (input as { to?: unknown }).to;
  if (typeof to !== 'string' || !to.trim()) return null;
  const pid = pidFromUds(to);
  const summaryRaw = (input as { summary?: unknown; message?: unknown });
  const summary = typeof summaryRaw.summary === 'string' && summaryRaw.summary.trim()
    ? clip(summaryRaw.summary)
    : (typeof summaryRaw.message === 'string' && summaryRaw.message.trim() ? clip(summaryRaw.message, 96) : null);
  return { peerName: pid ? null : to.trim(), peerPid: pid, summary };
}

/** A Bash command that launches a headless agent worker. Only the spellings
 *  we have measured: `claude -p` / `claude --print`. */
export function isAgentSpawnCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return /(^|[\s;&|(])claude\s+(?:[^\n;&|]*\s)?(?:-p|--print)(?:\s|$)/.test(command);
}

/** The interactive/headless agent binaries a session runs as. Used to stop
 *  the hook-pid walk and to keep an agent's own descendants out of the
 *  background-job set. */
export function isAgentProcessCommand(command: string): boolean {
  const head = command.split(/\s+/).filter(Boolean).find((t) => !/^[A-Z_]+=/.test(t)) ?? '';
  const base = head.split('/').pop() ?? '';
  if (/^(claude|codex|opencode|kiro-cli)$/.test(base)) return true;
  // `node …/cli.js` style launches name the agent in a later token.
  return /(^|\/)(claude|codex|opencode)(\.js|\.mjs)?(\s|$)/.test(command.split(/\s+/).slice(0, 3).join(' '));
}

/** Scratchpad directory Claude Code hands a session (the `SP=` every
 *  background job in the measured transcript inherited). The session id is
 *  the last path segment before `/scratchpad`. */
export function commandNamesSession(command: string, sessionId: string): boolean {
  if (!sessionId || sessionId.length < 8) return false;
  return command.includes(`/${sessionId}/`) || command.endsWith(`/${sessionId}`);
}

function commandLabel(command: string): string {
  // "bash -c bash tools/run_bot_matrix.sh /private/tmp/…" → "run_bot_matrix.sh"
  const tokens = command.split(/\s+/).filter(Boolean);
  const candidates = tokens.filter((t) => !/^(bash|sh|zsh|-c|-lc|python3?|node|npx|pnpm|env)$/.test(t));
  const first = candidates.find((t) => !t.startsWith('-') && !t.includes('/private/tmp/') && !/^[A-Z_]+=/.test(t))
    ?? tokens[0] ?? 'process';
  const base = first.split('/').pop() ?? first;
  return clip(base, 48);
}

/** Walk the parent chain from `pid` (exclusive) up to `maxDepth` levels and
 *  return the first ancestor that is an observed peer session. */
export function findAncestorSession(
  processes: ProcessRow[],
  pid: number,
  peers: ObservedPeer[],
  maxDepth = 8,
): ObservedPeer | null {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const peerByPid = new Map(peers.map((p) => [p.pid, p]));
  let cur = byPid.get(pid);
  for (let depth = 0; cur && depth < maxDepth; depth++) {
    const ppid = cur.ppid;
    if (!ppid || ppid <= 1) return null;
    const peer = peerByPid.get(ppid);
    if (peer && peer.pid !== pid) return peer;
    cur = byPid.get(ppid);
  }
  return null;
}

interface SessionCoordination {
  /** Open background jobs by pid → label. */
  jobs: Map<number, string>;
  /** Spawned peers by child session id → alive. */
  spawned: Map<string, boolean>;
  /** Spawn intents seen on Bash calls, pending a child to attribute to. */
  spawnIntents: number;
  messagesIn: number;
  messagesOut: number;
  lastPeerName?: string;
  lastRelationAt?: number;
}

const MAX_COMMAND_CHARS = 4096;

/**
 * Per-session reducer. Two inputs — hook facts (`noteMessageOut`,
 * `noteMessageIn`, `noteToolCall`) and the periodic process table
 * (`observe`) — and two outputs: `RelationObservation`s to persist on the
 * session's APME task, and `summary()` for the `sessions_list` wire. The
 * summary is kept here rather than derived from the rows it emits, for the
 * same reason the subagent census is (the rows are lossy on purpose).
 */
export class CoordinationTracker {
  private readonly sessions = new Map<string, SessionCoordination>();
  /** Session names learned from envelopes: name → sender session id. */
  private readonly nameToSession = new Map<string, string>();
  private readonly sessionToName = new Map<string, string>();
  /** Latest pid → session map from the observer, for uds resolution. */
  private pidToSession = new Map<number, string>();
  /** Session → agent pid learned from the hook header (`X-AgentDeck-Pid`),
   *  the path a sandboxed daemon has no file-based alternative to. */
  private readonly hookPids = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private entry(sessionId: string): SessionCoordination {
    let e = this.sessions.get(sessionId);
    if (!e) {
      e = { jobs: new Map(), spawned: new Map(), spawnIntents: 0, messagesIn: 0, messagesOut: 0 };
      this.sessions.set(sessionId, e);
    }
    return e;
  }

  private touch(e: SessionCoordination, peerName: string | null | undefined, ts: number): void {
    if (peerName) e.lastPeerName = peerName;
    e.lastRelationAt = ts;
  }

  /** A hook arrived with the posting shell's parent pid. The shell's parent
   *  is normally the agent process itself; if a wrapper sits in between, walk
   *  up to the nearest agent process so the registered pid is the one whose
   *  children are the session's workers. */
  registerPid(sessionId: string, pid: number, processes: ProcessRow[] = []): void {
    if (!Number.isInteger(pid) || pid <= 1) return;
    const byPid = new Map(processes.map((p) => [p.pid, p]));
    let cur = byPid.get(pid);
    let chosen = pid;
    for (let depth = 0; cur && depth < 4 && !isAgentProcessCommand(cur.command); depth++) {
      const parent = byPid.get(cur.ppid);
      if (!parent || parent.pid <= 1) break;
      cur = parent;
      if (isAgentProcessCommand(cur.command)) chosen = cur.pid;
    }
    this.hookPids.set(sessionId, chosen);
    this.pidToSession.set(chosen, sessionId);
  }

  /** Observer peers plus hook-registered pids for sessions the observer did
   *  not resolve (a session whose `sessions/<pid>.json` is unreadable, or the
   *  whole roster on a daemon with no file access). The observer's pid wins
   *  when both exist. */
  mergePeers(observed: ObservedPeer[]): ObservedPeer[] {
    const seen = new Set(observed.map((p) => p.sessionId));
    const out = [...observed];
    for (const [sessionId, pid] of this.hookPids) {
      if (!seen.has(sessionId)) out.push({ sessionId, pid });
    }
    return out;
  }

  /** The receiver's side of a message: the prompt carried the envelope. */
  noteMessageIn(sessionId: string, prompt: string): RelationObservation | null {
    const env = parseCrossSessionEnvelope(prompt);
    if (!env) return null;
    const ts = this.now();
    const peerSessionId = env.fromPid != null ? this.pidToSession.get(env.fromPid) ?? null : null;
    if (env.fromName && peerSessionId) {
      this.nameToSession.set(env.fromName, peerSessionId);
      this.sessionToName.set(peerSessionId, env.fromName);
    }
    const e = this.entry(sessionId);
    e.messagesIn += 1;
    this.touch(e, env.fromName, ts);
    return {
      sessionId,
      relation: 'messaged',
      direction: 'in',
      phase: 'closed',
      peerSessionId,
      peerName: env.fromName,
      evidence: 'cross_session_message',
      detail: env.body || null,
      ts,
      key: `${env.fromPid ?? env.fromName ?? 'peer'}:${ts}`,
    };
  }

  /** A tool call the session made: SendMessage → `messaged` out; a Bash that
   *  launches `claude -p` → a `spawned` intent (open, peer unknown yet). */
  noteToolCall(sessionId: string, toolName: unknown, toolInput: unknown): RelationObservation | null {
    if (toolName === 'SendMessage') {
      const target = parseSendMessageInput(toolInput);
      if (!target) return null;
      const ts = this.now();
      const peerSessionId = target.peerPid != null
        ? this.pidToSession.get(target.peerPid) ?? null
        : (target.peerName ? this.nameToSession.get(target.peerName) ?? null : null);
      const peerName = target.peerName ?? (peerSessionId ? this.sessionToName.get(peerSessionId) ?? null : null);
      const e = this.entry(sessionId);
      e.messagesOut += 1;
      this.touch(e, peerName, ts);
      return {
        sessionId,
        relation: 'messaged',
        direction: 'out',
        phase: 'closed',
        peerSessionId,
        peerName,
        evidence: 'send_message_tool',
        detail: target.summary,
        ts,
        key: `${target.peerPid ?? target.peerName ?? 'peer'}:${ts}`,
      };
    }
    if (toolName === 'Bash') {
      const command = (toolInput as { command?: unknown } | null)?.command;
      if (!isAgentSpawnCommand(command)) return null;
      const ts = this.now();
      const e = this.entry(sessionId);
      e.spawnIntents += 1;
      this.touch(e, null, ts);
      return {
        sessionId,
        relation: 'spawned',
        direction: 'out',
        phase: 'open',
        peerSessionId: null,
        peerName: 'claude -p',
        evidence: 'bash_claude_p',
        detail: clip(String(command), 96),
        ts,
        key: `intent:${ts}`,
      };
    }
    return null;
  }

  /**
   * Reconcile against the process table. `peers` are the observed agent
   * sessions with their pids (bare ids). Emits: `spawned` open on the parent
   * when a peer's ancestry reaches another peer, `spawned` closed when such a
   * child's process is gone, `waiting_on` open/closed for background jobs.
   */
  observe(processes: ProcessRow[], peers: ObservedPeer[]): RelationObservation[] {
    const ts = this.now();
    const out: RelationObservation[] = [];
    this.pidToSession = new Map(peers.map((p) => [p.pid, p.sessionId]));
    for (const [sessionId, pid] of this.hookPids) if (!this.pidToSession.has(pid)) this.pidToSession.set(pid, sessionId);
    const peerPids = new Set(peers.map((p) => p.pid));
    const alivePeerIds = new Set(peers.map((p) => p.sessionId));
    const rows = processes.map((p) => ({ ...p, command: p.command.slice(0, MAX_COMMAND_CHARS) }));

    // Spawned peers: ancestry.
    for (const child of peers) {
      const parent = findAncestorSession(rows, child.pid, peers);
      if (!parent || parent.sessionId === child.sessionId) continue;
      const e = this.entry(parent.sessionId);
      if (e.spawned.has(child.sessionId)) continue;
      e.spawned.set(child.sessionId, true);
      // A spawn intent that has now materialized is no longer pending.
      if (e.spawnIntents > 0) e.spawnIntents -= 1;
      this.touch(e, null, ts);
      out.push({
        sessionId: parent.sessionId, relation: 'spawned', direction: 'out', phase: 'open',
        peerSessionId: child.sessionId, peerName: null, evidence: 'process_ancestry',
        detail: null, ts, key: child.sessionId,
      });
      out.push({
        sessionId: child.sessionId, relation: 'spawned', direction: 'in', phase: 'open',
        peerSessionId: parent.sessionId, peerName: null, evidence: 'process_ancestry',
        detail: null, ts, key: parent.sessionId,
      });
    }
    // Spawned peers that ended.
    for (const [parentId, e] of this.sessions) {
      for (const [childId, alive] of e.spawned) {
        if (alive && !alivePeerIds.has(childId)) {
          e.spawned.set(childId, false);
          this.touch(e, null, ts);
          out.push({
            sessionId: parentId, relation: 'spawned', direction: 'out', phase: 'closed',
            peerSessionId: childId, peerName: null, evidence: 'process_ancestry',
            detail: null, ts, key: childId,
          });
        }
      }
    }
    // Background jobs: argv names a session's scratchpad, and the process is
    // neither an agent session itself nor a descendant of one (a `claude -p`
    // worker inherits the parent's scratchpad path in its prompt).
    for (const peer of peers) {
      const e = this.sessions.get(peer.sessionId) ?? null;
      const seen = new Set<number>();
      for (const proc of rows) {
        if (proc.pid === peer.pid || peerPids.has(proc.pid)) continue;
        if (!commandNamesSession(proc.command, peer.sessionId)) continue;
        if (findAncestorSession(rows, proc.pid, peers)) continue;
        // One job may be a `bash -c …` wrapping the same script — count the
        // outermost only, so a job reads as one row rather than two.
        const parentRow = rows.find((r) => r.pid === proc.ppid);
        if (parentRow && commandNamesSession(parentRow.command, peer.sessionId) && !peerPids.has(parentRow.pid)) continue;
        seen.add(proc.pid);
        const entry = e ?? this.entry(peer.sessionId);
        if (entry.jobs.has(proc.pid)) continue;
        const label = commandLabel(proc.command);
        entry.jobs.set(proc.pid, label);
        this.touch(entry, null, ts);
        out.push({
          sessionId: peer.sessionId, relation: 'waiting_on', direction: 'out', phase: 'open',
          peerSessionId: null, peerName: label, evidence: 'background_process',
          detail: clip(proc.command, 96), ts, key: String(proc.pid),
        });
      }
      if (!e) continue;
      for (const [pid, label] of e.jobs) {
        if (seen.has(pid)) continue;
        e.jobs.delete(pid);
        this.touch(e, null, ts);
        out.push({
          sessionId: peer.sessionId, relation: 'waiting_on', direction: 'out', phase: 'closed',
          peerSessionId: null, peerName: label, evidence: 'background_process',
          detail: null, ts, key: String(pid),
        });
      }
    }
    return out;
  }

  /** The session ended: its jobs and children are no longer its concern. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    const pid = this.hookPids.get(sessionId);
    this.hookPids.delete(sessionId);
    if (pid != null && this.pidToSession.get(pid) === sessionId) this.pidToSession.delete(pid);
  }

  /** `null` when the session has never had a relation — the caller omits the
   *  wire field; once it has, zeros are emitted explicitly. */
  summary(sessionId: string): CoordinationSummaryLike | null {
    const e = this.sessions.get(sessionId);
    if (!e) return null;
    let spawnedActive = 0; let spawnedCompleted = 0;
    for (const alive of e.spawned.values()) { if (alive) spawnedActive += 1; else spawnedCompleted += 1; }
    return {
      backgroundJobs: e.jobs.size,
      spawnedActive: spawnedActive + e.spawnIntents,
      spawnedCompleted,
      messagesIn: e.messagesIn,
      messagesOut: e.messagesOut,
      ...(e.lastPeerName ? { lastPeerName: e.lastPeerName } : {}),
      ...(e.lastRelationAt ? { lastRelationAt: e.lastRelationAt } : {}),
    };
  }

  summaries(): Map<string, CoordinationSummaryLike> {
    const out = new Map<string, CoordinationSummaryLike>();
    for (const id of this.sessions.keys()) {
      const s = this.summary(id);
      if (s) out.set(id, s);
    }
    return out;
  }
}
