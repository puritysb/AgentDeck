import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { DaemonClient } from '../daemon-client.js';

// Real filesystem, HTTP and WebSocket on each CI OS. This models a foreign
// process namespace; it does not boot WSL or run Studio/device firmware.
const hubs: Array<{ http: Server; ws: WebSocketServer }> = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await Promise.all(hubs.splice(0).map(async ({ http, ws }) => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }));
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function registry(port: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-ulanzi-transport-'));
  dirs.push(dir);
  // Not a usable local PID. Discovery must ask the daemon instead of kill(pid,0).
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ port, pid: 2_147_483_647 }));
  vi.stubEnv('AGENTDECK_DATA_DIR', dir);
  return dir;
}

async function hub() {
  let probes = 0;
  const registrations: unknown[] = [];
  const commands: unknown[] = [];
  const http = createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
    probes++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', mode: 'daemon' }));
  });
  const ws = new WebSocketServer({ server: http });
  hubs.push({ http, ws });
  ws.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.type === 'client_register') {
      registrations.push(message);
      socket.send(JSON.stringify({ type: 'sessions_list', sessions: [] }));
    } else commands.push(message);
  }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return { port: (http.address() as AddressInfo).port, ws, registrations, commands,
    probes: () => probes };
}

function client() {
  const result = new DaemonClient();
  clients.push(result);
  return result;
}

it('connects through native health and WS despite a foreign registry PID, then exchanges frames', async () => {
  const server = await hub();
  registry(server.port);
  const connection = client();
  const events: unknown[] = [];
  connection.on('event', event => events.push(event));
  connection.start();
  await vi.waitFor(() => {
    expect(connection.isConnected()).toBe(true);
    expect(server.registrations).toHaveLength(1);
    expect(events).toContainEqual({ type: 'sessions_list', sessions: [] });
  }, { timeout: 5000 });
  expect(server.probes()).toBeGreaterThan(0);
  expect(server.registrations[0]).toMatchObject({ type: 'client_register', clientType: 'ulanzi-plugin' });
  connection.send({ type: 'select_session', sessionId: 'local-fixture' });
  await vi.waitFor(() => expect(server.commands).toContainEqual({ type: 'select_session', sessionId: 'local-fixture' }));
});

it('rediscovers a changed registry port and registers again after a real socket drop', async () => {
  const first = await hub();
  const second = await hub();
  const dir = registry(first.port);
  const connection = client();
  const disconnected = vi.fn();
  connection.on('disconnected', disconnected);
  connection.start();
  await vi.waitFor(() => expect(first.registrations).toHaveLength(1), { timeout: 5000 });
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ port: second.port, pid: 2_147_483_647 }));
  for (const socket of first.ws.clients) socket.terminate();
  await vi.waitFor(() => {
    expect(disconnected).toHaveBeenCalledOnce();
    expect(second.registrations).toHaveLength(1);
    expect(connection.isConnected()).toBe(true);
  }, { timeout: 5000 });
  expect(second.probes()).toBeGreaterThan(0);
  expect(second.registrations[0]).toMatchObject({ clientType: 'ulanzi-plugin' });
});
