import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { LocalOAuth, OAUTH_LIMITS, clientName, clientRedirect, fetchClientMetadata, metadataRedirectMatches, metadataURL } from '../local-oauth.js';
import { createServer } from 'node:http';
import { Store, oauthStorage } from '../store.js';
const config = { resource: 'https://agentdeck.example', clientId: 'registered-chatgpt-client', clientSecret: 'c'.repeat(48), redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect' };
const verifier = 'v'.repeat(64);
let now: number, path: string, directory: string, store: Store, auth: LocalOAuth;
beforeEach(() => { now = Date.now(); directory = mkdtempSync(join(tmpdir(), 'dot-oauth-')); path = join(directory, 'state.json'); store = new Store(path); auth = new LocalOAuth(config, oauthStorage(store), () => now); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
const authorization = (extra = {}) => new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectURI,
  resource: config.resource, scope: 'agentdeck:read agentdeck:report agentdeck:subscribe', state: 'original-state',
  code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...extra });
function linked() {
  const id = auth.request(authorization()); auth.decide(id, true);
  const status = auth.status(id); if (!('redirect' in status)) throw new Error('Not approved');
  const redirect = new URL(status.redirect);
  const params = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code',
    code: redirect.searchParams.get('code')!, redirect_uri: config.redirectURI, resource: config.resource, code_verifier: verifier });
  return { params, redirect };
}
it('requires native consent and an exact redirect, scope, resource and PKCE', () => {
  const id = auth.request(authorization()); expect(auth.status(id)).toMatchObject({ pending: true });
  expect(auth.grants()).toEqual([]);
  expect(auth.pendingRequests()[0]).toMatchObject({ verificationCode: id.slice(0, 8), redirectURI: config.redirectURI });
  for (const extra of [{ redirect_uri: 'https://evil.example' }, { resource: 'https://other.example' }, { scope: 'agentdeck:device' }, { code_challenge_method: 'plain' }]) {
    expect(() => auth.request(authorization(extra))).toThrow('invalid_request');
  }
  const duplicate = authorization(); duplicate.append('redirect_uri', config.redirectURI);
  expect(() => auth.request(duplicate)).toThrow('invalid_request');
  const { params, redirect } = linked();
  expect(redirect.searchParams.get('iss')).toBe(config.resource); expect(redirect.searchParams.get('state')).toBe('original-state');
  const wrong = new URLSearchParams(params); wrong.set('code_verifier', 'w'.repeat(64));
  expect(() => auth.exchange(wrong)).toThrow('invalid_grant');
  const tokens = auth.exchange(params);
  expect(auth.authenticate(tokens.access_token).scopes).not.toContain('agentdeck:device');
  expect(() => auth.exchange(params)).toThrow('invalid_grant');
  expect(JSON.stringify(store.read())).not.toContain(tokens.access_token);
  expect(JSON.stringify(store.read())).not.toContain(tokens.refresh_token);
});
it('rotates refresh tokens and revokes the entire grant on a replay', () => {
  const first = auth.exchange(linked().params);
  const input = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
    resource: config.resource, grant_type: 'refresh_token', refresh_token: first.refresh_token });
  const second = auth.exchange(input);
  const owner = auth.authenticate(second.access_token).subject;
  expect(second.refresh_token).not.toBe(first.refresh_token);
  expect(() => auth.exchange(input)).toThrow('invalid_grant');
  expect(() => auth.authenticate(second.access_token)).toThrow('invalid_token');
  expect(auth.hasAccess(owner)).toBe(false);
});
it('persists grants across restart, expires access, and keeps revocation durable', () => {
  const tokens = auth.exchange(linked().params), principal = auth.authenticate(tokens.access_token);
  store.close(); store = new Store(path); auth = new LocalOAuth(config, oauthStorage(store), () => now);
  expect(auth.authenticate(tokens.access_token)).toEqual(principal);
  now += OAUTH_LIMITS.accessMs;
  expect(() => auth.authenticate(tokens.access_token)).toThrow('invalid_token');
  auth.revoke(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, token: tokens.refresh_token }));
  expect(auth.hasAccess(principal.subject)).toBe(false);
  store.close(); store = new Store(path); auth = new LocalOAuth(config, oauthStorage(store), () => now);
  expect(auth.hasAccess(principal.subject)).toBe(false);
});
it('denial returns issuer and state, while consent expires and pending work is bounded', () => {
  const id = auth.request(authorization()); auth.decide(id, false);
  const status = auth.status(id); expect(status).toHaveProperty('redirect');
  if ('redirect' in status) expect(new URL(status.redirect).searchParams.get('error')).toBe('access_denied');
  now += OAUTH_LIMITS.consentMs;
  expect(() => auth.decide(id, true)).toThrow('invalid_request');
  for (let i = 0; i < OAUTH_LIMITS.pending; i++) auth.request(authorization());
  expect(() => auth.request(authorization())).toThrow('temporarily_unavailable');
});

