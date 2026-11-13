import { createServer, type Server, type ServerOptions } from 'node:https';
import type { Socket } from 'node:net';
import { DEVICE_SNAPSHOT as P, buildDeviceSnapshot, deviceHttpAllowed } from '@agentdeck/shared';
import { DeviceCredentialStore } from './device-credential-store.js';

/** Dedicated read-only listener; deliberately has no legacy dispatch callback. */
export class DeviceTLSServer {
  private server: Server;
  private sockets = new Set<Socket>();
  constructor(identity: Pick<ServerOptions, 'pfx' | 'passphrase'>, private credentials: DeviceCredentialStore,
    snapshot: () => Promise<{sessions: unknown; usage: unknown}>) {
    if (!identity.pfx) throw new Error('device-tls-identity-required');
    this.server = createServer({...identity, minVersion:'TLSv1.2', maxHeaderSize:P.headerBytes, handshakeTimeout:P.timeoutMs}, (req, res) => {
      const send = (status: number, body = '') => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),
          'Connection':'close','Cache-Control':'no-store'}); res.end(body);
      };
      // Reject duplicates, browser calls, request bodies, and URL credentials.
      const headers = req.rawHeaders.filter((_, index) => index % 2 === 0).map(key => key.toLowerCase());
      if (!deviceHttpAllowed(req.method ?? '', req.url ?? '') || new Set(headers).size !== headers.length
        || req.headers.origin !== undefined || req.headers['transfer-encoding'] !== undefined
        || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) { send(400); return; }
      const authorization = req.headers.authorization ?? '';
      if (!authorization.startsWith('Bearer ')) { send(401); return; }
      const token = authorization.slice(7);
      let device;
      try { device = credentials.authenticate(token); } catch { send(503); return; }
      if (!device) { send(401); return; }
      const deadline = setTimeout(() => send(504), P.timeoutMs);
      void Promise.resolve().then(snapshot).then(value => {
        if (res.writableEnded || res.destroyed) return;
        // Revocation may occur while snapshot collection is pending.
        const current = credentials.authenticate(token);
        if (!current) { send(401); return; }
        const body = JSON.stringify(buildDeviceSnapshot(current.scopes, value.sessions, value.usage));
        if (Buffer.byteLength(body) > P.maxBytes) { send(503); return; }
        send(200, body);
      }).catch(() => send(503)).finally(() => clearTimeout(deadline));
    });
    this.server.headersTimeout = P.timeoutMs;
    this.server.requestTimeout = P.timeoutMs;
    this.server.setTimeout(P.timeoutMs, socket => socket.destroy());
    this.server.on('connection', socket => {
      if (this.sockets.size >= P.maxConnections) { socket.destroy(); return; }
      this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('upgrade', (_req, socket) => socket.destroy());
    this.server.on('clientError', (_error, socket) => socket.destroy());
    this.server.on('tlsClientError', () => {});
  }
  async start(port: number, host = '0.0.0.0'): Promise<number> {
    if (port !== 0 && (!Number.isInteger(port) || port < 1024 || port > 65535 || (port >= 9120 && port <= 9139))) throw new Error('device-tls-dedicated-port-required');
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.server.off('listening', ready); reject(error); };
      const ready = () => { this.server.off('error', failed); resolve(); };
      this.server.once('error', failed); this.server.once('listening', ready); this.server.listen(port, host);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('device-tls-not-listening');
    return address.port;
  }
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}
