/** Claude hook background_tasks is a session-work snapshot, not a parent turn
 * boundary or a subagent census. SSOT for the generated Swift adapter.
 * Shape: Claude 2.1.198+ / iTerm2 cc-status HookEvent.swift + main.swift.
 * Only the observed array shape is accepted; missing/malformed means unknown.
 * The adapter feeds the agent-agnostic `BackgroundWorkTracker`
 * (shared/src/background-work.ts), which owns the count and the projection.
 */
import { BackgroundWorkTracker } from '@agentdeck/shared';

export const CLAUDE_BACKGROUND_POLICY = {
  "maxTasks": 4096,
  "snapshots": [
    "Stop",
    "StopFailure",
    "SubagentStop",
    "Notification"
  ],
  "finished": [
    "completed",
    "failed",
    "cancelled",
    "canceled",
    "killed",
    "stopped",
    "done"
  ],
  "tool": "Background tasks"
} as const;

/** Running task ids in a hook snapshot, or undefined when the snapshot is
 *  absent or malformed (no information). */
export function claudeBackgroundTaskIds(payload: Record<string, unknown>, excludedId?: string): string[] | undefined {
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks) || tasks.length > CLAUDE_BACKGROUND_POLICY.maxTasks) return undefined;
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return undefined;
    const { id, status } = task as Record<string, unknown>;
    if (typeof id !== 'string' || !id || typeof status !== 'string') return undefined;
    if (id === excludedId || (CLAUDE_BACKGROUND_POLICY.finished as readonly string[]).includes(status)) continue;
    if (status !== 'running') return undefined;
    ids.add(id);
  }
  return [...ids];
}

export function claudeBackgroundTaskCount(payload: Record<string, unknown>, excludedId?: string): number | undefined {
  return claudeBackgroundTaskIds(payload, excludedId)?.length;
}

export class ClaudeBackgroundTasks {
  constructor(private readonly work: BackgroundWorkTracker = new BackgroundWorkTracker(),
    private readonly now: () => number = Date.now) {}

  note(event: string, payload: Record<string, unknown>): boolean {
    const sid = payload.session_id;
    if (typeof sid !== 'string' || !sid.trim()) return false;
    // Child tool/Stop hooks describe the child. Only SubagentStop carries a
    // parent snapshot; exclude the exiting child, still listed as running.
    if (event !== 'SubagentStop' && typeof payload.agent_id === 'string' && payload.agent_id) return false;
    if (event === 'SessionStart' || event === 'SessionEnd') return this.work.reset(sid);
    if (!(CLAUDE_BACKGROUND_POLICY.snapshots as readonly string[]).includes(event)) return false;
    if (event === 'Notification' && payload.notification_type !== 'idle_prompt') return false;
    const ids = claudeBackgroundTaskIds(payload,
      event === 'SubagentStop' && typeof payload.agent_id === 'string' ? payload.agent_id : undefined);
    if (ids === undefined) return false;
    // Snapshots re-assert the whole set on every Stop, so no stale bound.
    return this.work.snapshot(sid, ids, this.now(), { noun: 'task', staleMs: null });
  }

  /** Presentation only: never reopens a turn, fabricates children, or covers
   * an approval/question/offline state. Input rows stay unchanged. */
  project<T extends { state?: string; currentTool?: string; currentTask?: string; activity?: string }>(sid: string, session: T): T & { backgroundTaskCount?: number } {
    return this.work.project(sid, session);
  }
}
