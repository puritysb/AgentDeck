/**
 * A Claude Code background-job spare announces itself with a `SessionStart`
 * (source `startup`) carrying its own session id and cwd, yet holds no
 * conversation. Left alone it minted an observed row, a session_start timeline
 * row and an APME run that the reaper closed 30 min later as `abandoned`
 * (live 2026-10-10). The process role comes from the shared argv rule
 * (`claudeBackgroundProcessRole`), the same one the Swift daemon replays.
 */
import {
  claudeBackgroundProcessRole,
  isClaudeSpareStartup,
  type ClaudeBackgroundProcessRole,
} from '@agentdeck/shared';
import type { ProcInfo } from './passive-observer.js';

function roleForPid(pid: number, table: readonly ProcInfo[]) {
  const proc = table.find((p) => p.pid === pid);
  if (!proc) return undefined;
  const parent = table.find((p) => p.pid === proc.ppid);
  return claudeBackgroundProcessRole(proc.command, parent?.command);
}

/**
 * Background-job role of the Claude process behind a `SessionStart`, or
 * undefined for any other event or when no table shows the pid (unknown —
 * never a reason to drop or retire anything). `cached` is the observer's table
 * (up to a scan old — a spare's SessionStart fires the moment it boots, so it
 * is usually not there yet); `fresh` reads one current table, only on a miss.
 */
export async function claudeBackgroundRoleForHook(
  eventName: string,
  payload: Record<string, unknown>,
  cached: readonly ProcInfo[],
  fresh: () => Promise<readonly ProcInfo[]>,
): Promise<ClaudeBackgroundProcessRole | undefined> {
  if (eventName !== 'SessionStart') return undefined;
  const pid = payload.agentdeck_pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return undefined;
  return roleForPid(pid, cached) ?? roleForPid(pid, await fresh().catch(() => [] as ProcInfo[]));
}

/** True when this hook is a spare's startup announcement and must be dropped
 *  before any pipeline sees it. */
export function isClaudeSpareHook(
  payload: Record<string, unknown>,
  role: ClaudeBackgroundProcessRole | undefined,
): boolean {
  return role ? isClaudeSpareStartup(payload.source, role) : false;
}

/** The conversation a background job continues, when the job was forked from
 *  one whose window is now parked (`--fork-session --resume <OLD>`). */
export function parkedClaudeSessionId(
  payload: Record<string, unknown>,
  role: ClaudeBackgroundProcessRole | undefined,
): string | undefined {
  if (role?.role !== 'job' || !role.forkedFrom) return undefined;
  const sid = typeof payload.session_id === 'string' ? payload.session_id.toLowerCase() : '';
  return role.forkedFrom === sid ? undefined : role.forkedFrom;
}
