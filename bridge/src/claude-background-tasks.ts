/** Claude hook background_tasks is a session-work snapshot, not a parent turn
 * boundary or a subagent census. SSOT for the generated Swift projection.
 * Shape: Claude 2.1.198+ / iTerm2 cc-status HookEvent.swift + main.swift.
 * Only the observed array shape is accepted; missing/malformed means unknown.
 */
export const CLAUDE_BACKGROUND_POLICY = {
  "maxSessions": 4096,
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

export function claudeBackgroundTaskCount(payload: Record<string, unknown>, excludedId?: string): number | undefined {
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
  return ids.size;
}

export class ClaudeBackgroundTasks {
  private readonly counts = new Map<string, number>();

  note(event: string, payload: Record<string, unknown>): boolean {
    const sid = payload.session_id;
    if (typeof sid !== 'string' || !sid.trim()) return false;
    // Child tool/Stop hooks describe the child. Only SubagentStop carries a
    // parent snapshot; exclude the exiting child, still listed as running.
    if (event !== 'SubagentStop' && typeof payload.agent_id === 'string' && payload.agent_id) return false;
    if (event === 'SessionStart' || event === 'SessionEnd') return this.counts.delete(sid);
    if (!(CLAUDE_BACKGROUND_POLICY.snapshots as readonly string[]).includes(event)) return false;
    if (event === 'Notification' && payload.notification_type !== 'idle_prompt') return false;
    const count = claudeBackgroundTaskCount(payload,
      event === 'SubagentStop' && typeof payload.agent_id === 'string' ? payload.agent_id : undefined);
    if (count === undefined) return false;
    const changed = this.counts.get(sid) !== count;
    this.counts.delete(sid);
    this.counts.set(sid, count);
    if (this.counts.size > CLAUDE_BACKGROUND_POLICY.maxSessions) this.counts.delete(this.counts.keys().next().value!);
    return changed;
  }

  /** Presentation only: never reopens a turn, fabricates children, or covers
   * an approval/question/offline state. Input rows stay unchanged. */
  project<T extends { state?: string; currentTool?: string; currentTask?: string; activity?: string }>(sid: string, session: T): T {
    const count = this.counts.get(sid) ?? 0;
    if (session.state !== 'idle' || count === 0) return session;
    const activity = `Waiting for ${count} background task${count === 1 ? '' : 's'}`;
    return { ...session, state: 'processing', currentTool: CLAUDE_BACKGROUND_POLICY.tool, currentTask: activity, activity };
  }
}
