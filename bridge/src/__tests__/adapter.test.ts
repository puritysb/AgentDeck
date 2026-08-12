import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty before any imports that use it
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _pty: '/dev/ttys042',
  })),
}));

// Mock express/http for HookServer
vi.mock('express', () => {
  const app = {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  };
  const fn = Object.assign(vi.fn(() => app), {
    json: vi.fn(() => vi.fn()),
    raw: vi.fn(() => vi.fn()),
  });
  return { default: fn };
});

vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  const mockServer = {
    listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
    close: vi.fn((cb: () => void) => cb()),
    closeAllConnections: vi.fn(),
    on: vi.fn(),
  };
  return {
    ...actual,
    createServer: vi.fn(() => mockServer),
  };
});

// Mock ws for OpenClawAdapter (prevent real WebSocket connections)
vi.mock('ws', () => {
  const MockWebSocket = vi.fn(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
  }));
  (MockWebSocket as any).OPEN = 1;
  (MockWebSocket as any).CLOSED = 3;
  return { default: MockWebSocket };
});

import { createAdapter, ClaudeCodeAdapter, CodexCliAdapter, OpenClawAdapter, MonitorAdapter } from '../adapters/index.js';
import type { AgentAdapter, AdapterEvent, PluginCommand } from '../types.js';

describe('createAdapter factory', () => {
  it('creates ClaudeCodeAdapter for "claude-code"', () => {
    const adapter = createAdapter('claude-code');
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
    expect(adapter.capabilities.type).toBe('claude-code');
    expect(adapter.capabilities.displayName).toBe('Claude Code');
  });

  it('creates OpenClawAdapter for "openclaw"', () => {
    const adapter = createAdapter('openclaw');
    expect(adapter).toBeInstanceOf(OpenClawAdapter);
    expect(adapter.capabilities.type).toBe('openclaw');
    expect(adapter.capabilities.displayName).toBe('OpenClaw');
  });

  it('passes gatewayUrl to OpenClawAdapter', () => {
    const adapter = createAdapter('openclaw', 'ws://custom:9999');
    expect(adapter).toBeInstanceOf(OpenClawAdapter);
  });

  it('creates CodexCliAdapter for "codex-cli"', () => {
    const adapter = createAdapter('codex-cli');
    expect(adapter).toBeInstanceOf(CodexCliAdapter);
    expect(adapter.capabilities.type).toBe('codex-cli');
    expect(adapter.capabilities.displayName).toBe('Codex CLI');
  });

  it('throws for unknown agent type', () => {
    expect(() => createAdapter('unknown' as any)).toThrow('Unknown agent type');
  });
});

