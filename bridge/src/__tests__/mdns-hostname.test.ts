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

vi.mock('@agentdeck/shared', () => ({
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
    const cleanup = advertiseBridge(9120, 'AgentDeck', 'daemon', 'test-token');

    expect(MDNS_SERVICE_HOST).toMatch(/^agentdeck-[0-9a-f]{32}\.local$/);
    expect(MDNS_SERVICE_HOST).not.toBe(os.hostname());
    expect(bonjourMocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'AgentDeck-9120',
        host: MDNS_SERVICE_HOST,
        type: 'agentdeck',
        port: 9120,
      }),
    );

    cleanup();
  });

  it('keeps the service hostname stable across recovery re-publishes', () => {
    const cleanup = advertiseBridge(9120, 'AgentDeck', 'daemon', 'test-token');

    triggerMdnsRecovery();

    expect(bonjourMocks.publish).toHaveBeenCalledTimes(2);
    expect(bonjourMocks.publish.mock.calls[0][0].host).toBe(MDNS_SERVICE_HOST);
    expect(bonjourMocks.publish.mock.calls[1][0].host).toBe(MDNS_SERVICE_HOST);

    cleanup();
  });
});
