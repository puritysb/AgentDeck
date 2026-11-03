import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const adb = vi.hoisted(() => ({run:vi.fn(),log:vi.fn()}));
vi.mock('child_process', () => ({execFile:Object.assign(vi.fn(),{[Symbol.for('nodejs.util.promisify.custom')]: (...args:unknown[]) => adb.run(...args)})}));
vi.mock('../logger.js', () => ({debug:vi.fn(),log:adb.log}));
let api: typeof import('../adb-reverse.js');
let listing: string;
beforeEach(async () => {
  vi.resetModules(); adb.run.mockReset(); adb.log.mockReset(); listing = '';
  adb.run.mockImplementation(async (_file:string,args:string[]) => ({stdout:args[0] === 'devices' ? 'List of devices attached\nUSB\tdevice\n' : listing}));
  api = await import('../adb-reverse.js');
});
afterEach(() => vi.useRealTimers());
const creates = () => adb.run.mock.calls.filter(c => c[1].includes('--no-rebind'));
describe('ADB reverse endpoint ownership', () => {
  it.each([
    ['',9120,{kind:'absent'}],
    ['UsbFfs tcp:9120 tcp:9121\n',9121,{kind:'matching'}],
    ['UsbFfs tcp:9120 tcp:9121\n',9120,{kind:'conflict',target:'tcp:9121'}],
    ['UsbFfs tcp:91200 tcp:9121\n',9120,{kind:'absent'}],
    ['garbled',9120,{kind:'unknown'}],
    ['UsbFfs tcp:9120 tcp:9120\nUsbFfs tcp:9120 tcp:9121',9120,{kind:'unknown'}],
  ] as const)('classifies a list without inferring an OS user', (text,port,expected) => expect(api.inspectAdbReverse(text,port)).toEqual(expected));
  it('creates only an absent mapping and uses atomic no-rebind protection', async () => {
    await api.setupAdbReverse(9123);
    expect(creates()).toHaveLength(1);
    expect(creates()[0]).toEqual(['adb',['-s','USB','reverse','--no-rebind','tcp:9120','tcp:9123'],{timeout:5000,windowsHide:true}]);
  });
  it('reuses an exact target without replacing it', async () => {
    listing = 'UsbFfs tcp:9120 tcp:9123';
    await api.setupAdbReverse(9123); expect(creates()).toHaveLength(0); expect(adb.log).not.toHaveBeenCalled();
  });
  it('preserves a competing target and warns once while it remains unchanged', async () => {
    listing = 'UsbFfs tcp:9120 tcp:9124';
    await api.setupAdbReverse(9123); await api.setupAdbReverse(9123);
    expect(creates()).toHaveLength(0); expect(adb.log).toHaveBeenCalledTimes(1);
    expect(adb.log.mock.calls[0][0]).toContain('may own it');
  });
  it('refuses unknown or failed probes instead of treating them as empty', async () => {
    listing = 'bad response'; await api.setupAdbReverse(9123); expect(creates()).toHaveLength(0);
    adb.run.mockImplementation(async (_file:string,args:string[]) => { if(args[0] === 'devices')return {stdout:'List of devices attached\nUSB\tdevice'};throw new Error('permission denied'); });
    await api.setupAdbReverse(9123); expect(creates()).toHaveLength(0);
  });
  it('never retries a refused no-rebind as an unconditional replacement', async () => {
    adb.run.mockImplementation(async (_file:string,args:string[]) => {
      if(args[0] === 'devices')return {stdout:'List of devices attached\nUSB\tdevice'};
      if(args.includes('--list'))return {stdout:''}; throw new Error('intervening owner');
    });
    await api.setupAdbReverse(9123);
    expect(creates()).toHaveLength(1); expect(adb.run).toHaveBeenCalledTimes(3); expect(adb.log).toHaveBeenCalledTimes(1);
  });
  it('does not install a tunnel after polling was stopped during a pending probe', async () => {
    vi.useFakeTimers(); let resolve!: (value:{stdout:string})=>void;
    adb.run.mockImplementation(async (_file:string,args:string[]) => args[0] === 'devices' ? {stdout:'List of devices attached\nUSB\tdevice'} : new Promise(r => {resolve=r;}));
    const stop = api.startAdbReversePolling(9123,{intervalMs:10});
    await vi.advanceTimersByTimeAsync(10); stop(); resolve({stdout:''});
    await vi.advanceTimersByTimeAsync(100); expect(creates()).toHaveLength(0);
  });
  it('does not remove any mapping at shutdown because ADB cannot conditionally remove an owned target', async () => {
    await api.cleanupAdbReverse(9123); expect(adb.run).not.toHaveBeenCalled();
  });
});
