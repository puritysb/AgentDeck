import type { BackgroundWorkTracker, CiWaitTracker } from '@agentdeck/shared';
import type { AntigravityBackgroundTask } from './antigravity-observation.js';

/**
 * Antigravity pushes no hooks: its background commands are read from the
 * transcript (`backgroundTasks` on each observation). This turns successive
 * transcript snapshots into the same two trackers the hook agents feed, so a
 * background build reads as "1 task running" and a background `gh run watch`
 * as a CI wait — the Claude Code / Codex presentation, without a new wire.
 *
 * The background set is a snapshot (`BackgroundWorkTracker.snapshot`), so a
 * task the transcript no longer lists is gone. A CI wait opens from the task's
 * command; when that task finishes before GitHub evidence settled the wait, it
 * closes with `unconfirmed` (the watcher's exit is not a CI conclusion).
 */
export class AntigravityBackgroundFeed {
  /** Per session: the task ids last seen running, and the CI-wait token each opened. */
  private readonly known = new Map<string, Map<string, number | undefined>>();

  sync(
    tasksBySession: ReadonlyMap<string, readonly AntigravityBackgroundTask[]>,
    work: BackgroundWorkTracker,
    ciWaits: CiWaitTracker,
    now: number,
  ): { changed: boolean; unconfirmed: string[] } {
    let changed = false;
    const unconfirmed: string[] = [];
    for (const sid of new Set([...this.known.keys(), ...tasksBySession.keys()])) {
      const tasks = tasksBySession.get(sid) ?? [];
      const before = this.known.get(sid);
      if (!before && !tasks.length) continue;
      const after = new Map<string, number | undefined>();
      // Every Antigravity background task is a shell command: a `process`.
      if (work.snapshot(sid, tasks.map((task) => task.id), now, { noun: 'task', kind: 'process', staleMs: null })) changed = true;
      for (const task of tasks) {
        if (before?.has(task.id)) { after.set(task.id, before.get(task.id)); continue; }
        const tokens = new Set(ciWaits.waitsFor(sid, now).map((wait) => wait.token));
        if (task.command && ciWaits.note(sid, 'tool_start', {
          tool_name: 'bash', tool_use_id: task.id, tool_input: { command: task.command, run_in_background: true },
        }, now)) changed = true;
        after.set(task.id, ciWaits.waitsFor(sid, now).find((wait) => !tokens.has(wait.token))?.token);
      }
      for (const [id, token] of before ?? []) {
        if (after.has(id) || token === undefined) continue;
        const wait = ciWaits.waitsFor(sid, now).find((candidate) => candidate.token === token);
        if (!wait || wait.status.phase === 'passed' || wait.status.phase === 'failed') continue;
        // tool_failure drops the wait by id; tool_end would keep a background
        // wait open for a watcher that no longer exists.
        ciWaits.note(sid, 'tool_failure', { tool_use_id: id }, now);
        changed = true; unconfirmed.push(sid);
      }
      if (after.size) this.known.set(sid, after);
      else this.known.delete(sid);
    }
    return { changed, unconfirmed };
  }
}
