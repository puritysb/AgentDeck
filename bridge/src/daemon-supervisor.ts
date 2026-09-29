/**
 * The autostart supervisor as a lifecycle PEER of the CLI, not just something
 * `daemon install` writes once.
 *
 * The daemon ends `/shutdown` by SIGKILLing itself (`exitProcessNow`), and that
 * is load-bearing: `process.exit()` has been observed joining a macOS serial fs
 * worker and leaving the pid behind (2026-06-06), and a daemon that will not
 * die while holding 9120 is strictly worse than one that comes back. But a
 * signalled death is not a successful exit, so every supervisor reads a
 * deliberate stop as a crash. Measured on this fleet 2026-09-09 with a
 * throwaway LaunchAgent carrying the same `KeepAlive{SuccessfulExit:false}`:
 * a self-SIGKILL was respawned every time (three consecutive runs, ~7s apart —
 * the 10s minimum-runtime throttle), while a plain `exit 0` left the job at
 * `state = not running`, `last exit code = 0`, and launchd did not touch it.
 *
 * The tempting fix — exit 0 instead — is wrong twice: it trades away the
 * guaranteed exit for the one failure mode nobody can recover from, and it does
 * not even fix the second symptom. With a clean exit launchd deliberately does
 * NOT respawn, so `daemon restart`'s own forked child wins the port every time
 * and the daemon ends up outside supervision DETERMINISTICALLY instead of by
 * race.
 *
 * So intent is not encoded in the exit status at all — the exit status is a
 * one-bit crash channel and it has no room for "the user asked for this".
 * Intent is spoken to the supervisor directly: when a unit owns the daemon,
 * `daemon stop` / `start` / `restart` go THROUGH it. Anything else is a race
 * with the process's own parent.
 *
 * macOS is the asymmetric one. `launchctl stop` sends SIGTERM, the daemon's
 * handler runs and ends in the same self-SIGKILL, and KeepAlive brings it
 * straight back — so a stop that means "stay stopped" must be `bootout`, which
 * removes the job. `bootout` is not `disable`: the plist is still installed and
 * launchd loads it again at the next login, which is exactly what `systemctl
 * --user stop` and `schtasks /End` already mean. The cost is that `kickstart`
 * then fails with "Could not find service" (verified, rc 113), so the start
 * plan has to `bootstrap` first.
 *
 * The plans are pure so the decision can be replayed in a test on any platform;
 * only `runSupervisorPlan` and `detectSupervisor` touch the machine.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readDaemonInfo } from './session-registry.js';

export type SupervisorKind = 'launchd' | 'systemd' | 'schtasks';

export const PLIST_LABEL = 'dev.agentdeck.daemon';
export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

export interface SupervisorFacts {
  kind: SupervisorKind;
  /** launchd label / systemd unit file name / scheduled task name. */
  label: string;
  /** The file that defines it, when it is a file (launchd, systemd). */
  unitPath?: string;
  /** Effective uid, for launchd's `gui/<uid>` domain. */
  uid?: number;
}

export interface SupervisorCommand {
  argv: string[];
  /**
   * A command whose failure is a legitimate state, not an error: `bootout` on a
   * job that was never loaded, `schtasks /End` on a task that is not running.
   * Only the failure of a REQUIRED command makes the plan fail.
   */
  optional?: boolean;
  /** Milliseconds. A stop can block on the supervised process's own teardown. */
  timeoutMs?: number;
}

/** Human name for a message. */
export function describeSupervisor(f: SupervisorFacts): string {
  switch (f.kind) {
    case 'launchd': return `launchd unit ${f.label}`;
    case 'systemd': return `systemd --user unit ${f.label}`;
    case 'schtasks': return `scheduled task ${f.label}`;
  }
}

/**
 * Stop the daemon and keep it stopped for this login session.
 *
 * launchd: `bootout` rather than `stop`, because `stop` only sends SIGTERM and
 * KeepAlive re-launches whatever the daemon's exit status ends up being.
 */