it('invalidates existing tokens when registered credentials are replaced', () => {
  const token = auth.exchange(linked().params).access_token;
  auth = new LocalOAuth({ ...config, clientSecret: 'different'.repeat(8) }, oauthStorage(store), () => now);
  expect(() => auth.authenticate(token)).toThrow('invalid_token');
  expect(auth.grants()).toEqual([]);
});
it('supports explicit loopback public clients without weakening confidential clients', () => {
  const local = { resource: 'http://127.0.0.1:9476', clientId: 'agentdeck-local-plugin', clientSecret: '', redirectURI: 'http://127.0.0.1:1455/callback', local: true };
  auth = new LocalOAuth(local, oauthStorage(store), () => now);
  const callback = 'http://127.0.0.1:38472/callback';
  const input = authorization({ client_id: local.clientId, resource: local.resource, redirect_uri: callback, scope: 'agentdeck:read agentdeck:report' });
  for (const bad of ['https://evil.example/callback', 'http://192.168.1.2:1234/callback', 'http://2130706433:1234/callback', 'http://127.0.0.1:1234/other', callback + '?redirect=evil', 'http://user@127.0.0.1:1234/callback']) {
    const invalid = new URLSearchParams(input); invalid.set('redirect_uri', bad);
    expect(() => auth.request(invalid)).toThrow();
  }
  const id = auth.request(input); auth.decide(id, true);
  const status = auth.status(id); if (!('redirect' in status)) throw new Error('not approved');
  const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: local.clientId,
    resource: local.resource, redirect_uri: callback, code: new URL(status.redirect).searchParams.get('code')!, code_verifier: verifier });
  const wrong = new URLSearchParams(params); wrong.set('redirect_uri', local.redirectURI);
  expect(() => auth.exchange(wrong)).toThrow('invalid_grant');
  expect(auth.authenticate(auth.exchange(params).access_token).subject).toBeTruthy();
  expect(() => new LocalOAuth({ ...local, local: false }, oauthStorage(store))).toThrow();
});

const local = { resource: 'http://127.0.0.1:9476', clientId: 'agentdeck-local-plugin', clientSecret: '', redirectURI: 'http://127.0.0.1:1455/callback', local: true };
const vectors = JSON.parse(readFileSync(new URL('../../../../shared/dot-oauth-client-vectors.json', import.meta.url), 'utf8'));
const challenge = createHash('sha256').update(verifier).digest('base64url');
const begin = (oauth: LocalOAuth, client: string, redirect: string) => oauth.request(new URLSearchParams({ response_type: 'code', client_id: client,
  redirect_uri: redirect, resource: local.resource, scope: 'agentdeck:read agentdeck:report', state: 's', code_challenge_method: 'S256', code_challenge: challenge }));
function approve(oauth: LocalOAuth, id: string) {
  oauth.decide(id, true); const status = oauth.status(id); if (!('redirect' in status)) throw new Error('not approved');
  return new URL(status.redirect).searchParams.get('code')!;
}
const tokenFor = (client: string, redirect: string, code: string) => new URLSearchParams({ grant_type: 'authorization_code', client_id: client,
  resource: local.resource, redirect_uri: redirect, code, code_verifier: verifier });
