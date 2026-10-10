import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DOT_OAUTH_LIMITS as OAUTH_LIMITS, DOT_LOCAL_MCP } from '@agentdeck/shared';
export { DOT_OAUTH_LIMITS as OAUTH_LIMITS } from '@agentdeck/shared';
import type { Principal } from './contracts.js';

const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');
const same = (a: string, b: string) => { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
const SCOPES = ['agentdeck:read', 'agentdeck:report', 'agentdeck:subscribe'];
export class OAuthError extends Error {
  constructor(public code: string) { super(code); }
}
interface Grant { id: string; client: string; scopes: string[]; expiresAt: number; revoked: boolean }
interface Token { hash: string; grant: string; kind: 'access' | 'refresh'; expiresAt: number; used: boolean }
export interface OAuthState { configurationHash?: string; version: 1; grants: Grant[]; tokens: Token[] }
export interface OAuthStorage {
  read(): OAuthState;
  change<T>(fn: (s: OAuthState) => T): T;
}
interface Pending {
  id: string; redirect: string; challenge: string; scopes: string[]; state: string; expiresAt: number;
  decision: 'pending' | 'approved' | 'denied'; code?: string; grant?: string;
}
export interface OAuthConfiguration { resource: string; clientId: string; clientSecret: string; redirectURI: string; local?: boolean }

/** One locally approved installation; no passwords, remote approval or dynamic client registration. */
export class LocalOAuth {
  private pending = new Map<string, Pending>();
  private config: OAuthConfiguration;
  constructor(config: OAuthConfiguration, private store: OAuthStorage, private clock = Date.now) {
    const resource = new URL(config.resource), redirect = new URL(config.redirectURI);
    if ((config.local ? resource.protocol !== 'http:' || resource.hostname !== DOT_LOCAL_MCP.host || config.clientId !== DOT_LOCAL_MCP.clientId : resource.protocol !== 'https:') || resource.origin !== config.resource || (config.local ? !localRedirect(config.redirectURI) : redirect.protocol !== 'https:')
      || redirect.username || redirect.password || redirect.hash || config.clientId.length < 16 || (!config.local && config.clientSecret.length < 32)) {
      throw new Error('Invalid local OAuth configuration');
    }
    this.config = { ...config };
    const state = this.store.read();
    const stamp = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
    if (state.version !== 1 || !Array.isArray(state.grants) || !Array.isArray(state.tokens)
      || state.grants.length > OAUTH_LIMITS.records || state.tokens.length > OAUTH_LIMITS.records
      || state.grants.some(g => typeof g.id !== 'string' || typeof g.client !== 'string' || typeof g.revoked !== 'boolean'
        || !stamp(g.expiresAt) || !Array.isArray(g.scopes) || !g.scopes.length || g.scopes.some(s => !SCOPES.includes(s)))
      || state.tokens.some(t => !/^[A-Za-z0-9_-]{43}$/.test(t.hash) || typeof t.grant !== 'string'
        || !['access', 'refresh'].includes(t.kind) || !stamp(t.expiresAt) || typeof t.used !== 'boolean')) throw new Error('Invalid persisted OAuth state');
    const configurationHash = digest(JSON.stringify(config));
    if (state.configurationHash !== configurationHash) this.store.change(s => {
      s.configurationHash = configurationHash; s.grants = []; s.tokens = [];
    });
  }
  metadata() {
    const resource = this.config.resource;
    return { issuer: resource, authorization_endpoint: `${resource}/oauth/authorize`, token_endpoint: `${resource}/oauth/token`,
      revocation_endpoint: `${resource}/oauth/revoke`, authorization_response_iss_parameter_supported: true,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [this.config.local ? 'none' : 'client_secret_post'], code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES };
  }
  private sweep() {
    for (const [id, value] of this.pending) if (value.expiresAt <= this.clock()) this.pending.delete(id);
  }
  request(params: URLSearchParams): string {
    this.sweep();
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request');
    const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
    if (params.get('client_id') !== this.config.clientId || (this.config.local ? !localRedirect(params.get('redirect_uri') ?? '') : params.get('redirect_uri') !== this.config.redirectURI)
      || params.get('response_type') !== 'code' || params.get('resource') !== this.config.resource
      || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '')
      || !scopes.length || scopes.some(s => !SCOPES.includes(s)) || !params.get('state') || params.get('state')!.length > 512) {
      throw new OAuthError('invalid_request');
    }
    if (this.pending.size >= OAUTH_LIMITS.pending) throw new OAuthError('temporarily_unavailable');
    const id = random();
    this.pending.set(id, { id, redirect: params.get('redirect_uri')!, challenge: params.get('code_challenge')!,
      scopes: [...new Set(scopes)].sort(), state: params.get('state')!, expiresAt: this.clock() + OAUTH_LIMITS.consentMs, decision: 'pending' });
    return id;
  }
  pendingRequests() {
    this.sweep();
    return [...this.pending.values()].filter(p => p.decision === 'pending').map(p => ({
      id: p.id, verificationCode: p.id.slice(0, 8), clientId: this.config.clientId, redirectURI: p.redirect,
      scopes: [...p.scopes], expiresAt: p.expiresAt,
    }));
  }
  decide(id: string, approve: boolean) {
    this.sweep(); const p = this.pending.get(id);
    if (!p || p.decision !== 'pending') throw new OAuthError('invalid_request');
    if (!approve) { p.decision = 'denied'; return; }
    const grant: Grant = { id: randomUUID(), client: this.config.clientId, scopes: p.scopes, expiresAt: this.clock() + OAUTH_LIMITS.refreshMs, revoked: false };
    this.store.change(s => {
      this.prune(s);
      if (s.grants.length >= OAUTH_LIMITS.records) throw new OAuthError('temporarily_unavailable');
      s.grants.push(grant);
    });
    p.code = random(); p.grant = grant.id; p.decision = 'approved';
  }
  status(id: string): { pending: true; verificationCode: string } | { redirect: string } {
    this.sweep(); const p = this.pending.get(id);
    if (!p) throw new OAuthError('invalid_request');
    if (p.decision === 'pending') return { pending: true, verificationCode: p.id.slice(0, 8) };
    const redirect = new URL(p.redirect);
    redirect.searchParams.set('state', p.state); redirect.searchParams.set('iss', this.config.resource);
    redirect.searchParams.set(p.decision === 'approved' ? 'code' : 'error', p.code ?? 'access_denied');
    return { redirect: redirect.href };
  }
  private client(params: URLSearchParams) {
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request');
    if (params.get('client_id') !== this.config.clientId || (!this.config.local && !same(digest(params.get('client_secret') ?? ''), digest(this.config.clientSecret)))) {
      throw new OAuthError('invalid_client');
    }
  }
  private prune(s: OAuthState) {
    const now = this.clock();
    s.grants = s.grants.filter(g => g.expiresAt > now);
    const live = new Set(s.grants.filter(g => !g.revoked).map(g => g.id));
    s.tokens = s.tokens.filter(t => t.expiresAt > now && live.has(t.grant));
  }
  exchange(params: URLSearchParams) {
    this.client(params); this.sweep();
    if (params.get('resource') !== this.config.resource) throw new OAuthError('invalid_target');
    const kind = params.get('grant_type');
    let id: string;
    if (kind === 'authorization_code') {
      const p = [...this.pending.values()].find(p => p.code && same(p.code, params.get('code') ?? ''));
      const verifier = params.get('code_verifier') ?? '';
      if (!p || p.decision !== 'approved' || !p.grant || params.get('redirect_uri') !== p.redirect
        || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(p.challenge, digest(verifier))) throw new OAuthError('invalid_grant');
      // Consume before issuing. A persistence failure can require reauthorization, never code reuse.
      this.pending.delete(p.id); id = p.grant;
    } else if (kind === 'refresh_token') {
      const hash = digest(params.get('refresh_token') ?? '');
      const prior = this.store.read().tokens.find(t => t.kind === 'refresh' && same(t.hash, hash));
      if (!prior || prior.expiresAt <= this.clock()) throw new OAuthError('invalid_grant');
      if (prior.used) { this.revokeGrant(prior.grant); throw new OAuthError('invalid_grant'); }
      id = prior.grant;
      this.store.change(s => { const t = s.tokens.find(t => t.hash === hash); if (t) t.used = true; });
    } else throw new OAuthError('unsupported_grant_type');
    const access = random(), refresh = random(), now = this.clock();
    const scopes = this.store.change(s => {
      this.prune(s);
      const grant = s.grants.find(g => g.id === id && !g.revoked);
      if (!grant) throw new OAuthError('invalid_grant');
      if (params.has('scope') && [...new Set(params.get('scope')!.split(' ').filter(Boolean))].sort().join(' ') !== [...grant.scopes].sort().join(' ')) throw new OAuthError('invalid_scope');
      if (s.tokens.length + 2 > OAUTH_LIMITS.records) throw new OAuthError('temporarily_unavailable');
      s.tokens.push({ hash: digest(access), kind: 'access', grant: id, expiresAt: Math.min(now + OAUTH_LIMITS.accessMs, grant.expiresAt), used: false },
        { hash: digest(refresh), kind: 'refresh', grant: id, expiresAt: grant.expiresAt, used: false });
      return grant.scopes;
    });
    return { access_token: access, token_type: 'Bearer', expires_in: Math.min(OAUTH_LIMITS.accessMs, this.store.read().grants.find(g => g.id === id)!.expiresAt - now) / 1000,
      refresh_token: refresh, scope: scopes.join(' '), resource: this.config.resource };
  }
  authenticate(token: string): Principal {
    const s = this.store.read(), now = this.clock();
    const access = s.tokens.find(t => t.kind === 'access' && t.expiresAt > now && same(t.hash, digest(token)));
    const grant = s.grants.find(g => g.id === access?.grant && !g.revoked && g.expiresAt > now);
    if (!access || !grant) throw new OAuthError('invalid_token');
    return { subject: grant.id, scopes: [...grant.scopes] };
  }
  hasAccess(subject: string): boolean {
    return this.store.read().grants.some(g => g.id === subject && !g.revoked && g.expiresAt > this.clock());
  }
  grants() { return this.store.read().grants.filter(g => !g.revoked && g.expiresAt > this.clock()).map(g => ({ id: g.id, scopes: g.scopes, expiresAt: g.expiresAt })); }
  revokeGrant(id: string) {
    this.store.change(s => { for (const g of s.grants) if (g.id === id) g.revoked = true; s.tokens = s.tokens.filter(t => t.grant !== id); });
    for (const [key, p] of this.pending) if (p.grant === id) this.pending.delete(key);
  }
  revoke(params: URLSearchParams) {
    this.client(params);
    const hash = digest(params.get('token') ?? '');
    const token = this.store.read().tokens.find(t => same(t.hash, hash));
    if (token) this.revokeGrant(token.grant);
  }
}

export function localRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && !!url.port && Number(url.port) >= 1024 && url.pathname === DOT_LOCAL_MCP.callbackPath
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
