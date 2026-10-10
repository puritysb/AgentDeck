import type { IncomingMessage, ServerResponse } from 'node:http';
import { LocalOAuth, OAuthError } from './local-oauth.js';
import { LIMITS } from './contracts.js';

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > LIMITS.bodyBytes) throw new OAuthError('invalid_request'); chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
export async function oauthHTTP(req: IncomingMessage, res: ServerResponse, oauth: LocalOAuth): Promise<boolean> {
  const path = req.url?.split('?')[0];
  if (!['/.well-known/oauth-authorization-server', '/oauth/authorize', '/oauth/status', '/oauth/token', '/oauth/revoke'].includes(path ?? '')) return false;
  const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    const url = new URL(req.url!, 'https://local.invalid');
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') reply(200, oauth.metadata());
    else if (req.method === 'GET' && path === '/oauth/authorize') {
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
    else reply(405);
  } catch (error) { reply(400, { error: error instanceof OAuthError ? error.code : 'invalid_request' }); }
  return true;
}