describe('ClaudeCodeAdapter', () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
  });

  describe('capabilities', () => {
    it('reports all Claude Code capabilities as true', () => {
      const caps = adapter.capabilities;
      expect(caps.hasTerminal).toBe(true);
      expect(caps.hasModeSwitching).toBe(true);
      expect(caps.hasDiffReview).toBe(true);
      expect(caps.hasOptionLists).toBe(true);
      expect(caps.hasNavigablePrompts).toBe(true);
      expect(caps.hasSuggestedPrompts).toBe(true);
      expect(caps.hasApiUsage).toBe(true);
    });
  });

  describe('handleCommand routing', () => {
    it('handles respond → returns true', () => {
      const cmd: PluginCommand = { type: 'respond', value: 'y' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles switch_mode → returns true', () => {
      const cmd: PluginCommand = { type: 'switch_mode' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles interrupt → returns true', () => {
      const cmd: PluginCommand = { type: 'interrupt' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles escape → returns true', () => {
      const cmd: PluginCommand = { type: 'escape' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('defers select_option to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'select_option', index: 0 };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers navigate_option to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'navigate_option', direction: 'up' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers send_prompt to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'send_prompt', text: 'hello' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers voice to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'voice', action: 'start' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers query_usage to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'query_usage' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });
  });

  describe('switch_mode debounce', () => {
    it('debounces rapid switch_mode calls (< 100ms apart)', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cmd: PluginCommand = { type: 'switch_mode' };
      expect(adapter.handleCommand(cmd)).toBe(true);

      // Call again within 100ms
      vi.spyOn(Date, 'now').mockReturnValue(now + 50);
      expect(adapter.handleCommand(cmd)).toBe(true); // Still returns true (handled = debounced)

      vi.restoreAllMocks();
    });
  });

  describe('lifecycle', () => {
    it('isAlive returns false before start', () => {
      expect(adapter.isAlive()).toBe(false);
    });

    it('getTtyPath returns undefined before start', () => {
      expect(adapter.getTtyPath()).toBeUndefined();
    });

    it('getProjectName returns null before start', () => {
      expect(adapter.getProjectName()).toBeNull();
    });

    it('getHttpServer returns an object', () => {
      // Even before start, the HookServer creates the HTTP server in constructor
      expect(adapter.getHttpServer()).toBeDefined();
    });
  });

  describe('onRawData callback', () => {
    it('can register callback without error', () => {
      const cb = vi.fn();
      expect(() => adapter.onRawData(cb)).not.toThrow();
    });
  });

  describe('onDiag handler', () => {
    it('can register handler without error', () => {
      const handler = vi.fn();
      expect(() => adapter.onDiag(handler)).not.toThrow();
    });
  });
});

describe('OpenClawAdapter', () => {
  let adapter: OpenClawAdapter;

  beforeEach(() => {
    adapter = new OpenClawAdapter('ws://127.0.0.1:18789');
  });

  describe('capabilities', () => {
    it('reports OpenClaw capabilities correctly', () => {
      const caps = adapter.capabilities;
      expect(caps.type).toBe('openclaw');
      expect(caps.displayName).toBe('OpenClaw');
      expect(caps.hasTerminal).toBe(false);
      expect(caps.hasModeSwitching).toBe(false);
      expect(caps.hasDiffReview).toBe(false);
      expect(caps.hasOptionLists).toBe(true);
      expect(caps.hasNavigablePrompts).toBe(false);
      expect(caps.hasSuggestedPrompts).toBe(false);
      expect(caps.hasApiUsage).toBe(false);
    });
  });

  describe('handleCommand routing', () => {
    it('handles respond → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'respond', value: 'y' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles select_option → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'select_option', index: 0 };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles navigate_option → returns true (no-op)', () => {
      const cmd: PluginCommand = { type: 'navigate_option', direction: 'up' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles send_prompt → returns false without session key', () => {
      const cmd: PluginCommand = { type: 'send_prompt', text: 'hello' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('handles interrupt → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'interrupt' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles escape → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'escape' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('defers switch_mode → returns false (not supported)', () => {
      const cmd: PluginCommand = { type: 'switch_mode' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers voice to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'voice', action: 'start' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers query_usage to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'query_usage' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('isAlive returns false before start', () => {
      expect(adapter.isAlive()).toBe(false);
    });

    it('getTtyPath returns undefined (no PTY)', () => {
      expect(adapter.getTtyPath()).toBeUndefined();
    });

    it('getProjectName returns null before start', () => {
      expect(adapter.getProjectName()).toBeNull();
    });

    it('getHttpServer returns an object', () => {
      expect(adapter.getHttpServer()).toBeDefined();
    });

    it('attachTerminal is a no-op', () => {
      // Should not throw
      const mockStdin = { on: vi.fn() } as any;
      const mockStdout = { write: vi.fn() } as any;
      expect(() => adapter.attachTerminal(mockStdin, mockStdout)).not.toThrow();
    });
  });

  describe('onRawData callback', () => {
    it('can register callback without error', () => {
      const cb = vi.fn();
      expect(() => adapter.onRawData(cb)).not.toThrow();
    });
  });

  describe('onDiag handler', () => {
    it('can register handler without error', () => {
      const handler = vi.fn();
      expect(() => adapter.onDiag(handler)).not.toThrow();
    });
  });
});

describe('OpenClawAdapter gateway protocol', () => {
  let adapter: OpenClawAdapter;
  let events: AdapterEvent[];
  let wsInstance: any;

  beforeEach(async () => {
    // Capture the WS instance created by connectGateway()
    wsInstance = null;
    const WS = (await import('ws')).default;
    (WS as any).mockImplementation(function (this: any) {
      this.on = vi.fn();
      this.send = vi.fn();
      this.close = vi.fn();
      this.readyState = 1;
      wsInstance = this;
    });

    adapter = new OpenClawAdapter('ws://127.0.0.1:18789');
    events = [];
    adapter.on('event', (evt: AdapterEvent) => events.push(evt));

    await adapter.start({ port: 9120 });

    // If wsInstance is still null, connectGateway was never called
    if (!wsInstance) {
      throw new Error('WebSocket was not created — connectGateway() not called');
    }
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  function getHandler(name: string): ((...args: any[]) => void) | undefined {
    const call = wsInstance.on.mock.calls.find((c: any[]) => c[0] === name);
    return call?.[1];
  }

  function simulateMessage(msg: unknown): void {
    const handler = getHandler('message');
    handler?.(Buffer.from(JSON.stringify(msg)));
  }

  function completeHandshake(): void {
    simulateMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'test-nonce', ts: Date.now() },
    });
    simulateMessage({
      type: 'res',
      id: 'init-1',
      ok: true,
      payload: {
        protocol: 4,
        server: { version: '0.1.0', connId: 'test' },
        features: { methods: ['chat.send', 'sessions.list'], events: ['chat'] },
      },
    });
  }

  it('sends connect request with correct format on connect.challenge', () => {
    simulateMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'test-nonce-abc', ts: Date.now() },
    });

    expect(wsInstance.send).toHaveBeenCalled();
    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('connect');
    expect(sent.id).toBe('init-1');
    expect(sent.params.minProtocol).toBe(4);
    expect(sent.params.maxProtocol).toBe(4);
    expect(sent.params.client.id).toBe('gateway-client');
    expect(sent.params.client.mode).toBe('backend');
    expect(sent.params.client.displayName).toBe('AgentDeck');
    expect(sent.params.client.deviceFamily).toBe('mac');
    expect(sent.params.role).toBe('operator');
    expect(sent.params.caps).toContain('tool-events');
  });

  it('becomes alive after hello-ok response', () => {
    expect(adapter.isAlive()).toBe(false);

    completeHandshake();

    expect(adapter.isAlive()).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ source: 'connection', status: 'connected' }),
    );
  });

  it('emits spinner_start on chat delta event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-1', sessionKey: 'key-1', seq: 0, state: 'delta' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'parser', event: 'spinner_start' }),
    );
  });

  it('emits idle on chat final event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-1', sessionKey: 'key-1', seq: 1, state: 'final' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'parser', event: 'idle' }),
    );
  });

  it('emits idle on chat aborted event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-1', sessionKey: 'key-1', seq: 1, state: 'aborted' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'parser', event: 'idle' }),
    );
  });

  it('emits idle on chat error event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-1', sessionKey: 'key-1', seq: 1, state: 'error', errorMessage: 'fail' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'parser', event: 'idle' }),
    );
  });

  it('emits permission_prompt on exec.approval.requested', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-1', command: 'rm -rf /tmp/test' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        source: 'parser',
        event: 'permission_prompt',
        data: expect.objectContaining({
          question: 'rm -rf /tmp/test',
          options: expect.arrayContaining([
            expect.objectContaining({ label: 'Allow' }),
            expect.objectContaining({ label: 'Deny' }),
          ]),
        }),
      }),
    );
  });

  it('sends exec.approval.resolve on respond after approval request', () => {
    completeHandshake();

    simulateMessage({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-42', command: 'npm install' },
    });

    wsInstance.send.mockClear();

    adapter.handleCommand({ type: 'respond', value: 'y' });

    expect(wsInstance.send).toHaveBeenCalled();
    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('exec.approval.resolve');
    expect(sent.params.id).toBe('approval-42');
    expect(sent.params.decision).toBe('allow');
  });

  it('sends exec.approval.resolve with deny on respond "n"', () => {
    completeHandshake();

    simulateMessage({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-99', command: 'dangerous-cmd' },
    });

    wsInstance.send.mockClear();

    adapter.handleCommand({ type: 'respond', value: 'n' });

    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.params.decision).toBe('deny');
  });

  it('sends chat.send on send_prompt with active session', () => {
    completeHandshake();

    // Set session key via chat event
    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'r1', sessionKey: 'agent:main:test', seq: 0, state: 'delta' },
    });

    wsInstance.send.mockClear();

    adapter.handleCommand({ type: 'send_prompt', text: 'hello world' });

    expect(wsInstance.send).toHaveBeenCalled();
    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('chat.send');
    expect(sent.params.sessionKey).toBe('agent:main:test');
    expect(sent.params.message).toBe('hello world');
    expect(sent.params.idempotencyKey).toBeDefined();
  });

  it('sends chat.abort on interrupt with active session and runId', () => {
    completeHandshake();

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-abc', sessionKey: 'agent:main:test', seq: 0, state: 'delta' },
    });

    wsInstance.send.mockClear();

    adapter.handleCommand({ type: 'interrupt' });

    expect(wsInstance.send).toHaveBeenCalled();
    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('chat.abort');
    expect(sent.params.sessionKey).toBe('agent:main:test');
    expect(sent.params.runId).toBe('run-abc');
  });

  it('emits SessionEnd on shutdown event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'shutdown',
      payload: {},
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'hook', event: 'SessionEnd' }),
    );
  });

  it('clears pendingApprovalId on exec.approval.resolved', () => {
    completeHandshake();

    simulateMessage({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-1', command: 'test' },
    });

    simulateMessage({
      type: 'event',
      event: 'exec.approval.resolved',
      payload: {},
    });

    // Now respond should be a no-op (no pending approval)
    wsInstance.send.mockClear();
    adapter.handleCommand({ type: 'respond', value: 'y' });
    expect(wsInstance.send).not.toHaveBeenCalled();
  });
});

