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

  it('broadcasts and clears the separate Dot snapshot without creating a session', async () => {
    mockBuildEnrichedSessionsList.mockResolvedValue([]);
    let dot: import('@agentdeck/shared').DotDeckSnapshot | null = { configured: true, hosting: false, reportState: null, reportedAt: null, expiresAt: null };
    core.setDotDeckProvider(() => dot);
    await core.broadcastSessionsList();
    expect(core.getLastSessionsListEvent()).toMatchObject({ dot, sessions: [] });
    dot = null; await core.broadcastSessionsList();
    expect(core.getLastSessionsListEvent()).toMatchObject({ dot: null, sessions: [] });
  });

  it('broadcasts both independent Desktop chats with their own state and controls', async () => {
    const rows = [
      { id: 'observed:codex-app:11111111-1111-4111-8111-111111111111', port: 0,
        projectName: 'AgentDeck', agentType: 'codex-app' as const, alive: true, state: 'awaiting_permission',
        question: 'Approve only this session', requestId: 'own-approval', currentTool: 'Bash' },
      { id: 'observed:codex-app:22222222-2222-4222-8222-222222222222', port: 0,
        projectName: 'AgentDeck', agentType: 'codex-app' as const, alive: true, state: 'processing',
        currentTool: 'other-tool' },
    ];
    mockBuildEnrichedSessionsList.mockResolvedValue(rows);
    const broadcast = vi.spyOn(core.wsServer, 'broadcast').mockImplementation(() => {});
    await core.broadcastSessionsList();
    const frame = core.getLastSessionsListEvent();
    expect(frame?.sessions).toHaveLength(2);
    expect(frame?.sessions).toEqual(expect.arrayContaining(rows.map(row => expect.objectContaining(row))));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'sessions_list', sessions: frame?.sessions }));
    expect((await core.buildSessionsSnapshot()).map(row => row.id).sort()).toEqual(rows.map(row => row.id).sort());
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

  it('preserves same-project independent Codex App chats in the canonical snapshot', async () => {
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

    expect(sessions).toHaveLength(2);
    expect(sessions.find(row => row.id === 'observed:codex-app:working')).toMatchObject({
      id: 'observed:codex-app:working',
      state: 'processing',
    });
    expect(sessions.find(row => row.id === 'observed:codex-app:old')).toMatchObject({ state: 'idle' });
    expect(sessions.every(row => row.groupSize == null && row.foldedSessionIds == null)).toBe(true);
  });

  it("caches a connecting client's roster, so ids it shows resolve before the next broadcast", async () => {
    mockBuildEnrichedSessionsList.mockResolvedValue([
      { id: 'observed:codex:e2eb0a4d-5f0e-4c6b-9d1a-7e2f40c0ffee', port: 0, projectName: 'Board', alive: true, state: 'idle', agentType: 'codex-cli' },
    ]);
    vi.spyOn(core.wsServer, 'sendTo').mockImplementation(() => {});
    core.sendInitialState({ readyState: 1, send: vi.fn() } as any, { agentType: 'claude-code', isAlive: true });
    await vi.waitFor(() => {
      expect((core.getLastSessionsListEvent() as any)?.sessions?.map((s: { id: string }) => s.id))
        .toContain('observed:codex:e2eb0a4d-5f0e-4c6b-9d1a-7e2f40c0ffee');
    });
  });

  it('keeps the newest-started roster when an older snapshot finishes last', async () => {
    let finishOld!: (rows: any[]) => void;
    mockBuildEnrichedSessionsList
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce([{ id: 'new-session', port: 0, projectName: 'New', alive: true, state: 'idle', agentType: 'claude-code' }]);
    vi.spyOn(core.wsServer, 'broadcast').mockImplementation(() => {});
    vi.spyOn(core.wsServer, 'sendTo').mockImplementation(() => {});
    const older = core.broadcastSessionsList();
    core.sendInitialState({ readyState: 1, send: vi.fn() } as any, { agentType: 'claude-code', isAlive: true });
    await vi.waitFor(() => expect((core.getLastSessionsListEvent() as any)?.sessions?.[0]?.id).toBe('new-session'));
    finishOld([{ id: 'old-session', port: 0, projectName: 'Old', alive: true, state: 'idle', agentType: 'claude-code' }]);
    await older;
    expect((core.getLastSessionsListEvent() as any).sessions.map((s: { id: string }) => s.id)).toEqual(['new-session']);
  });

  it('still caches an older roster when the newest build fails', async () => {
    let finishOld!: (rows: any[]) => void;
    mockBuildEnrichedSessionsList
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockRejectedValueOnce(new Error('enricher threw'));
    vi.spyOn(core.wsServer, 'broadcast').mockImplementation(() => {});
    vi.spyOn(core.wsServer, 'sendTo').mockImplementation(() => {});
    const older = core.broadcastSessionsList();
    core.sendInitialState({ readyState: 1, send: vi.fn() } as any, { agentType: 'claude-code', isAlive: true });
    await vi.waitFor(() => expect(mockBuildEnrichedSessionsList).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishOld([{ id: 'old-session', port: 0, projectName: 'Old', alive: true, state: 'idle', agentType: 'claude-code' }]);
    await older;
    expect((core.getLastSessionsListEvent() as any)?.sessions?.map((s: { id: string }) => s.id)).toEqual(['old-session']);
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
