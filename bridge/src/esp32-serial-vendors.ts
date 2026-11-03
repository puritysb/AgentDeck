import { execFile } from 'node:child_process';

const LOOKUP_TIMEOUT_MS = 3_000;
const CACHE_MS = 5 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Map each callout device in `ioreg -r -c IOUSBHostDevice -l -w0` output to the
 * `idVendor` of its nearest enclosing USB device (a CH340 behind a hub belongs
 * to the CH340, not the hub).
 * @internal Exported for testing only
 */
export function parseIoregSerialVendors(output: string): Map<string, number> {
  const vendors = new Map<string, number>();
  const stack: { column: number; vendorId?: number }[] = [];
  for (const line of output.split('\n')) {
    const node = line.indexOf('+-o ');
    if (node >= 0) {
      while (stack.length > 0 && stack[stack.length - 1].column >= node) stack.pop();
      stack.push({ column: node });
      continue;
    }
    const vendor = /"idVendor" = (\d+)/.exec(line);
    if (vendor && stack.length > 0) {
      stack[stack.length - 1].vendorId = Number(vendor[1]);
      continue;
    }
    const callout = /"IOCalloutDevice" = "([^"]+)"/.exec(line);
    if (callout) {
      const owner = [...stack].reverse().find(entry => entry.vendorId !== undefined);
      if (owner?.vendorId !== undefined) vendors.set(callout[1], owner.vendorId);
    }
  }
  return vendors;
}

/** macOS USB vendor reads have two lifetimes: callers stop waiting at the
 * deadline, but the subprocess slot stays occupied until the child closes.
 * In particular, child.killed only means a signal was sent, not that it exited.
 * Keep this instance across serial stop/start so a wedged ioreg cannot stack. */
export class SerialVendorDiscovery {
  private topology = '';
  private generation = 0;
  private cache?: { at: number; vendors: Map<string, number> };
  private request?: { generation: number; result: Promise<Map<string, number>> };
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly report: (message: string) => void = () => {}) {}

  lookup(ports: readonly string[], platform = process.platform): Promise<Map<string, number>> {
    if (platform !== 'darwin') return Promise.resolve(new Map());
    const key = JSON.stringify([...new Set(ports)].sort());
    if (key !== this.topology) {
      this.topology = key;
      this.generation++;
      this.cache = undefined;
    }
    const snapshot = () => new Map(this.cache?.vendors);
    if (ports.length === 0) return Promise.resolve(snapshot());
    const now = performance.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return Promise.resolve(snapshot());
    if (this.request) {
      return this.request.generation === this.generation
        ? this.request.result.then(v => new Map(v)) : Promise.resolve(snapshot());
    }
    // Topology changes must not bypass a sick registry's global backoff.
    if (now < this.retryAt) return Promise.resolve(snapshot());

    let resolve!: (vendors: Map<string, number>) => void;
    const result = new Promise<Map<string, number>>(done => { resolve = done; });
    const request = { generation: this.generation, result };
    this.request = request;
    const generation = this.generation;
    const deadline = now + LOOKUP_TIMEOUT_MS;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => { if (this.request === request) this.request = undefined; };
    const finish = (error: Error | null, stdout = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Check the deadline here too: a stalled event loop can delay the timer.
      if (error || performance.now() >= deadline) {
        this.failures = Math.min(this.failures + 1, 4);
        const delay = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
        this.retryAt = performance.now() + delay;
        this.report(`USB vendor lookup failed; backing off ${delay / 1_000}s (no retry before ioreg exits)`);
      } else {
        if (generation === this.generation) this.cache = { at: performance.now(), vendors: parseIoregSerialVendors(stdout) };
        this.failures = 0;
        this.retryAt = 0;
      }
      // A result from a topology that changed during the read is not current.
      resolve(generation === this.generation ? snapshot() : new Map());
    };
    try {
      // No shell: signals target ioreg itself, not a shell that can orphan it.
      // A real multi-device registry exceeded Node's default 1 MiB buffer.
      const child = execFile('ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l', '-w0'],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout) => finish(error, stdout));
      child.once('close', release);
      child.once('error', error => {
        finish(error);
        // Spawn failures have no live process and may never emit exit.
        if (child.pid === undefined) release();
      });
      timer = setTimeout(() => {
        finish(new Error('ioreg timed out'));
        try { child.kill('SIGKILL'); } catch { /* retain the slot until close */ }
      }, LOOKUP_TIMEOUT_MS);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      release();
    }
    return result.then(v => new Map(v));
  }
}
