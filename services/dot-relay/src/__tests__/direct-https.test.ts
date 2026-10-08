import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { directHTTPS } from '../direct-https.js';
import { createRelayServer } from '../server.js';
import { Store } from '../store.js';
import { Relay } from '../relay.js';

// Publicly checked-in, self-signed TEST identity. Never a production trust anchor.
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const env = { DOT_RELAY_RESOURCE: 'https://relay.example', DOT_RELAY_TLS_CERT: fixture('localhost-test.crt'),
  DOT_RELAY_TLS_KEY: fixture('localhost-test.key') };
const certificate = readFileSync(env.DOT_RELAY_TLS_CERT);
let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

describe('direct HTTPS MCP ingress', () => {
  it('refuses missing keys, wrong hostname, expired certificate and daemon ports', () => {
    expect(() => directHTTPS({ ...env, DOT_RELAY_TLS_KEY: undefined })).toThrow('Missing');
    expect(() => directHTTPS({ ...env, DOT_RELAY_RESOURCE: 'https://wrong.example' })).toThrow('hostname');
    expect(() => directHTTPS(env, Date.UTC(2099, 0, 1))).toThrow('valid');
    for (const port of ['9120', '9121', '9139', '443', 'NaN']) {
      expect(() => directHTTPS({ ...env, DOT_RELAY_PORT: port })).toThrow('port');
    }
    expect(() => directHTTPS({ ...env, DOT_RELAY_RESOURCE: 'https://relay.example/mcp' })).toThrow('origin');
  });

  it('terminates real TLS, rejects plaintext and keeps device actions off public ingress', async () => {
    directory = mkdtempSync(join(tmpdir(), 'dot-direct-tls-'));
    const store = new Store(join(directory, 'state.json'));
    const server = createRelayServer(new Relay(store), async token => {
      if (token !== 'test-token') throw new Error('Unauthorized');
      return { subject: 'test', scopes: ['agentdeck:read', 'agentdeck:device'] };
    }, env.DOT_RELAY_RESOURCE, 'https://issuer.example', { tls: directHTTPS(env).tls, deviceRoutes: false });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const call = (path: string, authenticated = true, ca: Buffer | undefined = certificate) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', servername: 'relay.example', port, path, method: 'POST', ca,
        timeout: 2000, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer test-token' } : {}) } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('timeout', () => req.destroy(new Error('Timeout'))); req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    try {
      expect((await call('/mcp')).status).toBe(200);
      expect((await call('/mcp', false)).status).toBe(401);
      for (const path of ['/experiment/requests', '/experiment/revoke', '/health', '/shutdown']) {
        expect((await call(path)).status).toBe(404);
      }
      const plaintext = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1'); let bytes = '';
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Plaintext socket did not close')); });
        socket.on('connect', () => socket.write('GET /mcp HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
        socket.on('data', chunk => bytes += chunk); socket.on('close', () => resolve(bytes)); socket.on('error', reject);
      });
      expect(plaintext).not.toContain('HTTP/1.1 200');
      // No process-wide disablement of TLS validation, even in the test harness.
      await expect(call('/mcp', true, Buffer.from('invalid CA'))).rejects.toThrow();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
  });
});
