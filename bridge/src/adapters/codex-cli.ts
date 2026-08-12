import { CodexOutputParser } from '../codex-output-parser.js';
import type { AgentCapabilities, PluginCommand } from '../types.js';
import { CODEX_CLI_CAPABILITIES } from '../types.js';
import { PtyAdapter } from './pty-adapter.js';

/**
 * Codex CLI adapter — lifecycle correctness comes from Codex lifecycle hooks
 * and its turn-complete notification. The terminal observer is limited to
 * interaction affordances not yet present in those payloads.
 */
export class CodexCliAdapter extends PtyAdapter {
  readonly capabilities: AgentCapabilities = CODEX_CLI_CAPABILITIES;

  private outputParser: CodexOutputParser;

  constructor() {
    super();
    this.outputParser = new CodexOutputParser();
  }

  protected getDefaultCommand(): string {
    return 'codex';
  }

  protected wireOutputParser(): void {
    // Never forward spinner/idle/tool actions from the terminal. Hooks own
    // state, timeline, and APME; this observer supplies UI-only detail.
    const terminalUiEvents = [
      'permission_prompt',
      'project_name',
      'model_info',
    ];
    for (const eventName of terminalUiEvents) {
      this.outputParser.on(eventName, (data?: Record<string, unknown>) => {
        this.emitAdapterEvent({ source: 'terminal_ui', event: eventName, data });
      });
    }
  }

  protected feedParser(data: string): void {
    this.outputParser.feed(data);
  }

  protected handleAgentCommand(_cmd: PluginCommand): boolean {
    // No agent-specific commands in Phase 1
    // Phase 2: could handle mode switching via /permissions slash command
    return false;
  }

  override getProjectName(): string | null {
    return this.outputParser.getProjectName();
  }

  /** Exposed for SSE broadcasting from bridge index (alias for getHookServer) */
  getCodexHookServer() {
    return this.getHookServer();
  }
}
