import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bonjourMocks = vi.hoisted(() => {
  const publish = vi.fn();
  const unpublishAll = vi.fn();
  const destroy = vi.fn();
  return { publish, unpublishAll, destroy };
});

vi.mock('bonjour-service', () => ({
  default: class MockBonjour {
    publish = bonjourMocks.publish;
    unpublishAll = bonjourMocks.unpublishAll;
    destroy = bonjourMocks.destroy;
  },
}));

// Only `getLanIp` is faked — the identity helpers are the thing under test
// here, and stubbing them would let the publish call go out with `undefined`
// where a name belongs while every assertion still passed.
vi.mock('@agentdeck/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentdeck/shared')>()),
  getLanIp: () => '192.0.2.10',
}));

import { advertiseBridge, MDNS_SERVICE_HOST, triggerMdnsRecovery } from '../mdns.js';

describe('mDNS service hostname', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bonjourMocks.publish.mockReset();
    bonjourMocks.unpublishAll.mockReset();
    bonjourMocks.destroy.mockReset();
    bonjourMocks.publish.mockReturnValue({
      on: vi.fn(),
      stop: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never publishes A/AAAA records under the macOS system hostname', () => {
    const cleanup = advertiseBridge(9120, 'AgentDeck', 'daemon');

    expect(MDNS_SERVICE_HOST).toMatch(/^agentdeck-[0-9a-f]{32}\.local$/);
    expect(MDNS_SERVICE_HOST).not.toBe(os.hostname());
    expect(bonjourMocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        // The instance name identifies host and user now (it used to be
        // `AgentDeck-9120` on every machine on the segment — see
        // docs/ENTERPRISE-ROADMAP.md §2.1), so this asserts the SHAPE: those
        // components come from the machine running the test.
        name: expect.stringMatching(/^AgentDeck-[A-Za-z0-9-]*9120$/),
        host: MDNS_SERVICE_HOST,
        type: 'agentdeck',
        port: 9120,
      }),
    );

    cleanup();
  });

  it('identifies which daemon it is without naming the account', () => {
    const cleanup = advertiseBridge(9120, 'AgentDeck', 'daemon');

    const call = bonjourMocks.publish.mock.calls[0][0];
    const txt = call.txt as Record<string, string>;
    // A client has to be able to tell two daemons apart before dialling one.
    expect(txt.user).toMatch(/^[0-9a-f]{4}$/);
    expect(txt.host).toBe(call.name.split('-').slice(1, -2).join('-'));
    // …but multicast is readable by everyone on the segment, so the account
    // name must never be the value of anything. Asserted per-value rather than
    // over the serialized record: the hostname IS published on purpose and can
    // legitimately contain the username as a substring (CI's runner is user
    // `runner` on host `runnervmzvulz`), so a substring test over the whole
    // TXT blob fails on a machine that is doing nothing wrong.
    const username = os.userInfo().username;
    expect(txt.user).not.toContain(username);
    expect(Object.values(txt)).not.toContain(username);

    cleanup();
  });

  it('never puts a pairing token in the multicast TXT record (issue #145)', () => {
    const cleanup = advertiseBridge(9120, 'AgentDeck', 'daemon');

    const txt = bonjourMocks.publish.mock.calls[0][0].txt as Record<string, string>;
    expect(Object.keys(txt)).not.toContain('token');
    expect(JSON.stringify(txt)).not.toMatch(/token/i);

    cleanup();
  });

  it('keeps the service hostname stable across recovery re-publishes', () => {
    const cleanup = advertiseBridge(9120, 'AgentDeck', 'daemon');

    triggerMdnsRecovery();

    expect(bonjourMocks.publish).toHaveBeenCalledTimes(2);
    expect(bonjourMocks.publish.mock.calls[0][0].host).toBe(MDNS_SERVICE_HOST);
    expect(bonjourMocks.publish.mock.calls[1][0].host).toBe(MDNS_SERVICE_HOST);

    cleanup();
  });
});
