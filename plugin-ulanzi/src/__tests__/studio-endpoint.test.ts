import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #730 finding 1, against the REAL vendored SDK and the real supervisor: the
 * SDK's connect() consumes Studio's launch argv, so a reconnect used to fall
 * back to 127.0.0.1:3906. Only the WebSocket constructor is faked, to record the
 * URL each connect dials.
 */
const dialed: string[] = [];
vi.mock('ws', () => ({
  default: class FakeWebSocket {
    constructor(url: string) { dialed.push(url); }
    close(): void {}
    send(): void {}
  },
}));

const { UlanziApiCtor } = await import('../ulanzi.js');
const { ReconnectSupervisor } = await import('../reconnect-supervisor.js');
const { readStudioEndpoint, studioConnector } = await import('../studio-endpoint.js');

const UUID = 'com.ulanzi.ulanzistudio.agentdeck';
const LAUNCH = ['node', 'app.js', '127.0.0.1', '39069', 'en'];

/** Minimal timer clock: `advance` fires every one-shot that is due. */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { due: t + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    setIntervalTimer: () => 0,
    clearIntervalTimer: () => {},
    advance(ms: number) {
      t += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= t) { timers.delete(id); timer.fn(); }
    },
  };
}

describe('Studio endpoint across reconnects (#730)', () => {
  let savedArgv: string[];
  beforeEach(() => { savedArgv = process.argv; process.argv = [...LAUNCH]; dialed.length = 0; });
  afterEach(() => { process.argv = savedArgv; });

  function reconnectOnce(connect: () => void): void {
    const clock = fakeClock();
    const sup = new ReconnectSupervisor({ connect, backoffMs: [100], clock, log: () => {} });
    sup.start();
    sup.noteOpen();
    sup.noteClosed();
    clock.advance(100);
    sup.stop();
  }

  it('the bare SDK connect loses the launch port on reconnect (the defect)', () => {
    const api = new UlanziApiCtor();
    reconnectOnce(() => api.connect(UUID));
    expect(dialed).toEqual(['ws://127.0.0.1:39069', 'ws://127.0.0.1:3906']);
  });

  it('the retained endpoint dials the launch port on every connect', () => {
    const api = new UlanziApiCtor();
    reconnectOnce(studioConnector(api, UUID, readStudioEndpoint(process.argv)));
    expect(dialed).toEqual(['ws://127.0.0.1:39069', 'ws://127.0.0.1:39069']);
  });

  it('reads argv without consuming it and falls back to SDK defaults', () => {
    const argv = [...LAUNCH];
    expect(readStudioEndpoint(argv)).toEqual({ address: '127.0.0.1', port: 39069 });
    expect(argv).toEqual(LAUNCH);
    expect(readStudioEndpoint(['node', 'app.js'])).toEqual({ address: '127.0.0.1', port: 3906 });
    expect(readStudioEndpoint(['node', 'app.js', '10.0.0.2', 'nope'])).toEqual({ address: '10.0.0.2', port: 3906 });
  });
});
