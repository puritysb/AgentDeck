import { dotInteractionTransition, type DotInteraction } from '@agentdeck/shared';
import { createHash, randomUUID } from 'node:crypto';
import { EVENT, Fault, LIMITS, VERSION, eventDefinition, invalid, requireScope, schemas, tools, validate, type Principal } from './contracts.js';
import { Store, type Briefing, type Subscription } from './store.js';
import { callbackUrl, equal, headers, sendPublic, signingKey, type Send } from './webhook.js';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const terminal = (state?: string) => state === 'completed' || state === 'failed';
const view = (r: Briefing) => ({
  requestId: r.id, integrationId: r.profile, createdAt: r.createdAt, expiresAt: r.expiresAt,
  delivery: r.delivery, attempts: r.attempts,
  claim: r.claim ? { attemptId: r.claim.id, expiresAt: r.claim.expiresAt } : null,
  report: r.report ?? null, interactions: r.interactions ?? [],
});

/** Experimental one-process relay. Public exposure requires the OAuth resource-server adapter. */
export class Relay {
  private tail: Promise<unknown> = Promise.resolve();
  private delivering = false;
  private queued = 0;
  private stopped = false;
  async stop(): Promise<void> { this.stopped = true; await this.tail; }
  constructor(readonly store: Store, private send: Send = sendPublic, private clock = Date.now, private hasAccess: (subject: string) => boolean = () => true) {}

