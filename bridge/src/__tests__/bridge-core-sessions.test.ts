import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import { BridgeCore } from '../bridge-core.js';
import { HookClaudeSessions } from '../hook-claude-sessions.js';
import { createTempDataDir, type TempDataDir } from './helpers/temp-data-dir.js';

vi.mock('../session-aggregator.js', () => ({
  buildEnrichedSessionsList: vi.fn(),
}));

import { buildEnrichedSessionsList } from '../session-aggregator.js';

const mockBuildEnrichedSessionsList = vi.mocked(buildEnrichedSessionsList);

describe('BridgeCore sessions_list', () => {
  let core: BridgeCore;
  let httpServer: ReturnType<typeof createServer>;
  let tempDir: TempDataDir;

  beforeEach(() => {
    tempDir = createTempDataDir();
    httpServer = createServer();
    core = new BridgeCore({
      port: 9121,
      projectName: 'TestProject',
      httpServer,
    });
    mockBuildEnrichedSessionsList.mockReset();
  });

  afterEach(() => {
    core.wsServer.close();
    core.displayMonitor.stop();
    httpServer.close();
    tempDir.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('broadcastSessionsList enriches sessions before broadcast', async () => {
    mockBuildEnrichedSessionsList.mockResolvedValue([
      {
        id: 'sibling-1',
        port: 9122,
        projectName: 'Backend',
        alive: true,
        state: 'idle',
        agentType: 'codex-cli',
        modelName: 'gpt-5.4',
      },
    ]);

    core.setSessionsEnricher((sessions) => sessions.map((session) => ({
      ...session,
      projectName: `${session.projectName} [visible]`,
    })));

    const broadcastSpy = vi.spyOn(core.wsServer, 'broadcast').mockImplementation(() => {});
    core.stateMachine.handleHookEvent('SessionStart', {});

    await core.broadcastSessionsList();

    expect(mockBuildEnrichedSessionsList).toHaveBeenCalledWith(core.sessionId, 'idle', undefined, undefined);
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: 'sessions_list',
      sessions: [
        expect.objectContaining({
          id: 'sibling-1',
          projectName: 'Backend [visible]',
          state: 'idle',
          modelName: 'gpt-5.4',
          agentType: 'codex-cli',
        }),
      ],
    });
  });

  it('delivers the final hook state within a broadcast window and shares it with feed snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.spyOn(core, 'hasClients').mockReturnValue(true);
    const tracker = new HookClaudeSessions();
    mockBuildEnrichedSessionsList.mockResolvedValue([{
      id: 'observed:claude:a', port: 0, projectName: 'P', alive: true,
      state: 'idle', agentType: 'claude-code',
    }]);
    core.setSessionsEnricher((sessions) => tracker.applyTo(sessions));
    const broadcast = vi.spyOn(core.wsServer, 'broadcast').mockImplementation(() => {});
    tracker.note('UserPromptSubmit', { session_id: 'a' });
    core.maybeBroadcastSessionsList();
    await vi.advanceTimersByTimeAsync(100);
    tracker.note('PreToolUse', { session_id: 'a', tool_use_id: 't', tool_name: 'Bash' });
    core.maybeBroadcastSessionsList();
    expect((await core.buildSessionsSnapshot())[0].currentTool).toBe('Bash');
    tracker.note('Stop', { session_id: 'a' });
    core.maybeBroadcastSessionsList();
    expect(broadcast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1900);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.lastCall?.[0]).toEqual({
      type: 'sessions_list', sessions: await core.buildSessionsSnapshot(),
    });
    expect((await core.buildSessionsSnapshot())[0]).toMatchObject({ state: 'idle', currentTool: undefined });
    tracker.note('SessionEnd', { session_id: 'a' });
    core.maybeBroadcastSessionsList();
    await vi.advanceTimersByTimeAsync(2000);
    expect(broadcast.mock.lastCall?.[0]).toEqual({ type: 'sessions_list', sessions: [] });
    await vi.advanceTimersByTimeAsync(4000);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it('folds same-project Codex App chats in the canonical snapshot', async () => {
    mockBuildEnrichedSessionsList.mockResolvedValue([
      {
        id: 'observed:codex-app:old',
        port: 0,
        projectName: 'AgentDeck',
        alive: true,
        state: 'idle',
        agentType: 'codex-app',
        startedAt: '2026-08-25T00:00:00.000Z',
      },
      {
        id: 'observed:codex-app:working',
        port: 0,
        projectName: 'AgentDeck',
        alive: true,
        state: 'processing',
        agentType: 'codex-app',
        startedAt: '2026-08-26T00:00:00.000Z',
      },
    ]);

    const sessions = await core.buildSessionsSnapshot();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'observed:codex-app:working',
      state: 'processing',
      groupSize: 2,
      foldedSessionIds: [
        'observed:codex-app:old',
        'observed:codex-app:working',
      ],
    });
  });

  it('sendInitialState sends enriched sessions_list to the connecting client', async () => {
    mockBuildEnrichedSessionsList.mockResolvedValue([
      {
        id: 'sibling-2',
        port: 9123,
        projectName: 'Frontend',
        alive: true,
        state: 'processing',
        agentType: 'claude-code',
        modelName: 'opus-4',
      },
    ]);

    core.setSessionsEnricher((sessions) => [
      ...sessions,
      {
        id: 'openclaw-gateway',
        port: 18789,
        projectName: 'OpenClaw',
        alive: true,
        state: 'idle',
        agentType: 'openclaw',
      },
    ]);

    const sentEvents: Array<Record<string, unknown>> = [];
    vi.spyOn(core.wsServer, 'sendTo').mockImplementation((_ws, evt) => {
      sentEvents.push(evt as Record<string, unknown>);
    });
    const ws = { readyState: 1, send: vi.fn() } as any;

    core.stateMachine.handleHookEvent('SessionStart', {});
    core.sendInitialState(ws, {
      agentType: 'claude-code',
      isAlive: true,
    });

    await vi.waitFor(() => {
      const sessionsEvent = sentEvents.find((evt) => evt.type === 'sessions_list');
      expect(sessionsEvent).toBeDefined();
      expect((sessionsEvent as any).sessions).toEqual([
        expect.objectContaining({
          id: 'openclaw-gateway',
          projectName: 'OpenClaw',
          agentType: 'openclaw',
          state: 'idle',
        }),
        expect.objectContaining({
          id: 'sibling-2',
          projectName: 'Frontend',
          state: 'processing',
          modelName: 'opus-4',
        }),
      ]);
    });

    expect(mockBuildEnrichedSessionsList).toHaveBeenCalledWith(core.sessionId, 'idle', undefined, undefined);
  });
});