const refreshFor = (client: string, token: string) => new URLSearchParams({ grant_type: 'refresh_token', client_id: client, resource: local.resource, refresh_token: token });

it('replays the shared loopback client vectors the Swift host also replays', () => {
  for (const c of vectors.registeredRedirects) expect(clientRedirect(c.value), c.name).toBe(c.valid);
  for (const c of vectors.metadataMatches) expect(metadataRedirectMatches(c.registered, c.requested), c.name).toBe(c.valid);
  for (const c of vectors.metadataURLs) expect(metadataURL(c.value), c.name).toBe(c.valid);
  for (const c of vectors.clientNames) expect(clientName(c.input), c.name).toBe(c.expected);
  // Every client kind on the loopback host, including the pre-registered one, is refused subscription.
  auth = new LocalOAuth(local, oauthStorage(store), () => now);
  const registered = auth.register({ redirect_uris: ['http://127.0.0.1:4000/callback'] }).client_id;
  for (const [client, redirect] of [[local.clientId, 'http://127.0.0.1:4000/callback'], [registered, 'http://127.0.0.1:4000/callback']]) {
    for (const c of vectors.loopbackScopes) {
      const params = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, resource: local.resource, scope: c.scope,
        state: 's', code_challenge_method: 'S256', code_challenge: challenge });
      if (c.valid) expect(() => auth.request(params), c.name).not.toThrow(); else expect(() => auth.request(params), c.name).toThrow('invalid_request');
    }
  }
  expect(() => auth.register({ redirect_uris: ['http://127.0.0.1:4000/callback'], scope: 'agentdeck:subscribe' })).toThrow('invalid_client_metadata');
});
it('advertises registration only on a loopback host, with least-privilege scopes', () => {
  expect(auth.metadata()).not.toHaveProperty('registration_endpoint');
  expect(() => auth.register({ redirect_uris: ['http://127.0.0.1:4000/callback'] })).toThrow('invalid_request');
  auth = new LocalOAuth(local, oauthStorage(store), () => now);
  expect(auth.metadata()).toMatchObject({ registration_endpoint: `${local.resource}/oauth/register`, client_id_metadata_document_supported: true,
    scopes_supported: ['agentdeck:read', 'agentdeck:report'], token_endpoint_auth_methods_supported: ['none'] });
});
it('registers a secretless loopback client that still needs consent, and binds its codes, refreshes and revocation to it', () => {
  auth = new LocalOAuth(local, oauthStorage(store), () => now);
  const redirect = 'http://127.0.0.1:51816/callback/us-sGnlul-Ab';
  const client = auth.register({ client_name: 'Codex\u0007', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'agentdeck:read agentdeck:report', application_type: 'native' });
  expect(client).toMatchObject({ client_name: 'Codex', redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
  expect(client).not.toHaveProperty('client_secret');
  expect(client.client_id).toMatch(/^dcr_[A-Za-z0-9_-]{43}$/);
  // Registration is not authorization: the exact registered callback only, and nothing issues before consent.
  expect(() => begin(auth, client.client_id, 'http://127.0.0.1:51817/callback/us-sGnlul-Ab')).toThrow('invalid_request');
  expect(() => begin(auth, client.client_id, local.redirectURI)).toThrow('invalid_request');
  expect(() => begin(auth, 'dcr_' + 'x'.repeat(43), redirect)).toThrow('invalid_request');
  const id = begin(auth, client.client_id, redirect);
  expect(auth.pendingRequests()[0]).toMatchObject({ clientId: client.client_id, clientName: 'Codex', clientKind: 'registered' });
  expect(auth.grants()).toEqual([]);
  const code = approve(auth, id);
  expect(() => auth.exchange(tokenFor(local.clientId, redirect, code))).toThrow('invalid_grant');
  const tokens = auth.exchange(tokenFor(client.client_id, redirect, code));
  const subject = auth.authenticate(tokens.access_token).subject;
  expect(store.read().oauth!.grants.find(g => g.id === subject)!.client).toBe(client.client_id);
  // Another client can neither refresh (nor burn) this refresh token, nor revoke the grant.
  expect(() => auth.exchange(refreshFor(local.clientId, tokens.refresh_token))).toThrow('invalid_grant');
  auth.revoke(new URLSearchParams({ client_id: local.clientId, token: tokens.refresh_token }));
  expect(auth.hasAccess(subject)).toBe(true);
  const next = auth.exchange(refreshFor(client.client_id, tokens.refresh_token));
  auth.revoke(new URLSearchParams({ client_id: client.client_id, token: next.refresh_token }));
  expect(auth.hasAccess(subject)).toBe(false);
  // Registrations persist across restart.
  store.close(); store = new Store(path); auth = new LocalOAuth(local, oauthStorage(store), () => now);
  expect(() => begin(auth, client.client_id, redirect)).not.toThrow();
});
it('refuses registrations that are not secretless loopback code clients', () => {
  auth = new LocalOAuth(local, oauthStorage(store), () => now);
  const ok = 'http://127.0.0.1:4000/callback';
  for (const bad of [{}, [], { redirect_uris: [] }, { redirect_uris: ['https://evil.example/callback'] }, { redirect_uris: ['http://127.0.0.1/callback'] },
    { redirect_uris: Array.from({ length: OAUTH_LIMITS.redirectURIs + 1 }, (_, i) => `http://127.0.0.1:${4000 + i}/callback`) }]) {
    expect(() => auth.register(bad), JSON.stringify(bad)).toThrow(/invalid_redirect_uri|invalid_client_metadata/);
  }
  for (const bad of [{ token_endpoint_auth_method: 'client_secret_basic' }, { grant_types: ['client_credentials'] }, { grant_types: [] },
    { response_types: ['token'] }, { scope: 'agentdeck:device' }, { client_name: 7 }]) {
    expect(() => auth.register({ redirect_uris: [ok], ...bad })).toThrow('invalid_client_metadata');
  }
  expect(store.read().oauth?.clients ?? []).toEqual([]);
});
it('bounds registrations and evicts only clients nobody depends on', () => {
  auth = new LocalOAuth(local, oauthStorage(store), () => now);
  const redirect = 'http://127.0.0.1:4000/callback';
  const link = (client: string) => auth.exchange(tokenFor(client, redirect, approve(auth, begin(auth, client, redirect))));
  const first = auth.register({ redirect_uris: [redirect] }); link(first.client_id);
  const second = auth.register({ redirect_uris: [redirect] });
  for (let i = 2; i < OAUTH_LIMITS.clients; i++) auth.register({ redirect_uris: [redirect] });
  auth.register({ redirect_uris: [redirect] });
  const ids = () => store.read().oauth!.clients!.map(c => c.id);
  expect(ids()).toHaveLength(OAUTH_LIMITS.clients);
  expect(ids()).toContain(first.client_id); expect(ids()).not.toContain(second.client_id);
  // Once every registration holds a live grant, a new one is refused rather than displacing it.
  for (const id of ids()) if (id !== first.client_id) link(id);
  expect(() => auth.register({ redirect_uris: [redirect] })).toThrow('temporarily_unavailable');
  expect(ids()).toHaveLength(OAUTH_LIMITS.clients);
});
it('accepts a Client ID Metadata Document only from an allow-listed host, validated, cached and port-agnostic', async () => {
  const url = 'https://chatgpt.com/oauth/codex/us-sGnlul-Ab/client.json';
  const document = { client_id: url, client_name: 'Codex', application_type: 'native', token_endpoint_auth_method: 'none',
    redirect_uris: ['http://127.0.0.1/callback/us-sGnlul-Ab', 'http://localhost/callback/us-sGnlul-Ab'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  const fetched: string[] = [];
  let served: unknown = document;
  auth = new LocalOAuth(local, oauthStorage(store), () => now, async u => { fetched.push(u); return served; });
  await auth.prepareClient('https://evil.example/client.json');
  await auth.prepareClient('http://127.0.0.1:9476/client.json');
  expect(fetched).toEqual([]);
  expect(() => begin(auth, 'https://evil.example/client.json', 'http://127.0.0.1:52065/callback/us-sGnlul-Ab')).toThrow('invalid_request');
  await Promise.all([auth.prepareClient(url), auth.prepareClient(url)]); await auth.prepareClient(url);
  expect(fetched).toEqual([url]);
  const redirect = 'http://127.0.0.1:52065/callback/us-sGnlul-Ab';
  expect(() => begin(auth, url, 'http://127.0.0.1:52065/callback/other')).toThrow('invalid_request');
  const id = begin(auth, url, redirect);
  expect(auth.pendingRequests()[0]).toMatchObject({ clientId: url, clientName: 'Codex', clientKind: 'metadata' });
  const tokens = auth.exchange(tokenFor(url, redirect, approve(auth, id)));
  expect(auth.authenticate(tokens.access_token).subject).toBeTruthy();
  // An expired document is refetched before the next consent; a refresh needs no document.
  now += OAUTH_LIMITS.metadataCacheMs;
  expect(auth.exchange(refreshFor(url, tokens.refresh_token)).access_token).toBeTruthy();
  expect(() => begin(auth, url, redirect)).toThrow('invalid_request');
  for (const bad of [{ ...document, client_id: url + 'x' }, { ...document, token_endpoint_auth_method: 'client_secret_basic' },
    { ...document, redirect_uris: ['https://evil.example/callback'] }, { ...document, redirect_uris: [] }, { ...document, grant_types: ['implicit'] }, 'nope']) {
    served = bad;
    await expect(auth.prepareClient(url)).rejects.toThrow('invalid_client');
  }
  served = document; await auth.prepareClient(url);
  expect(() => begin(auth, url, redirect)).not.toThrow();
});
it('refuses persisted client registrations that break the loopback rules', () => {
  const state = (clients: unknown) => ({ version: 1 as const, grants: [], tokens: [], clients: clients as never });
  for (const clients of [[{ id: 'dcr_' + 'a'.repeat(43), name: 'x', redirects: ['https://evil.example/callback'], createdAt: 1 }],
    [{ id: 'bad', name: 'x', redirects: ['http://127.0.0.1:4000/callback'], createdAt: 1 }], 'x']) {
    expect(() => new LocalOAuth(local, { read: () => state(clients), change: fn => fn(state(clients)) })).toThrow('Invalid persisted OAuth state');
  }
});

it('clears registered clients with the grants when the host configuration changes', () => {
  auth = new LocalOAuth(local, oauthStorage(store), () => now);
  auth.register({ redirect_uris: ['http://127.0.0.1:4000/callback'] });
  expect(store.read().oauth!.clients).toHaveLength(1);
  auth = new LocalOAuth({ ...local, resource: 'http://127.0.0.1:9478' }, oauthStorage(store), () => now);
  expect(store.read().oauth!.clients).toEqual([]);
});
it('fetches a metadata document without following redirects, within the size cap and the deadline', async () => {
  const body = JSON.stringify({ client_id: 'x' });
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); return; }
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('"' + 'x'.repeat(OAUTH_LIMITS.metadataBytes) + '"'); return; }
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end(body); }, 1500); return; }
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect(await fetchClientMetadata(base + '/ok')).toEqual({ client_id: 'x' });
    await expect(fetchClientMetadata(base + '/redirect')).rejects.toThrow();
    await expect(fetchClientMetadata(base + '/big')).rejects.toThrow('metadata too large');
    await expect(fetchClientMetadata(base + '/missing')).rejects.toThrow('metadata unavailable');
    await expect(fetchClientMetadata(base + '/slow', 300)).rejects.toThrow();
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
