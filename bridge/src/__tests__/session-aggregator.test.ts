import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enrichSessionsWithState, buildEnrichedSessionsList, clearSiblingStateCache } from '../session-aggregator.js';
import type { SessionEntry } from '../session-registry.js';

vi.mock('../session-registry.js', () => ({
  listActive: vi.fn(() => []),
}));

import { listActive } from '../session-registry.js';

const mockListActive = vi.mocked(listActive);

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'session-1',
    port: 9121,
    pid: process.pid,
    projectName: 'AgentDeck',
    startedAt: new Date().toISOString(),
    agentType: 'claude-code',
    ...overrides,
  };
}

describe('session-aggregator', () => {
  beforeEach(() => {
    mockListActive.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses ownState for the current session without fetching /health', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'own-session', port: 9125 })],
      'own-session',
      'processing',
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'own-session',
        port: 9125,
        projectName: 'AgentDeck',
        agentType: 'claude-code',
        alive: true,
        state: 'processing',
      }),
    ]);
  });

  it('fetches sibling /health and merges state and modelName', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ state: 'idle', modelName: 'opus-4' }),
    } as Response);

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9130, projectName: 'Backend' })],
      'own-session',
      'processing',
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9130/health',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'sibling',
        port: 9130,
        projectName: 'Backend',
        state: 'idle',
        modelName: 'opus-4',
      }),
    ]);
  });

  it('falls back to base session info when sibling /health fails (no cache)', async () => {
    clearSiblingStateCache('sibling');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect failed'));

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131, agentType: 'codex-cli' })],
      'own-session',
      'processing',
    );

    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'sibling',
        port: 9131,
        projectName: 'AgentDeck',
        alive: true,
        agentType: 'codex-cli',
      }),
    ]);
    expect(sessions[0].state).toBeUndefined();
  });

  it('returns cached state when sibling /health fails after a previous success', async () => {
    clearSiblingStateCache('sibling');
    // First call succeeds — populates cache
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      json: async () => ({ state: 'processing', modelName: 'gpt-5.4' }),
    } as Response);

    await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131 })],
      'own-session',
      'idle',
    );

    // Second call fails — should use cached state
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('timeout'));

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131 })],
      'own-session',
      'idle',
    );

    expect(sessions[0]).toEqual(expect.objectContaining({
      id: 'sibling',
      state: 'processing',
      modelName: 'gpt-5.4',
    }));
  });

  it('clearSiblingStateCache removes cached entry', async () => {
    // Populate cache
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      json: async () => ({ state: 'idle', modelName: 'opus-4' }),
    } as Response);

    await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131 })],
      'own-session',
      'idle',
    );

    // Clear cache then fail — should get undefined state
    clearSiblingStateCache('sibling');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('timeout'));

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131 })],
      'own-session',
      'idle',
    );

    expect(sessions[0].state).toBeUndefined();
  });

  it('buildEnrichedSessionsList includes own session and excludes daemon', async () => {
    mockListActive.mockReturnValue([
      makeSession({ id: 'own-session', port: 9121, projectName: 'Main' }),
      makeSession({ id: 'daemon-1', port: 9120, projectName: 'Daemon', agentType: 'daemon' }),
      makeSession({ id: 'sibling-1', port: 9122, projectName: 'Backend' }),
      makeSession({ id: 'sibling-2', port: 9123, projectName: 'Frontend', agentType: 'codex-cli' }),
    ]);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(':9122/health')) {
        return { json: async () => ({ state: 'processing', modelName: 'opus-4' }) } as Response;
      }
      if (url.includes(':9123/health')) {
        return { json: async () => ({ state: 'idle', modelName: 'gpt-5.4' }) } as Response;
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const sessions = await buildEnrichedSessionsList('own-session', 'awaiting_option', 'opus-4', 'high');

    // Order from sortSessions: claude-code group sorted by projectName (Backend, Main)
    // then codex-cli group (Frontend). Daemon excluded.
    expect(sessions).toHaveLength(3);
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'sibling-1',
        projectName: 'Backend',
        state: 'processing',
        modelName: 'opus-4',
      }),
      expect.objectContaining({
        id: 'own-session',
        projectName: 'Main',
        state: 'awaiting_option',
        modelName: 'opus-4',
        effortLevel: 'high',
      }),
      expect.objectContaining({
        id: 'sibling-2',
        projectName: 'Frontend',
        state: 'idle',
        modelName: 'gpt-5.4',
        agentType: 'codex-cli',
      }),
    ]);
  });

  it('buildEnrichedSessionsList returns own session in single-session mode without /health calls', async () => {
    // single-session mode: only the own session is registered (no daemon, no siblings).
    // This is the `agentdeck claude` standalone case where session-slot buttons would
    // otherwise stay "Empty" because the aggregator returned [].
    mockListActive.mockReturnValue([
      makeSession({ id: 'own-session', port: 9121, projectName: 'Solo' }),
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const sessions = await buildEnrichedSessionsList('own-session', 'idle', 'opus-4');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(expect.objectContaining({
      id: 'own-session',
      projectName: 'Solo',
      state: 'idle',
      modelName: 'opus-4',
    }));
  });
});
