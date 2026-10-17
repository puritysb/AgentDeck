import { EventEmitter } from 'events';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { debug } from './logger.js';

const POLL_INTERVAL_S = 2;
const MAX_RESTARTS = Infinity; // keep trying forever
const RESTART_DELAY_MS = 5_000;
const FALLBACK_POLL_MS = 5_000;
const FALLBACK_PROBE_TIMEOUT_MS = 2_000;
type DisplayProbeResult = { stdout: string; code: number };
type DisplayProbe = { promise: Promise<DisplayProbeResult | undefined>; cancel: () => void };

const PYTHON_SCRIPT = `
import ctypes, ctypes.util, time, sys
cg = ctypes.CDLL(ctypes.util.find_library('CoreGraphics'))
cg.CGMainDisplayID.restype = ctypes.c_uint32
cg.CGDisplayIsAsleep.restype = ctypes.c_uint32
cg.CGDisplayIsAsleep.argtypes = [ctypes.c_uint32]
display = cg.CGMainDisplayID()
prev = -1
while True:
    cur = cg.CGDisplayIsAsleep(display)
    if cur != prev:
        prev = cur
        print(cur, flush=True)
    time.sleep(${POLL_INTERVAL_S})
`;

/**
 * Monitors macOS display sleep state via CoreGraphics.
 * Emits 'display_state_changed' with boolean (true = on, false = asleep)
 * only when the state actually changes.
 *
 * Uses a persistent python3 process that checks every 2s and outputs
 * only on state transitions (no per-poll process spawning).
 */
export class DisplayMonitor extends EventEmitter {
  private proc: ChildProcess | null = null;
  private displayAsleepByCG = false;
  private displayAsleepByPower = false;
  private screenLocked = false;
  private screensaverActive = false;
  private sessionInactive = false;
  private lastDisplayOn = true;
  private running = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  private fallbackPending = false;
  private fallbackGeneration = 0;
  private readonly fallbackProbes = new Map<string, DisplayProbe>();

  start(): void {
    if (this.running) return;
    // Both the CGDisplayIsAsleep + pmset paths are macOS-only. On other
    // platforms keep `isDisplayOn()` at its default `true` (display assumed
    // on) and skip the python3/pmset spawn loop — otherwise Windows users
    // see a console window flash every 5s as the doomed python3 restart
    // timer fires.
    if (process.platform !== 'darwin') {
      debug('display', `DisplayMonitor skipped (platform=${process.platform})`);
      return;
    }
    this.running = true;
    this.restartCount = 0;
    debug('display', `DisplayMonitor started (${POLL_INTERVAL_S}s persistent poll)`);
    this.spawnProcess();
    this.startFallbackPoll();
  }

  stop(): void {
    this.running = false;
    this.fallbackGeneration++;
    this.fallbackPending = false;
    for (const probe of this.fallbackProbes.values()) probe.cancel();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }

  isDisplayOn(): boolean {
    return this.computeDisplayOn();
  }

  private computeDisplayOn(): boolean {
    return !this.displayAsleepByCG
      && !this.displayAsleepByPower
      && !this.screenLocked
      && !this.screensaverActive
      && !this.sessionInactive;
  }

  private emitIfChanged(reason: string): void {
    const nowOn = this.computeDisplayOn();
    if (nowOn !== this.lastDisplayOn) {
      this.lastDisplayOn = nowOn;
      debug(
        'display',
        `display state changed: ${nowOn ? 'ON' : 'ASLEEP'} (cause=${reason}) `
        + `[cgAsleep=${this.displayAsleepByCG} powerAsleep=${this.displayAsleepByPower} `
        + `locked=${this.screenLocked} screensaver=${this.screensaverActive} sessionInactive=${this.sessionInactive}]`,
      );
      this.emit('display_state_changed', nowOn);
    }
  }

  private setComponent(
    key: 'displayAsleepByCG' | 'displayAsleepByPower' | 'screenLocked' | 'screensaverActive' | 'sessionInactive',
    value: boolean,
    reason: string,
  ): void {
    if (this[key] === value) return;
    this[key] = value;
    this.emitIfChanged(reason);
  }

  private spawnProcess(): void {
    if (!this.running) return;

    try {
      this.proc = spawn('python3', ['-c', PYTHON_SCRIPT], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (err) {
      debug('display', `Failed to spawn python3: ${err}`);
      this.scheduleRestart();
      return;
    }

    if (this.proc.stdout) {
      const rl = createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed !== '0' && trimmed !== '1') return;
        this.setComponent('displayAsleepByCG', trimmed === '1', trimmed === '1' ? 'cgDisplaySleep' : 'cgDisplayWake');
      });
    }

    this.proc.on('error', (err) => {
      debug('display', `python3 process error: ${err.message}`);
      this.proc = null;
      this.scheduleRestart();
    });

