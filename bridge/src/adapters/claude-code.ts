import { OutputParser } from '../output-parser.js';
import { debug } from '../logger.js';
import type { AgentCapabilities, PluginCommand } from '../types.js';
import { CLAUDE_CODE_CAPABILITIES } from '../types.js';
import { PtyAdapter } from './pty-adapter.js';

/**
 * Claude Code adapter — extends PtyAdapter with Claude-specific output parsing
 * and mode switching (Shift+Tab).
 */
export class ClaudeCodeAdapter extends PtyAdapter {
  readonly capabilities: AgentCapabilities = CLAUDE_CODE_CAPABILITIES;

  private outputParser: OutputParser;
  /** Mode switch debounce */
  private lastModeSwitchTime = 0;

  constructor() {
    super();
    this.outputParser = new OutputParser();
    this.ptyManager.on('input', (data: string) => {
      this.outputParser.notifyUserInput(data);
    });
  }

  protected getDefaultCommand(): string {
    return 'claude';
  }

  protected wireOutputParser(): void {
    // Parser events → AdapterEvents
    const parserEvents = [
      'spinner_start',
      'spinner_stop',
      'permission_prompt',
      'option_prompt',
      'diff_prompt',
      'idle',
      'status_line',
      'tool_action',
      'project_name',
      'model_info',
      'mode_change',
      'suggested_prompt',
      'remote_url',
    ];
    for (const eventName of parserEvents) {
      this.outputParser.on(eventName, (data?: Record<string, unknown>) => {
        this.emitAdapterEvent({ source: 'parser', event: eventName, data });
      });
    }

    // cursor_update → metadata
    this.outputParser.on('cursor_update', (data?: Record<string, unknown>) => {
      this.emitAdapterEvent({ source: 'metadata', event: 'cursor_update', data: data ?? {} });
    });

    // usage_info → metadata
    this.outputParser.on('usage_info', (data?: Record<string, unknown>) => {
      if (data) {
        this.emitAdapterEvent({ source: 'metadata', event: 'usage_info', data });
      }
    });

    // user_prompt → metadata
    this.outputParser.on('user_prompt', (data?: Record<string, unknown>) => {
      const text = data?.text as string | undefined;
      if (text) {
        this.emitAdapterEvent({ source: 'metadata', event: 'user_prompt', data: { text } });
      }
    });
  }

  protected feedParser(data: string): void {
    this.outputParser.feed(data);
  }

  protected handleAgentCommand(cmd: PluginCommand): boolean {
    if (cmd.type === 'switch_mode') {
      const now = Date.now();
      if (now - this.lastModeSwitchTime < 100) {
        debug('adapter:claude', `switch_mode: debounced (${now - this.lastModeSwitchTime}ms < 100ms)`);
        return true;
      }
      this.lastModeSwitchTime = now;
      debug('adapter:claude', 'switch_mode: sending Shift+Tab');
      this.outputParser.notifyModeSwitchSent();
      this.ptyManager.write('\x1b[Z');
      return true;
    }
    return false;
  }

  /**
   * Pre-seed the bridge-resolved (git-aware) project name so the parser's
   * PROJECT_DIR scrape never fires. The scrape is kept only as a fallback for
   * the rare case the resolver produced nothing meaningful.
   */
  seedProjectName(name: string): void {
    this.outputParser.seedProjectName(name);
  }

  override getProjectName(): string | null {
    return this.outputParser.getProjectName();
  }

  override prepareForNavigation(): void {
    this.outputParser.startInteractiveCooldown();
  }

  /** Exposed for SSE broadcasting from bridge index (alias for getHookServer) */
  getClaudeHookServer() {
    return this.getHookServer();
  }
}
