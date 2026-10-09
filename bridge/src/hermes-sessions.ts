import type { ObservedSession } from './passive-observer.js';

/** Hermes observer v1: a conversation survives turns, not explicit finalize.
 * No process guessing, gateway singleton, transcript scraping, or steering.
 * The one process fact used is the pid the observer reports for itself: a
 * conversation cannot outlive the Hermes process that hosts it. */
export const HERMES_SILENCE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 128;
const EVENTS = new Set(['session_start', 'user_prompt_submit', 'tool_start', 'tool_end', 'stop', 'session_end']);
interface Entry { row: ObservedSession; lastAt: number; pid?: number; cli?: boolean; stopped?: boolean; }

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
  onChanged?: () => void;
  onExpired?: (sessionId: string) => void;

  /** False means this payload must not enter the generic timeline/APME path. */
  note(event: string, payload: Record<string, unknown>, now = Date.now()): boolean {
    const boundary = event.replace(/^hermes_/, '');
    const sid = payload.session_id;
    if (!event.startsWith('hermes_') || !EVENTS.has(boundary)
      || typeof sid !== 'string' || !/^hermes-[a-f0-9]{32}$/.test(sid)) return false;
    this.reap(now);
    const opening = boundary === 'session_start' || boundary === 'user_prompt_submit';
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
    this.sessions.set(sid, { row, lastAt: now, pid, cli, stopped: boundary === 'stop' || (!opening && old?.stopped === true) });
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
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
    const verdicts = new Map<number, HermesPidLiveness>();
    for (const [sid, entry] of this.sessions) {
      if (entry.pid == null) continue;
      let verdict = verdicts.get(entry.pid);
      if (verdict == null) { verdict = probe(entry.pid); verdicts.set(entry.pid, verdict); }
      // Like OpenClaw, a running Hermes CLI stays on screen: its live process
      // keeps the silence TTL from retiring an idle conversation. Gateway
      // conversations (no finalize per chat) keep the TTL.
      if (verdict === 'alive' && entry.cli && entry.row.state === 'idle') { entry.lastAt = now; continue; }
      if (verdict !== 'dead') continue;
      this.sessions.delete(sid);
      this.ended.set(sid, now);
      closed.push(sid);
    }
    while (this.ended.size > MAX_SESSIONS) this.ended.delete(this.ended.keys().next().value!);
    if (closed.length) this.onChanged?.();
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
    return [...observed, ...[...this.sessions.values()].map(({ row }) => ({ ...row }))];
  }
}