  authorize(p: Principal): void {
    if (this.stopped || !p.subject || !this.hasAccess(p.subject) || this.store.read().revoked.includes(p.subject)) throw new Fault(-32003, 'Account access revoked');
  }
  // Bounded serial protocol mutation prevents subscribe/unsubscribe races around callback verification.
  rpc(p: Principal, method: string, params: unknown = {}): Promise<unknown> {
    if (this.queued >= LIMITS.connections) return Promise.reject(new Fault(-32009, "MCP request capacity reached"));
    this.queued++;
    const result = this.tail.then(() => this.dispatch(p, method, params)).finally(() => { this.queued--; });
    this.tail = result.catch(() => {});
    return result;
  }
  private async dispatch(p: Principal, method: string, raw: unknown): Promise<unknown> {
    this.authorize(p);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Fault(-32602, 'Expected object params');
    const params = raw as Record<string, any>;
    switch (method) {
      case 'server/discover':
        return { resultType: 'complete', supportedVersions: [VERSION], capabilities: { tools: {}, events: {} } };
      case 'events/list':
        requireScope(p, 'agentdeck:subscribe');
        return { events: [eventDefinition] };
      case 'events/subscribe':
        requireScope(p, 'agentdeck:subscribe'); validate(schemas.subscribe, params);
        return this.subscribe(p, params);
      case 'events/unsubscribe': {
        requireScope(p, 'agentdeck:subscribe'); validate(schemas.unsubscribe, params);
        const id = this.subscriptionId(p.subject, params.arguments.integrationId, params.delivery.url);
        this.store.change(s => {
          s.subscriptions = s.subscriptions.filter(x => x.id !== id);
          for (const r of s.requests) if (r.subscriptionId === id && r.delivery === 'pending') r.delivery = 'cancelled';
        });
        return {};
      }
      case 'tools/list':
        return { tools: tools.filter(t => p.scopes.includes(t.read ? 'agentdeck:read' : 'agentdeck:report')).map(({ read, ...t }) => ({
          ...t, annotations: { readOnlyHint: read, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })) };
      case 'tools/call': {
        const tool = tools.find(t => t.name === params.name);
        if (!tool) throw new Fault(-32602, 'Unknown tool');
        requireScope(p, tool.read ? 'agentdeck:read' : 'agentdeck:report');
        validate(tool.inputSchema, params.arguments);
        try {
          const result = this.call(p, tool.name, params.arguments);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        } catch (e) {
          if (!(e instanceof Fault)) throw e;
          return { isError: true, content: [{ type: 'text', text: e.message }] };
        }
      }
      default: throw new Fault(-32601, 'Method not supported by this experimental adapter');
    }
  }
  private subscriptionId(owner: string, profile: string, url: string): string {
    return `sub_${hash([owner, url, EVENT, { integrationId: profile }])}`;
  }
  private async subscribe(p: Principal, args: Record<string, any>): Promise<unknown> {
    const profile = args.arguments.integrationId as string;
    const url = args.delivery.url as string, secret = args.delivery.secret as string;
    callbackUrl(url); signingKey(secret);
    const id = this.subscriptionId(p.subject, profile, url);
    const now = this.clock();
    const state = this.store.read();
    const existing = state.subscriptions.find(s => s.id === id);
    if (state.subscriptions.some(s => s.owner === p.subject && s.profile === profile && s.id !== id && s.expiresAt > now)) {
      throw new Fault(-32009, 'Profile already has a primary subscription; unsubscribe it first');
    }
    const sub: Subscription = { id, owner: p.subject, profile, url, secret, expiresAt: 0, verifiedUntil: existing?.verifiedUntil ?? 0 };
    // Existing unchanged verification is cached only for this still-active subscription/secret.
    if (!existing || existing.expiresAt <= now || existing.verifiedUntil <= now || existing.secret !== secret) {
      const challenge = randomUUID();
      const body = JSON.stringify({ type: 'verification', challenge });
      let response;
      try { response = await this.send(url, body, headers(sub, `verify_${randomUUID()}`, body, now)); }
      catch { throw new Fault(-32015, 'Callback verification failed', 'unreachable_or_timeout'); }
      let echoed: unknown;
      try { echoed = JSON.parse(response.body).challenge; } catch { /* handled below */ }
      if (response.status < 200 || response.status >= 300 || typeof echoed !== 'string' || !equal(challenge, echoed)) {
        throw new Fault(-32015, 'Callback verification failed', 'challenge_failed');
      }
      sub.verifiedUntil = this.clock() + LIMITS.rotationMs;
    }
    this.authorize(p); // Revocation while verification was in flight wins.
    const activated = this.clock();
    sub.expiresAt = activated + Math.min(args.ttlMs ?? LIMITS.subscriptionMs, LIMITS.subscriptionMs);
    if (existing && existing.secret !== secret) sub.previous = { secret: existing.secret, until: activated + LIMITS.rotationMs };
    else if (existing?.previous && existing.previous.until > activated) sub.previous = existing.previous;
    this.store.change(s => {
      s.subscriptions = s.subscriptions.filter(x => x.id !== id && (x.owner !== p.subject || x.profile !== profile));
      if (s.subscriptions.length >= LIMITS.records) throw new Fault(-32009, 'Pilot subscription capacity reached');
      s.subscriptions.push(sub);
    });
    return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false };
  }

