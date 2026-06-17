import { spawn } from 'child_process';
import { debug } from './logger.js';
import type { UtilityCommand } from './types.js';

export interface UtilityState {
  mode: string;
  value: string;
  icon: string;
  level: number; // 0-1
}

type UtilityMode = 'volume' | 'brightness' | 'media';

const MODES: UtilityMode[] = ['volume', 'brightness', 'media'];
const POLL_INTERVAL_MS = 15000;
const OSASCRIPT_TIMEOUT_MS = 2000;
const OSASCRIPT_KILL_GRACE_MS = 1000;
const FAILURE_THRESHOLD = 3;
const MAX_SKIP_TICKS = 50;

/**
 * Runs an osascript command with a hard kill fallback.
 * execSync()'s timeout only sends SIGTERM and returns, but osascript can hang
 * indefinitely on AppleEvent IPC when System Events.app is unresponsive. Without
 * a SIGKILL follow-up those children accumulate as zombies, dragging down
 * launchservicesd/syspolicyd. This helper resolves only after the child has
 * actually exited.
 */
function runOsascript(script: string, timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    child.stdout?.on('data', (d) => { out += d.toString(); });
    const termTimer = setTimeout(() => {
      if (!settled) child.kill('SIGTERM');
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, timeoutMs + OSASCRIPT_KILL_GRACE_MS);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`osascript exit ${code}`));
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

export class UtilityProxy {
  private currentMode: UtilityMode = 'volume';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cachedVolume = 50;
  private cachedMuted = false;
  private cachedBrightness = 50;
  private polling = false;
  private consecutiveFailures = 0;
  private skipTicks = 0;

  constructor() {
    // osascript is macOS-only; spawning it on Windows would either flash
    // console windows (if Node's CreateProcess pops one) or just fail-then-
    // retry every POLL_INTERVAL_MS. Skip the polling loop and let getState()
    // serve its initial cached defaults.
    if (process.platform !== 'darwin') {
      debug('Utility', `polling skipped (platform=${process.platform})`);
      return;
    }
    void this.poll();
    this.pollTimer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
  }

  cycleMode(): void {
    const idx = MODES.indexOf(this.currentMode);
    this.currentMode = MODES[(idx + 1) % MODES.length];
    debug('Utility', `Mode → ${this.currentMode}`);
  }

  getState(): UtilityState {
    switch (this.currentMode) {
      case 'volume':
        return {
          mode: 'volume',
          value: this.cachedMuted ? 'MUTE' : `${this.cachedVolume}%`,
          icon: this.cachedMuted ? '🔇' : this.cachedVolume > 50 ? '🔊' : '🔉',
          level: this.cachedMuted ? 0 : this.cachedVolume / 100,
        };
      case 'brightness':
        return {
          mode: 'brightness',
          value: `${this.cachedBrightness}%`,
          icon: '☀️',
          level: this.cachedBrightness / 100,
        };
      case 'media':
        return {
          mode: 'media',
          value: 'MEDIA',
          icon: '🎵',
          level: 0.5,
        };
    }
  }

  handleCommand(cmd: UtilityCommand): void {
    switch (cmd.action) {
      case 'adjust_volume':
        void this.adjustVolume(cmd.value ?? 1);
        break;
      case 'toggle_mute':
        void this.toggleMute();
        break;
      case 'adjust_brightness':
        void this.adjustBrightness(cmd.value ?? 1);
        break;
      case 'media_play_pause':
        void this.mediaPlayPause();
        break;
      case 'media_next':
        void this.mediaNext();
        break;
      case 'media_prev':
        void this.mediaPrev();
        break;
    }
  }

  async adjustVolume(delta: number): Promise<void> {
    // Each tick ~6.25% (16 ticks = 0..100)
    const step = Math.round(delta * 6.25);
    const newVol = Math.max(0, Math.min(100, this.cachedVolume + step));
    try {
      await runOsascript(`set volume output volume ${newVol}`);
      this.cachedVolume = newVol;
      if (newVol > 0) this.cachedMuted = false;
      debug('Utility', `Volume → ${newVol}%`);
    } catch (err) {
      debug('Utility', `adjustVolume error: ${err}`);
    }
  }

  async toggleMute(): Promise<void> {
    try {
      const next = this.cachedMuted ? 'false' : 'true';
      await runOsascript(`set volume with output muted:${next}`);
      this.cachedMuted = !this.cachedMuted;
      debug('Utility', `Mute → ${this.cachedMuted}`);
    } catch (err) {
      debug('Utility', `toggleMute error: ${err}`);
    }
  }

  async adjustBrightness(delta: number): Promise<void> {
    try {
      const script = `tell application "System Events"
  key code ${delta > 0 ? 144 : 145}
end tell`;
      await runOsascript(script);
      // Approximate new brightness
      this.cachedBrightness = Math.max(0, Math.min(100, this.cachedBrightness + Math.round(delta * 6.25)));
      debug('Utility', `Brightness → ~${this.cachedBrightness}%`);
    } catch (err) {
      debug('Utility', `adjustBrightness error: ${err}`);
    }
  }

  async mediaPlayPause(): Promise<void> {
    try {
      await runOsascript(`tell application "System Events" to key code 16 using {command down}`);
      debug('Utility', 'Media: play/pause');
    } catch (err) {
      debug('Utility', `mediaPlayPause error: ${err}`);
    }
  }

  async mediaNext(): Promise<void> {
    try {
      await runOsascript(`tell application "System Events" to key code 124 using {command down}`);
      debug('Utility', 'Media: next');
    } catch (err) {
      debug('Utility', `mediaNext error: ${err}`);
    }
  }

  async mediaPrev(): Promise<void> {
    try {
      await runOsascript(`tell application "System Events" to key code 123 using {command down}`);
      debug('Utility', 'Media: prev');
    } catch (err) {
      debug('Utility', `mediaPrev error: ${err}`);
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    if (this.skipTicks > 0) {
      this.skipTicks--;
      return;
    }
    this.polling = true;
    try {
      const vol = await runOsascript(`output volume of (get volume settings)`);
      this.cachedVolume = parseInt(vol, 10) || 0;
      const muted = await runOsascript(`output muted of (get volume settings)`);
      this.cachedMuted = muted === 'true';
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
        this.skipTicks = Math.min(MAX_SKIP_TICKS, this.consecutiveFailures * 3);
        debug('Utility', `osascript failures=${this.consecutiveFailures}, skipping ${this.skipTicks} ticks`);
      }
    } finally {
      this.polling = false;
    }
  }

  cleanup(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
