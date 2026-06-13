/**
 * Integration test: HookServer + WsServer + StateMachine
 *
 * Spins up real HTTP/WS servers on ephemeral ports.
 * Tests the full hook event → state transition → WS broadcast pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HookServer } from '../hook-server.js';
import { WsServer } from '../ws-server.js';
import { StateMachine } from '../state-machine.js';
import { UsageTracker } from '../usage-tracker.js';
import { WsTestClient } from './helpers/ws-test-client.js';
import type { StateUpdateEvent } from '../types.js';
import { State } from '@agentdeck/shared';

/** POST JSON to the hook server */
async function postHook(port: number, eventName: string, data: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hooks/${eventName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

/** GET from the hook server */
async function getEndpoint(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

describe('Server Integration', () => {
  let hookServer: HookServer;
  let wsServer: WsServer;
  let sm: StateMachine;
  let usageTracker: UsageTracker;
  let port: number;
  let wsClient: WsTestClient;

  beforeEach(async () => {
    usageTracker = new UsageTracker();
    sm = new StateMachine(usageTracker);
    hookServer = new HookServer();

    // Wire hook events to state machine
    hookServer.on('hook', ({ event, data }: { event: string; data: Record<string, unknown> }) => {
      sm.handleHookEvent(event, data);
    });

    // Listen on port 0 (OS assigns ephemeral port)
    await hookServer.listen(0);
    const addr = hookServer.getServer().address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    // Create WS server on the same HTTP server
    wsServer = new WsServer(hookServer.getServer());

    // Wire state changes to WS broadcast
    sm.on('state_changed', (snapshot) => {
      const event: StateUpdateEvent = {
        type: 'state_update',
        state: snapshot.state,
        permissionMode: snapshot.permissionMode,
        currentTool: snapshot.currentTool ?? undefined,
        toolInput: snapshot.toolInput ?? undefined,
        projectName: snapshot.projectName ?? undefined,
        modelName: snapshot.modelName ?? undefined,
        options: snapshot.options,
        question: snapshot.question ?? undefined,
        navigable: snapshot.navigable,
        cursorIndex: snapshot.cursorIndex,
        suggestedPrompt: snapshot.suggestedPrompt ?? undefined,
      };
      wsServer.broadcast(event);
      hookServer.broadcastSse(event);
    });

    // Connect WS test client
    wsClient = new WsTestClient();
    await wsClient.connect(`ws://127.0.0.1:${port}`);
  });

  afterEach(async () => {
    await wsClient.close();
    wsServer.close();
    await hookServer.close();
  });

  // ─── Hook → State → WS broadcast ─────────────────────────────────

  it('SessionStart hook → IDLE state broadcast', async () => {
    await postHook(port, 'SessionStart');

    const evt = await wsClient.waitForType('state_update') as StateUpdateEvent;
    expect(evt.state).toBe(State.IDLE);
  });

  it('PreToolUse responds 200 with an EMPTY body (managed sessions must not gate)', async () => {
    // The hook script echoes this body to Claude's stdout; any JSON here would
    // be parsed as a hookSpecificOutput permission decision. Managed sessions
    // own a PTY for prompts, so the body must stay empty.
    const res = await postHook(port, 'PreToolUse', { tool_name: 'Bash' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('non-PreToolUse hooks still ack with { received: true }', async () => {
    const res = await postHook(port, 'PostToolUse', { tool_name: 'Bash' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('full session lifecycle: SessionStart → UserPromptSubmit → Stop', async () => {
    await postHook(port, 'SessionStart');
    const idleEvt = await wsClient.waitForType('state_update') as StateUpdateEvent;
    expect(idleEvt.state).toBe(State.IDLE);

    wsClient.clear();
    await postHook(port, 'UserPromptSubmit');
    const processingEvt = await wsClient.waitForType('state_update') as StateUpdateEvent;
    expect(processingEvt.state).toBe(State.PROCESSING);

    wsClient.clear();
    await postHook(port, 'Stop');
    const stopEvt = await wsClient.waitForType('state_update') as StateUpdateEvent;
    expect(stopEvt.state).toBe(State.IDLE);
  });

  it('PreToolUse → PostToolUse cycle broadcasts tool info', async () => {
    await postHook(port, 'SessionStart');
    await wsClient.waitFor((e) => e.type === 'state_update' && (e as StateUpdateEvent).state === State.IDLE);

    wsClient.clear();
    await postHook(port, 'UserPromptSubmit');
    await wsClient.waitFor((e) => e.type === 'state_update' && (e as StateUpdateEvent).state === State.PROCESSING);

    wsClient.clear();
    await postHook(port, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/foo/bar.ts' } });
    const toolEvt = await wsClient.waitForType('state_update') as StateUpdateEvent;
    expect(toolEvt.currentTool).toBe('Read');
    expect(toolEvt.toolInput).toContain('/foo/bar.ts');

    wsClient.clear();
    await postHook(port, 'PostToolUse', { tool_name: 'Read', input_tokens: 100, output_tokens: 50 });
    const afterTool = await wsClient.waitForType('state_update') as StateUpdateEvent;
    expect(afterTool.currentTool).toBeUndefined();
  });

  it('SessionEnd → DISCONNECTED', async () => {
    await postHook(port, 'SessionStart');
    await wsClient.waitFor((e) => e.type === 'state_update' && (e as StateUpdateEvent).state === State.IDLE);

    wsClient.clear();
    await postHook(port, 'SessionEnd');
    const evt = await wsClient.waitForType('state_update') as StateUpdateEvent;
    expect(evt.state).toBe(State.DISCONNECTED);
  });

  // ─── HTTP endpoints ───────────────────────────────────────────────

  it('GET /health returns valid JSON', async () => {
    hookServer.setMeta({ agentType: 'claude-code', projectName: 'test-project', state: 'idle' });

    const res = await getEndpoint(port, '/health');
    expect(res.status).toBe(200);

    const json = await res.json() as any;
    expect(json.status).toBe('ok');
    expect(json.agentType).toBe('claude-code');
    expect(json.projectName).toBe('test-project');
    expect(typeof json.uptime).toBe('number');
  });

  it('GET /usage returns data when getter is set', async () => {
    const mockUsage = { fiveHourPercent: 42, sevenDayPercent: 15 };
    hookServer.onApiUsage(() => ({ usage: mockUsage, fetchedAt: Date.now() }));

    const res = await getEndpoint(port, '/usage');
    const json = await res.json() as any;
    expect(json.status).toBe('ok');
    expect(json.usage).toEqual(mockUsage);
    expect(json.fetchedAt).toBeGreaterThan(0);
  });

  it('GET /usage returns null when no getter', async () => {
    const res = await getEndpoint(port, '/usage');
    const json = await res.json() as any;
    expect(json.usage).toBeNull();
  });

  it('GET /devices returns empty when no getter', async () => {
    const res = await getEndpoint(port, '/devices');
    const json = await res.json() as any;
    expect(json.devices).toEqual([]);
  });

  it('POST to unknown route returns 404', async () => {
    const res = await getEndpoint(port, '/nonexistent');
    expect(res.status).toBe(404);
  });

  it('hook endpoint responds immediately', async () => {
    const start = Date.now();
    const res = await postHook(port, 'SessionStart');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.received).toBe(true);
    // Hook should respond quickly (< 100ms local)
    expect(elapsed).toBeLessThan(500);
  });

  // ─── SSE ──────────────────────────────────────────────────────────

  it('SSE client receives state_update events', async () => {
    const events: string[] = [];

    // Connect SSE client
    const ssePromise = new Promise<void>((resolve) => {
      const controller = new AbortController();
      fetch(`http://127.0.0.1:${port}/sse`, { signal: controller.signal })
        .then(async (res) => {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value);
              if (text.includes('event: state_update')) {
                events.push('state_update');
                if (events.length >= 1) {
                  controller.abort();
                  resolve();
                }
              }
            }
          } catch {
            // AbortError expected
            resolve();
          }
        })
        .catch(() => resolve());
    });

    // Wait a tick for SSE to connect
    await new Promise((r) => setTimeout(r, 50));

    // Trigger state change
    await postHook(port, 'SessionStart');

    await Promise.race([
      ssePromise,
      new Promise((r) => setTimeout(r, 2000)),
    ]);

    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Multiple WS clients ─────────────────────────────────────────

  it('broadcasts to multiple WS clients', async () => {
    const client2 = new WsTestClient();
    await client2.connect(`ws://127.0.0.1:${port}`);

    try {
      await postHook(port, 'SessionStart');

      const [evt1, evt2] = await Promise.all([
        wsClient.waitForType('state_update'),
        client2.waitForType('state_update'),
      ]);

      expect((evt1 as StateUpdateEvent).state).toBe(State.IDLE);
      expect((evt2 as StateUpdateEvent).state).toBe(State.IDLE);
    } finally {
      await client2.close();
    }
  });

  // ─── WS command handling ──────────────────────────────────────────

  it('WS command from client triggers callback', async () => {
    const commands: unknown[] = [];
    wsServer.onCommand((cmd) => commands.push(cmd));

    wsClient.send({ type: 'interrupt' } as any);

    // Wait for command to arrive
    await new Promise((r) => setTimeout(r, 100));
    expect(commands).toHaveLength(1);
    expect((commands[0] as any).type).toBe('interrupt');
  });

  // ─── Rapid events (race condition check) ──────────────────────────

  it('rapid hook events do not corrupt state', async () => {
    await postHook(port, 'SessionStart');
    await wsClient.waitFor((e) => e.type === 'state_update' && (e as StateUpdateEvent).state === State.IDLE);

    // Fire 10 rapid UserPromptSubmit → Stop cycles
    for (let i = 0; i < 10; i++) {
      await postHook(port, 'UserPromptSubmit');
      await postHook(port, 'Stop');
    }

    // Wait for events to settle
    await new Promise((r) => setTimeout(r, 200));

    // Final state should be IDLE
    expect(sm.getState()).toBe(State.IDLE);

    // Should have received state_update events
    const stateEvents = wsClient.getMessagesOfType<StateUpdateEvent>('state_update');
    expect(stateEvents.length).toBeGreaterThan(0);
  });

  // ─── Usage data propagation ───────────────────────────────────────

  it('token counts accumulate through hook events', async () => {
    await postHook(port, 'SessionStart');
    await wsClient.waitForType('state_update');

    await postHook(port, 'UserPromptSubmit');
    await postHook(port, 'PostToolUse', { tool_name: 'Read', input_tokens: 200, output_tokens: 100 });
    await postHook(port, 'PostToolUse', { tool_name: 'Edit', input_tokens: 300, output_tokens: 150 });

    // Check usage tracker accumulated correctly
    const snapshot = usageTracker.getSnapshot();
    expect(snapshot.inputTokens).toBe(500);
    expect(snapshot.outputTokens).toBe(250);
    expect(snapshot.toolCalls).toBe(2);
  });
});
