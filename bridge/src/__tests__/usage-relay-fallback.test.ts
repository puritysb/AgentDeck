/**
 * Regression test for fa1d98c9 — "fall back to direct usage API when the
 * sibling relay is stale".
 *
 * The daemon relays Claude usage from a sibling session bridge to avoid
 * running multiple API pollers. But a PTY session bridge only refreshes its
 * usage when it has *direct* inbound WS clients, and dashboards/Stream Deck
 * connect to the daemon (the sole entry point) — never to the bridge. So a
 * sibling with no direct clients never populates its /usage, the relay yields
 * null forever, and the daemon's usage froze at its startup value.
 *
 * fetchUsageRelayed must therefore fall back to the direct API whenever the
 * relay yields nothing fresh — even when siblings *exist*. Before fa1d98c9 the
 * "siblings exist" branch returned null and skipped the direct API entirely.
 *
 * These tests mock the session registry (to control the sibling set) and the
 * direct-API fetch (to observe whether the fallback fires), while exercising
 * the real fetchUsageViaHttp/fetchUsageViaWs relay helpers against a live/dead
 * loopback sibling.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import type { ApiUsageData } from '../usage-api.js';

// Mutable sibling list the mocked registry hands back, per test. fetchUsageRelayed
// reads only `.port` and `.agentType` off each entry, so a structural subset of
// SessionEntry is all these fixtures need (the cast below narrows to that intent).
const registryState = vi.hoisted(() => ({ siblings: [] as Array<{ port: number; agentType: string }> }));

vi.mock('../session-registry.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../session-registry.js')>();
  return { ...mod, listActive: (() => registryState.siblings) as unknown as typeof mod.listActive };
});

vi.mock('../usage-api.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../usage-api.js')>();
  return { ...mod, fetchUsageFromApi: vi.fn() };
});

import { fetchUsageRelayed } from '../daemon-server.js';
import { fetchUsageFromApi } from '../usage-api.js';

const fetchUsageFromApiMock = vi.mocked(fetchUsageFromApi);

function sampleUsage(overrides: Partial<ApiUsageData> = {}): ApiUsageData {
  return {
    fiveHourPercent: 42,
    fiveHourResetsAt: '2026-08-02T15:00:00Z',
    sevenDayPercent: 15,
    sevenDayResetsAt: '2026-08-08T00:00:00Z',
    extraUsageEnabled: false,
    extraUsageMonthlyLimit: null,
    extraUsageUsedCredits: null,
    extraUsageUtilization: null,
    inferredBillingType: 'subscription',
    ...overrides,
  };
}

/** A sibling HTTP server whose GET /usage returns a caller-controlled payload. */
async function startSibling(
  respond: () => { usage: ApiUsageData | null; fetchedAt: number },
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.get('/usage', (_req, res) => {
    const { usage, fetchedAt } = respond();
    res.json({ status: 'ok', usage, fetchedAt });
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A loopback port with nothing listening — HTTP + WS relay attempts both fail fast. */
async function reserveDeadPort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const SELF_PORT = 9120;

describe('fetchUsageRelayed — direct-API fallback (regression: fa1d98c9)', () => {
  beforeEach(() => {
    registryState.siblings = [];
    fetchUsageFromApiMock.mockReset();
  });

  // Baseline/control (not the fa1d98c9 branch): the empty-sibling path already
  // used the direct API before fa1d98c9. Pins that it still does.
  it('no siblings → uses the direct API', async () => {
    const direct = sampleUsage({ fiveHourPercent: 7 });
    fetchUsageFromApiMock.mockResolvedValue(direct);

    const result = await fetchUsageRelayed(SELF_PORT);

    expect(result).toBe(direct);
    expect(fetchUsageFromApiMock).toHaveBeenCalledTimes(1);
  });

  it('siblings exist but the relay yields nothing → falls back to the direct API', async () => {
    // A sibling registered but unreachable (no direct WS clients / bridge gone):
    // both relay tiers yield null. Pre-fa1d98c9 this returned null and froze usage.
    const deadPort = await reserveDeadPort();
    registryState.siblings = [{ port: deadPort, agentType: 'claude' }];

    const direct = sampleUsage({ fiveHourPercent: 63 });
    fetchUsageFromApiMock.mockResolvedValue(direct);

    const result = await fetchUsageRelayed(SELF_PORT);

    expect(result).toBe(direct);
    expect(fetchUsageFromApiMock).toHaveBeenCalledTimes(1);
  });

  it('siblings exist but only serve null usage → falls back to the direct API', async () => {
    // Sibling is reachable but its /usage has no data (never refreshed). The
    // relay must still fall back rather than returning the null payload.
    const sibling = await startSibling(() => ({ usage: null, fetchedAt: Date.now() }));
    registryState.siblings = [{ port: sibling.port, agentType: 'claude' }];

    const direct = sampleUsage({ fiveHourPercent: 88 });
    fetchUsageFromApiMock.mockResolvedValue(direct);

    try {
      const result = await fetchUsageRelayed(SELF_PORT);
      expect(result).toBe(direct);
      expect(fetchUsageFromApiMock).toHaveBeenCalledTimes(1);
    } finally {
      await sibling.close();
    }
  });

  it('sibling serves fresh usage → relay wins, direct API not called (429 prevention preserved)', async () => {
    const relayed = sampleUsage({ fiveHourPercent: 55 });
    const sibling = await startSibling(() => ({ usage: relayed, fetchedAt: Date.now() }));
    registryState.siblings = [{ port: sibling.port, agentType: 'claude' }];

    fetchUsageFromApiMock.mockResolvedValue(sampleUsage({ fiveHourPercent: 1 }));

    try {
      const result = await fetchUsageRelayed(SELF_PORT);
      expect(result?.fiveHourPercent).toBe(55);
      expect(fetchUsageFromApiMock).not.toHaveBeenCalled();
    } finally {
      await sibling.close();
    }
  });

  it('stale sibling data (>5 min old) is ignored → falls back to the direct API', async () => {
    const stale = sampleUsage({ fiveHourPercent: 99 });
    const sibling = await startSibling(() => ({ usage: stale, fetchedAt: Date.now() - 6 * 60 * 1000 }));
    registryState.siblings = [{ port: sibling.port, agentType: 'claude' }];

    const direct = sampleUsage({ fiveHourPercent: 33 });
    fetchUsageFromApiMock.mockResolvedValue(direct);

    try {
      const result = await fetchUsageRelayed(SELF_PORT);
      expect(result).toBe(direct);
      expect(fetchUsageFromApiMock).toHaveBeenCalledTimes(1);
    } finally {
      await sibling.close();
    }
  });
});