export function supervisorStopPlan(f: SupervisorFacts): SupervisorCommand[] {
  switch (f.kind) {
    case 'launchd':
      return [{ argv: ['launchctl', 'bootout', `gui/${f.uid ?? 0}/${f.label}`], optional: true, timeoutMs: 20_000 }];
    case 'systemd':
      return [{ argv: ['systemctl', '--user', 'stop', f.label], timeoutMs: 30_000 }];
    case 'schtasks':
      return [{ argv: ['schtasks', '/End', '/TN', f.label], optional: true, timeoutMs: 20_000 }];
  }
}

/**
 * Start the daemon UNDER the supervisor.
 *
 * launchd needs both halves: `bootstrap` re-registers a job a previous `stop`
 * booted out (and fails harmlessly when it is still loaded), `kickstart` then
 * runs it now rather than at the next login.
 */
export function supervisorStartPlan(f: SupervisorFacts): SupervisorCommand[] {
  switch (f.kind) {
    case 'launchd':
      return [
        { argv: ['launchctl', 'bootstrap', `gui/${f.uid ?? 0}`, f.unitPath ?? ''], optional: true, timeoutMs: 20_000 },
        { argv: ['launchctl', 'kickstart', `gui/${f.uid ?? 0}/${f.label}`], timeoutMs: 20_000 },
      ];
    case 'systemd':
      return [{ argv: ['systemctl', '--user', 'start', f.label], timeoutMs: 30_000 }];
    case 'schtasks':
      return [{ argv: ['schtasks', '/Run', '/TN', f.label], timeoutMs: 20_000 }];
  }
}

/**
 * The posture flags baked into the installed unit's argv.
 *
 * `daemon restart` inherits the RUNNING daemon's posture, and handing the
 * restart to a unit whose argv carries a different posture would silently
 * rewrite it — the enterprise downgrade that inheritance exists to prevent. So
 * the two are compared, and they can only be compared by reading the unit.
 *
 * Parses the file the installer wrote, per format: one `<string>` element per
 * flag in a plist, one quoted ExecStart word in a systemd unit, and a plain
 * argv tail inside `<Arguments>` in the Task Scheduler XML.
 */
export function parseSupervisorPosture(kind: SupervisorKind, content: string): string[] {
  const has = (flag: string): boolean => {
    if (kind === 'launchd') return content.includes(`<string>${flag}</string>`);
    // systemd quotes every ExecStart word; the Task Scheduler XML writes them
    // bare inside <Arguments>, where the LAST flag is followed by `<` and not by
    // whitespace — a same-format fixture would never have shown that, the real
    // generated file did. So the trailing boundary is "not more flag", not "a
    // separator".
    return new RegExp(`(^|[\\s"><])${flag}(?![\\w-])`, 'm').test(content);
  };
  // Canonical order — the same one `daemonPostureArgs` emits, so two lists can
  // be compared as strings.
  return ['--local', '--loopback'].filter(has);
}

/**
 * The installed autostart unit for this platform, or null when there is none.
 *
 * Registration is read from disk (or from `schtasks /Query`) — never from
 * whether the daemon happens to be running, which is a different question and
 * the one the caller asks separately.
 */
export function detectSupervisor(): SupervisorFacts | null {
  try {
    if (process.platform === 'darwin') {
      const unitPath = launchAgentPlistPath();
      if (!existsSync(unitPath)) return null;
      return { kind: 'launchd', label: PLIST_LABEL, unitPath, uid: process.getuid?.() ?? 0 };
    }
    if (process.platform === 'linux') {
      const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
      const unitPath = join(configHome, 'systemd', 'user', 'agentdeck-daemon.service');
      if (!existsSync(unitPath)) return null;
      return { kind: 'systemd', label: 'agentdeck-daemon.service', unitPath };
    }
    if (process.platform === 'win32') {
      try {
        execFileSync('schtasks', ['/Query', '/TN', 'AgentDeckDaemon'], { stdio: 'pipe', windowsHide: true });
      } catch {
        return null;
      }
      return { kind: 'schtasks', label: 'AgentDeckDaemon' };
    }
  } catch {
    // A supervisor we cannot even look up is one we must not claim to drive.
  }
  return null;
}

