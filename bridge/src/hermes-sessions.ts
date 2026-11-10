import type { ObservedSession } from './passive-observer.js';

/** Hermes observer v1: a conversation survives turns, not explicit finalize.
 * No process guessing, gateway singleton, transcript scraping, or steering.
 * The one process fact used is the pid the observer reports for itself: a
 * conversation cannot outlive the Hermes process that hosts it. */
export const HERMES_SILENCE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 128;
const MAX_PENDING_INPUTS = 32;
const MAX_SETTLED_INPUTS = 256;
export const HERMES_ATTENTION_LEASE_MS = 12_000;
const ATTENTION_SNAPSHOT = 'hermes_human_input_snapshot';
type InputKind = 'clarify' | 'approval' | 'sudo';
export function isHermesAttentionEvent(event: string): boolean {
  return event === ATTENTION_SNAPSHOT || event === 'hermes_human_input_request' || event === 'hermes_human_input_resolved';
}
function isInputKind(value: unknown): value is InputKind {
  return value === 'clarify' || value === 'approval' || value === 'sudo';
}
const EVENTS = new Set(['session_start', 'user_prompt_submit', 'tool_start', 'tool_end', 'stop', 'session_end']);
interface Entry {
  row: ObservedSession; lastAt: number; pid?: number; cli?: boolean; stopped?: boolean;
  inputs: Map<string, InputKind>; settled: Set<string>;
}

function settle(entry: Entry, id: string): void {
  entry.inputs.delete(id);
  entry.settled.add(id);
  while (entry.settled.size > MAX_SETTLED_INPUTS) entry.settled.delete(entry.settled.values().next().value!);
}

function clearInputs(entry: Entry): void {
  for (const id of entry.inputs.keys()) settle(entry, id);
}

/** Whether a reported Hermes pid still runs. Three answers: only "no such
 *  process" is `dead`; a refused or failed probe (EPERM…) is `unknown` and
 *  never closes a conversation. */
export type HermesPidLiveness = 'alive' | 'dead' | 'unknown';
export function hermesPidLiveness(pid: number): HermesPidLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

export class HermesSessions {
  private readonly sessions = new Map<string, Entry>();
  private readonly ended = new Map<string, number>();
  private readonly attention = new Map<string, { inputs: Map<string, InputKind>; expiresAt: number }>();
  onChanged?: () => void;
  onExpired?: (sessionId: string) => void;

