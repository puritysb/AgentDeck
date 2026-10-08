import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { discoverDaemonPort, probeDaemon } from '../daemon-discovery.js';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
const servers: Server[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections(); s.close(() => resolve());
  })));
});

describe('Ulanzi daemon discovery across process namespaces', () => {
  it('finds the canonical hub without a Windows registry', async () => {
    vi.stubEnv('AGENTDECK_DATA_DIR', '');
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const probe = vi.fn(async () => true);
    expect(await discoverDaemonPort(probe)).toBe(9120);
    expect(probe).toHaveBeenCalledExactlyOnceWith(9120);
  });
  it('uses a registry port even when its PID belongs to Linux', async () => {
    vi.stubEnv('AGENTDECK_DATA_DIR', '/test-instance');
    vi.mocked(readFileSync).mockReturnValue('{"port":9234,"pid":272056}');
    expect(await discoverDaemonPort(async () => true)).toBe(9234);
  });
  it('falls back after a stale registry and ignores invalid port values', async () => {
    vi.stubEnv('AGENTDECK_DATA_DIR', '');
    vi.mocked(readFileSync).mockReturnValueOnce('{"port":9234}')
      .mockReturnValue('{"port":-1}');
    const probe = vi.fn(async (port) => port === 9120);
    expect(await discoverDaemonPort(probe)).toBe(9120);
    expect(probe.mock.calls).toEqual([[9234], [9120]]);
  });
  it('does not escape an explicit development data directory', async () => {
    vi.stubEnv('AGENTDECK_DATA_DIR', '/test-instance');
    vi.mocked(readFileSync).mockReturnValue('{"port":"9120"}');
    const probe = vi.fn(async () => true);
    expect(await discoverDaemonPort(probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});

async function endpoint(body?: string, status = 200): Promise<number> {
  const server = createServer((_req, res) => {
    if (body !== undefined) { res.writeHead(status); res.end(body); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('bounded loopback health probe', () => {
  it('accepts only a healthy, locally accessible daemon', async () => {
    expect(await probeDaemon(await endpoint('{"status":"ok","mode":"daemon"}'))).toBe(true);
  });
  it.each([
    '{}', 'null', 'not json', '{"status":"ok","mode":"bridge"}',
    '{"mode":"daemon"}', '{"status":"ok","mode":"daemon","authRequired":true}',
    'x'.repeat(16_385),
  ])('rejects an invalid, incomplete, or unauthorized health response %#', async (body) => {
    expect(await probeDaemon(await endpoint(body))).toBe(false);
  });
  it('rejects HTTP errors and bounds silent peers', async () => {
    expect(await probeDaemon(await endpoint('{"status":"ok","mode":"daemon"}', 500))).toBe(false);
    expect(await probeDaemon(await endpoint(), 25)).toBe(false);
  });
});
