import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import { createServer as createHTTPSServer, type ServerOptions } from 'node:https';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { Fault, LIMITS, VERSION, type Principal } from './contracts.js';
import type { Relay } from './relay.js';
import type { LocalOAuth } from './local-oauth.js';
import { oauthHTTP } from './oauth-http.js';

// Tools-only compatibility; MCP Events discovery remains a separate experimental contract.
const TOOL_VERSION = '2025-11-25';

export type Authenticate = (bearer: string) => Promise<Principal>;
export function jwtAuth(issuer: string, audience: string, jwks: URL | JWTVerifyGetKey): Authenticate {
  const key = jwks instanceof URL ? createRemoteJWKSet(jwks, { timeoutDuration: 5000 }) : jwks;
  return async token => {
    const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'sub'] });
    if (!payload.sub || typeof payload.scope !== 'string') throw new Error('Missing subject/scope');
    return { subject: payload.sub, scopes: payload.scope.split(' ').filter(Boolean) };
  };
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.bodyBytes) throw new Fault(-32013, 'Request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Fault(-32700, 'Invalid JSON'); }
}
export function createRelayServer(relay: Relay, authenticate: Authenticate, resource: string, issuer: string,
  options: { tls?: ServerOptions; deviceRoutes?: boolean; oauth?: LocalOAuth; operator?: boolean } = {}) {
  let budgetAt = Date.now(), budget = 0;
  const handler: RequestListener = async (req, res) => {
    const reply = (status: number, value?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (Date.now() - budgetAt >= 60_000) { budgetAt = Date.now(); budget = 0; }
    if (++budget > LIMITS.requestsPerMinute) { res.setHeader('Retry-After', '60'); reply(429); return; }
    // Server-to-server experiment; browser requests are unsupported, not granted broad CORS.
    if (req.headers.origin) { reply(403, { error: 'Browser requests are not supported' }); return; }
    if (options.oauth && !options.operator && await oauthHTTP(req, res, options.oauth)) return;
    if (req.method === 'GET' && req.url === '/.well-known/oauth-protected-resource') {
      reply(200, { resource, authorization_servers: [issuer], scopes_supported: [
        'agentdeck:read', 'agentdeck:report', 'agentdeck:subscribe',
      ] }); return;
    }
    // Public ingress must not expose local device/control endpoints, even with a valid device token.
    if (options.deviceRoutes === false && req.url !== '/mcp') { reply(404, { error: 'Not found' }); return; }
    let principal: Principal;
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) throw new Error('Missing bearer');
      principal = await authenticate(auth.slice(7));
    } catch {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource"`);
      reply(401, { error: 'Authorization required' }); return;
    }
    let rpcId: unknown = null;
    const isRpc = req.method === 'POST' && req.url === '/mcp';
    try {
      if (options.operator && options.oauth) {
        if (req.url === '/operator/status' && req.method === 'GET') { reply(200, { pending: options.oauth.pendingRequests(), grants: options.oauth.grants(), requests: relay.list() }); return; }
        if (req.url === '/operator/consent' && req.method === 'POST') {
          const value = await body(req) as { id?: string; approve?: boolean };
          if (typeof value?.id !== 'string' || typeof value.approve !== 'boolean') throw new Fault(-32602, 'Invalid consent decision');
          options.oauth.decide(value.id, value.approve); reply(200, { accepted: true }); return;
        }
        if (req.url === '/operator/revoke' && req.method === 'POST') {
          const value = await body(req) as { grantId?: string };
          if (typeof value?.grantId !== 'string') throw new Fault(-32602, 'Invalid grant');
          options.oauth.revokeGrant(value.grantId); relay.maintenance(); reply(200, { revoked: true }); return;
        }
        if (req.url === '/operator/request' && req.method === 'POST') {
          const { grantId, ...input } = await body(req) as Record<string, unknown>;
          if (typeof grantId !== 'string' || !options.oauth.hasAccess(grantId)) throw new Fault(-32003, 'Invalid grant');
          reply(201, relay.create({ subject: grantId, scopes: ['agentdeck:device'] }, input)); return;
        }
        reply(404, { error: 'Not found' }); return;
      }
      relay.authorize(principal);
      if (req.url === '/mcp' && req.method !== 'POST') {
        res.setHeader('Allow', 'POST'); reply(405); return;
      }
      if (isRpc) {
        const version = req.headers['mcp-protocol-version'];
        if (version !== undefined && version !== TOOL_VERSION && version !== VERSION) {
          reply(400, { error: 'Unsupported MCP protocol version' }); return;
        }
        if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, { error: 'Expected application/json' }); return; }
        const request = await body(req) as Record<string, unknown>;
        if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0'
          || typeof request.method !== 'string' || ('id' in request && !(typeof request.id === 'string' || (typeof request.id === 'number' && Number.isSafeInteger(request.id))))) {
          throw new Fault(-32600, 'Expected a JSON-RPC request or notification');
        }
        if (!('id' in request)) {
          // No server-initiated requests or cancellable streaming operations in this pilot.
          if (request.method !== 'notifications/initialized' && request.method !== 'notifications/cancelled') {
            reply(400, { error: 'Unsupported notification' }); return;
          }
          reply(202); return;
        }
        rpcId = request.id;
        if (request.method === 'initialize') {
          const params = request.params as Record<string, unknown> | undefined;
          if (!params || typeof params.protocolVersion !== 'string' || !params.capabilities
            || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)
            || !params.clientInfo || typeof params.clientInfo !== 'object') {
            throw new Fault(-32602, 'Invalid initialization parameters');
          }
          // Negotiate only the tools protocol here; do not advertise Events to a legacy client.
          reply(200, { jsonrpc: '2.0', id: rpcId, result: {
            protocolVersion: TOOL_VERSION, capabilities: { tools: {} },
            serverInfo: { name: 'agentdeck-dot-relay-experiment', version: '0.0.0' },
            instructions: 'Use get_request and get_context for a shared request, then claim_request before report_update. Reports describe this request only, never global Dot status.',
          } }); return;
        }
        if (request.method === 'ping') { reply(200, { jsonrpc: '2.0', id: rpcId, result: {} }); return; }
        if (version === TOOL_VERSION && (request.method.startsWith('events/') || request.method === 'server/discover')) {
          throw new Fault(-32601, 'MCP Events requires the experimental discovery protocol');
        }
        const result = await relay.rpc(principal, request.method, request.params);
        reply(200, { jsonrpc: '2.0', id: rpcId, result }); return;
      }
      if (req.method === 'POST' && req.url === '/experiment/requests') {
        reply(201, relay.create(principal, await body(req))); return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/experiment/requests/')) {
        reply(200, relay.get(principal, req.url.slice('/experiment/requests/'.length))); return;
      }
      if (req.method === 'POST' && req.url === '/experiment/revoke') {
        relay.revoke(principal); reply(200, { revoked: true }); return;
      }
      reply(404, { error: 'Not found' });
    } catch (error) {
      const fault = error instanceof Fault ? error : new Fault(-32603, 'Internal relay error');
      if (isRpc) reply(fault.code === -32013 ? 413 : 200, { jsonrpc: '2.0', id: rpcId,
        error: { code: fault.code, message: fault.message, ...(fault.reason ? { data: { reason: fault.reason } } : {}) } });
      else reply(fault.code === -32003 ? 403 : fault.code === -32004 ? 404 : fault.code === -32013 ? 413 : fault.code === -32603 ? 500 : 400,
        { error: fault.message });
    }
  };
  const server = options.tls ? createHTTPSServer(options.tls, handler) : createServer(handler);
  server.maxConnections = LIMITS.connections;
  server.maxRequestsPerSocket = 16;
  server.setTimeout(15_000, socket => socket.destroy());
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
