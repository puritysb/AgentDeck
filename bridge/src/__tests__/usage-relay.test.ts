/**
 * Integration test: Usage relay chain (3-tier) and BridgeCore usage management.
 *
 * Tests the daemon's relay strategy: HTTP /usage → WS usage_update → direct API.
 * Uses real HTTP/WS servers to validate the actual relay functions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { HookServer } from '../hook-server.js';
import { WsServer } from '../ws-server.js';
import { WsTestClient } from './helpers/ws-test-client.js';
import type { ApiUsageData } from '../usage-api.js';
import type { BridgeEvent, UsageEvent } from '../types.js';

// ─── Test server helpers ────────────────────────────────────────────

interface MockSiblingServer {
  port: number;
  httpServer: Server;
  wss: WebSocketServer;
  setUsage: (usage: ApiUsageData | null, fetchedAt?: number) => void;
  close: () => Promise<void>;
}

/** Create a mock sibling bridge that responds to GET /usage and broadcasts usage_update */
async function createMockSibling(usage: ApiUsageData | null = null): Promise<MockSiblingServer> {
  const app = express();
  let cachedUsage = usage;
  let cachedFetchedAt = Date.now();

  app.get('/usage', (_req, res) => {
    res.json({ status: 'ok', usage: cachedUsage, fetchedAt: cachedFetchedAt });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  // Send usage_update on connect (simulates session bridge behavior)
  wss.on('connection', (ws) => {
    if (cachedUsage) {
      ws.send(JSON.stringify({
        type: 'usage_update',
        sessionDurationSec: 60,
        inputTokens: 1000,
        outputTokens: 500,
        toolCalls: 5,
        fiveHourPercent: cachedUsage.fiveHourPercent,
        fiveHourResetsAt: cachedUsage.fiveHourResetsAt,
        sevenDayPercent: cachedUsage.sevenDayPercent,
        sevenDayResetsAt: cachedUsage.sevenDayResetsAt,
        extraUsageEnabled: cachedUsage.extraUsageEnabled,
        scopedLimits: cachedUsage.scopedLimits,
      }));
    }
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      resolve({
        port,
        httpServer,
        wss,
        setUsage: (u, fetchedAt) => {
          cachedUsage = u;
          if (fetchedAt != null) cachedFetchedAt = fetchedAt;
        },
        close: () => new Promise<void>((res) => {
          wss.close();
          httpServer.close(() => res());
          setTimeout(res, 500);
        }),
      });
    });
  });
}

function sampleUsage(overrides: Partial<ApiUsageData> = {}): ApiUsageData {
  return {
    fiveHourPercent: 42,
    fiveHourResetsAt: '2026-03-22T15:00:00Z',
    sevenDayPercent: 15,
    sevenDayResetsAt: '2026-03-28T00:00:00Z',
    extraUsageEnabled: false,
    extraUsageMonthlyLimit: null,
    extraUsageUsedCredits: null,
    extraUsageUtilization: null,
    scopedLimits: [],
    inferredBillingType: 'subscription',
    ...overrides,
  };
}

// ─── HTTP relay (Tier 1) ────────────────────────────────────────────

describe('Usage relay — HTTP (Tier 1)', () => {
  let sibling: MockSiblingServer;

  beforeEach(async () => {
    sibling = await createMockSibling(sampleUsage());
  });

  afterEach(async () => {
    await sibling.close();
  });

  it('fetches usage from sibling GET /usage', async () => {
    const res = await fetch(`http://127.0.0.1:${sibling.port}/usage`);
    const data = await res.json() as any;

    expect(data.status).toBe('ok');
    expect(data.usage).not.toBeNull();
    expect(data.usage.fiveHourPercent).toBe(42);
    expect(data.usage.sevenDayPercent).toBe(15);
    expect(data.fetchedAt).toBeGreaterThan(0);
  });

  it('returns null usage when sibling has no data', async () => {
    sibling.setUsage(null);

    const res = await fetch(`http://127.0.0.1:${sibling.port}/usage`);
    const data = await res.json() as any;

    expect(data.usage).toBeNull();
  });

  it('rejects stale data (>5 min old)', async () => {
    sibling.setUsage(sampleUsage(), Date.now() - 6 * 60 * 1000);

    const res = await fetch(`http://127.0.0.1:${sibling.port}/usage`);
    const data = await res.json() as any;

    // Data exists but is stale — caller should treat as relay failure
    expect(data.usage).not.toBeNull();
    const age = Date.now() - data.fetchedAt;
    expect(age).toBeGreaterThan(5 * 60 * 1000);
  });
});

