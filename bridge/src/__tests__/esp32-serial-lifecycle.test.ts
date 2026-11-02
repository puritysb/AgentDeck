import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const lease = vi.hoisted(() => ({ active: false }));
vi.mock('../esp32-flash-lease.js', () => ({ readLease: () => lease.active ? { until: Date.now() + 60_000 } : null }));
import { __setSerialDiscoveryForTest, __pollSerialDevicesForTest, startESP32Serial, stopESP32Serial,
  releaseESP32SerialPorts, getESP32Ports } from '../esp32-serial.js';

function connection(port: string) {
  return { port, fd: null, connected: true, connectedAt: Date.now(), lastReadAt: 0,
    lastWriteAt: Date.now(), writeQueue: [], writeTimer: null } as any;
}
function pending<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

describe('serial discovery lifetime fencing', () => {
  let restore: () => void;
  let detect: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let activate: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    lease.active = false;
    detect = vi.fn(async () => [] as string[]);
    open = vi.fn(async (port: string) => connection(port));
    activate = vi.fn();
    restore = __setSerialDiscoveryForTest({ detect, open, activate });
    startESP32Serial();
    await Promise.resolve();
    await Promise.resolve();
  });
  afterEach(() => { stopESP32Serial(); restore(); lease.active = false; });

  it.each(['lease', 'stop', 'restart'])('discards an in-flight open and never opens its next candidate after %s', async (action) => {
    const first = pending<ReturnType<typeof connection>>();
    detect.mockResolvedValue(['fake-A', 'fake-B']);
    open.mockImplementationOnce(() => first.promise);
    const poll = __pollSerialDevicesForTest();
    await Promise.resolve();
    expect(open).toHaveBeenCalledExactlyOnceWith('fake-A');
    if (action === 'lease') { lease.active = true; releaseESP32SerialPorts('test lease'); }
    else { stopESP32Serial(); if (action === 'restart') startESP32Serial(); }
    const late = connection('fake-A');
    first.resolve(late);
    await poll;
    expect(late.connected).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(getESP32Ports()).toEqual([]);
    if (action === 'restart') {
      await __pollSerialDevicesForTest();
      expect(getESP32Ports()).toEqual(['fake-A', 'fake-B']);
      expect(activate).toHaveBeenCalledTimes(2);
    }
  });

  it('checks a lease created while discovery is pending, even without an in-process generation change', async () => {
    const found = pending<string[]>();
    detect.mockReturnValueOnce(found.promise);
    const poll = __pollSerialDevicesForTest();
    lease.active = true;
    found.resolve(['fake-A']);
    await poll;
    expect(open).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
