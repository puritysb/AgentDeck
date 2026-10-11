import type { IncomingMessage, ServerResponse } from 'node:http';
import { LocalOAuth, OAuthError, OAUTH_LIMITS } from './local-oauth.js';
import { LIMITS } from './contracts.js';

async function read(req: IncomingMessage, type: string, limit: number): Promise<string> {
  if (!req.headers['content-type']?.startsWith(type)) throw new OAuthError('invalid_request');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new OAuthError('invalid_request'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
const form = async (req: IncomingMessage) => new URLSearchParams(await read(req, 'application/x-www-form-urlencoded', LIMITS.bodyBytes));
async function json(req: IncomingMessage): Promise<unknown> {
  const text = await read(req, 'application/json', OAUTH_LIMITS.registrationBytes);
  try { return JSON.parse(text); } catch { throw new OAuthError('invalid_client_metadata'); }
}
export async function oauthHTTP(req: IncomingMessage, res: ServerResponse, oauth: LocalOAuth): Promise<boolean> {
  const path = req.url?.split('?')[0];
  if (!['/.well-known/oauth-authorization-server', '/oauth/authorize', '/oauth/status', '/oauth/token', '/oauth/revoke', '/oauth/register'].includes(path ?? '')) return false;
  const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    const url = new URL(req.url!, 'https://local.invalid');
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') reply(200, oauth.metadata());
    else if (req.method === 'GET' && path === '/oauth/authorize') {
      // A metadata-document client is fetched first; the request itself stays synchronous.
      if (url.searchParams.getAll('client_id').length === 1) await oauth.prepareClient(url.searchParams.get('client_id'));
      const id = oauth.request(url.searchParams);
      reply(302, '', { Location: `/oauth/status?id=${id}` });
    } else if (req.method === 'GET' && path === '/oauth/status') {
      const id = url.searchParams.get('id') ?? '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(id) || url.searchParams.getAll('id').length !== 1) throw new OAuthError('invalid_request');
      const status = oauth.status(id);
      if ('redirect' in status) reply(302, '', { Location: status.redirect });
      else reply(200, `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3><title>Connect AgentDeck</title><h1>Approve in AgentDeck</h1><p>Compare this code with the local connection request before approving:</p><p>${status.verificationCode}</p><p>This request expires in two minutes.</p>`, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
    } else if (req.method === 'POST' && path === '/oauth/token') reply(200, oauth.exchange(await form(req)));
    else if (req.method === 'POST' && path === '/oauth/revoke') { oauth.revoke(await form(req)); reply(200); }
    else if (req.method === 'POST' && path === '/oauth/register') reply(201, oauth.register(await json(req)));
    else reply(405);
  } catch (error) { reply(400, { error: error instanceof OAuthError ? error.code : 'invalid_request' }); }
  return true;
}
