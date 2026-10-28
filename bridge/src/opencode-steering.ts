/**
 * Command queue for observed (standalone TUI) OpenCode sessions.
 *
 * Unlike Claude Code, OpenCode gives its observer plugin a full in-process
 * server client — so steering is DIRECT, not hook-mediated: the AgentDeck
 * plugin (hooks/src/opencode-install.ts) long-polls
 * `GET /opencode/commands?sid=<sessionID>` and executes what it receives via
 * the SDK (`session.abort`, `session.prompt`). That makes interrupt immediate
 * and prompt injection possible even while the session is idle — near-managed
 * steering with zero PTY.
 *
 * The daemon side is deliberately dumb: a bounded per-session FIFO plus
 * long-poll waiters. Commands are enqueued from device session_command
 * routing; the plugin drains them within one poll round-trip.
 */

export interface OpenCodeCommand {
  type: 'interrupt' | 'send_prompt' | 'permission_respond';
  text?: string;
  /** permission_respond: the OpenCode permission id (from permission.asked). */
  permissionId?: string;
  /** permission_respond: device decision; the plugin maps allow→"once", deny→"reject". */
  response?: 'allow' | 'deny';
}

interface Waiter {
  resolve: (cmds: OpenCodeCommand[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueueEntry {
  commands: OpenCodeCommand[];
  waiters: Waiter[];
  /** Last poll seen — a live poller marks the session steerable. */
  lastPollAt: number;
}

const QUEUE_CAP = 8;
const queues = new Map<string, QueueEntry>();

function entry(sid: string): QueueEntry {
  let e = queues.get(sid);
  if (!e) {
    e = { commands: [], waiters: [], lastPollAt: 0 };
    queues.set(sid, e);
  }
  return e;
}

/** Queue a command; wakes a pending long-poll immediately. Returns false when
 *  the queue is full (device keeps its button semantics honest via this). */
export function enqueueOpenCodeCommand(sid: string, cmd: OpenCodeCommand): boolean {
  const e = entry(sid);
  if (e.commands.length >= QUEUE_CAP) return false;
  e.commands.push(cmd);
  wakeWaiter(e);
  return true;
}

function wakeWaiter(e: QueueEntry): void {
  const waiter = e.waiters.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    const cmds = e.commands.splice(0, e.commands.length);
    waiter.resolve(cmds);
  }
}

/** Put commands a poll took but could not deliver (its client was already
 *  gone) back at the head of the queue, ahead of anything newer, and hand them
 *  to a live poller if one is parked. They were accepted once, so the cap does
 *  not refuse them. */
export function requeueOpenCodeCommands(sid: string, cmds: OpenCodeCommand[]): void {
  if (cmds.length === 0) return;
  const e = entry(sid);
  e.commands.unshift(...cmds);
  wakeWaiter(e);
}

/** Long-poll: resolve immediately when commands are queued, otherwise hold up
 *  to waitMs and resolve with an empty batch. Aborting `signal` (the client
 *  closed its connection) withdraws the waiter, so a command enqueued after
 *  that reaches the next live poller instead of a response nobody reads. */
export function pollOpenCodeCommands(
  sid: string, waitMs: number, signal?: AbortSignal,
): Promise<OpenCodeCommand[]> {
  const e = entry(sid);
  e.lastPollAt = Date.now();
  if (signal?.aborted) return Promise.resolve([]);
  if (e.commands.length > 0) {
    return Promise.resolve(e.commands.splice(0, e.commands.length));
  }
  return new Promise((resolve) => {
    const withdraw = () => {
      clearTimeout(waiter.timer);
      const idx = e.waiters.indexOf(waiter);
      if (idx >= 0) e.waiters.splice(idx, 1);
      resolve([]);
    };
    const waiter: Waiter = {
      resolve: (cmds) => {
        signal?.removeEventListener('abort', withdraw);
        resolve(cmds);
      },
      timer: setTimeout(() => {
        signal?.removeEventListener('abort', withdraw);
        withdraw();
      }, Math.max(1_000, Math.min(50_000, waitMs))),
    };
    e.waiters.push(waiter);
    signal?.addEventListener('abort', withdraw, { once: true });
  });
}

/** Is a plugin actively polling this session (steerable right now)? */
export function isOpenCodeSteerable(sid: string, now: number = Date.now()): boolean {
  const e = queues.get(sid);
  if (!e) return false;
  // A live long-poll re-arms at least every wait window + margin.
  return e.waiters.length > 0 || now - e.lastPollAt < 40_000;
}

/** Release all waiters (daemon shutdown). */
export function drainOpenCodeSteering(): void {
  for (const e of queues.values()) {
    for (const w of e.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve([]);
    }
  }
  queues.clear();
}

/** Test helper. */
export function _resetOpenCodeSteering(): void {
  drainOpenCodeSteering();
}
