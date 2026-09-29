import type { DeviceModule, BridgeContext } from './types.js';
import { setupAdbReverse, cleanupAdbReverse, startAdbReversePolling } from '../adb-reverse.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
    // so detection works on Windows too (which lacks `which`). Async — the
    // synchronous spelling blocked the event loop at startup (#327).
    try {
      await execFileAsync('adb', ['version'], { timeout: 2000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  async start(ctx: BridgeContext): Promise<void> {
    this.port = ctx.port;
    // Loopback posture: USB-transport devices only. A TCP/mDNS adb device
    // (`adb connect`, wireless debugging) would carry the tunnel over the LAN.
    const opts = { usbOnly: ctx.loopbackOnly === true };
    await setupAdbReverse(ctx.port, opts);
    this.stopPolling = startAdbReversePolling(ctx.port, opts);
  }

  async stop(): Promise<void> {
    this.stopPolling?.();
    this.stopPolling = null;
    await cleanupAdbReverse(this.port);
  }
}
