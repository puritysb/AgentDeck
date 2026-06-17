import { EventEmitter } from 'events';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
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
  private displayOn = true;
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
    return this.displayOn;
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
        const nowOn = trimmed !== '1'; // "0" = awake, "1" = asleep
        if (nowOn !== this.displayOn) {
          this.displayOn = nowOn;
          debug('display', `display state changed: ${nowOn ? 'ON' : 'ASLEEP'}`);
          this.emit('display_state_changed', nowOn);
        }
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

  /** Fallback poll using pmset (works even if python/CGDisplayIsAsleep fails). */
  private startFallbackPoll(): void {
    if (this.fallbackTimer) return;
    this.fallbackTimer = setInterval(() => {
      try {
        const out = execFileSync('pmset', ['-g', 'powerstate', 'IODisplayWrangler'], { encoding: 'utf8' });
        const match = out.match(/state:\s*(\d+)/);
        if (match) {
          const stateNum = parseInt(match[1], 10);
          // 4 = awake, 1 = asleep (common mapping)
          const nowOn = stateNum >= 4;
          if (nowOn !== this.displayOn) {
            this.displayOn = nowOn;
            debug('display', `fallback pmset state changed: ${nowOn ? 'ON' : 'ASLEEP'} (state=${stateNum})`);
            this.emit('display_state_changed', nowOn);
          }
        }
      } catch (err) {
        debug('display', `pmset poll failed: ${err}`);
      }
    }, FALLBACK_POLL_MS);
  }
}