  create(p: Principal, input: unknown): ReturnType<typeof view> {
    this.authorize(p); requireScope(p, 'agentdeck:device'); validate(schemas.create, input);
    const a = input as { integrationId: string; idempotencyKey: string; context: string; capturedAt: number };
    const fingerprint = hash([a.integrationId, a.context, a.capturedAt]);
    const now = this.clock();
    if (a.capturedAt > now + 60_000) invalid('Context capture time is in the future');
    return this.store.change(s => {
      const prior = s.requests.find(r => r.owner === p.subject && r.key === a.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Fault(-32009, 'Idempotency key reused with different data');
        return view(prior);
      }
      const sub = s.subscriptions.find(x => x.owner === p.subject && x.profile === a.integrationId && x.expiresAt > now);
      if (!sub) throw new Fault(-32009, 'No active subscription for this profile');
      if (s.requests.length >= LIMITS.records) throw new Fault(-32009, 'Pilot request capacity reached');
      const r: Briefing = { id: `req_${randomUUID()}`, owner: p.subject, profile: a.integrationId, key: a.idempotencyKey,
        fingerprint, context: a.context, capturedAt: a.capturedAt, createdAt: now, expiresAt: now + LIMITS.requestMs,
        eventId: `evt_${randomUUID()}`, subscriptionId: sub.id, delivery: 'pending', attempts: 0, nextAttemptAt: now, reportKeys: {} };
      s.requests.push(r); return view(r);
    });
  }
  list() { return this.store.read().requests.map(view); }
  maintenance(): void {
    const state = this.store.read(), now = this.clock();
    const denied = new Set([...state.requests.map(r => r.owner), ...state.subscriptions.map(s => s.owner)].filter(owner => !this.hasAccess(owner)));
    if (denied.size || state.requests.some(r => r.createdAt + LIMITS.retentionMs <= now || (r.expiresAt <= now && r.context !== ''))
      || state.subscriptions.some(s => s.expiresAt <= now || (s.previous && s.previous.until <= now))) this.store.change(s => {
      s.requests = s.requests.filter(r => !denied.has(r.owner) && r.createdAt + LIMITS.retentionMs > now);
      for (const r of s.requests) if (r.expiresAt <= now) r.context = '';
      s.subscriptions = s.subscriptions.filter(r => !denied.has(r.owner) && r.expiresAt > now);
      for (const sub of s.subscriptions) if (sub.previous && sub.previous.until <= now) delete sub.previous;
    });
  }
  get(p: Principal, id: string): ReturnType<typeof view> {
    this.authorize(p); requireScope(p, 'agentdeck:device');
    return view(this.owned(p, id));
  }
  revoke(p: Principal): void {
    this.authorize(p); requireScope(p, 'agentdeck:device');
    this.store.change(s => {
      s.revoked.push(p.subject);
      s.subscriptions = s.subscriptions.filter(x => x.owner !== p.subject);
      s.requests = s.requests.filter(x => x.owner !== p.subject);
    });
  }
  private owned(p: Principal, id: string): Briefing {
    const r = this.store.read().requests.find(x => x.id === id && x.owner === p.subject);
    if (!r) throw new Fault(-32004, 'Request not found');
    return r;
  }
  private call(p: Principal, name: string, a: Record<string, any>): object {
    const r = this.owned(p, a.requestId);
    const now = this.clock();
    if (name === 'get_request') return { ...view(r), expired: r.expiresAt <= now };
    if (r.expiresAt <= now) throw new Fault(-32009, 'Request expired');
    if (name === 'get_context') return { context: r.context, capturedAt: r.capturedAt, requestId: r.id };
    return this.store.change(s => {
      const row = s.requests.find(x => x.id === r.id)!;
      if (name === 'claim_request') {
        if (row.claim) {
          if (row.claim.key !== a.idempotencyKey) throw new Fault(-32009, 'Request already claimed');
          return { attemptId: row.claim.id, expiresAt: row.claim.expiresAt };
        }
        row.claim = { id: `attempt_${randomUUID()}`, key: a.idempotencyKey, expiresAt: Math.min(row.expiresAt, now + LIMITS.claimMs) };
        return { attemptId: row.claim.id, expiresAt: row.claim.expiresAt };
      }
      if (!row.claim || row.claim.id !== a.attemptId) throw new Fault(-32009, 'Unknown processing attempt');
      if (name === 'report_interaction') {
        const event: DotInteraction = { relationId: a.relationId, sequence: a.sequence, kind: a.kind,
          direction: a.direction, stage: a.stage, targetRef: a.targetRef, summary: a.summary, evidence: 'dot_report', receivedAt: now };
        const fingerprint = hash([a.attemptId, a.relationId, a.sequence, a.kind, a.direction, a.stage, a.targetRef, a.summary]);
        const previousKey = row.interactionKeys?.[a.idempotencyKey];
        if (previousKey !== undefined) {
          if (previousKey !== fingerprint) throw new Fault(-32009, 'Interaction idempotency conflict');
          return { accepted: true, sequence: a.sequence };
        }
        const history = row.interactions ?? [];
        const prior = [...history].reverse().find(i => i.relationId === event.relationId);
        if (row.claim.expiresAt <= now || terminal(row.report?.state) || history.length >= LIMITS.interactionEvents
          || !dotInteractionTransition(prior, event)) throw new Fault(-32009, 'Expired, conflicting or terminal interaction');
        row.interactions = [...history, event];
        row.interactionKeys = Object.fromEntries([...Object.entries(row.interactionKeys ?? {}), [a.idempotencyKey, fingerprint]]);
        return { accepted: true, sequence: a.sequence };
      }
      const fingerprint = hash([a.attemptId, a.sequence, a.state, a.summary]);
      if (Object.hasOwn(row.reportKeys, a.idempotencyKey)) {
        if (row.reportKeys[a.idempotencyKey] !== fingerprint) throw new Fault(-32009, 'Idempotency key conflict');
        return { accepted: true, sequence: a.sequence };
      }
      if (row.claim.expiresAt <= now) throw new Fault(-32009, 'Processing attempt expired; no automatic retry');
      if (terminal(row.report?.state) || a.sequence <= (row.report?.sequence ?? 0)) throw new Fault(-32009, 'Stale or terminal report');
      if (Object.keys(row.reportKeys).length >= LIMITS.reportKeys) throw new Fault(-32009, 'Pilot report capacity reached');
      row.report = { sequence: a.sequence, state: a.state, summary: a.summary, receivedAt: now };
      row.reportKeys = Object.fromEntries([...Object.entries(row.reportKeys), [a.idempotencyKey, fingerprint]]);
      return { accepted: true, sequence: a.sequence };
    });
  }