/**
 * The unit's baked posture flags, or `undefined` when they cannot be read.
 *
 * The third answer is load-bearing here for the same reason it is in
 * `supervisorJobRunning`. A Windows scheduled task has no `unitPath` at all —
 * `windows-service.ts` writes the task XML to a temp file and deletes it after
 * `schtasks /Create` — so this used to answer `[]`, which reads as "the unit
 * bakes the default posture". Every `daemon restart` on a machine installed
 * with `--local` then compared its inherited `--local` against a fabricated
 * default, took the `posture-mismatch` branch, printed a claim about the task
 * that was not true, and forked an UNSUPERVISED daemon. `routeDaemonLifecycle`
 * already treats `undefined` as "no comparison to make" and leaves the
 * supervisor owning the restart, which is the correct behaviour when we could
 * not look.
 */
export function supervisorPosture(f: SupervisorFacts): string[] | undefined {
  if (!f.unitPath) return undefined;
  try {
    return parseSupervisorPosture(f.kind, readFileSync(f.unitPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

export interface SupervisorRunResult {
  /** Every REQUIRED command succeeded. */
  ok: boolean;
  ran: { argv: string[]; ok: boolean; detail?: string }[];
}

/** Run a plan. Never throws — a supervisor that misbehaves must not leave the machine daemonless. */
export function runSupervisorPlan(plan: SupervisorCommand[]): SupervisorRunResult {
  const ran: SupervisorRunResult['ran'] = [];
  let ok = true;
  for (const cmd of plan) {
    const [bin, ...args] = cmd.argv;
    try {
      execFileSync(bin, args, { stdio: 'pipe', windowsHide: true, timeout: cmd.timeoutMs ?? 20_000 });
      ran.push({ argv: cmd.argv, ok: true });
    } catch (e) {
      const detail = ((e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message || '').trim();
      ran.push({ argv: cmd.argv, ok: false, detail });
      if (!cmd.optional) ok = false;
    }
  }
  return { ok, ran };
}

/** bootout acknowledges removal before the old job has necessarily disappeared.
 * Do not bootstrap its replacement while launchd can still remove that label.
 * A stopped-but-loaded job is not enough; only a missing service is terminal.
 */
export async function waitForSupervisorUnload(
  f: SupervisorFacts,
  options: {
    timeoutMs?: number;
    probe?: () => boolean | undefined;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  if (f.kind !== 'launchd') return true;
  const probe = options.probe ?? (() => {
    try {
      execFileSync('launchctl', ['print', `gui/${f.uid ?? 0}/${f.label}`],
        { stdio: 'pipe', timeout: 1_000 });
      return false;
    } catch (error) {
      // ESRCH from launchctl means the service is absent. Permission errors,
      // timeouts and a missing executable do not establish removal.
      return (error as { status?: number }).status === 113 ? true : undefined;
    }
  });
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 20_000);
  do {
    if (probe() === true) return true;
    if (now() >= deadline) return false;
    await sleep(Math.min(100, deadline - now()));
  } while (true);
}

/**
 * Flags that cannot be handed to the supervisor.
 *
 * The unit carries one fixed argv, so a one-off `-p 9130` / `--loopback` /
 * `--debug` invocation is asking for a daemon the unit cannot produce. Those
 * fork as before — and the caller says the resulting daemon is not the
 * supervised one, because that is the whole failure this routing exists to
 * stop being silent.
 */
export function oneOffFlagsBlockingSupervisor(opts: {
  port?: unknown; debug?: unknown; local?: unknown; loopback?: unknown;
  portWindow?: unknown; wakeWord?: unknown;
}): string[] {
  const blocking: string[] = [];
  if (opts.port) blocking.push('--port');
  if (opts.debug) blocking.push('--debug');
  if (opts.local) blocking.push('--local');
  if (opts.loopback) blocking.push('--loopback');
  if (opts.portWindow) blocking.push('--port-window');
  if (opts.wakeWord) blocking.push('--wake-word');
  return blocking;
}

/**
 * Who performs this lifecycle command: the supervisor, or the CLI itself.
 *
 * A truth table rather than three `if`s at two call sites — `daemon start` and
 * `daemon restart` must not answer this differently, and a rule spelled out
 * inline stays green while the other call site forgets it.
 */
export type LifecycleRoute =
  | { via: 'supervisor' }
  | { via: 'self'; reason: 'no-supervisor' }
  | { via: 'self'; reason: 'one-off-flags'; flags: string[] }
  | { via: 'self'; reason: 'posture-mismatch'; unitPosture: string[]; wantedPosture: string[] };

export function routeDaemonLifecycle(args: {
  supervisor: SupervisorFacts | null;
  /** Flags this invocation typed that the unit's fixed argv cannot express. */
  oneOffFlags: string[];
  /**
   * The posture baked into the unit, and the posture the daemon must come up
   * with. Both omitted when there is nothing to preserve (`daemon start` has no
   * running daemon to inherit from — the unit's own posture IS the answer).
   */
  unitPosture?: string[];
  wantedPosture?: string[];
}): LifecycleRoute {
  if (!args.supervisor) return { via: 'self', reason: 'no-supervisor' };
  if (args.oneOffFlags.length > 0) return { via: 'self', reason: 'one-off-flags', flags: args.oneOffFlags };
  if (args.unitPosture && args.wantedPosture
      && args.unitPosture.join(' ') !== args.wantedPosture.join(' ')) {
    return {
      via: 'self', reason: 'posture-mismatch',
      unitPosture: args.unitPosture, wantedPosture: args.wantedPosture,
    };
  }
  return { via: 'supervisor' };
}

/**
 * Is the supervisor's own job still running?
 *
 * The supervised analog of "is the child this command forked still alive?".
 * `waitForRestartedDaemon` treats its floor as a floor, not a budget — a start
 * can legitimately spend a minute negotiating a stand-down and then reclaiming
 * a port macOS is still holding — and it only gives up when the thing it
 * started has EXITED without a daemon appearing. Handing it nothing here would
 * turn that floor back into a hard 20s deadline, which is the false-failure
 * report this whole verification path was rewritten to remove.
 *
 * `undefined` means the supervisor did not answer, which is not "it died": the
 * caller keeps waiting, bounded by the ceiling.
 */
/**
 * `systemctl is-active` → the three answers.
 *
 * The transitional states are the reason this is not `=== 'active'`. With
 * `Restart=on-failure` a unit in restart backoff answers `activating`, which
 * is "still working on it" — reading it as dead makes the liveness probe
 * declare the job gone seconds before systemd brings the daemon back, which is
 * the premature deadline this whole path exists to avoid.
 */
export function parseSystemdActive(out: string): boolean | undefined {
  switch (out.trim()) {
    case 'active': return true;
    case 'inactive': case 'failed': return false;
    // activating / deactivating / reloading — in motion, not an outcome.
    default: return undefined;
  }
}

/**
 * `schtasks /Query /FO LIST` → the three answers.
 *
 * `schtasks` localizes both the field headers and the status VALUES, so a
 * regex for English `Status: Running` is not a test for "is it running" — on a
 * non-English Windows it fails to match a running job. Returning `false` there
 * told `convergeInstalledSupervision` to stop a healthy supervised daemon and
 * collapsed `waitForRestartedDaemon`'s ceiling to its floor. An output this
 * cannot read is `undefined`: we could not look, which is not "it died".
 */
export function parseSchtasksRunning(out: string): boolean | undefined {
  const m = /^Status:\s*(.+)$/mi.exec(out);
  if (!m) return undefined;               // localized header — unreadable
  switch (m[1].trim().toLowerCase()) {
    case 'running': return true;
    case 'ready': case 'disabled': return false;
    // Queued / Unknown / "Could not start" / any localized value.
    default: return undefined;
  }
}

/**
 * `schtasks /Query` → the task's status, or `undefined` for a query that did
 * not answer. Shared by the liveness and the ownership readings so they cannot
 * disagree about what the task said.
 */
export function schtasksStatus(f: SupervisorFacts): boolean | undefined {
  try {
    const out = execFileSync('schtasks', ['/Query', '/TN', f.label, '/FO', 'LIST'],
      { stdio: 'pipe', encoding: 'utf-8', timeout: 5_000, windowsHide: true });
    return parseSchtasksRunning(out);
  } catch {
    // Timed out, missing binary, or a query that exited non-zero (no such
    // task): none of these is a status, and a task we cannot query is not a
    // task we may declare dead.
    return undefined;
  }
}

/**
 * The scheduled task's two readings, composed into one answer.
 *
 * The task's action is a LAUNCHER that spawns the daemon with no console and
 * exits (windows-service.ts explains why it has to be), so `Status: Ready` is
 * the steady state of a healthy machine — it says the launcher finished, and
 * nothing at all about the daemon. Treating it as `false`, the way it has to be
 * treated for a task whose action is the daemon, is exactly the reading that
 * makes `convergeInstalledSupervision` stop a healthy supervised daemon.
 *
 * So `Ready` defers to the daemon's own `startedBy` stamp, and the other two
 * readings still win on their own: `Running` means a launcher is in flight (or
 * an action from a build before this change that still IS the daemon), and an
 * unreadable status is a status we did not get.
 */
export function composeSchtasksRunning(
  status: boolean | undefined,
  taskOwnsRegisteredDaemon: () => boolean | undefined,
): boolean | undefined {
  return status === false ? taskOwnsRegisteredDaemon() : status;
}

/**
 * The env var the Windows launcher passes to the daemon it spawns, and the
 * daemon's reading of it.
 *
 * The daemon stamps this into `daemon.json` only AFTER it wins the port
 * (daemon-server.ts), and that ordering is the whole design. The first shape of
 * this signal had the launcher record the pid it spawned, which failed live on
 * 2026-09-14: installing over an already-running unsupervised daemon, the
 * launcher's daemon hit the incumbent guard and was alive for a second or two
 * while it conceded, so "the pid the task started is alive" was true while the
 * daemon holding 9120 was the incumbent — the install reported `Daemon running
 * under the scheduled task (PID <incumbent>)` and converged nothing, reopening
 * from a new side the exact hole `convergeInstalledSupervision` exists to
 * close. A daemon that loses the race exits before the stamp, so the stamp
 * cannot lie about who is serving.
 *
 * Only a value we recognise is accepted: this reads an environment variable,
 * and an unknown string must not become a supervisor kind.
 */
export const SUPERVISOR_ENV = 'AGENTDECK_SUPERVISOR';

export function startedBySupervisor(
  env: NodeJS.ProcessEnv = process.env,
): SupervisorKind | undefined {
  const value = env[SUPERVISOR_ENV];
  return value === 'launchd' || value === 'systemd' || value === 'schtasks' ? value : undefined;
}

/**
 * Is the daemon registered in `daemon.json` one the scheduled task started?
 *
 * `readDaemonInfo` already prunes a record whose pid is dead, so a record that
 * comes back describes a LIVE daemon — which is why this needs no pid
 * comparison of its own. An available record without `startedBy` identifies
 * a hand-started or older daemon. No readable record is UNKNOWN: the live
 * daemon may still answer while its discovery file is temporarily missing.
 * Install must not stop that daemon on an unavailable ownership reading.
 */
export function schtasksOwnsRegisteredDaemon(
  readInfo: typeof readDaemonInfo = readDaemonInfo,
): boolean | undefined {
  const info = readInfo();
  return info ? info.startedBy === 'schtasks' : undefined;
}

/**
 * Did a failed `execFileSync` actually ANSWER, or did it fail to look?
 *
 * A command that ran and exited non-zero carries a numeric `status` — that is
 * an answer (`systemctl is-active` exits 3 and prints the state; `launchctl
 * print` fails outright once the job is booted out). A timeout (`ETIMEDOUT` /
 * killed by `SIGTERM`) or a missing binary (`ENOENT`) carries no status: the
 * probe never got a reading, and saying "dead" there is the false-failure
 * report this module was rewritten to remove.
 */
export function execFailureAnswered(e: unknown): boolean {
  return typeof (e as { status?: unknown } | null)?.status === 'number';
}

export function supervisorJobRunning(f: SupervisorFacts): boolean | undefined {
  try {
    switch (f.kind) {
      case 'launchd': {
        const out = execFileSync('launchctl', ['print', `gui/${f.uid ?? 0}/${f.label}`],
          { stdio: 'pipe', encoding: 'utf-8', timeout: 5_000 });
        // The first `state = ` line is the job's; nested ones belong to its
        // sub-dictionaries.
        const m = /^\s*state = (\S+)/m.exec(out);
        return m ? m[1] === 'running' : undefined;
      }
      case 'systemd': {
        const out = execFileSync('systemctl', ['--user', 'is-active', f.label],
          { stdio: 'pipe', encoding: 'utf-8', timeout: 5_000 });
        return parseSystemdActive(out);
      }
      case 'schtasks':
        // `schtasksStatus` swallows its own failures, so the outer catch below
        // is unreachable for this branch.
        return composeSchtasksRunning(schtasksStatus(f), schtasksOwnsRegisteredDaemon);
    }
  } catch (e) {
    // Only a command that ran and exited non-zero is an answer. A timeout or a
    // missing binary is not — see `execFailureAnswered`.
    if (!execFailureAnswered(e)) return undefined;
    const out = ((e as { stdout?: Buffer }).stdout?.toString() ?? '').trim();
    if (f.kind === 'systemd' && out) return parseSystemdActive(out);
    if (f.kind === 'launchd') return false;
    return undefined;
  }
  return undefined;
}

/**
 * Is the daemon this machine is running the one the supervisor owns?
 *
 * `daemon install` registers the unit and starts its job — and that job ends in
 * `daemon start --foreground`, which hits the incumbent guard and exits 0 the
 * moment an unsupervised daemon already holds the port. The install then
 * reports success over `state = not running`: the unit is registered, nothing
 * supervises the daemon, and nothing will until the next login. Measured on
 * this fleet 2026-09-09 (`runs = 7, last exit code = 0, state = not running`
 * beside a ppid-1 daemon serving 9120).
 *
 * A truth table rather than ifs at the three platform branches, and two of its
 * rules are about NOT acting. A foreign daemon is another user's and is never
 * touched however this machine is supervised. And a supervisor that did not
 * answer is `unknown`, not "unsupervised" — the same polarity as every other
 * probe in this codebase: "I could not look" must never be laundered into a
 * fact, least of all one whose remedy is stopping a healthy daemon.
 */
export type SupervisionState =
  /** The unit's job is running — it owns whatever daemon is or is about to be up. */
  | 'supervised'
  /** A daemon of ours answers, and the unit's job is not running. Converge. */
  | 'unsupervised'
  /** The port belongs to another OS user. Leave it alone. */
  | 'foreign'
  /** Nothing answers and the job is not running. The unit registered; no daemon came up. */
  | 'no-daemon'
  /** The supervisor did not answer. Report, act on nothing. */
  | 'unknown';

export function classifySupervision(args: {
  daemonAnswering: boolean;
  daemonIsForeign: boolean;
  jobRunning: boolean | undefined;
}): SupervisionState {
  if (args.daemonIsForeign) return 'foreign';
  if (args.jobRunning === undefined) return 'unknown';
  if (args.jobRunning) return 'supervised';
  return args.daemonAnswering ? 'unsupervised' : 'no-daemon';
}

/**
 * A throttled liveness probe for `waitForRestartedDaemon`.
 *
 * It is asked once per 300ms poll once past the floor, and each answer costs a
 * subprocess — so the answer is cached briefly. Unknown reads as alive: the
 * ceiling, not a failed lookup, is what ends the wait.
 */
export function supervisorLivenessProbe(f: SupervisorFacts, minIntervalMs = 2_000): () => boolean {
  let checkedAt = 0;
  let last = true;
  return () => {
    const now = Date.now();
    if (now - checkedAt < minIntervalMs) return last;
    checkedAt = now;
    last = supervisorJobRunning(f) !== false;
    return last;
  };
}
