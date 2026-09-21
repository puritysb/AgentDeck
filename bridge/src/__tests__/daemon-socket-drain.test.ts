import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { trackDaemonSockets } from '../daemon-socket-drain.js';

describe('daemon socket handover', () => {
  it.each(['http', 'upgrade'] as const)('resets an open %s peer and releases the listener', async (kind) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ready\n\n');
    });
    server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    });
    const drain = trackDaemonSockets(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const client = connect(port, '127.0.0.1');
    const errors: string[] = [];
    client.on('error', e => errors.push((e as NodeJS.ErrnoException).code!));
    try {
      await once(client, 'connect');
      client.write(`GET / HTTP/1.1\r\nHost: localhost\r\n${kind === 'upgrade' ? 'Connection: Upgrade\r\nUpgrade: test\r\n' : ''}\r\n`);
      await once(client, 'data');
      const closed = new Promise<void>(r => client.once('close', () => r()));
      drain();
      drain(); // Teardown can be requested twice.
      await closed;
      expect(errors).toContain('ECONNRESET');
      expect(server.listening).toBe(false);
      const successor = createServer();
      await new Promise<void>((resolve, reject) => {
        successor.once('error', reject);
        successor.listen(port, '127.0.0.1', resolve);
      });
      await new Promise<void>(r => successor.close(() => r()));
    } finally { client.destroy(); server.close(); }
  });
});