    this.proc.on('exit', (code) => {
      debug('display', `python3 process exited (code=${code})`);
      this.proc = null;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (!this.running) return;
    if (this.restartCount >= MAX_RESTARTS) {
      debug('display', `Max restarts (${MAX_RESTARTS}) reached, keeping fallback poll only`);
      return;
    }
    this.restartCount++;
    debug('display', `Restarting python3 in ${RESTART_DELAY_MS / 1000}s (attempt ${this.restartCount}/${MAX_RESTARTS})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnProcess();
    }, RESTART_DELAY_MS);
  }

  /** Bound fallback waits and retain a probe until its native child exits. */
  private startFallbackPoll(): void {
    if (this.fallbackTimer) return;
    void this.pollFallbackOnce();
    this.fallbackTimer = setInterval(() => { void this.pollFallbackOnce(); }, FALLBACK_POLL_MS);
  }

  private async pollFallbackOnce(): Promise<void> {
    if (!this.running || this.fallbackPending) return;
    this.fallbackPending = true;
    const generation = this.fallbackGeneration;
    try {
      const [power, registry, screensaver] = await Promise.all([
        probeDisplayCommand(this.fallbackProbes, 'pmset', ['-g', 'powerstate', 'IODisplayWrangler']),
        probeDisplayCommand(this.fallbackProbes, 'ioreg', ['-n', 'Root', '-d1']),
        probeDisplayCommand(this.fallbackProbes, 'pgrep', ['-x', 'ScreenSaverEngine']),
      ]);
      // A stopped/restarted monitor must not consume the previous poll's data.
      if (!this.running || generation !== this.fallbackGeneration) return;
      if (power?.code === 0) {
        const match = power.stdout.match(/state:\s*(\d+)/);
        if (match) {
          const stateNum = parseInt(match[1], 10);
          this.setComponent('displayAsleepByPower', stateNum < 4, `pmset:${stateNum}`);
        }
      }
      if (registry?.code === 0) {
        const presence = parseIoregPresence(registry.stdout);
        if (presence.screenLocked !== undefined) {
          this.setComponent('screenLocked', presence.screenLocked, presence.screenLocked ? 'screenLock' : 'screenUnlock');
        }
        if (presence.sessionInactive !== undefined) {
          this.setComponent('sessionInactive', presence.sessionInactive, presence.sessionInactive ? 'sessionResign' : 'sessionResume');
        }
      }
      // pgrep exit 1 proves no match; a timeout or any other failure is unknown.
      if (screensaver?.code === 0 || screensaver?.code === 1) {
        const active = screensaver.code === 0;
        this.setComponent('screensaverActive', active, active ? 'screensaverStart' : 'screensaverStop');
      }
    } finally {
      if (generation === this.fallbackGeneration) this.fallbackPending = false;
    }
  }
}

function parseIoregBool(output: string, key: string): boolean | undefined {
  // Real ioreg output prefixes most IOConsoleUsers keys with "k"
  // ("kCGSSessionOnConsoleKey"=Yes); the lock marker historically appears
  // both with and without it. Accept either.
  const match = output.match(new RegExp(`"k?${key}"\\s*=\\s*(Yes|No|true|false|1|0)`, 'i'));
  if (!match) return undefined;
  return /^(yes|true|1)$/i.test(match[1]);
}

export function parseIoregPresence(output: string): { screenLocked?: boolean; sessionInactive?: boolean } {
  let screenLocked = parseIoregBool(output, 'CGSSessionScreenIsLocked');
  const onConsole = parseIoregBool(output, 'CGSSessionOnConsoleKey');
  // macOS REMOVES the ScreenIsLocked key on unlock rather than flipping it to
  // No. If we can see the console-users dict at all, an absent lock key means
  // UNLOCKED — returning undefined here latched screenLocked=true forever
  // after the first lock, which kept displayOn=false and put every panel to
  // sleep until the daemon restarted.
  if (screenLocked === undefined && /IOConsoleUsers/.test(output)) {
    screenLocked = false;
  }
  return {
    ...(screenLocked !== undefined ? { screenLocked } : {}),
    ...(onConsole !== undefined ? { sessionInactive: !onConsole } : {}),
  };
}

/** Resolve independently of child close: even a stuck child has a bounded probe. */
function probeDisplayCommand(pending: Map<string, DisplayProbe>, file: string, args: string[]): Promise<DisplayProbeResult | undefined> {
  const key = JSON.stringify([file, args]);
  const existing = pending.get(key);
  if (existing) return existing.promise;
  let reaped = false;
  let cancel = () => {};
  const promise = new Promise<DisplayProbeResult | undefined>((resolve) => {
    let child: ChildProcess | undefined;
    let settled = false;
    const finish = (result: DisplayProbeResult | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    cancel = () => {
      finish(undefined);
      try { child?.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const deadline = setTimeout(() => {
      debug('display', `${file} probe timed out`);
      cancel();
    }, FALLBACK_PROBE_TIMEOUT_MS);
    try {
      child = execFile(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        reaped = true;
        pending.delete(key);
        if (!error) finish({ stdout, code: 0 });
        else if (typeof error.code === 'number' && !error.killed && !error.signal) finish({ stdout, code: error.code });
        else finish(undefined);
      });
    } catch {
      reaped = true;
      finish(undefined);
    }
  });
  // A timeout ends the caller's wait, not the native process. Retain the
  // latch until the callback acknowledges exit, including across stop/start,
  // so a stuck kernel child cannot spawn replacements every five seconds.
  if (!reaped) pending.set(key, { promise, cancel });
  return promise;
}
