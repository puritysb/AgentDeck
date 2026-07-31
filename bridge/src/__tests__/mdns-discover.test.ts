import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock state — hoisted so the vi.mock factories (also hoisted) can see it.
const h = vi.hoisted(() => {
  const state: { services: any[] } = { services: [] };
  const stop = vi.fn();
  const destroy = vi.fn();
  class MockBonjour {
    find(_opts: any, cb: (svc: any) => void) {
      for (const s of state.services) cb(s);
      return { stop };
    }
    destroy() { destroy(); }
  }
  const probeHealthAt = vi.fn();
  return { state, stop, destroy, MockBonjour, probeHealthAt };
});

vi.mock('bonjour-service', () => ({ default: h.MockBonjour }));
vi.mock('../session-registry.js', () => ({ probeHealthAt: h.probeHealthAt }));

import { discoverDaemons } from '../mdns-discover.js';

const probeHealthAt = h.probeHealthAt;

beforeEach(() => {
  h.state.services = [];
  h.probeHealthAt.mockReset();
  h.stop.mockReset();
  h.destroy.mockReset();
});

describe('discoverDaemons', () => {
  it('returns a reachable daemon, preferring the /health pairingToken over TXT', async () => {
    h.state.services = [
      { addresses: ['192.168.1.42'], port: 9120, txt: { port: '9120', token: 'txt-token', project: 'Main' } },
    ];
    probeHealthAt.mockResolvedValue({ mode: 'daemon', pairingToken: 'health-token', sameSocketControl: true });

    const found = await discoverDaemons({ timeoutMs: 10 });
    expect(found).toHaveLength(1);
    // sameSocketControl must be PROPAGATED (not just filtered on): the
    // resolver's capability-aware remoteAttach decision reads it off the target.
    expect(found[0]).toEqual({ host: '192.168.1.42', port: 9120, token: 'health-token', projectName: 'Main', sameSocketControl: true });
    expect(h.destroy).toHaveBeenCalled(); // browser cleaned up
  });

  it('filters out daemons that do not advertise sameSocketControl (e.g. Swift App Store)', async () => {
    h.state.services = [
      { addresses: ['192.168.1.42'], port: 9120, txt: { port: '9120' } },
      { addresses: ['192.168.1.77'], port: 9120, txt: { port: '9120' } },
    ];
    probeHealthAt.mockImplementation(async (host: string) =>
      host === '192.168.1.42'
        ? { mode: 'daemon', pairingToken: 'ok', sameSocketControl: true }
        : { mode: 'daemon', pairingToken: 'swift' }, // capable-looking but no control frames
    );

    const found = await discoverDaemons({ timeoutMs: 10 });
    expect(found.map(d => d.host)).toEqual(['192.168.1.42']);
  });

  it('drops link-local and loopback addresses', async () => {
    h.state.services = [
      { addresses: ['169.254.10.10'], port: 9120, txt: { port: '9120' } },
      { addresses: ['127.0.0.1'], port: 9120, txt: { port: '9120' } },
      { addresses: ['fe80::1'], port: 9120, txt: { port: '9120' } },
    ];
    probeHealthAt.mockResolvedValue({ mode: 'daemon', pairingToken: 't' });

    const found = await discoverDaemons({ timeoutMs: 10 });
    expect(found).toHaveLength(0);
    expect(probeHealthAt).not.toHaveBeenCalled(); // nothing usable to probe
  });

  it('excludes candidates whose /health is not a daemon', async () => {
    h.state.services = [
      { addresses: ['192.168.1.42'], port: 9120, txt: { port: '9120' } },
      { addresses: ['192.168.1.99'], port: 9120, txt: { port: '9120' } },
    ];
    probeHealthAt.mockImplementation(async (host: string) =>
      host === '192.168.1.42' ? { mode: 'daemon', pairingToken: 'ok', sameSocketControl: true } : null,
    );

    const found = await discoverDaemons({ timeoutMs: 10 });
    expect(found.map(d => d.host)).toEqual(['192.168.1.42']);
  });

  it('falls back to the TXT ip when no usable addresses are present', async () => {
    h.state.services = [
      { addresses: ['127.0.0.1'], port: 9120, txt: { port: '9120', ip: '10.0.0.5', token: 'txt' } },
    ];
    probeHealthAt.mockResolvedValue({ mode: 'daemon', sameSocketControl: true }); // no pairingToken → use TXT token

    const found = await discoverDaemons({ timeoutMs: 10 });
    expect(found).toEqual([{ host: '10.0.0.5', port: 9120, token: 'txt', projectName: undefined, sameSocketControl: true }]);
  });
});
