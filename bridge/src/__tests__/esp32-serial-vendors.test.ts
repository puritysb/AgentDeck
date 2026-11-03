import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ execFile: vi.fn(), exec: vi.fn() }));
vi.mock('node:child_process', () => io);
vi.mock('child_process', () => io);
vi.mock('../esp32-flash-lease.js', () => ({ readLease: () => null }));
import { SerialVendorDiscovery } from '../esp32-serial-vendors.js';
import { __setSerialDiscoveryForTest, __pollSerialDevicesForTest, startESP32Serial, stopESP32Serial } from '../esp32-serial.js';

const PORT = '/dev/cu.usbmodem123';
const OTHER = '/dev/cu.usbmodem456';
const registry = (port = PORT, vendor = 1086) => [
  '+-o USB Controls <class IOUSBHostDevice>',
  `  "idVendor" = ${vendor}`,
  '  +-o IOSerialBSDClient <class IOSerialBSDClient>',
  `      "IOCalloutDevice" = "${port}"`,
].join('\n');
class Child extends EventEmitter {
  pid: number | undefined = 42;
  kill = vi.fn(() => true);
}
type Attempt = { child: Child; complete: (error: Error | null, stdout?: string) => void };
let attempts: Attempt[];
let discovery: SerialVendorDiscovery;
const lookup = (ports: string[] = [PORT]) => discovery.lookup(ports, 'darwin');
function complete(stdout = registry(), error: Error | null = null) {
  const attempt = attempts.at(-1)!;
  attempt.complete(error, stdout);
  attempt.child.emit('close', error ? 1 : 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  attempts = [];
  discovery = new SerialVendorDiscovery();
  io.execFile.mockReset().mockImplementation((_file, _args, _options, callback) => {
    const child = new Child();
    attempts.push({ child, complete: callback });
    return child;
  });
});
afterEach(() => { stopESP32Serial(); vi.useRealTimers(); });

