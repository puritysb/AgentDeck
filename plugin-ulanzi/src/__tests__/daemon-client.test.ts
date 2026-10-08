import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { discoverDaemonPort } from '../daemon-discovery.js';
import { DaemonClient } from '../daemon-client.js';

vi.mock('../daemon-discovery.js', () => ({ discoverDaemonPort: vi.fn() }));
vi.mock('ws', () => ({ default: vi.fn(function () {
  return Object.assign(new EventEmitter(), { send: vi.fn(), terminate: vi.fn(), close: vi.fn() });
}) }));
afterEach(() => vi.resetAllMocks());

it('does not open a socket after a pending discovery has been stopped', async () => {
  let complete!: (port: number) => void;
  vi.mocked(discoverDaemonPort).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const client = new DaemonClient();
  client.start(); client.stop(); complete(9120);
  await Promise.resolve();
  expect(WebSocket).not.toHaveBeenCalled();
});

it('registers the Ulanzi surface after health discovery and bounds the handshake', async () => {
  vi.mocked(discoverDaemonPort).mockResolvedValue(9120);
  const client = new DaemonClient(); client.start();
  await Promise.resolve();
  expect(WebSocket).toHaveBeenCalledWith('ws://127.0.0.1:9120', { handshakeTimeout: 3000 });
  const socket = vi.mocked(WebSocket).mock.results[0].value;
  socket.emit('open');
  expect(JSON.parse(socket.send.mock.calls[0][0]).clientType).toBe('ulanzi-plugin');
  expect(client.isConnected()).toBe(true);
  client.stop();
  expect(client.isConnected()).toBe(false);
  expect(socket.terminate).toHaveBeenCalledOnce();
});
