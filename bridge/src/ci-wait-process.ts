import { classifyCiWaitIntent, type CiWaitStatus } from '@agentdeck/shared';
import type { ProcInfo } from './passive-observer.js';

/** An argv match alone is never ownership. The watcher must descend from the
 * hook's agent PID and have exactly one matching session. Failed/stale process
 * snapshots cannot close anything. No process commands survive this method.
 */
export class CiWaitProcesses {
  private seen = new Map<string, { openedAt: number; pids: number[]; capturedAt: number }>();
  ended(waits: [string, CiWaitStatus][], owners: Map<string, number>, snapshot: { processes: ProcInfo[]; capturedAt: number }): string[] {
    if (waits.length === 0) {
      this.seen.clear();
      return [];
    }
    if (!snapshot.capturedAt) return [];
    const table = new Map(snapshot.processes.map(p => [p.pid, p]));
    const active = new Set(waits.map(([sid]) => sid));
    for (const sid of this.seen.keys()) if (!active.has(sid)) this.seen.delete(sid);
    const matches = new Map<string, number[]>();
    for (const process of snapshot.processes) {
      const ancestors = new Set<number>();
      let parent = process.ppid;
      for (let depth = 0; depth < 64 && parent > 0 && !ancestors.has(parent); depth++) {
        ancestors.add(parent); parent = table.get(parent)?.ppid ?? 0;
      }
      // Most host processes cannot own any pending watcher. Do not run the
      // shell lexer over their argv on every coordination tick.
      const owned = waits.filter(([sid]) => {
        const owner = owners.get(sid);
        return owner !== undefined && ancestors.has(owner);
      });
      if (owned.length === 0) continue;
      const intent = classifyCiWaitIntent(process.command, true);
      if (!intent || intent.mode !== 'watch') continue;
      const candidates = owned.filter(([, wait]) =>
        (['repo', 'ref', 'pr', 'runId'] as const).every(k => wait[k] === undefined || wait[k] === intent[k]));
      if (candidates.length !== 1) continue;
      const sid = candidates[0][0];
      matches.set(sid, [...(matches.get(sid) ?? []), process.pid]);
    }
    const ended: string[] = [];
    for (const [sid, wait] of waits) {
      const previous = this.seen.get(sid);
      const pids = matches.get(sid);
      if (pids?.length) this.seen.set(sid, { openedAt: wait.openedAt, pids, capturedAt: snapshot.capturedAt });
      else if (previous && previous.openedAt === wait.openedAt && snapshot.capturedAt > previous.capturedAt &&
          previous.pids.every(pid => !table.has(pid))) {
        this.seen.delete(sid); ended.push(sid);
      }
    }
    return ended;
  }
}
