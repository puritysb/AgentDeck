import { EventEmitter } from 'events';
import { spawn, execFileSync, type ChildProcess } from './proc.js';
import { createInterface } from 'readline';
import { debug } from './logger.js';

const POLL_INTERVAL_S = 2;
const MAX_RESTARTS = Infinity; // keep trying forever
const RESTART_DELAY_MS = 5_000;
const FALLBACK_POLL_MS = 5_000;

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

  /** Fallback poll using public macOS CLIs (works even if python/CGDisplayIsAsleep fails). */
  private startFallbackPoll(): void {
    if (this.fallbackTimer) return;
    this.pollFallbackOnce();
    this.fallbackTimer = setInterval(() => this.pollFallbackOnce(), FALLBACK_POLL_MS);
  }

  private pollFallbackOnce(): void {
    try {
      const out = execFileSync('pmset', ['-g', 'powerstate', 'IODisplayWrangler'], { encoding: 'utf8' });
      const match = out.match(/state:\s*(\d+)/);
      if (match) {
        const stateNum = parseInt(match[1], 10);
        // 4 = awake, 1 = asleep (common mapping)
        this.setComponent('displayAsleepByPower', stateNum < 4, `pmset:${stateNum}`);
      }
    } catch (err) {
      debug('display', `pmset poll failed: ${err}`);
    }

    try {
      const out = execFileSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' });
      const presence = parseIoregPresence(out);
      if (presence.screenLocked !== undefined) {
        this.setComponent('screenLocked', presence.screenLocked, presence.screenLocked ? 'screenLock' : 'screenUnlock');
      }
      if (presence.sessionInactive !== undefined) {
        this.setComponent('sessionInactive', presence.sessionInactive, presence.sessionInactive ? 'sessionResign' : 'sessionResume');
      }
    } catch (err) {
      debug('display', `ioreg presence poll failed: ${err}`);
    }

    const screensaverActive = isScreensaverProcessActive();
    this.setComponent('screensaverActive', screensaverActive, screensaverActive ? 'screensaverStart' : 'screensaverStop');
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

function isScreensaverProcessActive(): boolean {
  try {
    execFileSync('pgrep', ['-x', 'ScreenSaverEngine'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
