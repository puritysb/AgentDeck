/** Run manually for private tunnel experiments; never bundled into the macOS app. */
import { existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { DOT_LOCAL_MCP, DOT_LIMITS, DOT_OAUTH_LIMITS } from '@agentdeck/shared';
import { PrivateCredentials, RESOURCE, TunnelSession, boundedText, credentialsFrom, serveStdio } from './tunnel-stdio.js';

async function authorize(store: PrivateCredentials): Promise<void> {
  if (existsSync(store.path)) throw new Error('Credential file exists; revoke the prior grant before replacing it');
  const verifier = randomBytes(48).toString('base64url'), state = randomBytes(32).toString('base64url');
  const redirect = `http://${DOT_LOCAL_MCP.host}:${DOT_LOCAL_MCP.callbackPort}${DOT_LOCAL_MCP.callbackPath}`;
  const params = new URLSearchParams({ response_type: 'code', client_id: DOT_LOCAL_MCP.clientId, redirect_uri: redirect,
    resource: RESOURCE, scope: 'agentdeck:read agentdeck:report', state, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  const local = (url: string, options: RequestInit = {}) => fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(DOT_LIMITS.callbackMs) });
  const begin = await local(`${RESOURCE}/oauth/authorize?${params}`);
  await begin.body?.cancel();
  const location = begin.headers.get('location');
  if (begin.status !== 302 || !location || !/^\/oauth\/status\?id=[A-Za-z0-9_-]{43}$/.test(location)) throw new Error('Authorization refused');
  const id = new URL(location, RESOURCE).searchParams.get('id')!;
  process.stderr.write(`Tunnel-only grant pending: ${id}\nVerification code: ${id.slice(0, 8)}\nScopes: agentdeck:read agentdeck:report\nApprove this separate private-tunnel grant in AgentDeck.\n`);
  const deadline = Date.now() + DOT_OAUTH_LIMITS.consentMs;
  while (Date.now() < deadline) {
    const result = await local(RESOURCE + location); await result.body?.cancel();
    if (result.status === 302) {
      const callback = new URL(result.headers.get('location') ?? '');
      if (callback.origin + callback.pathname !== redirect || callback.searchParams.get('state') !== state
        || callback.searchParams.get('iss') !== RESOURCE || callback.searchParams.has('error') || !callback.searchParams.get('code')) throw new Error('Authorization denied');
      const response = await local(`${RESOURCE}/oauth/token`, { method: 'POST', body: new URLSearchParams({
        client_id: DOT_LOCAL_MCP.clientId, resource: RESOURCE, redirect_uri: redirect, grant_type: 'authorization_code',
        code: callback.searchParams.get('code')!, code_verifier: verifier,
      }) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Token exchange refused'); }
      store.save(credentialsFrom(JSON.parse(await boundedText(response)), Date.now()));
      process.stderr.write('Dedicated credentials saved privately. No token was printed.\n'); return;
    }
    if (result.status !== 200) throw new Error('Authorization expired');
    await setTimeout(1000);
  }
  throw new Error('Authorization expired');
}

async function main(): Promise<void> {
  const [mode, path, ...extra] = process.argv.slice(2);
  if (!['authorize', 'serve'].includes(mode) || !path || extra.length) throw new Error('Usage: tunnel-main.js authorize|serve /absolute/private/credential-file');
  const store = new PrivateCredentials(path);
  const close = () => store.close();
  process.once('exit', close);
  process.once('SIGTERM', () => process.exit(0));
  process.once('SIGINT', () => process.exit(0));
  try {
    if (mode === 'authorize') await authorize(store);
    else {
      store.read();
      await serveStdio(process.stdin, line => new Promise<void>((resolve, reject) => {
        process.stdout.write(line, error => error ? reject(error) : resolve());
      }), new TunnelSession(store));
    }
  } finally { close(); process.removeListener('exit', close); }
}
main().catch(() => { process.stderr.write('AgentDeck tunnel adapter stopped. Check local authorization, private file permissions and exclusive ownership; no automatic retry.\n'); process.exitCode = 1; });
