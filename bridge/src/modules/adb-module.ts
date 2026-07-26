import type { DeviceModule, BridgeContext } from './types.js';
import { setupAdbReverse, cleanupAdbReverse, startAdbReversePolling } from '../adb-reverse.js';
import { execSync } from '../proc.js';

/**
 * ADB reverse tunnel module for Android dashboard clients.
 * D200H Deck Dock is driven by the Ulanzi Studio plugin over WebSocket.
 */
export class AdbModule implements DeviceModule {
  readonly name = 'adb';
  private port = 0;
  private stopPolling: (() => void) | null = null;

  async shouldActivate(config: 'auto' | boolean): Promise<boolean> {
    if (config === false) return false;
    if (config === true) return true;
    // auto: check if adb is available. Use `adb version` instead of `which`
    // so detection works on Windows too (which lacks `which`).
    try {
      execSync('adb version', { stdio: 'pipe', timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  async start(ctx: BridgeContext): Promise<void> {
    this.port = ctx.port;
    setupAdbReverse(ctx.port);
    this.stopPolling = startAdbReversePolling(ctx.port);
  }

  async stop(): Promise<void> {
    this.stopPolling?.();
    this.stopPolling = null;
    cleanupAdbReverse(this.port);
  }
}