  async deliver(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      // One attempt per tick bounds work. Restart resumes the persisted outbox.
      this.maintenance();
      const now = this.clock();
      const r = this.store.read().requests.find(x => x.delivery === 'pending' && x.nextAttemptAt <= now);
      if (!r) return;
      const state = this.store.read();
      const sub = state.subscriptions.find(x => x.id === r.subscriptionId);
      if (!sub || !this.hasAccess(r.owner) || state.revoked.includes(r.owner) || sub.expiresAt <= now || r.expiresAt <= now) {
        this.store.change(s => { s.requests.find(x => x.id === r.id)!.delivery = 'expired'; }); return;
      }
      if (r.attempts >= LIMITS.attempts) {
        this.store.change(s => { s.requests.find(x => x.id === r.id)!.delivery = 'failed'; }); return;
      }
      const body = JSON.stringify({ eventId: r.eventId, name: EVENT, timestamp: new Date(r.createdAt).toISOString(),
        data: { requestId: r.id, integrationId: r.profile, expiresAt: r.expiresAt }, cursor: null });
      this.store.change(s => {
        const row = s.requests.find(x => x.id === r.id)!;
        row.attempts++;
        row.nextAttemptAt = now + Math.min(LIMITS.retryMaxMs, 1000 * 2 ** row.attempts) + Math.floor(Math.random() * 500);
      });
      let status = 0;
      try { status = (await this.send(sub.url, body, headers(sub, r.eventId, body, now))).status; }
      catch { /* Persisted backoff handles uncertain receipt; same event ID on retry. */ }
      if (this.stopped || !this.hasAccess(r.owner)) return;
      this.store.change(s => {
        const row = s.requests.find(x => x.id === r.id);
        if (!row || row.delivery !== 'pending') return;
        if (status >= 200 && status < 300) row.delivery = 'accepted';
        else if (status === 410 || status === 413 || (status >= 300 && status < 500 && status !== 408 && status !== 429)
          || row.attempts >= LIMITS.attempts) row.delivery = 'failed';
        if (status === 410) {
          s.subscriptions = s.subscriptions.filter(x => x.id !== sub.id);
          for (const other of s.requests) if (other.subscriptionId === sub.id && other.delivery === 'pending') other.delivery = 'cancelled';
        }
      });
    } finally { this.delivering = false; }
  }
}
