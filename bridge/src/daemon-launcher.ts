import type { ChildProcess } from 'child_process';
import { once } from 'events';

/** Attach immediately after spawn: creation errors arrive asynchronously. */
export async function waitForDaemonSpawn(child: ChildProcess): Promise<void> {
  // once rejects on `error`. Returning before this event would let the task
  // report exit 0 for ENOENT/EAGAIN and suppress its RestartOnFailure policy.
  await once(child, 'spawn');
  child.unref();
}
