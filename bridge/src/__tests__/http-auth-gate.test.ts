import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import {
  approvePeer,
  peerKey,
  resetPairingKnocksForTests,
  revokePeer,
} from '../pairing-knocks.js';

function fakeReq(over: {
  url?: string;
  remoteAddress?: string;
  authorization?: string;
  deviceId?: string;
}) {
  const headers: Record<string, string> = {};
  if (over.authorization) headers.authorization = over.authorization;
  if (over.deviceId) headers['x-agentdeck-device'] = over.deviceId;
  return {
    url: over.url ?? '/',
    headers,
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
      // The operator side of pairing is same-machine only: a remote peer that
      // could open its own window would be granting itself a credential.
      ['POST', '/pair/open'], ['GET', '/pair/status'], ['POST', '/pair/close'],
      // Same reason for the approval half: a peer that could approve itself
      // would be granting itself a credential.
      ['GET', '/pair/knocks'], ['POST', '/pair/approve'],
      ['POST', '/pair/revoke'], ['POST', '/pair/dismiss'],
    ] as const;
    for (const [method, path] of sensitive) {
      expect(gateHttpRequest(method, path, false), `${method} ${path}`).toBe('deny');
    }
  });
});

describe('POST /pair — only a route while the operator holds a window open', () => {
  it('is denied exactly like an unknown path when no window is open', () => {
    // Indistinguishable by design: if a closed daemon answered /pair
    // differently from /nonsense, the endpoint would tell a LAN peer when
    // somebody is pairing, which is precisely the moment worth attacking.
    expect(gateHttpRequest('POST', '/pair', false, false)).toBe('deny');
    expect(gateHttpRequest('POST', '/nonsense', false, false)).toBe('deny');
  });

  it('opens for redemption only while a window is open', () => {
    expect(gateHttpRequest('POST', '/pair', false, true)).toBe('pair-redeem');
  });

  it('defaults to closed when the caller forgets to pass the window state', () => {
    // The parameter is optional so existing call sites keep compiling; the
    // default must be the safe one.
    expect(gateHttpRequest('POST', '/pair', false)).toBe('deny');
  });

  it('an open window does not unlock anything else, or any other method', () => {
    expect(gateHttpRequest('GET', '/pair', false, true)).toBe('deny');
    expect(gateHttpRequest('POST', '/pair/open', false, true)).toBe('deny');
    expect(gateHttpRequest('POST', '/pair/', false, true)).toBe('deny');
    expect(gateHttpRequest('GET', '/status', false, true)).toBe('deny');
    expect(gateHttpRequest('POST', '/hooks/stop', false, true)).toBe('deny');
  });

  it('still serves public health while a window is open', () => {
    expect(gateHttpRequest('GET', '/health', false, true)).toBe('public-health');
  });
});

describe('buildPublicHealth', () => {
  it('never contains credentials, module inventory, or session state', () => {
    const payload = buildPublicHealth(9120);
    expect(Object.keys(payload).sort()).toEqual(
      ['authRequired', 'daemonRelay', 'mode', 'port', 'sameSocketControl', 'status'].sort(),
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

// The third way a peer is authorized, beside same-machine and a token: the
// operator approved it. Folded into `isAuthorizedHttpRequest` rather than added
// as a `gateHttpRequest` parameter, so the truth table above stays pure.
describe('operator approval authorizes an HTTP request', () => {
  const DEV = 'c'.repeat(32);
  const IP = '192.0.2.77';
  let dir: string;

  beforeEach(async () => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-gate-'));
    process.env.AGENTDECK_DATA_DIR = dir;
    resetPairingKnocksForTests();
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    delete process.env.AGENTDECK_DATA_DIR;
    resetPairingKnocksForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an unapproved remote peer', () => {
    expect(isAuthorizedHttpRequest(fakeReq({ remoteAddress: IP }))).toBe(false);
  });

  it('admits it once the operator approves its address', () => {
    approvePeer(peerKey(IP, null));
    expect(isAuthorizedHttpRequest(fakeReq({ remoteAddress: IP }))).toBe(true);
  });

  it('admits a device-approved peer from a DIFFERENT address', () => {
    // The whole point of keying on a device: a DHCP lease change must not
    // retire the grant.
    approvePeer(peerKey(IP, DEV));
    expect(isAuthorizedHttpRequest(
      fakeReq({ remoteAddress: '192.0.2.99', deviceId: DEV }),
    )).toBe(true);
  });

  it('does not admit a different device sharing an approved device grant', () => {
    approvePeer(peerKey(IP, DEV));
    expect(isAuthorizedHttpRequest(
      fakeReq({ remoteAddress: IP, deviceId: 'd'.repeat(32) }),
    )).toBe(false);
  });

  it('still admits a header-less client approved by address', () => {
    // Every device in the field predates the header; refusing them would turn
    // an upgrade into a fleet-wide outage.
    approvePeer(peerKey(IP, null));
    expect(isAuthorizedHttpRequest(fakeReq({ remoteAddress: IP }))).toBe(true);
  });

  it('stops admitting once revoked', () => {
    approvePeer(peerKey(IP, DEV));
    revokePeer(peerKey(IP, DEV));
    expect(isAuthorizedHttpRequest(
      fakeReq({ remoteAddress: IP, deviceId: DEV }),
    )).toBe(false);
  });
});
