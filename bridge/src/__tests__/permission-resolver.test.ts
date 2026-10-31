import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerPending,
  resolvePending,
  abandonPending,
  sweepStalePending,
  drainAllPending,
  _pendingCount,
} from '../permission-resolver.js';

/** Minimal ServerResponse stub capturing the body written by the resolver. */
function fakeRes() {
  return {
    headers: undefined as undefined | Record<string, string>,
    body: undefined as undefined | string,
    ended: false,
    writeHead(_code: number, headers?: Record<string, string>) { this.headers = headers; return this; },
    end(body?: string) { this.body = body; this.ended = true; },
  };
}

function parseDecision(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try { return JSON.parse(body).hookSpecificOutput?.permissionDecision; } catch { return undefined; }
}

describe('permission-resolver', () => {
  it('refuses a late press when wall time expired before the sleeping timer ran', () => {
    const res = fakeRes();
    registerPending('sleep', res as any, { sessionId: 'sid', timeoutMs: 1000 });
    vi.setSystemTime(Date.now() + 1001);
    expect(resolvePending('sleep', 'allow')).toBeNull();
    expect(res.body).toBe('');
    expect(_pendingCount()).toBe(0);
  });
  beforeEach(() => {
    drainAllPending();
    vi.useFakeTimers();
  });
  afterEach(() => {
    drainAllPending();
    vi.useRealTimers();
  });

  it('register → resolve(allow) ends the held response with allow', () => {
    const res = fakeRes();
    registerPending('r1', res as any, { sessionId: 'sid-1', tool: 'Bash', timeoutMs: 45_000 });
    expect(_pendingCount()).toBe(1);

    const sid = resolvePending('r1', 'allow');
    expect(sid).toBe('sid-1');
    expect(res.ended).toBe(true);
    expect(parseDecision(res.body)).toBe('allow');
    expect(_pendingCount()).toBe(0);
  });

  it('resolve(deny) ends with deny', () => {
    const res = fakeRes();
    registerPending('r2', res as any, { sessionId: 'sid-2', timeoutMs: 45_000 });
    expect(resolvePending('r2', 'deny')).toBe('sid-2');
    expect(parseDecision(res.body)).toBe('deny');
  });

  it('times out to an EMPTY pass-through body after timeoutMs (never an explicit "ask")', () => {
    // `ask` could force a prompt the allowlist would have auto-approved — the
    // fallback must leave Claude's own permission evaluation untouched.
    const res = fakeRes();
    registerPending('r3', res as any, { sessionId: 'sid-3', timeoutMs: 45_000 });
    vi.advanceTimersByTime(45_000 + 1);
    expect(res.ended).toBe(true);
    expect(res.body).toBe('');
    expect(parseDecision(res.body)).toBeUndefined();
    expect(_pendingCount()).toBe(0);
  });

  it('resolving an unknown id returns null and is a no-op', () => {
    expect(resolvePending('nope', 'allow')).toBeNull();
  });

  it('double resolve: second returns null (already resolved)', () => {
    const res = fakeRes();
    registerPending('r4', res as any, { sessionId: 'sid-4', timeoutMs: 45_000 });
    expect(resolvePending('r4', 'allow')).toBe('sid-4');
    expect(resolvePending('r4', 'deny')).toBeNull();
  });

  it('abandonPending drops the entry without writing a decision', () => {
    const res = fakeRes();
    registerPending('r5', res as any, { sessionId: 'sid-5', timeoutMs: 45_000 });
    abandonPending('r5');
    expect(_pendingCount()).toBe(0);
    expect(res.ended).toBe(false);
    // A subsequent timer fire must not touch the (already abandoned) entry.
    vi.advanceTimersByTime(45_000 + 1);
    expect(res.ended).toBe(false);
  });

  it('sweepStalePending releases entries older than maxAge as pass-through', () => {
    const res = fakeRes();
    registerPending('r6', res as any, { sessionId: 'sid-6', timeoutMs: 999_000 });
    // createdAt uses real Date.now at register; sweep with now far ahead.
    const swept = sweepStalePending(1, Date.now() + 10_000);
    expect(swept).toBe(1);
    expect(res.body).toBe('');
  });

  it('re-registering a duplicate requestId releases the stale entry first', () => {
    const stale = fakeRes();
    const fresh = fakeRes();
    registerPending('r7', stale as any, { sessionId: 'sid-7a', timeoutMs: 45_000 });
    registerPending('r7', fresh as any, { sessionId: 'sid-7b', timeoutMs: 45_000 });

    // The first held response was flushed defensively (pass-through body);
    // only one entry remains.
    expect(stale.ended).toBe(true);
    expect(stale.body).toBe('');
    expect(_pendingCount()).toBe(1);

    // The surviving entry is the fresh one.
    expect(resolvePending('r7', 'allow')).toBe('sid-7b');
    expect(parseDecision(fresh.body)).toBe('allow');
  });

  it('resolving over a dead socket does not throw and still clears the entry', () => {
    const res = fakeRes();
    res.writeHead = () => { throw new Error('socket closed'); };
    registerPending('r8', res as any, { sessionId: 'sid-8', timeoutMs: 45_000 });

    expect(() => resolvePending('r8', 'allow')).not.toThrow();
    expect(_pendingCount()).toBe(0);
  });

  it('fires onResolved exactly once on a device decision', () => {
    const res = fakeRes();
    const seen: string[] = [];
    registerPending('rc1', res as any, { sessionId: 'sid-c1', timeoutMs: 45_000, onResolved: (d) => seen.push(d) });
    resolvePending('rc1', 'deny');
    resolvePending('rc1', 'allow'); // already resolved — must not fire again
    expect(seen).toEqual(['deny']);
  });

  it('fires onResolved with "pass" on timeout (arms the auto-approval learner)', () => {
    const res = fakeRes();
    const seen: string[] = [];
    registerPending('rc2', res as any, { sessionId: 'sid-c2', timeoutMs: 45_000, onResolved: (d) => seen.push(d) });
    vi.advanceTimersByTime(45_000 + 1);
    expect(seen).toEqual(['pass']);
  });

  it('drainAllPending releases every held response as pass-through', () => {
    const a = fakeRes();
    const b = fakeRes();
    registerPending('r9a', a as any, { sessionId: 'sid-9a', timeoutMs: 45_000 });
    registerPending('r9b', b as any, { sessionId: 'sid-9b', timeoutMs: 45_000 });

    drainAllPending();
    expect(_pendingCount()).toBe(0);
    expect(a.body).toBe('');
    expect(b.body).toBe('');
  });
});