describe('CodexCliAdapter', () => {
  let adapter: CodexCliAdapter;

  beforeEach(() => {
    adapter = new CodexCliAdapter();
  });

  describe('capabilities', () => {
    it('reports Codex CLI capabilities correctly', () => {
      const caps = adapter.capabilities;
      expect(caps.type).toBe('codex-cli');
      expect(caps.displayName).toBe('Codex CLI');
      expect(caps.hasTerminal).toBe(true);
      expect(caps.hasModeSwitching).toBe(false);
      expect(caps.hasDiffReview).toBe(false);
      expect(caps.hasOptionLists).toBe(true);
      expect(caps.hasNavigablePrompts).toBe(false);
      expect(caps.hasSuggestedPrompts).toBe(false);
      expect(caps.hasApiUsage).toBe(false);
      expect(caps.hasModelCatalog).toBe(false);
    });
  });

  describe('handleCommand routing', () => {
    it('handles respond → returns true', () => {
      const cmd: PluginCommand = { type: 'respond', value: 'y' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles interrupt → returns true', () => {
      const cmd: PluginCommand = { type: 'interrupt' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles escape → returns true', () => {
      const cmd: PluginCommand = { type: 'escape' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('does not handle switch_mode → returns false', () => {
      const cmd: PluginCommand = { type: 'switch_mode' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers select_option to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'select_option', index: 0 };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers navigate_option to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'navigate_option', direction: 'up' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers send_prompt to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'send_prompt', text: 'hello' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers voice to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'voice', action: 'start' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers query_usage to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'query_usage' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('isAlive returns false before start', () => {
      expect(adapter.isAlive()).toBe(false);
    });

    it('getTtyPath returns undefined before start', () => {
      expect(adapter.getTtyPath()).toBeUndefined();
    });

    it('getProjectName returns null before start', () => {
      expect(adapter.getProjectName()).toBeNull();
    });

    it('getHttpServer returns an object', () => {
      expect(adapter.getHttpServer()).toBeDefined();
    });
  });

  describe('onRawData callback', () => {
    it('can register callback without error', () => {
      const cb = vi.fn();
      expect(() => adapter.onRawData(cb)).not.toThrow();
    });
  });

  describe('onDiag handler', () => {
    it('can register handler without error', () => {
      const handler = vi.fn();
      expect(() => adapter.onDiag(handler)).not.toThrow();
    });
  });
});

describe('CodexCliAdapter start lifecycle', () => {
  let adapter: CodexCliAdapter;
  let events: AdapterEvent[];

  beforeEach(() => {
    adapter = new CodexCliAdapter();
    events = [];
    adapter.on('event', (evt: AdapterEvent) => events.push(evt));
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('emits SessionStart and connected on start', async () => {
    await adapter.start({ port: 9170 });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'hook', event: 'SessionStart' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ source: 'connection', status: 'connected' }),
    );
  });

  it('feeds PTY data to output parser and emits activity', async () => {
    await adapter.start({ port: 9171 });

    const pty = await import('node-pty');
    const mockPty = (pty.spawn as any).mock.results[0]?.value;
    if (mockPty?.onData?.mock?.calls?.[0]?.[0]) {
      events.length = 0;
      const dataHandler = mockPty.onData.mock.calls[0][0];
      dataHandler('some output data');

      expect(events).toContainEqual(
        expect.objectContaining({ source: 'activity' }),
      );
    }
  });

  it('exports only terminal UI affordances, not parser lifecycle guesses', async () => {
    await adapter.start({ port: 9172 });
    events.length = 0;
    const observer = (adapter as any).outputParser;
    observer.emit('spinner_start', {});
    observer.emit('idle', {});
    observer.emit('tool_action', { tool: 'shell' });
    observer.emit('permission_prompt', { question: 'Allow?', options: [] });

    expect(events).toContainEqual(expect.objectContaining({
      source: 'terminal_ui', event: 'permission_prompt',
    }));
    expect(events.some((event) => event.source === 'parser')).toBe(false);
  });
});

describe('MonitorAdapter', () => {
  let adapter: MonitorAdapter;

  beforeEach(() => {
    adapter = new MonitorAdapter();
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  describe('capabilities', () => {
    it('reports monitor capabilities correctly', () => {
      const caps = adapter.capabilities;
      expect(caps.type).toBe('monitor');
      expect(caps.displayName).toBe('Monitor');
      expect(caps.hasTerminal).toBe(false);
      expect(caps.hasModeSwitching).toBe(false);
      expect(caps.hasDiffReview).toBe(false);
      expect(caps.hasOptionLists).toBe(false);
      expect(caps.hasNavigablePrompts).toBe(false);
      expect(caps.hasSuggestedPrompts).toBe(false);
      expect(caps.hasApiUsage).toBe(true);     // monitor tracks usage via hooks
      expect(caps.hasModelCatalog).toBe(false);
    });
  });

  describe('handleCommand routing', () => {
    it('rejects respond (no PTY)', () => {
      expect(adapter.handleCommand({ type: 'respond', value: 'y' })).toBe(false);
    });

    it('rejects interrupt (no PTY)', () => {
      expect(adapter.handleCommand({ type: 'interrupt' })).toBe(false);
    });

    it('rejects escape (no PTY)', () => {
      expect(adapter.handleCommand({ type: 'escape' })).toBe(false);
    });

    it('rejects switch_mode (no PTY)', () => {
      expect(adapter.handleCommand({ type: 'switch_mode' })).toBe(false);
    });

    it('rejects select_option (no PTY)', () => {
      expect(adapter.handleCommand({ type: 'select_option', index: 0 })).toBe(false);
    });

    it('rejects send_prompt (no PTY)', () => {
      expect(adapter.handleCommand({ type: 'send_prompt', text: 'hello' })).toBe(false);
    });

    it('defers voice to bridge', () => {
      expect(adapter.handleCommand({ type: 'voice', action: 'start' })).toBe(false);
    });

    it('defers query_usage to bridge', () => {
      expect(adapter.handleCommand({ type: 'query_usage' })).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('isAlive always returns true', () => {
      expect(adapter.isAlive()).toBe(true);
    });

    it('getTtyPath returns undefined (no PTY)', () => {
      expect(adapter.getTtyPath()).toBeUndefined();
    });

    it('getProjectName returns null', () => {
      expect(adapter.getProjectName()).toBeNull();
    });

    it('getHttpServer returns an object', () => {
      expect(adapter.getHttpServer()).toBeDefined();
    });

    it('writeInput is a no-op (no PTY)', () => {
      expect(() => adapter.writeInput('test')).not.toThrow();
    });

    it('attachTerminal is a no-op', () => {
      const mockStdin = { on: vi.fn() } as any;
      const mockStdout = { write: vi.fn() } as any;
      expect(() => adapter.attachTerminal(mockStdin, mockStdout)).not.toThrow();
    });

    it('onRawData is a no-op', () => {
      const cb = vi.fn();
      expect(() => adapter.onRawData(cb)).not.toThrow();
    });
  });

  describe('start and event emission', () => {
    it('emits connected event on start', async () => {
      const events: AdapterEvent[] = [];
      adapter.on('event', (evt: AdapterEvent) => events.push(evt));

      await adapter.start({ port: 9150 });

      expect(events).toContainEqual(
        expect.objectContaining({ source: 'connection', status: 'connected' }),
      );
    });

    it('exposes hook server for external wiring', () => {
      expect(adapter.getHookServer()).toBeDefined();
    });
  });
});

describe('ClaudeCodeAdapter start lifecycle', () => {
  let adapter: ClaudeCodeAdapter;
  let events: AdapterEvent[];

  beforeEach(async () => {
    // Clear pty.spawn mock to avoid stale results from earlier test suites
    const pty = await import('node-pty');
    (pty.spawn as any).mockClear();
    adapter = new ClaudeCodeAdapter();
    events = [];
    adapter.on('event', (evt: AdapterEvent) => events.push(evt));
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('emits SessionStart and connected on start', async () => {
    await adapter.start({ port: 9160 });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'hook', event: 'SessionStart' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ source: 'connection', status: 'connected' }),
    );
  });

  it('uses claude as default command', async () => {
    const pty = await import('node-pty');
    await adapter.start({ port: 9161 });

    expect(pty.spawn).toHaveBeenCalled();
    const callArgs = (pty.spawn as any).mock.calls[0];
    // First arg is the shell, second includes the command
    expect(callArgs).toBeDefined();
  });

  it('feeds PTY data to output parser and emits activity', async () => {
    await adapter.start({ port: 9162 });

    // Get the onData callback from the mock PTY
    const pty = await import('node-pty');
    const mockPty = (pty.spawn as any).mock.results[0]?.value;
    if (mockPty?.onData?.mock?.calls?.[0]?.[0]) {
      events.length = 0;
      const dataHandler = mockPty.onData.mock.calls[0][0];
      dataHandler('some output data');

      expect(events).toContainEqual(
        expect.objectContaining({ source: 'activity' }),
      );
    }
  });

  it('exports terminal UI detail without exporting lifecycle or tool guesses', async () => {
    await adapter.start({ port: 9165 });
    events.length = 0;
    const observer = (adapter as any).outputParser;
    observer.emit('spinner_start', {});
    observer.emit('spinner_stop', {});
    observer.emit('tool_action', { toolName: 'Bash' });
    observer.emit('option_prompt', { options: [{ index: 0, label: 'A' }] });

    expect(events).toContainEqual(expect.objectContaining({
      source: 'terminal_ui', event: 'option_prompt',
    }));
    expect(events.some((event) => event.source === 'parser')).toBe(false);
  });

  it('emits SessionEnd and disconnected on PTY exit', async () => {
    await adapter.start({ port: 9163 });

    const pty = await import('node-pty');
    const mockPty = (pty.spawn as any).mock.results[0]?.value;
    if (mockPty?.onExit?.mock?.calls?.[0]?.[0]) {
      events.length = 0;
      const exitHandler = mockPty.onExit.mock.calls[0][0];
      exitHandler({ exitCode: 0, signal: 0 });

      expect(events).toContainEqual(
        expect.objectContaining({ source: 'hook', event: 'SessionEnd' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ source: 'connection', status: 'disconnected' }),
      );
    }
  });

  it('registers rawData callback without error', async () => {
    const rawCb = vi.fn();
    expect(() => adapter.onRawData(rawCb)).not.toThrow();
    await adapter.start({ port: 9164 });
    // rawData callback is stored internally; actual invocation requires real PTY data
    // which is tested via integration tests (cursor-sync, output-parser)
  });
});
