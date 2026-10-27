/** Claude hook background_tasks is a session-work snapshot, not a parent turn
 * boundary or a subagent census. SSOT for the generated Swift adapter.
 * Shape: Claude 2.1.198+ / iTerm2 cc-status HookEvent.swift + main.swift.
 * Only the observed array shape is accepted; missing/malformed means unknown.
 *
 * Claude lists every in-flight task as `running`, including a teammate idling
 * between mailbox messages and a long-lived dev server; the payload has no idle
 * bit (2.1.311: `XTn` copies `status`, while Claude's own active predicate
 * excludes `in_process_teammate && isIdle`). Task types that can run
 * indefinitely are therefore `process` items, which go on standby after
 * `BACKGROUND_WORK_POLICY.standbyAfterMs`; every other type, including one this
 * table predates, is a `job`. Claude sends the friendly label and falls back to
 * the raw discriminant, so both spellings are listed.
 * The adapter feeds the agent-agnostic `BackgroundWorkTracker`
 * (shared/src/background-work.ts), which owns the count and the projection.
 */
import { BackgroundWorkTracker, type BackgroundWorkKind } from '@agentdeck/shared';

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
  "tool": "Background tasks",
  "processTypes": [
    "shell",
    "local_bash",
    "monitor",
    "monitor_mcp",
    "monitor_ws",
    "teammate",
    "in_process_teammate",
    "cloud session",
    "remote_agent"
  ]
} as const;

/** Running tasks in a hook snapshot keyed by id with their kind, or undefined
 *  when the snapshot is absent or malformed (no information). */
export function claudeBackgroundTasks(payload: Record<string, unknown>, excludedId?: string): Map<string, BackgroundWorkKind> | undefined {
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks) || tasks.length > CLAUDE_BACKGROUND_POLICY.maxTasks) return undefined;
  const found = new Map<string, BackgroundWorkKind>();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return undefined;
    const { id, status, type } = task as Record<string, unknown>;
    if (typeof id !== 'string' || !id || typeof status !== 'string') return undefined;
    if (id === excludedId || (CLAUDE_BACKGROUND_POLICY.finished as readonly string[]).includes(status)) continue;
    if (status !== 'running') return undefined;
    if (!found.has(id)) found.set(id, typeof type === 'string' && (CLAUDE_BACKGROUND_POLICY.processTypes as readonly string[]).includes(type) ? 'process' : 'job');
  }
  return found;
}

/** Running task ids in a hook snapshot, or undefined when the snapshot is
 *  absent or malformed (no information). */
export function claudeBackgroundTaskIds(payload: Record<string, unknown>, excludedId?: string): string[] | undefined {
  const tasks = claudeBackgroundTasks(payload, excludedId);
  return tasks && [...tasks.keys()];
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
    const tasks = claudeBackgroundTasks(payload,
      event === 'SubagentStop' && typeof payload.agent_id === 'string' ? payload.agent_id : undefined);
    if (tasks === undefined) return false;
    // Snapshots re-assert the whole set on every Stop, so no stale bound.
    return this.work.snapshot(sid, [...tasks.keys()], this.now(),
      { noun: 'task', staleMs: null, kinds: Object.fromEntries(tasks) });
  }

  /** Presentation only: never reopens a turn, fabricates children, or covers
   * an approval/question/offline state. Input rows stay unchanged. */
  project<T extends { state?: string; currentTool?: string; currentTask?: string; activity?: string }>(sid: string, session: T, now: number = this.now()): T & { backgroundTaskCount?: number; backgroundStandbyCount?: number } {
    return this.work.project(sid, session, now);
  }
}
