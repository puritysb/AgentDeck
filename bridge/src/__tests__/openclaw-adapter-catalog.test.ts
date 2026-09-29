/**
 * The adapter's catalog wiring: RPC first, CLI fallback, retry ladder, and
 * the generation token that keeps a fetch from a dead link from overwriting
 * the fresh one (the review-found race: fast reconnect → new fetch succeeds
 * → the old, slower CLI fallback resolves later and re-emits a stale list).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cli = vi.hoisted(() => ({
  fetchModelCatalog: vi.fn(),
  getDefaultModelName: vi.fn(),
  invalidateModelCache: vi.fn(),
}));
vi.mock('../model-catalog.js', () => cli);
vi.mock('../logger.js', () => ({ debug: vi.fn(), log: vi.fn(), logError: vi.fn() }));

import { OpenClawAdapter } from '../adapters/openclaw.js';
import type { AdapterEvent } from '@agentdeck/shared';

type Priv = {
  alive: boolean;
  catalogGeneration: number;
  gatewayMethods: Set<string> | null;
  catalogRetryTimer: unknown;
  catalogAttempt: number;
  rpcCall: (method: string, params: unknown) => Promise<unknown>;
  emitModelCatalog: () => Promise<void>;
  invalidateCatalogFetch: () => void;
};

const LIVE_PAYLOAD = { models: [
  { id: 'glm-5.3', name: 'GLM-5.3 (1M)', provider: 'zai', tags: ['default'], available: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', provider: 'zai', tags: ['fallback#1'], available: true },
] };

function makeAdapter(): { adapter: OpenClawAdapter; priv: Priv; events: AdapterEvent[] } {
  const adapter = new OpenClawAdapter({ autoReconnect: false });
  const priv = adapter as unknown as Priv;
  priv.alive = true;
  const events: AdapterEvent[] = [];
  adapter.on('event', (evt: AdapterEvent) => {
    if ((evt.source === 'metadata' && evt.event === 'model_catalog') || (evt.source === 'parser' && evt.event === 'model_info')) events.push(evt);
  });
  return { adapter, priv, events };
}

const catalogEvents = (events: AdapterEvent[]) => events.filter((e) => e.event === 'model_catalog');

describe('OpenClawAdapter catalog fetch', () => {
  beforeEach(() => {
    cli.fetchModelCatalog.mockReset();
    cli.getDefaultModelName.mockReset();
    cli.fetchModelCatalog.mockResolvedValue(null);
    cli.getDefaultModelName.mockResolvedValue(null);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reads models.list over the socket first and emits the joined keys plus the default model', async () => {
    const { priv, events } = makeAdapter();
    priv.rpcCall = vi.fn(async (method: string) => { expect(method).toBe('models.list'); return LIVE_PAYLOAD; });
    await priv.emitModelCatalog();
    expect(cli.fetchModelCatalog).not.toHaveBeenCalled();
    expect(events.map((e) => e.event)).toEqual(['model_info', 'model_catalog']);
    expect(events[0].data).toMatchObject({ model: 'GLM-5.3 (1M)' });
    expect((events[1].data as { models: Array<{ key: string }> }).models.map((m) => m.key))
      .toEqual(['zai/glm-5.3', 'zai/glm-5.3-flash']);
    expect(priv.catalogRetryTimer).toBeNull();
  });

  it('a Gateway that advertised its methods without models.list is not asked; the CLI answers instead', async () => {
    const { priv, events } = makeAdapter();
    priv.gatewayMethods = new Set(['health', 'sessions.list']);
    priv.rpcCall = vi.fn();
    cli.fetchModelCatalog.mockResolvedValue({ entries: [{ key: 'zai/glm-5.3', name: 'GLM-5.3 (1M)', role: 'default', available: true }], raw: [] });
    cli.getDefaultModelName.mockResolvedValue('GLM-5.3 (1M)');
    await priv.emitModelCatalog();
    expect(priv.rpcCall).not.toHaveBeenCalled();
    expect(catalogEvents(events)).toHaveLength(1);
  });

  it('a fetch that started before the link dropped emits nothing, even if it resolves after a reconnect', async () => {
    const { priv, events } = makeAdapter();
    let release!: (v: unknown) => void;
    priv.rpcCall = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const inFlight = priv.emitModelCatalog();
    // Link lost → reconnected: the close handler and the handshake both move
    // the generation; the fetch below belongs to the old link.
    priv.invalidateCatalogFetch();
    priv.catalogGeneration += 1;
    release(LIVE_PAYLOAD);
    await inFlight;
    expect(catalogEvents(events)).toHaveLength(0);
    expect(priv.catalogRetryTimer).toBeNull();
  });

  it('a stale FAILURE schedules no retry on the new link either', async () => {
    const { priv } = makeAdapter();
    let fail!: (e: Error) => void;
    priv.rpcCall = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const inFlight = priv.emitModelCatalog();
    priv.invalidateCatalogFetch();
    fail(new Error('socket closed'));
    await inFlight;
    expect(priv.catalogRetryTimer).toBeNull();
    expect(priv.catalogAttempt).toBe(0);
  });

  it('shutdown mid-fetch: a CLI fallback that resolves after shutdown emits nothing', async () => {
    const { adapter, priv, events } = makeAdapter();
    priv.rpcCall = vi.fn(async () => { throw new Error('Adapter shutting down'); });
    let releaseCli!: (v: unknown) => void;
    cli.fetchModelCatalog.mockImplementation(() => new Promise((resolve) => { releaseCli = resolve; }));
    const inFlight = priv.emitModelCatalog();
    await Promise.resolve(); // let the RPC rejection fall through to the CLI fallback
    await adapter.shutdown();
    // The subprocess has its own clock and answers well after shutdown.
    releaseCli({ entries: [{ key: 'zai/glm-5.3', name: 'GLM-5.3 (1M)', role: 'default', available: true }], raw: [] });
    cli.getDefaultModelName.mockResolvedValue('GLM-5.3 (1M)');
    await inFlight;
    expect(catalogEvents(events)).toHaveLength(0);
    expect(events.filter((e) => e.event === 'model_info')).toHaveLength(0);
    expect(priv.catalogRetryTimer).toBeNull();
  });

  it('climbs the retry ladder while both sources fail, then emits and resets on the first success', async () => {
    vi.useFakeTimers();
    const { priv, events } = makeAdapter();
    let rpcOk = false;
    priv.rpcCall = vi.fn(async () => { if (!rpcOk) throw new Error('RPC timeout: models.list'); return LIVE_PAYLOAD; });

    await priv.emitModelCatalog();
    expect(priv.catalogAttempt).toBe(1);
    expect(priv.catalogRetryTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);   // rung 1 fires → still failing
    expect(priv.catalogAttempt).toBe(2);
    expect(catalogEvents(events)).toHaveLength(0);

    rpcOk = true;
    await vi.advanceTimersByTimeAsync(30_000);   // rung 2 fires → succeeds
    expect(catalogEvents(events)).toHaveLength(1);
    expect(priv.catalogAttempt).toBe(0);
    expect(priv.catalogRetryTimer).toBeNull();
  });

  it('stops retrying once the adapter is no longer alive', async () => {
    vi.useFakeTimers();
    const { priv, events } = makeAdapter();
    priv.rpcCall = vi.fn(async () => { throw new Error('nope'); });
    await priv.emitModelCatalog();
    expect(priv.catalogRetryTimer).not.toBeNull();
    priv.alive = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(priv.catalogRetryTimer).toBeNull();
    expect(catalogEvents(events)).toHaveLength(0);
  });
});