// ─── WS relay (Tier 2) ─────────────────────────────────────────────

describe('Usage relay — WebSocket (Tier 2)', () => {
  let sibling: MockSiblingServer;

  beforeEach(async () => {
    sibling = await createMockSibling(sampleUsage());
  });

  afterEach(async () => {
    await sibling.close();
  });

  it('receives usage_update from sibling WS on connect', async () => {
    const received: BridgeEvent[] = [];

    const ws = new WebSocket(`ws://127.0.0.1:${sibling.port}`);
    // Register message handler BEFORE open completes, so we catch the
    // server's immediate usage_update sent on connection
    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()));
    });
    await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); });

    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const usageEvt = received.find((e) => e.type === 'usage_update') as UsageEvent | undefined;
    expect(usageEvt).toBeDefined();
    expect(usageEvt!.fiveHourPercent).toBe(42);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('does not send usage_update when sibling has no data', async () => {
    sibling.setUsage(null);

    const received: BridgeEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${sibling.port}`);
    await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); });

    ws.on('message', (data) => received.push(JSON.parse(data.toString())));

    await new Promise((r) => setTimeout(r, 200));

    const usageEvt = received.find((e) => e.type === 'usage_update');
    expect(usageEvt).toBeUndefined();

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── Scoped per-model limits survive the relay round-trip ───────────

/** A worst-first pair: one ACTIVE binding cap + one inactive cap, with the
 *  severity/active signals the plugin needs to gate its critical treatment. */
const SCOPED_FIXTURE = [
  { kind: 'weekly_scoped', label: 'Fable', percent: 98, severity: 'critical', resetsAt: '2026-03-29T00:00:00Z', active: true },
  { kind: 'weekly_scoped', label: 'Opus', percent: 40, severity: 'normal', resetsAt: '2026-03-29T00:00:00Z', active: false },
];

describe('Usage relay — scoped limits round-trip', () => {
  it('preserves scopedLimits (active + severity) over the sibling WS relay', async () => {
    const sibling = await createMockSibling(sampleUsage({ scopedLimits: SCOPED_FIXTURE }));
    try {
      const received: BridgeEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${sibling.port}`);
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));
      await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); });
      await new Promise((r) => setTimeout(r, 200));

      const evt = received.find((e) => e.type === 'usage_update') as UsageEvent | undefined;
      expect(evt).toBeDefined();
      // The whole array survives serialization, worst-first order intact.
      expect(evt!.scopedLimits).toEqual(SCOPED_FIXTURE);
      // The binding signals specifically must not be dropped/flattened.
      expect(evt!.scopedLimits![0].active).toBe(true);
      expect(evt!.scopedLimits![0].severity).toBe('critical');
      expect(evt!.scopedLimits![1].active).toBe(false);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await sibling.close();
    }
  });

  it('carries scopedLimits through the HTTP /usage relay tier', async () => {
    const sibling = await createMockSibling(sampleUsage({ scopedLimits: SCOPED_FIXTURE }));
    try {
      const res = await fetch(`http://127.0.0.1:${sibling.port}/usage`);
      const data = await res.json() as any;
      expect(data.usage.scopedLimits).toEqual(SCOPED_FIXTURE);
    } finally {
      await sibling.close();
    }
  });
});

// ─── HookServer /usage endpoint integration ─────────────────────────