  /** False means this payload must not enter the generic timeline/APME path. */
  note(event: string, payload: Record<string, unknown>, now = Date.now()): boolean {
    if (event === ATTENTION_SNAPSHOT) return this.noteSnapshot(payload, now);
    if (isHermesAttentionEvent(event)) return this.noteAttention(event, payload, now);
    const boundary = event.replace(/^hermes_/, '');
    const sid = payload.session_id;
    if (!event.startsWith('hermes_') || !EVENTS.has(boundary)
      || typeof sid !== 'string' || !/^hermes-[a-f0-9]{32}$/.test(sid)) return false;
    this.reap(now);
    const opening = boundary === 'session_start' || boundary === 'user_prompt_submit';
    if (boundary === 'user_prompt_submit' || boundary === 'stop' || boundary === 'session_end') {
      if (this.attention.delete(sid)) this.onChanged?.();
    }
    if (opening) this.ended.delete(sid);
    else if (this.ended.has(sid)) return false;
    if (boundary === 'session_end') {
      this.sessions.delete(sid);
      this.ended.set(sid, now);
      while (this.ended.size > MAX_SESSIONS) this.ended.delete(this.ended.keys().next().value!);
      this.onChanged?.();
      return true;
    }
    const old = this.sessions.get(sid);
    if (old && (boundary === 'user_prompt_submit' || boundary === 'stop')) clearInputs(old);
    // A late tool callback cannot reopen an authoritatively ended turn.
    // Only an explicit opening event starts the next turn/session.
    if (old?.stopped && !opening && (boundary === 'tool_start' || boundary === 'tool_end')) return false;
    // Recover from daemon restart only on real progress, never a stray Stop.
    if (!old && !opening && boundary !== 'tool_start') return false;
    const row: ObservedSession = old?.row ?? {
      id: `observed:hermes:${sid}`, port: 0, pid: 0,
      agentType: 'hermes', projectName: 'Hermes', alive: true,
      state: 'idle', controlMode: 'observed', liveAnswerable: false,
      startedAt: new Date(now).toISOString(),
    };
    if (typeof payload.project_name === 'string' && payload.project_name) row.projectName = payload.project_name.slice(0, 160);
    if (typeof payload.cwd === 'string' && payload.cwd) row.cwd = payload.cwd;
    if (typeof payload.model === 'string' && payload.model) row.modelName = payload.model.slice(0, 200);
    row.lastActivityAt = now;
    if (boundary === 'user_prompt_submit' || boundary === 'tool_start') row.state = 'processing';
    if (boundary === 'stop') row.state = 'idle';
    if (boundary === 'tool_start') {
      row.currentTool = typeof payload.tool_name === 'string' ? payload.tool_name.slice(0, 120) : undefined;
      row.currentTask = row.currentTool;
    } else if (boundary === 'stop' || boundary === 'tool_end' || boundary === 'user_prompt_submit') {
      row.currentTool = undefined;
      row.currentTask = undefined;
    }
    const pid = typeof payload.pid === 'number' && Number.isInteger(payload.pid) && payload.pid > 1
      ? payload.pid : old?.pid;
    const cli = typeof payload.platform === 'string' ? payload.platform === 'cli' : old?.cli;
    this.sessions.delete(sid);
    this.sessions.set(sid, { row, lastAt: now, pid, cli, stopped: boundary === 'stop' || (!opening && old?.stopped === true),
      inputs: old?.inputs ?? new Map(), settled: old?.settled ?? new Set() });
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    this.onChanged?.();
    return true;
  }

  private noteSnapshot(payload: Record<string, unknown>, now: number): boolean {
    const sid = payload.session_id;
    if (typeof sid !== 'string' || !/^hermes-[a-f0-9]{32}$/.test(sid)
      || !Array.isArray(payload.inputs) || payload.inputs.length > MAX_PENDING_INPUTS) return false;
    const inputs = new Map<string, InputKind>();
    for (const item of payload.inputs) {
      const id: unknown = item?.attention_id, kind: unknown = item?.kind;
      if (typeof id !== 'string' || !/^hermes-input-[a-f0-9]{32}$/.test(id)
        || !isInputKind(kind) || inputs.has(id)) return false;
      inputs.set(id, kind);
    }
    this.reap(now);
    const entry = this.sessions.get(sid);
    if (inputs.size && (entry?.stopped || this.ended.has(sid))) return false;
    // A live snapshot supersedes the old edge-only display for this session.
    if (entry) clearInputs(entry);
    this.attention.delete(sid);
    if (inputs.size) this.attention.set(sid, { inputs, expiresAt: now + HERMES_ATTENTION_LEASE_MS });
    while (this.attention.size > MAX_SESSIONS) this.attention.delete(this.attention.keys().next().value!);
    this.onChanged?.();
    return true;
  }

  private noteAttention(event: string, payload: Record<string, unknown>, now: number): boolean {
    const sid = payload.session_id, id = payload.attention_id, kind = payload.kind;
    if (typeof sid !== 'string' || !/^hermes-[a-f0-9]{32}$/.test(sid)
      || typeof id !== 'string' || !/^hermes-input-[a-f0-9]{32}$/.test(id)
      || !isInputKind(kind)) return false;
    this.reap(now);
    const entry = this.sessions.get(sid);
    // Attention cannot create an execution row or revive an ended turn. After
    // receiver downtime, normal lifecycle/progress must establish it first.
    if (!entry || entry.stopped || this.ended.has(sid)) return false;
    const pending = entry.inputs.get(id);
    if (pending !== undefined && pending !== kind) return false;
    if (event === 'hermes_human_input_request') {
      if (entry.settled.has(id) || pending !== undefined) return true;
      if (entry.inputs.size >= MAX_PENDING_INPUTS) return false;
      entry.inputs.set(id, kind);
    } else {
      // A reordered resolution fences a later duplicate request with this ID;
      // it never clears a different request, or means that the task succeeded.
      settle(entry, id);
    }
    entry.lastAt = now;
    this.onChanged?.();
    return true;
  }

