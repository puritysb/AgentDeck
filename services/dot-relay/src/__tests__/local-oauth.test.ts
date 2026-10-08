import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { LocalOAuth, OAUTH_LIMITS } from '../local-oauth.js';
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
