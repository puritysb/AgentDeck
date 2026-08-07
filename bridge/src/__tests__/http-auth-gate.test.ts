import { describe, it, expect, vi } from 'vitest';

// Hermetic auth: local-ness and token validity are inputs here, not the real
// ~/.agentdeck/auth-token file.
const authMocks = vi.hoisted(() => ({
  isLocal: false,
}));

vi.mock('../auth.js', () => ({
  isLocalConnection: () => authMocks.isLocal,
  validateToken: (t: string) => t === 'machine-token',
}));

import { buildPublicHealth, gateHttpRequest, isAuthorizedHttpRequest } from '../http-auth-gate.js';

function fakeReq(over: { url?: string; remoteAddress?: string; authorization?: string }) {
  return {
    url: over.url ?? '/',
    headers: over.authorization ? { authorization: over.authorization } : {},
    socket: { remoteAddress: over.remoteAddress ?? '192.0.2.55' },
  };
}

describe('gateHttpRequest (issue #145 LAN default-deny)', () => {
  it('lets an authorized request reach any route', () => {
    for (const [method, path] of [['GET', '/status'], ['POST', '/hooks/stop'], ['GET', '/apme/tasks']] as const) {
      expect(gateHttpRequest(method, path, true)).toBe('allow');
    }
  });

  it('serves only the public health payload to unauthorized peers', () => {
    expect(gateHttpRequest('GET', '/health', false)).toBe('public-health');
  });

  it('denies every other route to unauthorized peers', () => {
    const sensitive = [
      // /setup-status answers with `Access-Control-Allow-Origin: *` so the
      // Ulanzi Property Inspector (a webview on a foreign origin) can read it.
      // CORS governs which ORIGIN may read a response, not which HOST may ask —
      // an unauthenticated LAN peer must still get 401, not the payload.
      ['GET', '/setup-status'],
      ['GET', '/status'], ['GET', '/devices'], ['GET', '/sse'], ['GET', '/diag'],
      ['GET', '/usage'], ['GET', '/pixoo/frame'], ['GET', '/agentdeck/cards'],
      ['GET', '/apme/tasks'], ['GET', '/esp32/fw'], ['POST', '/hooks/stop'],
      ['POST', '/shutdown'], ['POST', '/voice/speak'], ['POST', '/generate'],
      ['POST', '/health'],
    ] as const;
    for (const [method, path] of sensitive) {
      expect(gateHttpRequest(method, path, false), `${method} ${path}`).toBe('deny');
    }
  });
});

describe('buildPublicHealth', () => {
  it('never contains credentials, module inventory, or session state', () => {
    const payload = buildPublicHealth(9120);
    expect(Object.keys(payload).sort()).toEqual(
      ['authRequired', 'mode', 'port', 'sameSocketControl', 'status'].sort(),
    );
    // Belt-and-braces: no key or value smells like a secret or state dump.
    const flat = JSON.stringify(payload).toLowerCase();
    for (const needle of ['token', 'modules', 'apme', 'state', 'pid', 'secret']) {
      expect(flat, `public health leaked '${needle}'`).not.toContain(needle);
    }
    expect(payload.authRequired).toBe(true);
    expect(payload.port).toBe(9120);
  });
});

describe('isAuthorizedHttpRequest', () => {
  it('trusts same-machine connections without a token', () => {
    authMocks.isLocal = true;
    try {
      expect(isAuthorizedHttpRequest(fakeReq({}))).toBe(true);
    } finally {
      authMocks.isLocal = false;
    }
  });

  it('accepts a valid query token from a remote peer', () => {
    expect(isAuthorizedHttpRequest(fakeReq({ url: '/status?token=machine-token' }))).toBe(true);
  });

  it('accepts a valid Authorization: Bearer header', () => {
    expect(isAuthorizedHttpRequest(fakeReq({ authorization: 'Bearer machine-token' }))).toBe(true);
  });

  it('rejects remote peers with a wrong or missing token', () => {
    expect(isAuthorizedHttpRequest(fakeReq({}))).toBe(false);
    expect(isAuthorizedHttpRequest(fakeReq({ url: '/status?token=wrong' }))).toBe(false);
    expect(isAuthorizedHttpRequest(fakeReq({ authorization: 'Bearer wrong' }))).toBe(false);
    expect(isAuthorizedHttpRequest(fakeReq({ authorization: 'Basic machine-token' }))).toBe(false);
  });
});
