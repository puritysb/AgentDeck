/**
 * Windows volume coprocess — protocol, serialization, coalescing, breaker.
 *
 * Everything runs against a fake child process; no PowerShell is spawned, so
 * these tests are host-platform independent. The scenarios pin the failure
 * semantics that came out of the design review: a hung-but-alive child killed
 * by the request timeout MUST count toward the breaker (it never served), and
 * a child that served real requests before dying must NOT.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

interface SpawnCall { exe: string; args: string[]; opts: Record<string, unknown> }

class FakeChild extends EventEmitter {
  written: string[] = [];
  // matches the narrow surface win32-volume uses (incl. the EPIPE 'error' listener hook)
  stdin = {
    writable: true,
    write: (s: string): boolean => { this.written.push(s); return true; },
    on: (_event: string, _listener: () => void): void => {},
  };
  stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  killed = false;
  kill = vi.fn((): boolean => {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
    return true;
  });
  reply(line: string): void {
    this.stdout.emit('data', `${line}\n`);
  }
}

const spawnCalls: SpawnCall[] = [];
let children: FakeChild[] = [];

vi.mock('child_process', () => ({
  spawn: (exe: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ exe, args, opts });
    const child = new FakeChild();
    children.push(child);
    return child;
  },
  execFile: vi.fn(),
}));

import { WinVolumeCoprocess } from '../system/win32-volume.js';

function latest(): FakeChild {
  return children[children.length - 1];
}

/** Let queued microtasks (promise callbacks after emit) run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('win32 volume coprocess', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    children = [];
    vi.useFakeTimers();
    // each test constructs a coprocess, and each constructor registers one
    // process 'exit' listener — raise the cap so Node doesn't warn
    process.setMaxListeners(100);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns powershell with -EncodedCommand carrying the ReadLine server script', async () => {
    const co = new WinVolumeCoprocess();
    void co.get().catch(() => {});
    expect(spawnCalls).toHaveLength(1);
    const { exe, args, opts } = spawnCalls[0];
    expect(exe.toLowerCase()).toContain('powershell.exe');
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    const encodedIdx = args.indexOf('-EncodedCommand');
    expect(encodedIdx).toBeGreaterThan(-1);
    const script = Buffer.from(args[encodedIdx + 1], 'base64').toString('utf16le');
    expect(script).toContain('ReadLine');
    expect(script).toContain('READY');
    expect(script).toContain('IAudioEndpointVolume');
    expect(opts).toMatchObject({ windowsHide: true });
  });

  it('waits for READY before writing, then GET resolves from an OK line', async () => {
    const co = new WinVolumeCoprocess();
    const p = co.get();
    expect(latest().written).toHaveLength(0);
    latest().reply('READY');
    expect(latest().written).toEqual(['GET\n']);
    latest().reply('OK 65 0');
    await expect(p).resolves.toEqual({ outputVolume: 65, outputMuted: false });
  });

  it('SET and MUTE use the wire format and parse the post-state echo', async () => {
    const co = new WinVolumeCoprocess();
    const pSet = co.set(30.4);
    latest().reply('READY');
    expect(latest().written).toEqual(['SET 30\n']);
    latest().reply('OK 30 0');
    await expect(pSet).resolves.toEqual({ outputVolume: 30, outputMuted: false });

    const pMute = co.mute(true);
    await flush();
    expect(latest().written).toEqual(['SET 30\n', 'MUTE 1\n']);
    latest().reply('OK 30 1');
    await expect(pMute).resolves.toEqual({ outputVolume: 30, outputMuted: true });
  });

  it('an ERR line rejects only that request; the child keeps serving', async () => {
    const co = new WinVolumeCoprocess();
    const p1 = co.get();
    latest().reply('READY');
    latest().reply('ERR boom');
    await expect(p1).rejects.toThrow(/ERR boom/);

    const p2 = co.get();
    await flush();
    latest().reply('OK 10 0');
    await expect(p2).resolves.toEqual({ outputVolume: 10, outputMuted: false });
    expect(children).toHaveLength(1); // same child throughout
  });

  it('serializes: the second request is not written until the first resolves', async () => {
    const co = new WinVolumeCoprocess();
    const p1 = co.get();
    const p2 = co.get();
    latest().reply('READY');
    expect(latest().written).toEqual(['GET\n']);
    latest().reply('OK 65 0');
    await p1;
    expect(latest().written).toEqual(['GET\n', 'GET\n']);
    latest().reply('OK 65 0');
    await p2;
  });

  it('coalesces queued SETs while the child hangs — only the final value is written', async () => {
    const co = new WinVolumeCoprocess();
    const pGet = co.get();          // becomes in-flight, child not READY yet
    const s1 = co.set(10);
    const s2 = co.set(20);
    const s3 = co.set(30);
    await expect(s1).rejects.toThrow('superseded');
    await expect(s2).rejects.toThrow('superseded');
    latest().reply('READY');
    latest().reply('OK 65 0');      // completes the GET
    await pGet;
    expect(latest().written).toEqual(['GET\n', 'SET 30\n']);
    latest().reply('OK 30 0');
    await expect(s3).resolves.toEqual({ outputVolume: 30, outputMuted: false });
  });

  it('kills a hung child on the first-request timeout and respawns lazily', async () => {
    const co = new WinVolumeCoprocess();
    const p1 = co.get();            // child never sends READY
    const rejected = expect(p1).rejects.toThrow();  // attach before the timer fires
    await vi.advanceTimersByTimeAsync(15_000);
    expect(children[0].kill).toHaveBeenCalled();
    await rejected;

    const p2 = co.get();            // lazy respawn
    expect(children).toHaveLength(2);
    latest().reply('READY');
    latest().reply('OK 40 0');
    await expect(p2).resolves.toEqual({ outputVolume: 40, outputMuted: false });
  });

  it('breaker: three never-served children (incl. hung-killed-by-timeout) flip unsupported', async () => {
    const co = new WinVolumeCoprocess();
    for (let i = 0; i < 3; i += 1) {
      const p = co.get();
      const rejected = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_000);  // hung → timeout kill → strike
      await rejected;
    }
    expect(co.isSupported()).toBe(false);
    expect(children).toHaveLength(3);
    await expect(co.get()).rejects.toThrow(/unavailable/);
    expect(children).toHaveLength(3);             // no further spawns
  });

  it('a served child dying is NOT a strike, and resets the count', async () => {
    const co = new WinVolumeCoprocess();

    // two strikes from never-served children
    for (let i = 0; i < 2; i += 1) {
      const p = co.get();
      const rejected = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
    }

    // a healthy child serves once, then dies — no third strike, count resets
    const ok = co.get();
    latest().reply('READY');
    latest().reply('OK 65 0');
    await ok;
    const dying = co.get();
    latest().emit('exit', 1, null);
    await expect(dying).rejects.toThrow();
    expect(co.isSupported()).toBe(true);

    // it now takes three MORE never-served exits to trip the breaker
    for (let i = 0; i < 3; i += 1) {
      const p = co.get();
      const rejected = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
    }
    expect(co.isSupported()).toBe(false);
  });

  it("a spawn 'error' without 'exit' (ENOENT) still rejects and counts a strike", async () => {
    const co = new WinVolumeCoprocess();
    const p = co.get();
    latest().emit('error', new Error('spawn ENOENT'));  // node never fires 'exit' here
    await expect(p).rejects.toThrow(/failed to start/);

    // two more such failures trip the breaker
    for (let i = 0; i < 2; i += 1) {
      const q = co.get();
      latest().emit('error', new Error('spawn ENOENT'));
      await expect(q).rejects.toThrow();
    }
    expect(co.isSupported()).toBe(false);
  });

  it("a zombie child's late buffered stdout cannot resolve the new child's request", async () => {
    const co = new WinVolumeCoprocess();
    const p1 = co.get();
    const rejected = expect(p1).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);   // hung child #1 killed
    await rejected;
    const zombie = children[0];

    const p2 = co.get();                          // child #2 spawned, request in-flight
    zombie.reply('READY');                        // late buffered output from the corpse
    zombie.reply('OK 99 1');                      // must NOT resolve p2
    latest().reply('READY');
    latest().reply('OK 40 0');
    await expect(p2).resolves.toEqual({ outputVolume: 40, outputMuted: false });
  });

  it('a child exit rejects the in-flight and all queued requests', async () => {
    const co = new WinVolumeCoprocess();
    const p1 = co.get();
    const p2 = co.set(50);
    latest().emit('exit', 1, null);
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
  });

  it("a stream 'error' event is absorbed — an unlistened stream error would crash the process", async () => {
    const co = new WinVolumeCoprocess();
    const p = co.get();
    // EventEmitter throws on 'error' with no listener, so this line IS the assertion
    latest().stdout.emit('error', new Error('pipe broke'));
    latest().reply('READY');
    latest().reply('OK 65 0');
    await expect(p).resolves.toEqual({ outputVolume: 65, outputMuted: false });
  });

  it('dispose writes EXIT and kills the child', async () => {
    const co = new WinVolumeCoprocess();
    void co.get().catch(() => {});
    const child = latest();
    child.reply('READY');
    co.dispose();
    expect(child.written).toContain('EXIT\n');
    expect(child.kill).toHaveBeenCalled();
  });
});
