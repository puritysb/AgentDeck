/**
 * Integration test: BridgeCore orchestration.
 *
 * Tests the central BridgeCore class with real HTTP/WS server, real StateMachine,
 * and real UsageTracker. Verifies state building, usage broadcasting, client
 * connect flow, polling guards, and timeline wiring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import { resolveRelayedUsageEvent } from '../relayed-usage.js';
import {
  BridgeCore,
  ESP32_INITIAL_TIMELINE_HISTORY_MAX_BYTES,
  INITIAL_TIMELINE_HISTORY_ENTRIES,
  INITIAL_TIMELINE_HISTORY_MAX_BYTES,
} from '../bridge-core.js';
import { WsTestClient } from './helpers/ws-test-client.js';
import { createTempDataDir, type TempDataDir } from './helpers/temp-data-dir.js';
import { State, PermissionMode, CLAUDE_CODE_CAPABILITIES } from '@agentdeck/shared';
import type { StateUpdateEvent, UsageEvent, BridgeEvent } from '../types.js';
import type { ApiUsageData } from '../usage-api.js';

function sampleApiUsage(overrides: Partial<ApiUsageData> = {}): ApiUsageData {
  return {
    fiveHourPercent: 35,
    fiveHourResetsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    sevenDayPercent: 12,
    sevenDayResetsAt: new Date(Date.now() + 5 * 24 * 3600_000).toISOString(),
    extraUsageEnabled: false,
    extraUsageMonthlyLimit: null,
    extraUsageUsedCredits: null,
    extraUsageUtilization: null,
    scopedLimits: [],
    inferredBillingType: 'subscription',
    ...overrides,
  };
}

describe('BridgeCore Orchestration', () => {
  let core: BridgeCore;
  let httpServer: ReturnType<typeof createServer>;
  let port: number;
  let tempDir: TempDataDir;

  beforeEach(async () => {
    tempDir = createTempDataDir();
    httpServer = createServer();

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = httpServer.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    core = new BridgeCore({
      port,
      projectName: 'TestProject',
      httpServer,
    });
  });

  afterEach(async () => {
    // Clean shutdown without process.exit
    core.wsServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      setTimeout(resolve, 500);
    });
    tempDir.cleanup();
  });

  it('retires old disk quota after a failed first poll and never restamps cache hits', () => {
    const capturedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    core.applyZaiUsageResult({ fresh: false, data: {
      primary: { usedPercent: 92, windowMinutes: 300 }, capturedAt, planType: 'max',
    } });
    expect((core.buildUsage() as UsageEvent).zaiRateLimits?.primary).toBeUndefined();
    const recent = new Date(Date.now() - 60_000).toISOString();
    core.applyZaiUsageResult({ fresh: true, data: {
      primary: { usedPercent: 12, windowMinutes: 300 }, capturedAt: recent,
    } });
    expect(core.lastZaiFetchTime).toBe(Date.parse(recent));
    expect((core.buildUsage() as UsageEvent).zaiRateLimits?.primary?.usedPercent).toBe(12);
    core.applyZaiUsageResult({ data: null, fresh: false });
    expect(JSON.parse(JSON.stringify(core.buildUsage())).zaiRateLimits).toEqual({});
  });

  it('expires z.ai on a focused relay without rebuilding usage or extending capture time', () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const capturedAt = new Date(now).toISOString();
      core.applyZaiUsageResult({ fresh: true, data: {
        capturedAt, planType: 'max', limitId: 'standard',
        primary: { usedPercent: 92, windowMinutes: 300 },
        secondary: { usedPercent: 100, windowMinutes: 43200, quantity: 'mcp' },
      } });
      const buildOwnUsage = vi.spyOn(core, 'buildUsage');
      const relay = () => JSON.parse(JSON.stringify(resolveRelayedUsageEvent({
        relayed: { type: 'usage_update', fiveHourPercent: 63, inputTokens: 42,
          subscriptions: [{ name: 'Claude' }] },
        ownCodexRateLimits: null,
        ownZaiRateLimits: core.zaiQuotaForWire(),
        buildOwnUsage: () => core.buildUsage() as UsageEvent,
      })));
      clock.mockReturnValue(now + 10 * 60_000);
      expect(relay().zaiRateLimits.capturedAt).toBe(capturedAt);
      expect(relay().subscriptions).toContainEqual({ name: 'GLM Coding Plan · Max' });
      clock.mockReturnValue(now + 10 * 60_000 + 1);
      const expired = relay();
      expect(expired.zaiRateLimits).toEqual({ planType: 'max', limitId: 'standard' });
      expect(expired.subscriptions).toEqual([{ name: 'Claude' }]);
      expect(expired.inputTokens).toBe(42);
      expect(expired.fiveHourPercent).toBe(63);
      expect(buildOwnUsage).not.toHaveBeenCalled();
      buildOwnUsage.mockRestore();

      // Replacement/removal must be visible on the next relay too.
      core.applyZaiUsageResult({ fresh: true, data: {
        capturedAt: new Date(Date.now()).toISOString(), planType: 'lite',
        primary: { usedPercent: 3, windowMinutes: 300 },
      } });
      expect(relay().subscriptions).toContainEqual({ name: 'GLM Coding Plan · Lite' });
      core.applyZaiUsageResult({ fresh: false, data: null });
      expect(relay().zaiRateLimits).toEqual({});
      expect(relay().subscriptions).toEqual([{ name: 'Claude' }]);
    } finally {
      clock.mockRestore();
    }
  });

  // ─── State event building ─────────────────────────────────────────

  describe('buildStateEvent', () => {
    it('builds state_update with IDLE state', () => {
      core.stateMachine.handleHookEvent('SessionStart', {});

      const evt = core.buildStateEvent({
        agentType: 'claude-code',
        agentCapabilities: CLAUDE_CODE_CAPABILITIES,
      }) as StateUpdateEvent;

      expect(evt.type).toBe('state_update');
      expect(evt.state).toBe(State.IDLE);
      expect(evt.agentType).toBe('claude-code');
      expect(evt.agentCapabilities).toEqual(CLAUDE_CODE_CAPABILITIES);
      expect(evt.projectName).toBe('TestProject');
      expect(evt.pairingUrl).toContain(`ws://`);
    });

    it('includes cached ollamaStatus and gatewayAvailable', () => {
      core.cachedOllamaStatus = { available: true, models: [{ name: 'qwen2.5:7b', size: 4_500_000_000, sizeVram: 4_500_000_000 }] };
      core.cachedGatewayAvailable = true;
      core.cachedGatewayHasError = false;

      const evt = core.buildStateEvent({ agentType: 'claude-code' }) as StateUpdateEvent;

      expect(evt.ollamaStatus).toBeDefined();
      expect(evt.ollamaStatus!.available).toBe(true);
      expect(evt.ollamaStatus!.models).toHaveLength(1);
      expect(evt.gatewayAvailable).toBe(true);
      expect(evt.gatewayHasError).toBe(false);
    });

    it('computes promptType for permission options', () => {
      core.stateMachine.handleHookEvent('SessionStart', {});
      core.stateMachine.handleHookEvent('UserPromptSubmit', {});
      core.stateMachine.handleParserEvent('permission_prompt', {
        options: [
          { index: 0, label: 'Allow once', shortcut: 'y' },
          { index: 1, label: 'Deny', shortcut: 'n' },
        ],
        question: 'Allow Read?',
      });

      const evt = core.buildStateEvent({ agentType: 'claude-code' }) as StateUpdateEvent;

      expect(evt.state).toBe(State.AWAITING_PERMISSION);
      expect(evt.promptType).toBe('yes_no');
      expect(evt.options).toHaveLength(2);
      expect(evt.question).toBe('Allow Read?');
    });

    it('computes promptType yes_no_always for 3+ permission options', () => {
      core.stateMachine.handleHookEvent('SessionStart', {});
      core.stateMachine.handleHookEvent('UserPromptSubmit', {});
      core.stateMachine.handleParserEvent('permission_prompt', {
        options: [
          { index: 0, label: 'Allow once', shortcut: 'y' },
          { index: 2, label: 'Always allow', shortcut: 'a' },
          { index: 1, label: 'Deny', shortcut: 'n' },
        ],
      });

      const evt = core.buildStateEvent({ agentType: 'claude-code' }) as StateUpdateEvent;
      expect(evt.promptType).toBe('yes_no_always');
    });
  });

  // ─── Usage management ─────────────────────────────────────────────

  describe('usage management', () => {
    it('updateApiUsage caches and broadcasts', async () => {
      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        core.stateMachine.handleParserEvent('model_info', { model: 'claude-3-5-sonnet' });
        const usage = sampleApiUsage();
        core.updateApiUsage(usage);

        expect(core.cachedApiUsage).toEqual(usage);
        expect(core.oauthConnected).toBe(true);
        expect(core.apiUsageStale).toBe(false);
        expect(core.lastApiFetchTime).toBeGreaterThan(0);

        const evt = await client.waitForType('usage_update') as UsageEvent;
        expect(evt.fiveHourPercent).toBe(35);
        expect(evt.sevenDayPercent).toBe(12);
      } finally {
        await client.close();
      }
    });

    it('buildUsage includes API usage data', () => {
      core.stateMachine.handleParserEvent('model_info', { model: 'claude-3-5-sonnet' });
      core.updateApiUsage(sampleApiUsage({ fiveHourPercent: 55 }));

      const evt = core.buildUsage() as UsageEvent;
      expect(evt.type).toBe('usage_update');
      expect(evt.fiveHourPercent).toBe(55);
      expect(evt.oauthConnected).toBe(true);
    });

    it('buildUsage works without API data', () => {
      const evt = core.buildUsage() as UsageEvent;
      expect(evt.type).toBe('usage_update');
      expect(evt.sessionDurationSec).toBeDefined();
      expect(evt.inputTokens).toBe(0);
      expect(evt.outputTokens).toBe(0);
    });

    it('inferredBillingType propagates to StateMachine', () => {
      core.updateApiUsage(sampleApiUsage({ inferredBillingType: 'subscription' }));

      const snapshot = core.stateMachine.getSnapshot();
      expect(snapshot.billingType).toBe('subscription');
    });

    // ─── Failed fetch must not launder as a fresh one ────────────────
    //
    // Every failure branch of fetchUsageFromApi (429 / 401 / !ok / API-error /
    // network-throw) still returns the last good numbers off the shared cache
    // file. Before UsageFetchResult those were indistinguishable from a live
    // reading, so updateApiUsage() pushed lastApiFetchTime forward and cleared
    // apiUsageStale — leaving the `usageStale` wire flag unreachable and the
    // USAGE_STALE_TTL backstop permanently disarmed. On 2026-08-19 that shipped
    // a 7-minute-old 0% to every surface, marked `usageStale: false`.
    describe('stale fetch results', () => {
      it('a not-fresh result keeps the numbers but marks them stale', () => {
        core.applyUsageResult({ data: sampleApiUsage({ fiveHourPercent: 41 }), fresh: false });

        expect(core.cachedApiUsage?.fiveHourPercent).toBe(41);
        expect(core.apiUsageStale).toBe(true);
      });

      it('a not-fresh result does NOT advance lastApiFetchTime', () => {
        // The freshness clock is what USAGE_STALE_TTL and fetchUsageIfStale both
        // read; advancing it on a failure is what disarmed them.
        core.applyUsageResult({ data: sampleApiUsage(), fresh: true });
        const afterFresh = core.lastApiFetchTime;
        expect(afterFresh).toBeGreaterThan(0);

        core.applyUsageResult({ data: sampleApiUsage({ fiveHourPercent: 99 }), fresh: false });

        expect(core.lastApiFetchTime).toBe(afterFresh);
        expect(core.apiUsageStale).toBe(true);
      });

      it('a fresh result clears staleness again', () => {
        core.applyUsageResult({ data: sampleApiUsage(), fresh: false });
        expect(core.apiUsageStale).toBe(true);

        core.applyUsageResult({ data: sampleApiUsage({ fiveHourPercent: 8 }), fresh: true });

        expect(core.apiUsageStale).toBe(false);
        expect(core.cachedApiUsage?.fiveHourPercent).toBe(8);
      });

      it('a null result (no numbers at all) marks an existing cache stale', () => {
        core.applyUsageResult({ data: sampleApiUsage(), fresh: true });

        expect(core.applyUsageResult(null)).toBe(false);
        expect(core.apiUsageStale).toBe(true);
      });

      it('retires quota and the subscription in both frame types before a timer runs, then recovers', () => {
        core.stateMachine.handleHookEvent('SessionStart', {});
        core.stateMachine.handleParserEvent('model_info', { model: 'claude-fable-5' });
        core.updateApiUsage(sampleApiUsage());
        const state = () => core.buildStateEvent({ agentType: 'claude-code' }) as StateUpdateEvent;
        const usage = () => core.buildUsage() as UsageEvent;
        expect(state().subscriptions).toContainEqual({ name: 'Claude' });
        expect(usage().fiveHourPercent).toBe(35);
        core.cachedAntigravityStatus = { planName: 'Antigravity Pro' };
        core.lastApiFetchTime = Date.now() - 600_001;
        expect(state().subscriptions).not.toContainEqual({ name: 'Claude' });
        expect(state().subscriptions).toContainEqual({ name: 'Antigravity Pro' });
        expect(usage().usageStale).toBe(true);
        expect(usage().fiveHourPercent).toBeUndefined();
        expect(core.cachedApiUsage?.fiveHourPercent).toBe(35);
        core.updateApiUsage(sampleApiUsage({ fiveHourPercent: 8 }));
        expect(usage().fiveHourPercent).toBe(8);
        expect(usage().usageStale).toBe(false);
        expect(state().subscriptions).toContainEqual({ name: 'Claude' });
        core.applyUsageResult(null);
        expect(usage().fiveHourPercent).toBeUndefined();
        expect(state().subscriptions).not.toContainEqual({ name: 'Claude' });
      });

      it('keeps API cost usage live without a subscription cache', () => {
        vi.spyOn(core.stateMachine, 'getSnapshot').mockReturnValue({
          ...core.stateMachine.getSnapshot(), billingType: 'api', costSpent: 5, costLimit: 20,
        });
        const event = core.buildUsage() as UsageEvent;
        expect(event.fiveHourPercent).toBe(25);
        expect(event.usageStale).toBe(false);
        expect(event.subscriptions).not.toContainEqual({ name: 'Claude' });
      });

      it('reports freshness back to the caller', () => {
        expect(core.applyUsageResult({ data: sampleApiUsage(), fresh: true })).toBe(true);
        expect(core.applyUsageResult({ data: sampleApiUsage(), fresh: false })).toBe(false);
      });
    });
  });

  // ─── Client connect: initial state ────────────────────────────────

  describe('sendInitialState', () => {
    it('sends state_update, usage_update, connection, display_state on connect', async () => {
      core.stateMachine.handleHookEvent('SessionStart', {});

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        // Wire onConnect to sendInitialState
        core.wsServer.onClientConnect((ws) => {
          core.sendInitialState(ws, {
            agentType: 'claude-code',
            agentCapabilities: CLAUDE_CODE_CAPABILITIES,
            isAlive: true,
          });
        });

        // Need a second client to trigger onConnect
        const client2 = new WsTestClient();
        await client2.connect(`ws://127.0.0.1:${port}`);

        try {
          const stateEvt = await client2.waitForType('state_update') as StateUpdateEvent;
          expect(stateEvt.state).toBe(State.IDLE);
          expect(stateEvt.agentType).toBe('claude-code');

          const usageEvt = await client2.waitForType('usage_update') as UsageEvent;
          expect(usageEvt.sessionDurationSec).toBeDefined();

          const connEvt = await client2.waitForType('connection');
          expect((connEvt as any).status).toBe('connected');

          const displayEvt = await client2.waitForType('display_state');
          expect(typeof (displayEvt as any).displayOn).toBe('boolean');
        } finally {
          await client2.close();
        }
      } finally {
        await client.close();
      }
    });

    it('includes timeline_history when entries exist', async () => {
      core.wireTimeline();
      core.bridgeTimeline.addEntry({ ts: 100, type: 'tool_request', raw: 'Read /foo.ts' });
      core.bridgeTimeline.addEntry({ ts: 200, type: 'chat_end', raw: 'Done' });

      core.wsServer.onClientConnect((ws) => {
        core.sendInitialState(ws, {
          agentType: 'claude-code',
          isAlive: true,
        });
      });

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        const historyEvt = await client.waitForType('timeline_history');
        expect((historyEvt as any).entries).toHaveLength(2);
      } finally {
        await client.close();
      }
    });

    it('gives a dashboard the latest readable rows, as the Swift daemon does', async () => {
      core.wireTimeline();
      for (let i = 0; i < 140; i++) {
        core.bridgeTimeline.addEntry({
          ts: 1000 + i,
          type: 'chat_response',
          raw: `reply-${i}-${'x'.repeat(900)}`,
        });
      }

      core.wsServer.onClientConnect((ws) => {
        core.sendInitialState(ws, {
          agentType: 'claude-code',
          isAlive: true,
        });
      });

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        const historyEvt = await client.waitForType('timeline_history');
        const entries = (historyEvt as any).entries as Array<{ raw: string }>;
        expect(Buffer.byteLength(JSON.stringify(historyEvt), 'utf8')).toBeLessThanOrEqual(
          INITIAL_TIMELINE_HISTORY_MAX_BYTES,
        );
        expect(entries.length).toBe(INITIAL_TIMELINE_HISTORY_ENTRIES);
        expect(entries.at(-1)?.raw).toContain('reply-139-');
      } finally {
        await client.close();
      }
    });

    it('keeps an untagged board on the board frame limit from its first connect', async () => {
      core.wireTimeline();
      for (let i = 0; i < 40; i++) {
        core.bridgeTimeline.addEntry({ ts: 1000 + i, type: 'chat_response', raw: `reply-${i}-${'x'.repeat(900)}` });
      }
      core.wsServer.onClientConnect((ws) => {
        core.sendInitialState(ws, { agentType: 'claude-code', isAlive: true });
      });

      const board = new WsTestClient();
      await board.connect(`ws://127.0.0.1:${port}`, { 'User-Agent': 'arduino-WebSocket-Client' });

      try {
        const historyEvt = await board.waitForType('timeline_history');
        expect(Buffer.byteLength(JSON.stringify(historyEvt), 'utf8')).toBeLessThanOrEqual(
          ESP32_INITIAL_TIMELINE_HISTORY_MAX_BYTES,
        );
      } finally {
        await board.close();
      }
    });

    it('filters unreadable rows before the byte cap, not after', async () => {
      core.wireTimeline();
      core.bridgeTimeline.addEntry({ ts: 500, type: 'chat_end', raw: 'Finished the migration' });
      // Newest rows are tool noise big enough to spend the whole budget.
      for (let i = 0; i < 40; i++) {
        core.bridgeTimeline.addEntry({
          ts: 1000 + i,
          type: 'tool_request',
          raw: `tool-${i}-${'x'.repeat(900)}`,
          toolEvent: true,
        } as any);
      }
      core.setConnectHistoryFilter((_ws, entries) =>
        entries.filter((entry) => entry.toolEvent !== true));
      core.wsServer.onClientConnect((ws) => {
        core.sendInitialState(ws, { agentType: 'claude-code', isAlive: true });
      });

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        const historyEvt = await client.waitForType('timeline_history');
        const entries = (historyEvt as any).entries as Array<{ raw: string }>;
        expect(entries.map((e) => e.raw)).toEqual(['Finished the migration']);
      } finally {
        await client.close();
      }
    });
  });

  // ─── State change → broadcast ─────────────────────────────────────

  describe('state change broadcast', () => {
    it('state_changed emits to WS clients when wired by caller', async () => {
      // This simulates what index.ts does: wire state_changed → broadcast
      core.stateMachine.on('state_changed', () => {
        const evt = core.buildStateEvent({ agentType: 'claude-code' });
        core.broadcast(evt);
      });

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        core.stateMachine.handleHookEvent('SessionStart', {});

        const evt = await client.waitForType('state_update') as StateUpdateEvent;
        expect(evt.state).toBe(State.IDLE);
        expect(evt.projectName).toBe('TestProject');
      } finally {
        await client.close();
      }
    });
  });

  // ─── Timeline wiring ─────────────────────────────────────────────

  describe('wireTimeline', () => {
    it('timeline entries broadcast as timeline_event', async () => {
      core.wireTimeline();

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        await new Promise((r) => setTimeout(r, 50));

        core.bridgeTimeline.addEntry({ ts: 100, type: 'tool_request', raw: 'Read /foo.ts' });

        const evt = await client.waitForType('timeline_event');
        expect((evt as any).entry.type).toBe('tool_request');
        expect((evt as any).entry.raw).toBe('Read /foo.ts');
      } finally {
        await client.close();
      }
    });
  });

  // ─── Polling guards ───────────────────────────────────────────────

  describe('hasClients guard', () => {
    it('wsServer.getClientCount reflects connected clients', async () => {
      expect(core.wsServer.getClientCount()).toBe(0);

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);
      await new Promise((r) => setTimeout(r, 50));

      expect(core.wsServer.getClientCount()).toBe(1);

      await client.close();
      await new Promise((r) => setTimeout(r, 200));

      expect(core.wsServer.getClientCount()).toBe(0);
    });

    it('external client count provider extends hasClients', () => {
      let externalCount = 0;
      core.setExternalClientCountProvider(() => externalCount);

      // No clients at all
      expect(core.wsServer.getClientCount()).toBe(0);

      // Simulate ESP32 serial connection
      externalCount = 1;
      // hasClients is private, but we can test indirectly through polling behavior
      // For now just verify the provider is callable
      expect(externalCount).toBe(1);
    });
  });

  // ─── Voice assistant state ────────────────────────────────────────

  describe('voice assistant state', () => {
    it('updateVoiceAssistantState caches and triggers state broadcast', async () => {
      core.stateMachine.on('state_changed', () => {
        const evt = core.buildStateEvent({ agentType: 'claude-code' });
        core.broadcast(evt);
      });

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        await new Promise((r) => setTimeout(r, 50));

        core.updateVoiceAssistantState('listening', 'hello world');

        const evt = await client.waitForType('state_update') as StateUpdateEvent;
        expect(evt.voiceAssistantState).toBe('listening');
        expect(evt.voiceAssistantText).toBe('hello world');
      } finally {
        await client.close();
      }
    });

    it('disabled voice assistant state is not included in event', () => {
      core.cachedVoiceAssistantState = 'disabled';

      const evt = core.buildStateEvent({ agentType: 'claude-code' }) as StateUpdateEvent;
      expect(evt.voiceAssistantState).toBeUndefined();
    });
  });

  // ─── Session registry integration ─────────────────────────────────

  describe('session registry', () => {
    it('registerSession writes to sessions.json', async () => {
      core.registerSession('claude-code');

      const { listActive } = await import('../session-registry.js');
      const sessions = listActive();
      const ours = sessions.find((s) => s.id === core.sessionId);
      expect(ours).toBeDefined();
      expect(ours!.port).toBe(port);
      expect(ours!.projectName).toBe('TestProject');
      expect(ours!.agentType).toBe('claude-code');
    });

    it('deregisterSession removes from sessions.json', async () => {
      core.registerSession('claude-code');
      core.deregisterSession();

      const { listActive } = await import('../session-registry.js');
      const sessions = listActive();
      const ours = sessions.find((s) => s.id === core.sessionId);
      expect(ours).toBeUndefined();
    });
  });

  // ─── Broadcast to multiple consumers ──────────────────────────────

  describe('broadcast coordination', () => {
    it('broadcast sends to WS and SSE callback', async () => {
      const sseEvents: BridgeEvent[] = [];
      core.setSseBroadcast((evt) => sseEvents.push(evt));

      const client = new WsTestClient();
      await client.connect(`ws://127.0.0.1:${port}`);

      try {
        await new Promise((r) => setTimeout(r, 50));

        const evt: BridgeEvent = { type: 'display_state', displayOn: true };
        core.broadcast(evt);

        const wsEvt = await client.waitForType('display_state');
        expect((wsEvt as any).displayOn).toBe(true);

        expect(sseEvents).toHaveLength(1);
        expect((sseEvents[0] as any).displayOn).toBe(true);
      } finally {
        await client.close();
      }
    });
  });
});