  /**
   * Close every conversation whose Hermes process is gone, as if it had been
   * finalized: the row leaves and a late callback cannot resurrect it. Returns
   * the closed session ids so the caller can close their APME runs. One-shot
   * mode (`hermes -z`) never fires on_session_finalize, so this is its only
   * end short of the silence TTL; it also covers kill/crash. A row with no
   * reported pid, or whose probe is `unknown`, keeps the TTL path.
   */
  sweepDeparted(probe: (pid: number) => HermesPidLiveness = hermesPidLiveness, now = Date.now()): string[] {
    const closed: string[] = [];
    let attentionChanged = false;
    for (const [sid, snapshot] of this.attention) {
      if (snapshot.expiresAt <= now) attentionChanged = this.attention.delete(sid) || attentionChanged;
    }
    const verdicts = new Map<number, HermesPidLiveness>();
    for (const [sid, entry] of this.sessions) {
      if (entry.pid == null) continue;
      let verdict = verdicts.get(entry.pid);
      if (verdict == null) { verdict = probe(entry.pid); verdicts.set(entry.pid, verdict); }
      // Like OpenClaw, a running Hermes CLI stays on screen: its live process
      // keeps the silence TTL from retiring an idle conversation. Gateway
      // conversations (no finalize per chat) keep the TTL.
      if (verdict === 'alive' && entry.cli && entry.row.state === 'idle' && entry.inputs.size === 0) { entry.lastAt = now; continue; }
      if (verdict !== 'dead') continue;
      this.sessions.delete(sid);
      this.attention.delete(sid);
      this.ended.set(sid, now);
      closed.push(sid);
    }
    while (this.ended.size > MAX_SESSIONS) this.ended.delete(this.ended.keys().next().value!);
    if (closed.length || attentionChanged) this.onChanged?.();
    return closed;
  }

  private reap(now: number): void {
    for (const [sid, entry] of this.sessions) {
      if (now - entry.lastAt >= HERMES_SILENCE_TTL_MS) {
        this.sessions.delete(sid);
        this.onExpired?.(sid);
      }
    }
    for (const [sid, at] of this.ended) {
      if (now - at >= HERMES_SILENCE_TTL_MS) this.ended.delete(sid);
    }
  }

  applyTo(observed: ObservedSession[], now = Date.now()): ObservedSession[] {
    this.reap(now);
    const rows = new Map([...this.sessions].map(([sid, { row, inputs }]) => [sid, { row, inputs }]));
    for (const [sid, { inputs, expiresAt }] of this.attention) {
      if (expiresAt <= now) continue;
      // Recovery can show a wait without establishing an execution session.
      const row: ObservedSession = rows.get(sid)?.row ?? {
        id: `observed:hermes:${sid}`, port: 0, pid: 0, agentType: 'hermes',
        projectName: 'Hermes', alive: true, state: 'idle', controlMode: 'observed', liveAnswerable: false,
      };
      rows.set(sid, { row, inputs });
    }
    return [...observed, ...[...rows.values()].map(({ row, inputs }) => {
      if (!inputs.size) return { ...row };
      const permission = [...inputs.values()].some(kind => kind !== 'clarify');
      // Existing display-only states. Never publish a wire requestId/options,
      // terminal identity, or answer transport for a Hermes wait.
      return { ...row, state: permission ? 'awaiting_permission' : 'awaiting_option',
        currentTask: permission ? 'Permission needed — respond in Hermes' : 'Input needed — respond in Hermes',
        liveAnswerable: false };
    })];
  }
}
