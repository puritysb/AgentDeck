import { EventEmitter } from 'node:events';
import { createServer, type Server, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenOnce, listenWithReclaim } from '../daemon-listen.js';
import { preferredPortReclaimBudgetMs } from '../daemon-port.js';

function fakeListener(failure: () => string | undefined) {
  const server = new EventEmitter() as Server;
  server.listen = vi.fn(() => {
    const code = failure();
    queueMicrotask(() => code
      ? server.emit('error', Object.assign(new Error(code), { code }))
      : server.emit('listening'));
    return server;
  }) as Server['listen'];
  return server;
}

afterEach(() => vi.useRealTimers());

describe('startup preferred-port reclaim', () => {
  it('binds after a 58s silent macOS hold without a fallback or leaked listeners', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const start = performance.now();
    const server = fakeListener(() => performance.now() - start < 58_000 ? 'EADDRINUSE' : undefined);
    const waiting = vi.fn();
    const result = listenWithReclaim(server, {
      port: 19220, host: '127.0.0.1', budgetMs: preferredPortReclaimBudgetMs('darwin'),
      onConflict: async () => 'retry', onWaiting: waiting,
    });
    await vi.advanceTimersByTimeAsync(58_000);
    expect(await result).toBe('bound');
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(server.listen).toHaveBeenLastCalledWith(19220, '127.0.0.1');
    expect(server.listenerCount('error')).toBe(0);
    expect(server.listenerCount('listening')).toBe(0);
  });

  it.each(['darwin', 'linux', 'win32'] as const)('bounds a permanently silent conflict on %s', async (platform) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const server = fakeListener(() => 'EADDRINUSE');
    const budgetMs = preferredPortReclaimBudgetMs(platform);
    let completed = false;
    const result = listenWithReclaim(server, {
      port: 19220, host: '0.0.0.0', budgetMs,
      onConflict: async () => 'retry', onWaiting: () => {},
    }).then(value => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(budgetMs - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('fallback');
    expect(server.listenerCount('listening')).toBe(0);
  });

  it.each(['concede', 'fallback'] as const)('stops retrying when a newly discovered peer requires %s', async (action) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const server = fakeListener(() => 'EADDRINUSE');
    const conflict = vi.fn().mockResolvedValueOnce('retry').mockResolvedValue(action);
    const result = listenWithReclaim(server, {
      port: 19220, host: '0.0.0.0', budgetMs: 90_000,
      onConflict: conflict, onWaiting: () => {},
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe(action);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(server.listen).toHaveBeenCalledTimes(2);
    expect(conflict).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-contention error without probing or retrying', async () => {
    const server = fakeListener(() => 'EACCES');
    const conflict = vi.fn();
    await expect(listenWithReclaim(server, {
      port: 19220, host: '0.0.0.0', budgetMs: 90_000,
      onConflict: conflict, onWaiting: () => {},
    })).rejects.toMatchObject({ code: 'EACCES' });
    expect(conflict).not.toHaveBeenCalled();
    expect(server.listenerCount('error')).toBe(0);
    expect(server.listenerCount('listening')).toBe(0);
  });

  it('cleans up after a synchronous listen failure', async () => {
    const server = new EventEmitter() as Server;
    server.listen = (() => { throw new Error('invalid options'); }) as Server['listen'];
    await expect(listenOnce(server, 19220, '127.0.0.1')).rejects.toThrow('invalid options');
    expect(server.listenerCount('error')).toBe(0);
    expect(server.listenerCount('listening')).toBe(0);
  });

  it('retains a real port after the incumbent socket closes, using the resolved bind address', async () => {
    const incumbent = createServer();
    const candidate = createServer();
    await listenOnce(incumbent, 0, '127.0.0.1');
    const port = (incumbent.address() as AddressInfo).port;
    let conflicts = 0;
    try {
      const result = await listenWithReclaim(candidate, {
        port, host: '127.0.0.1', budgetMs: 2000,
        onConflict: async () => {
          conflicts++;
          await new Promise<void>(resolve => incumbent.close(() => resolve()));
          return 'retry';
        },
        onWaiting: () => {},
      });
      expect(result).toBe('bound');
      expect(conflicts).toBe(1);
      expect(candidate.address()).toMatchObject({ address: '127.0.0.1', port });
      const competitor = createServer();
      await expect(listenOnce(competitor, port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await Promise.all([incumbent, candidate].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });
});
