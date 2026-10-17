import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { State } from '@agentdeck/shared';
import { WsTestClient } from './helpers/ws-test-client.js';

vi.mock('../auth.js', () => ({
  isLocalConnection: () => false,
  validateToken: (token: string) => token === 'paired-test-peer',
}));

import { WsServer } from '../ws-server.js';

describe('WebSocket clients admitted before daemon initialization finishes', () => {
  let http: Server;
  let server: WsServer;
  let url: string;
  let clients: WsTestClient[];

  beforeEach(async () => {
    http = createServer();
    server = new WsServer(http);
    clients = [];
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    server.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  async function connect(): Promise<WsTestClient> {
    const client = new WsTestClient();
    clients.push(client);
    await client.connect(`${url}?token=paired-test-peer`);
    return client;
  }

  function sendSnapshot(ws: WebSocket): void {
    server.sendTo(ws, { type: 'connection', status: 'connected', sessionId: 'daemon' });
    server.sendTo(ws, { type: 'sessions_list', sessions: [] });
  }

  it('delivers the initial connection and roster once to early and later clients', async () => {
    const early = await connect();
    // Startup broadcasts can make the transport look connected while the app
    // still awaits the one-off connection event from the initial snapshot.
    server.broadcast({ type: 'state_update', state: State.IDLE, permissionMode: 'default' });
    await early.waitForType('state_update');
    expect(early.getMessagesOfType('connection')).toHaveLength(0);

    const snapshot = vi.fn(sendSnapshot);
    server.onClientConnect(snapshot);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(await early.waitForType('connection')).toMatchObject({ status: 'connected' });
    await early.waitForType('sessions_list');

    // Replacing the callback must not replay already delivered snapshots.
    const replacement = vi.fn(sendSnapshot);
    server.onClientConnect(replacement);
    expect(replacement).not.toHaveBeenCalled();
    const later = await connect();
    await later.waitForType('sessions_list');
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(early.getMessagesOfType('connection')).toHaveLength(1);
    expect(later.getMessagesOfType('connection')).toHaveLength(1);
  });

  it('does not initialize an early client that already disconnected', async () => {
    const early = await connect();
    await early.close();
    const snapshot = vi.fn(sendSnapshot);
    server.onClientConnect(snapshot);
    expect(snapshot).not.toHaveBeenCalled();
    const later = await connect();
    await later.waitForType('connection');
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a delayed snapshot to an unauthorized peer', async () => {
    const rejected = new WebSocket(url);
    const closed = once(rejected, 'close');
    const messages: unknown[] = [];
    rejected.on('message', (message) => messages.push(message));
    await once(rejected, 'open');
    const snapshot = vi.fn(sendSnapshot);
    server.onClientConnect(snapshot);
    expect(snapshot).not.toHaveBeenCalled();
    expect((await closed)[0]).toBe(4001);
    expect(messages).toHaveLength(0);
  });
});