describe('macOS USB registry discovery', () => {
  it('shares a pending read and caches an unchanged, reordered candidate set', async () => {
    const first = lookup([PORT, OTHER]);
    const second = lookup([OTHER, PORT, PORT]);
    expect(io.execFile).toHaveBeenCalledTimes(1);
    complete();
    expect((await first).get(PORT)).toBe(0x043e);
    const result = await second;
    result.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await lookup([OTHER, PORT])).get(PORT)).toBe(0x043e);
    expect(io.execFile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes on changed candidates, after unplug/replug, and at the bounded cache age', async () => {
    const first = lookup(); complete(); await first;
    const changed = lookup([OTHER]); complete(registry(OTHER, 6790));
    expect((await changed).get(OTHER)).toBe(0x1a86);
    expect((await lookup([])).size).toBe(0);
    const replugged = lookup([OTHER]); complete(registry(OTHER, 12346));
    expect((await replugged).get(OTHER)).toBe(0x303a);
    await vi.advanceTimersByTimeAsync(300_000);
    const expired = lookup([OTHER]); complete(registry(OTHER, 1086));
    expect((await expired).get(OTHER)).toBe(0x043e);
    expect(io.execFile).toHaveBeenCalledTimes(4);
  });

  it('does not run ioreg for no candidates or on Linux/Windows', async () => {
    expect(await lookup([])).toEqual(new Map());
    expect(await discovery.lookup([PORT], 'linux')).toEqual(new Map());
    expect(await discovery.lookup([PORT], 'win32')).toEqual(new Map());
    expect(io.execFile).not.toHaveBeenCalled();
  });

  it('keeps a timed-out, SIGKILL-resistant child single-flight even beyond every retry delay', async () => {
    const first = lookup();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await first).toEqual(new Map());
    expect(attempts[0].child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await lookup(i % 2 ? [OTHER] : [PORT])).toEqual(new Map());
    }
    expect(io.execFile).toHaveBeenCalledTimes(1);
    // A callback/error is not proof of child termination either.
    attempts[0].complete(new Error('late callback'));
    attempts[0].child.emit('error', new Error('kill failed'));
    expect(await lookup()).toEqual(new Map());
    expect(io.execFile).toHaveBeenCalledTimes(1);
    attempts[0].child.emit('close', null, 'SIGKILL');
    const recovered = lookup(); complete();
    expect((await recovered).get(PORT)).toBe(0x043e);
    expect(io.execFile).toHaveBeenCalledTimes(2);
  });

  it('backs off globally through topology changes, caps retries, and resets after success', async () => {
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      const calls = io.execFile.mock.calls.length;
      const failed = lookup(); complete('', new Error('registry unavailable'));
      expect(await failed).toEqual(new Map());
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(await lookup([OTHER])).toEqual(new Map());
      expect(io.execFile).toHaveBeenCalledTimes(calls + 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    const success = lookup(); complete(); await success;
    const failed = lookup([OTHER]); complete('', new Error('registry unavailable')); await failed;
    await vi.advanceTimersByTimeAsync(60_000);
    const retried = lookup([OTHER]); complete(registry(OTHER)); await retried;
    expect(io.execFile).toHaveBeenCalledTimes(8);
  });

  it('ignores late successful output and waits for both close and the failure backoff', async () => {
    const first = lookup();
    await vi.advanceTimersByTimeAsync(3_000);
    await first;
    complete();
    expect(await lookup()).toEqual(new Map());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await lookup()).toEqual(new Map());
    expect(io.execFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const retry = lookup(); complete(registry(PORT, 6790));
    expect((await retry).get(PORT)).toBe(0x1a86);
  });

  it('retains known vendors for unchanged ports when a refresh fails', async () => {
    const first = lookup(); complete(); await first;
    await vi.advanceTimersByTimeAsync(300_000);
    const refresh = lookup(); complete('', new Error('unreadable registry'));
    expect((await refresh).get(PORT)).toBe(0x043e);
    expect((await lookup()).get(PORT)).toBe(0x043e);
    // Never apply that old vendor map to a changed topology.
    expect(await lookup([PORT, OTHER])).toEqual(new Map());
  });

  it('does not resurrect a timed-out cached result after unplug/replug of the same path', async () => {
    const first = lookup(); complete(); await first;
    await vi.advanceTimersByTimeAsync(300_000);
    const refresh = lookup();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await refresh).get(PORT)).toBe(0x043e);
    await lookup([]);
    expect(await lookup()).toEqual(new Map());
    expect(io.execFile).toHaveBeenCalledTimes(2);
  });

  it('discards a successful read if candidates changed while it was running', async () => {
    const first = lookup();
    expect(await lookup([OTHER])).toEqual(new Map());
    expect(await lookup([])).toEqual(new Map());
    complete();
    expect(await first).toEqual(new Map());
    const current = lookup([OTHER]); complete(registry(OTHER, 6790));
    expect(await current).toEqual(new Map([[OTHER, 0x1a86]]));
  });

  it('rejects a late callback even before a delayed timeout callback runs', async () => {
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const first = lookup();
      clock = 3_001;
      complete();
      expect(await first).toEqual(new Map());
      expect(vi.getTimerCount()).toBe(0);
    } finally { now.mockRestore(); }
  });

  it.each(['spawn error', 'throw'])('recovers from %s without a live child', async mode => {
    if (mode === 'throw') io.execFile.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    const first = lookup();
    if (mode === 'spawn error') {
      attempts[0].child.pid = undefined;
      attempts[0].child.emit('error', new Error('ENOENT'));
    }
    expect(await first).toEqual(new Map());
    await vi.advanceTimersByTimeAsync(60_000);
    const retry = lookup(); complete();
    expect((await retry).get(PORT)).toBe(0x043e);
    expect(io.execFile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the slot when sending SIGKILL throws', async () => {
    const first = lookup();
    attempts[0].child.kill.mockImplementationOnce(() => { throw new Error('EPERM'); });
    await vi.advanceTimersByTimeAsync(63_000);
    expect(await first).toEqual(new Map());
    expect(await lookup()).toEqual(new Map());
    expect(io.execFile).toHaveBeenCalledTimes(1);
  });

  it('runs ioreg directly with the bounded 8 MiB budget for a real-size registry', async () => {
    const first = lookup();
    const [file, args, options] = io.execFile.mock.calls[0];
    expect(file).toBe('ioreg');
    expect(args).toEqual(['-r', '-c', 'IOUSBHostDevice', '-l', '-w0']);
    expect(options).toMatchObject({ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    expect(options.shell).toBeUndefined();
    const output = ' '.repeat(1_100_000) + '\n' + registry();
    expect(Buffer.byteLength(output)).toBeLessThan(options.maxBuffer);
    complete(output);
    expect((await first).get(PORT)).toBe(0x043e);
  });
});

describe('production serial poll wiring', () => {
  it('does not stack ioreg across polls or serial stop/start after its deadline', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    io.exec.mockImplementation((_command, _options, callback) => {
      const child = new Child();
      queueMicrotask(() => { callback(null, PORT + '\n'); child.emit('exit', 0); });
      return child;
    });
    const open = vi.fn(async () => { throw new Error('fake port'); });
    const restore = __setSerialDiscoveryForTest({ open });
    try {
      startESP32Serial();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(io.execFile).toHaveBeenCalledTimes(1);
      stopESP32Serial();
      startESP32Serial();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(io.execFile).toHaveBeenCalledTimes(1);
      complete(); // timeout output is discarded
      await vi.advanceTimersByTimeAsync(10_000);
      expect(io.execFile).toHaveBeenCalledTimes(2);
      const opensBeforeSuccess = open.mock.calls.length;
      complete(); // known LG vendor must still prevent port opens
      await vi.advanceTimersByTimeAsync(10_000);
      await __pollSerialDevicesForTest();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(open).toHaveBeenCalledTimes(opensBeforeSuccess);
      expect(io.execFile).toHaveBeenCalledTimes(2);
    } finally { stopESP32Serial(); restore(); Object.defineProperty(process, 'platform', { value: platform }); }
  });
});
