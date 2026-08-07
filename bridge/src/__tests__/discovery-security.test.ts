import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socketMocks = vi.hoisted(() => {
  const send = vi.fn();
  const close = vi.fn();
  const setBroadcast = vi.fn();
  const on = vi.fn();
  const bind = vi.fn((ready: () => void) => ready());
  const createSocket = vi.fn(() => ({ send, close, setBroadcast, on, bind }));
  return { send, close, setBroadcast, on, bind, createSocket };
});

vi.mock('node:dgram', () => ({
  default: { createSocket: socketMocks.createSocket },
}));

vi.mock('@agentdeck/shared', () => ({
  getLanIp: () => '192.0.2.42',
}));

vi.mock('../logger.js', () => ({
  debug: vi.fn(),
  log: vi.fn(),
}));

import { advertiseUdpBroadcast } from '../broadcast.js';

describe('LAN discovery credential boundary (issue #145)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never serializes a pairing credential into a UDP discovery beacon', async () => {
    // Reflect.apply deliberately supplies the old fourth argument. If the
    // credential parameter or serialization is restored, this test exposes it
    // in the captured datagram instead of silently adapting to the regression.
    const cleanup = Reflect.apply(advertiseUdpBroadcast, undefined, [
      9120,
      'AgentDeck',
      'daemon',
      'sentinel-pairing-secret',
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(socketMocks.send).toHaveBeenCalledTimes(2);
    for (const [message, port, address] of socketMocks.send.mock.calls) {
      const text = (message as Buffer).toString('utf8');
      expect(port).toBe(9121);
      expect(['255.255.255.255', '192.0.2.255']).toContain(address);
      expect(JSON.parse(text)).toEqual({
        v: 1,
        ip: '192.0.2.42',
        port: 9120,
        project: 'AgentDeck',
        agent: 'daemon',
      });
      expect(text).not.toContain('sentinel-pairing-secret');
      expect(text).not.toMatch(/token|secret|credential/i);
    }

    cleanup();
  });

  it.each(['../index.ts', '../daemon-server.ts'])(
    'does not materialize or log a token-bearing pairing URL in %s',
    (relativePath) => {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
      expect(source).not.toContain('core.wsUrl');
      expect(source).not.toContain('Pairing URL:');
    },
  );

  it('keeps per-session project metadata off LAN discovery', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/mdns:\s*false,\s*\n\s*broadcast:\s*false,/);
  });
});
