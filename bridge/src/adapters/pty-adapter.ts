import { EventEmitter } from 'events';
import type { Server } from 'http';
import { PtyManager } from '../pty-manager.js';
import { HookServer } from '../hook-server.js';
import { debug } from '../logger.js';
import type {
  AgentAdapter,
  AgentCapabilities,
  AdapterStartOptions,
  AdapterEvent,
  PluginCommand,
} from '../types.js';

/**
 * Abstract base class for PTY-based agent adapters.
 *
 * Provides common infrastructure: PtyManager, HookServer, PTY lifecycle,
 * input/output wiring, and standard command handling (respond, interrupt, escape).
 *
 * Subclasses implement:
 * - capabilities — agent-specific feature flags
 * - getDefaultCommand() — CLI command to spawn (e.g. 'claude', 'codex')
 * - wireOutputParser() — connect optional terminal UI observations
 * - feedParser(data) — feed PTY data to that observer (or no-op)
 * - handleAgentCommand(cmd) — agent-specific commands (e.g. switch_mode)
 */
export abstract class PtyAdapter extends EventEmitter implements AgentAdapter {
  abstract readonly capabilities: AgentCapabilities;

  protected ptyManager: PtyManager;
  protected hookServer: HookServer;
  protected port = 0;

  /** Callback for raw PTY data (diagnostics) */
  private rawDataCallback: ((data: string) => void) | null = null;

  constructor() {
    super();
    this.ptyManager = new PtyManager();
    this.hookServer = new HookServer();
  }

  /** CLI command to spawn in PTY */
  protected abstract getDefaultCommand(): string;

  /** Wire output parser events → AdapterEvents. Called once during start(). */
  protected abstract wireOutputParser(): void;

  /** Feed raw PTY data to the parser. Called on every PTY data chunk. */
  protected abstract feedParser(data: string): void;

  /** Whether this agent uses HTTP hook server. Override to false for hook-less agents. */
  protected useHookServer(): boolean { return true; }

  /**
   * Handle agent-specific commands (e.g. switch_mode for Claude).
   * Return true if handled, false to fall through to common handlers.
   */
  protected handleAgentCommand(_cmd: PluginCommand): boolean { return false; }

  /** Get the hook server instance (for external wiring like SSE broadcast) */
  getHookServer(): HookServer { return this.hookServer; }

  async start(options: AdapterStartOptions): Promise<void> {
    this.port = options.port;

    // 1. Start HTTP hook server (optional per agent)
    if (this.useHookServer()) {
      await this.hookServer.listen(this.port);

      // Wire HookServer events → AdapterEvents
      this.hookServer.on('hook', ({ event, data }: { event: string; data: Record<string, unknown> }) => {
        if (event === 'shutdown') {
          this.emitAdapterEvent({ source: 'hook', event: 'shutdown', data });
          return;
        }
        this.emitAdapterEvent({ source: 'hook', event, data });
      });
    }

    // 2. Wire output parser (subclass-specific)
    this.wireOutputParser();

    // 3. Spawn PTY
    const command = options.command || this.getDefaultCommand();
    await this.ptyManager.spawn(command, { AGENTDECK_PORT: String(this.port) });

    // 4. Feed PTY output → parser + activity
    this.ptyManager.on('data', (data: string) => {
      if (this.rawDataCallback) {
        this.rawDataCallback(data);
      }
      this.feedParser(data);
      this.emitAdapterEvent({ source: 'activity' });
    });

    // 5. Handle PTY exit
    this.ptyManager.on('exit', (code: number, signal: number) => {
      debug('adapter:pty', `PTY exited (code=${code}, signal=${signal})`);
      this.emitAdapterEvent({ source: 'hook', event: 'SessionEnd', data: {} });
      this.emitAdapterEvent({ source: 'connection', status: 'disconnected' });
      this.emit('exit', code, signal);
    });

    // 6. Emit initial events
    this.emitAdapterEvent({ source: 'hook', event: 'SessionStart', data: {} });
    this.emitAdapterEvent({ source: 'connection', status: 'connected' });
  }

  handleCommand(cmd: PluginCommand): boolean {
    // Let subclass handle agent-specific commands first
    if (this.handleAgentCommand(cmd)) return true;

    // Common PTY commands
    switch (cmd.type) {
      case 'respond':
        debug('adapter:pty', `respond: "${cmd.value}"`);
        this.ptyManager.write(cmd.value + '\r');
        return true;

      case 'interrupt':
        this.ptyManager.interrupt();
        return true;

      case 'escape':
        debug('adapter:pty', 'escape: sending Esc');
        this.ptyManager.write('\x1b');
        return true;

      // These require StateMachine context — handled by bridge
      case 'select_option':
      case 'navigate_option':
      case 'send_prompt':
        return false;

      // Bridge-only commands
      case 'voice':
      case 'query_usage':
        return false;

      default:
        return false;
    }
  }

  writeInput(data: string): void {
    this.ptyManager.write(data);
  }

  isAlive(): boolean {
    return this.ptyManager.isAlive();
  }

  attachTerminal(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void {
    this.ptyManager.attachTerminal(stdin, stdout);
  }

  getTtyPath(): string | undefined {
    return this.ptyManager.getTtyPath();
  }

  getProjectName(): string | null {
    return null; // Override in subclasses with output parsers
  }

  getHttpServer(): Server {
    return this.hookServer.getServer();
  }

  prepareForNavigation?(): void {
    // Override in subclasses
  }

  onDiag(handler: (tail?: number) => unknown): void {
    this.hookServer.onDiag(handler);
  }

  onRawData(callback: (data: string) => void): void {
    this.rawDataCallback = callback;
  }

  async shutdown(): Promise<void> {
    if (this.ptyManager.isAlive()) {
      this.ptyManager.kill();
    }
    await this.hookServer.close();
  }

  protected emitAdapterEvent(evt: AdapterEvent): void {
    this.emit('event', evt);
  }
}
