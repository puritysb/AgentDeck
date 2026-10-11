import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DOT_OAUTH_LIMITS as OAUTH_LIMITS, DOT_LOCAL_MCP } from '@agentdeck/shared';
export { DOT_OAUTH_LIMITS as OAUTH_LIMITS } from '@agentdeck/shared';
import type { Principal } from './contracts.js';

const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');
const same = (a: string, b: string) => { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
const SCOPES = ['agentdeck:read', 'agentdeck:report', 'agentdeck:subscribe'];
// The loopback host has no Events surface (subscriptions need the HTTPS host), so it neither
// advertises nor grants subscription, to any client kind.
const LOCAL_SCOPES: readonly string[] = DOT_LOCAL_MCP.advertisedScopes;
export class OAuthError extends Error {
  constructor(public code: string) { super(code); }
}
interface Grant { id: string; client: string; scopes: string[]; expiresAt: number; revoked: boolean }
interface Token { hash: string; grant: string; kind: 'access' | 'refresh'; expiresAt: number; used: boolean }
/** A loopback client registered through RFC 7591; it carries no secret and no authority. */
interface RegisteredClient { id: string; name: string; redirects: string[]; createdAt: number }
export interface OAuthState { configurationHash?: string; version: 1; grants: Grant[]; tokens: Token[]; clients?: RegisteredClient[] }
export type ClientKind = 'preregistered' | 'registered' | 'metadata';
interface ResolvedClient { id: string; name: string; kind: ClientKind; redirects: string[] }
export type MetadataFetch = (url: string) => Promise<unknown>;
export interface OAuthStorage {
  read(): OAuthState;
  change<T>(fn: (s: OAuthState) => T): T;
}
interface Pending {
  id: string; client: string; clientName: string; clientKind: ClientKind; redirect: string; challenge: string; scopes: string[]; state: string; expiresAt: number;
  decision: 'pending' | 'approved' | 'denied'; code?: string; grant?: string;
}
export interface OAuthConfiguration { resource: string; clientId: string; clientSecret: string; redirectURI: string; local?: boolean }

/**
 * One locally approved installation; no passwords or remote approval. A loopback host also
 * accepts registered (RFC 7591) and metadata-document clients so a stock MCP client can sign
 * in without a configured client ID; neither registration nor a document grants access.
 */
export class LocalOAuth {
  private pending = new Map<string, Pending>();
  private config: OAuthConfiguration;
  private documents = new Map<string, { client: ResolvedClient; expiresAt: number }>();
  private fetching = new Map<string, Promise<void>>();
  constructor(config: OAuthConfiguration, private store: OAuthStorage, private clock = Date.now,
    private fetchMetadata: MetadataFetch = fetchClientMetadata) {
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
        || !['access', 'refresh'].includes(t.kind) || !stamp(t.expiresAt) || typeof t.used !== 'boolean')
      || (state.clients !== undefined && (!Array.isArray(state.clients) || state.clients.length > OAUTH_LIMITS.clients
        || state.clients.some(c => typeof c.id !== 'string' || !/^dcr_[A-Za-z0-9_-]{43}$/.test(c.id) || typeof c.name !== 'string'
          || c.name.length > OAUTH_LIMITS.clientNameCharacters || !stamp(c.createdAt) || !Array.isArray(c.redirects) || !c.redirects.length
          || c.redirects.length > OAUTH_LIMITS.redirectURIs || c.redirects.some(r => typeof r !== 'string' || !clientRedirect(r)))))) throw new Error('Invalid persisted OAuth state');
    const configurationHash = digest(JSON.stringify(config));
    if (state.configurationHash !== configurationHash) this.store.change(s => {
      s.configurationHash = configurationHash; s.grants = []; s.tokens = []; s.clients = [];
    });
  }
  metadata() {
    const resource = this.config.resource;
    return { issuer: resource, authorization_endpoint: `${resource}/oauth/authorize`, token_endpoint: `${resource}/oauth/token`,
      revocation_endpoint: `${resource}/oauth/revoke`, authorization_response_iss_parameter_supported: true,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [this.config.local ? 'none' : 'client_secret_post'], code_challenge_methods_supported: ['S256'],
      ...(this.config.local ? { registration_endpoint: `${resource}/oauth/register`, client_id_metadata_document_supported: true,
        scopes_supported: [...DOT_LOCAL_MCP.advertisedScopes] } : { scopes_supported: SCOPES }) };
  }
  /** Loopback hosts only. Bounded, secretless and unauthenticated by design: consent gates every grant. */
  register(input: unknown) {
    if (!this.config.local) throw new OAuthError('invalid_request');
    const value = input as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthError('invalid_client_metadata');
    const redirects = value.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > OAUTH_LIMITS.redirectURIs
      || redirects.some(r => typeof r !== 'string' || !clientRedirect(r))) throw new OAuthError('invalid_redirect_uri');
    const list = (v: unknown, allowed: string[]) => v === undefined || (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && allowed.includes(x)));
    if (!list(value.grant_types, ['authorization_code', 'refresh_token']) || !list(value.response_types, ['code'])
      || (value.token_endpoint_auth_method !== undefined && value.token_endpoint_auth_method !== 'none')
      || (value.scope !== undefined && (typeof value.scope !== 'string' || value.scope.split(' ').filter(Boolean).some(s => !LOCAL_SCOPES.includes(s))))
      || (value.client_name !== undefined && typeof value.client_name !== 'string')) throw new OAuthError('invalid_client_metadata');
    const client: RegisteredClient = { id: `dcr_${random()}`, name: clientName(value.client_name),
      redirects: [...new Set(redirects as string[])], createdAt: this.clock() };
    this.store.change(s => {
      const clients = s.clients ??= [];
      if (clients.length >= OAUTH_LIMITS.clients) {
        // Evict the oldest registration nobody depends on; a live grant or pending consent keeps a client.
        const now = this.clock();
        const busy = new Set([...s.grants.filter(g => !g.revoked && g.expiresAt > now).map(g => g.client), ...[...this.pending.values()].map(p => p.client)]);
        const index = clients.findIndex(c => !busy.has(c.id));
        if (index < 0) throw new OAuthError('temporarily_unavailable');
        clients.splice(index, 1);
      }
      clients.push(client);
    });
    return { client_id: client.id, client_id_issued_at: Math.floor(client.createdAt / 1000), client_name: client.name,
      redirect_uris: client.redirects, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  /** Resolve a metadata-document client before `request`; other client kinds need no I/O. */
  async prepareClient(id: string | null) {
    if (!this.config.local || !id || !metadataURL(id)) return;
    const cached = this.documents.get(id);
    if (cached && cached.expiresAt > this.clock()) return;
    let work = this.fetching.get(id);
    if (!work && this.fetching.size >= OAUTH_LIMITS.pending) throw new OAuthError('temporarily_unavailable');
    if (!work) {
      work = (async () => {
        let client: ResolvedClient;
        try { client = clientDocument(id, await this.fetchMetadata(id)); }
        catch { throw new OAuthError('invalid_client'); }
        for (const [key, entry] of this.documents) if (entry.expiresAt <= this.clock()) this.documents.delete(key);
        if (this.documents.size >= OAUTH_LIMITS.clients) this.documents.delete(this.documents.keys().next().value!);
        this.documents.set(id, { client, expiresAt: this.clock() + OAUTH_LIMITS.metadataCacheMs });
      })().finally(() => this.fetching.delete(id));
      this.fetching.set(id, work);
    }
    await work;
  }
  private resolveClient(id: string | null): ResolvedClient | undefined {
    if (!id) return undefined;
    if (id === this.config.clientId) {
      return { id, name: this.config.local ? 'AgentDeck local plugin' : 'Registered client', kind: 'preregistered', redirects: [this.config.redirectURI] };
    }
    if (!this.config.local) return undefined;
    const registered = this.store.read().clients?.find(c => c.id === id);
    if (registered) return { id, name: registered.name, kind: 'registered', redirects: registered.redirects };
    const document = this.documents.get(id);
    return document && document.expiresAt > this.clock() ? document.client : undefined;
  }
  private redirectAllowed(client: ResolvedClient, redirect: string) {
    if (client.kind === 'preregistered') return this.config.local ? localRedirect(redirect) : redirect === this.config.redirectURI;
    if (client.kind === 'registered') return client.redirects.includes(redirect);
    return metadataRedirectMatches(client.redirects, redirect);
  }
  private sweep() {
    for (const [id, value] of this.pending) if (value.expiresAt <= this.clock()) this.pending.delete(id);
  }
  request(params: URLSearchParams): string {
    this.sweep();
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request');
    const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
    const client = this.resolveClient(params.get('client_id'));
    if (!client || !this.redirectAllowed(client, params.get('redirect_uri') ?? '')
      || params.get('response_type') !== 'code' || params.get('resource') !== this.config.resource
      || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '')
      || !scopes.length || scopes.some(s => !(this.config.local ? LOCAL_SCOPES : SCOPES).includes(s)) || !params.get('state') || params.get('state')!.length > 512) {
      throw new OAuthError('invalid_request');
    }
    if (this.pending.size >= OAUTH_LIMITS.pending) throw new OAuthError('temporarily_unavailable');
    const id = random();
    this.pending.set(id, { id, client: client.id, clientName: client.name, clientKind: client.kind, redirect: params.get('redirect_uri')!, challenge: params.get('code_challenge')!,
      scopes: [...new Set(scopes)].sort(), state: params.get('state')!, expiresAt: this.clock() + OAUTH_LIMITS.consentMs, decision: 'pending' });
    return id;
  }
  pendingRequests() {
    this.sweep();
    return [...this.pending.values()].filter(p => p.decision === 'pending').map(p => ({
      id: p.id, verificationCode: p.id.slice(0, 8), clientId: p.client, clientName: p.clientName, clientKind: p.clientKind, redirectURI: p.redirect,
      scopes: [...p.scopes], expiresAt: p.expiresAt,
    }));
  }
  decide(id: string, approve: boolean) {
    this.sweep(); const p = this.pending.get(id);
    if (!p || p.decision !== 'pending') throw new OAuthError('invalid_request');
    if (!approve) { p.decision = 'denied'; return; }
    const grant: Grant = { id: randomUUID(), client: p.client, scopes: p.scopes, expiresAt: this.clock() + OAUTH_LIMITS.refreshMs, revoked: false };
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
  /** A confidential host authenticates its one client here; a public loopback client is bound per grant. */
  private client(params: URLSearchParams) {
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request');
    if (this.config.local ? !params.get('client_id')
      : params.get('client_id') !== this.config.clientId || !same(digest(params.get('client_secret') ?? ''), digest(this.config.clientSecret))) {
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
      if (!p || p.decision !== 'approved' || !p.grant || params.get('client_id') !== p.client || params.get('redirect_uri') !== p.redirect
        || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(p.challenge, digest(verifier))) throw new OAuthError('invalid_grant');
      // Consume before issuing. A persistence failure can require reauthorization, never code reuse.
      this.pending.delete(p.id); id = p.grant;
    } else if (kind === 'refresh_token') {
      const hash = digest(params.get('refresh_token') ?? '');
      const prior = this.store.read().tokens.find(t => t.kind === 'refresh' && same(t.hash, hash));
      if (!prior || prior.expiresAt <= this.clock()) throw new OAuthError('invalid_grant');
      // A refresh token is bound to the client it was issued to; a mismatch neither consumes nor revokes it.
      if (this.store.read().grants.find(g => g.id === prior.grant)?.client !== params.get('client_id')) throw new OAuthError('invalid_grant');
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
    const state = this.store.read(), token = state.tokens.find(t => same(t.hash, hash));
    // RFC 7009: another client's token is ignored without revealing that it exists.
    if (token && state.grants.find(g => g.id === token.grant)?.client === params.get('client_id')) this.revokeGrant(token.grant);
  }
}

const CLIENT_CALLBACK = new RegExp(DOT_LOCAL_MCP.clientCallbackPattern);
function loopbackURL(value: string, port: 'required' | 'optional'): URL | undefined {
  try {
    const url = new URL(value);
    if (url.href !== value || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !CLIENT_CALLBACK.test(url.pathname)) return undefined;
    if (url.port ? Number(url.port) < 1024 : port === 'required') return undefined;
    return url;
  } catch { return undefined; }
}
/** A redirect a registered client may use: loopback HTTP, an explicit port and the shared callback path. */
export function clientRedirect(value: string): boolean { return !!loopbackURL(value, 'required'); }
/** RFC 8252 §7.3: a metadata document's portless loopback redirect matches any port at request time. */
export function metadataRedirectMatches(registered: string[], requested: string): boolean {
  const url = loopbackURL(requested, 'required');
  if (!url) return false;
  const portless = `${url.protocol}//${url.hostname}${url.pathname}`;
  return registered.some(r => r === requested || r === portless);
}
/** Only HTTPS documents on allow-listed hosts, so the fetch can never reach this machine or its LAN. */
export function metadataURL(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= OAUTH_LIMITS.metadataURLCharacters && url.href === value && url.protocol === 'https:'
      && (DOT_LOCAL_MCP.metadataHosts as readonly string[]).includes(url.hostname) && !url.port
      && !url.username && !url.password && !url.search && !url.hash && url.pathname.length > 1;
  } catch { return false; }
}
/** A client-chosen display name: controls, format characters and every separator but a plain space become spaces. */
export function clientName(value: unknown) {
  const name = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu, ' ').trim().slice(0, OAUTH_LIMITS.clientNameCharacters) : '';
  return name || 'Unnamed client';
}
/** Validate a fetched Client ID Metadata Document; anything unexpected refuses the client. */
export function clientDocument(id: string, input: unknown): ResolvedClient {
  const value = input as Record<string, unknown>;
  const list = (v: unknown, needed: string) => v === undefined || (Array.isArray(v) && v.includes(needed));
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.client_id !== id
    || !Array.isArray(value.redirect_uris) || !value.redirect_uris.length || value.redirect_uris.length > OAUTH_LIMITS.redirectURIs
    || value.redirect_uris.some(r => typeof r !== 'string' || !loopbackURL(r, 'optional'))
    || value.token_endpoint_auth_method !== 'none' || !list(value.grant_types, 'authorization_code') || !list(value.response_types, 'code')
    || (value.client_name !== undefined && typeof value.client_name !== 'string')) throw new OAuthError('invalid_client');
  return { id, name: clientName(value.client_name), kind: 'metadata', redirects: value.redirect_uris as string[] };
}
export async function fetchClientMetadata(url: string, deadlineMs: number = OAUTH_LIMITS.metadataMs): Promise<unknown> {
  // No redirects: an allow-listed host must serve the document itself.
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(deadlineMs), headers: { Accept: 'application/json' } });
  if (!response.ok || !response.body) throw new Error('metadata unavailable');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > OAUTH_LIMITS.metadataBytes) throw new Error('metadata too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function localRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && !!url.port && Number(url.port) >= 1024 && url.pathname === DOT_LOCAL_MCP.callbackPath
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
