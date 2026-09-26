import { describe, it, expect } from 'vitest';
import {
  sweepAndSuspendDaemons,
  scanTcpListener,
  type SuspendSweepDeps,
  type PortHolderScan,
} from '../esp32-flash.js';

/**
 * The #327 truth table for the flash CLI's daemon suspend sweep. The incident:
 * the Node daemon went latency-silent at load 600–800, the macOS app promoted
 * a fallback daemon on 9121 that DTR-reset the board mid-write, and the CLI's
 * single suspend call timed out against the blocked Node daemon and was read
 * as "no daemon". Silence must not launder into absence; the LISTENER's
 * identity decides.
 */

type PostResult = { ok: boolean; statusCode: number | null; errCode: string | null };

function deps(overrides: Partial<SuspendSweepDeps> = {}): SuspendSweepDeps {
  return {
    postSuspend: async () => ({ ok: false, statusCode: null, errCode: 'ECONNREFUSED' }) as PostResult,
    probeDaemonHealth: async () => null,
    scanTcpListener: async () => ({ known: true, holders: [] }) as PortHolderScan,
    ...overrides,
  };
}

describe('sweepAndSuspendDaemons', () => {
  it('suspends every answering daemon and reports the ports to resume', async () => {
    const result = await sweepAndSuspendDaemons([9120, 9121, 9122], 420, deps({
      postSuspend: async (port) => (port === 9123 ? { ok: false, statusCode: null, errCode: 'ECONNREFUSED' } : { ok: true, statusCode: 200, errCode: null }),
    }));
    expect(result.suspendedPorts).toEqual([9120, 9121, 9122]);
    expect(result.refuse).toBeUndefined();
    expect(result.notices[0]).toContain(':9120, :9121, :9122');
  });

  it('the incident shape: timeout against an AgentDeck listener REFUSES, not "nothing to suspend"', async () => {
    const result = await sweepAndSuspendDaemons([9120], 420, deps({
      postSuspend: async () => ({ ok: false, statusCode: null, errCode: null }), // timeout: no code
      scanTcpListener: async () => ({ known: true, holders: [{ command: 'node', pid: 59120 }] }),
    }));
    expect(result.suspendedPorts).toEqual([]);
    expect(result.refuse).toContain(':9120');
    expect(result.refuse).toContain('node(59120)');
    expect(result.refuse).toContain('blocked event loop');
  });

  it('ECONNREFUSED is the one silence that means absent — proceeds', async () => {
    const result = await sweepAndSuspendDaemons([9120, 9121], 420, deps());
    expect(result.suspendedPorts).toEqual([]);
    expect(result.refuse).toBeUndefined();
    expect(result.notices).toContain('No daemon is listening — nothing to suspend.');
  });

  it('silence from a NON-AgentDeck listener is not a serial threat', async () => {
    const result = await sweepAndSuspendDaemons([9121], 420, deps({
      postSuspend: async () => ({ ok: false, statusCode: null, errCode: null }),
      scanTcpListener: async () => ({ known: true, holders: [{ command: 'python3', pid: 123 }] }),
    }));
    expect(result.refuse).toBeUndefined();
    // And it must NOT claim "no daemon is listening" while a listener exists.
    expect(result.notices).not.toContain('No daemon is listening — nothing to suspend.');
  });

  it('a daemon that answers HTTP 404 refuses only when /health says it is a daemon', async () => {
    // Pre-parity Swift fallback daemon: 404 on suspend, daemon on health.
    const daemon = await sweepAndSuspendDaemons([9121], 420, deps({
      postSuspend: async () => ({ ok: false, statusCode: 404, errCode: null }),
      probeDaemonHealth: async () => ({ mode: 'daemon' }),
    }));
    expect(daemon.refuse).toContain('answered HTTP 404');
    expect(daemon.refuse).toContain('will not stand down');

    // Session bridge in the same window: 404 on suspend, NOT a daemon.
    const bridge = await sweepAndSuspendDaemons([9122], 420, deps({
      postSuspend: async () => ({ ok: false, statusCode: 404, errCode: null }),
      probeDaemonHealth: async () => ({ mode: 'claude-code' }),
    }));
    expect(bridge.refuse).toBeUndefined();
  });

  it('an unobservable listener (lsof failed) is treated as absent, not refused', async () => {
    // scanTcpListener's own taxonomy already states unknown separately; the
    // sweep deliberately does not refuse on it — the serial-port lsof scan is
    // the gate for the device itself, and an unattributable TCP listener has
    // no evidence tying it to a serial poller.
    const result = await sweepAndSuspendDaemons([9125], 420, deps({
      postSuspend: async () => ({ ok: false, statusCode: null, errCode: 'ECONNRESET' }),
      scanTcpListener: async () => ({ known: false, reason: 'lsof timed out after 5s' }),
    }));
    expect(result.refuse).toBeUndefined();
  });
});

describe('scanTcpListener (live loopback)', () => {
  it('names its listener and observes its release', async () => {
    const { createServer } = await import('net');
    const server = createServer(() => { /* never respond — the silent-listener shape */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const scan = await scanTcpListener(port);
      expect(scan.known).toBe(true);
      if (scan.known) {
        expect(scan.holders.length).toBeGreaterThan(0);
        expect(scan.holders.some((h) => h.pid === process.pid)).toBe(true);
      }
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const closed = await scanTcpListener(port);
      // Never assume port + 1 is unused: parallel tests can bind it. Observe
      // this listener's removal; another process may reuse the released port.
      expect(closed.known).toBe(true);
      if (closed.known) expect(closed.holders.some((h) => h.pid === process.pid)).toBe(false);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