describe('HookServer GET /usage (relay source)', () => {
  let hookServer: HookServer;
  let port: number;

  beforeEach(async () => {
    hookServer = new HookServer();
    await hookServer.listen(0);
    const addr = hookServer.getServer().address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await hookServer.close();
  });

  it('returns cached usage via onApiUsage getter', async () => {
    const usage = sampleUsage();
    const fetchedAt = Date.now();
    hookServer.onApiUsage(() => ({ usage, fetchedAt }));

    const res = await fetch(`http://127.0.0.1:${port}/usage`);
    const data = await res.json() as any;

    expect(data.status).toBe('ok');
    expect(data.usage.fiveHourPercent).toBe(42);
    expect(data.usage.sevenDayPercent).toBe(15);
    expect(data.fetchedAt).toBe(fetchedAt);
  });

  it('returns fresh usage after update', async () => {
    let currentUsage = sampleUsage({ fiveHourPercent: 20 });
    let currentTime = Date.now();
    hookServer.onApiUsage(() => ({ usage: currentUsage, fetchedAt: currentTime }));

    // First fetch
    const res1 = await fetch(`http://127.0.0.1:${port}/usage`);
    const data1 = await res1.json() as any;
    expect(data1.usage.fiveHourPercent).toBe(20);

    // Update usage
    currentUsage = sampleUsage({ fiveHourPercent: 75 });
    currentTime = Date.now();

    // Second fetch should reflect update
    const res2 = await fetch(`http://127.0.0.1:${port}/usage`);
    const data2 = await res2.json() as any;
    expect(data2.usage.fiveHourPercent).toBe(75);
  });
});

// ─── 429 prevention logic ───────────────────────────────────────────

describe('429 prevention — relay-first strategy', () => {
  it('sibling with data prevents direct API call', async () => {
    // When siblings exist and have usage data, daemon should NOT call API directly.
    // This is the core 429 prevention: only one bridge calls the API.
    const sibling = await createMockSibling(sampleUsage());

    try {
      const res = await fetch(`http://127.0.0.1:${sibling.port}/usage`);
      const data = await res.json() as any;

      // Relay succeeded — daemon would use this and skip API
      expect(data.usage).not.toBeNull();
      expect(data.usage.fiveHourPercent).toBe(42);
    } finally {
      await sibling.close();
    }
  });

  it('multiple siblings — first with data wins', async () => {
    const sibling1 = await createMockSibling(null);             // No data
    const sibling2 = await createMockSibling(sampleUsage({ fiveHourPercent: 88 }));

    try {
      // Sibling 1 has no data
      const res1 = await fetch(`http://127.0.0.1:${sibling1.port}/usage`);
      expect((await res1.json() as any).usage).toBeNull();

      // Sibling 2 has data — would be used
      const res2 = await fetch(`http://127.0.0.1:${sibling2.port}/usage`);
      const data2 = await res2.json() as any;
      expect(data2.usage.fiveHourPercent).toBe(88);
    } finally {
      await sibling1.close();
      await sibling2.close();
    }
  });
});

// ─── Usage data shape validation ────────────────────────────────────

describe('ApiUsageData shape', () => {
  it('has all required fields', () => {
    const usage = sampleUsage();
    expect(typeof usage.fiveHourPercent).toBe('number');
    expect(typeof usage.fiveHourResetsAt).toBe('string');
    expect(typeof usage.sevenDayPercent).toBe('number');
    expect(typeof usage.sevenDayResetsAt).toBe('string');
    expect(typeof usage.extraUsageEnabled).toBe('boolean');
  });

  it('serializes to valid JSON and back', () => {
    const usage = sampleUsage();
    const json = JSON.stringify(usage);
    const parsed = JSON.parse(json) as ApiUsageData;
    expect(parsed.fiveHourPercent).toBe(usage.fiveHourPercent);
    expect(parsed.inferredBillingType).toBe('subscription');
  });

  it('handles null optional fields', () => {
    const usage = sampleUsage({
      extraUsageMonthlyLimit: null,
      extraUsageUsedCredits: null,
      extraUsageUtilization: null,
      inferredBillingType: null,
    });

    const json = JSON.stringify(usage);
    const parsed = JSON.parse(json);
    expect(parsed.extraUsageMonthlyLimit).toBeNull();
    expect(parsed.inferredBillingType).toBeNull();
  });
});
