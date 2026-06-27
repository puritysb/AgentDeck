/**
 * OpenCode adapter — PTY-based TUI + HTTP API/SSE overlay.
 *
 * Spawns `opencode --port XXXX` in a PTY (user interacts with TUI directly),
 * then connects to the embedded HTTP server for structured SSE events.
 * This gives the best of both worlds: familiar terminal UX + clean event data.
 *
 * Extends PtyAdapter for terminal lifecycle. Uses OpenCodeClient for:
 * - SSE event subscription (real-time state without TUI parsing)
 * - API calls for interrupt/abort (supplement PTY signals)
 * - Token/model/tool metadata (unavailable from TUI output)
 */

import { OpenCodeClient, type OpenCodeSSEEvent, type OpenCodeMessageInfo, type OpenCodeMessagePart, type OpenCodeSessionInfo } from '../opencode-client.js';
import { debug, log as stderrLog } from '../logger.js';
import { cleanDetailText, cleanRawText, prepareMarkdownDetail } from '@agentdeck/shared';
import type { AgentCapabilities, AdapterStartOptions, AdapterEvent, PluginCommand, TimelineEntry } from '../types.js';
import type { AdapterContext } from '@agentdeck/shared';
import { OPENCODE_CAPABILITIES } from '../types.js';
import { PtyAdapter } from './pty-adapter.js';
import { randomUUID } from 'crypto';
import { getApme } from '../apme/index.js';
import { opencodePartToSpans, opencodeMessageToSpans } from '../apme/adapters/opencode-hook.js';

const log = (...args: unknown[]) => debug('adapter:opencode', ...args);
const TIMELINE_CHAT_DETAIL_LIMIT = 6000;

export class OpenCodeAdapter extends PtyAdapter {
  readonly capabilities: AgentCapabilities = OPENCODE_CAPABILITIES;

  private client: OpenCodeClient | null = null;
  private serverPort = 0;

  // Session tracking from SSE
  private activeSessionID: string | null = null;
  private ocProjectName: string | null = null;

  // Chat tracking
  private chatStarted = false;
  private chatStartTime = 0;
  private chatToolCount = 0;
  private chatToolNames: string[] = [];
  private accumulatedResponse = '';

  // Permission tracking
  private pendingPermissionID: string | null = null;

  // APME bridge — set by `setApmeSession` so the adapter can pipe SSE-derived
  // spans (tool_call / tool_result / task_boundary / turn_*) into the same
  // collector that Claude / Codex feed via HTTP hooks. Without this OpenCode
  // sessions land in APME's `runs` table but never get per-task evaluation:
  // todowrite all-completed silently has no effect, idle just closes the run.
  private apmeSessionId: string | null = null;
  private apmeTraceId = randomUUID();
  private apmeCwdHint: string | undefined;
  /** Last seen user prompt — buffered so the assistant's response can be
   *  attached to the matching turn_start span. */
  private lastUserPrompt: string | undefined;

  protected getDefaultCommand(): string {
    return 'opencode';
  }

  protected wireOutputParser(): void {
    // No TUI output parser needed — SSE provides structured events.
    // PtyAdapter still feeds data through feedParser() for activity detection.
  }

  protected feedParser(_data: string): void {
    // No parsing needed — SSE handles state detection.
    // Activity events are already emitted by PtyAdapter's data handler.
  }

  protected override useHookServer(): boolean {
    // OpenCode has no HTTP hooks — but we still need the HookServer for
    // its HTTP server (WsServer plugin attachment). Keep it running.
    return true;
  }

  override async start(options: AdapterStartOptions): Promise<void> {
    // Allocate a port for OpenCode's embedded server
    this.serverPort = 14096 + Math.floor(Math.random() * 900);

    // Override command to include --port flag for embedded server
    const baseCommand = options.command || this.getDefaultCommand();
    options = {
      ...options,
      command: `${baseCommand} --port ${this.serverPort}`,
    };

    // Start PTY (spawns opencode TUI with embedded server)
    await super.start(options);

    // Connect SSE overlay. Failures inside connectToEmbeddedServer surface
    // their own stderr messages (timeout, health, subscribe). The outer
    // catch only fires on unexpected throws — keep it loud regardless.
    this.connectToEmbeddedServer().catch((err) => {
      stderrLog(`[opencode] SSE overlay setup threw unexpectedly — TUI still works, state events missing: ${err}`);
    });
  }

  /**
   * Bind this adapter to an APME session id so SSE events can be ingested
   * as TelemetrySpans. Called by the bridge once it knows the session id
   * + cwd. No-op when the global APME module isn't initialized. */
  setApmeSession(sessionId: string, cwd?: string): void {
    this.apmeSessionId = sessionId;
    this.apmeCwdHint = cwd;
  }

  private buildApmeCtx(): AdapterContext | null {
    if (!this.apmeSessionId || !getApme()) return null;
    return {
      sessionId: this.apmeSessionId,
      agentType: 'opencode',
      cwd: this.apmeCwdHint,
      traceId: this.apmeTraceId,
      activeTurnId: undefined,
    };
  }

  private ingestApmeSpans(spans: ReturnType<typeof opencodePartToSpans>): void {
    const apme = getApme();
    if (!apme || !this.apmeSessionId || spans.length === 0) return;
    for (const span of spans) {
      try {
        apme.collector.ingestSpan(this.apmeSessionId, span);
      } catch (err) {
        debug('apme:opencode', `ingestSpan failed: ${String(err)}`);
      }
    }
  }

  protected override handleAgentCommand(cmd: PluginCommand): boolean {
    switch (cmd.type) {
      case 'interrupt': {
        // Use API abort in addition to PTY SIGINT for cleaner interrupt
        if (this.activeSessionID && this.client) {
          this.client.abortSession(this.activeSessionID).catch((err) =>
            log('API abort failed:', err),
          );
        }
        return false; // fall through to PtyAdapter's SIGINT handler too
      }
      default:
        return false;
    }
  }

  override getProjectName(): string | null {
    return this.ocProjectName || null;
  }

  override async shutdown(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
    await super.shutdown();
  }

  // ===== Embedded Server Connection =====

  private async connectToEmbeddedServer(): Promise<void> {
    const serverUrl = `http://127.0.0.1:${this.serverPort}`;

    // Poll until the embedded server is ready (up to 15s)
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const resp = await fetch(`${serverUrl}/global/health`);
        if (resp.ok) { ready = true; break; }
      } catch { /* retry */ }

      // Bail if PTY died
      if (!this.isAlive()) return;
    }

    if (!ready) {
      stderrLog(`[opencode] embedded server on :${this.serverPort} did not respond within 15s — TUI still works, state events missing`);
      return;
    }

    const directory = process.cwd();
    this.client = new OpenCodeClient(serverUrl, directory);

    try {
      const health = await this.client.health();
      log('SSE overlay connected to embedded server:', health.version);
    } catch (err) {
      stderrLog(`[opencode] embedded server health check failed — TUI still works, state events missing: ${err}`);
      return;
    }

    // Resolve active session
    try {
      const sessions = await this.client.listSessions(5);
      const existing = sessions.find(s => s.directory === directory);
      if (existing) {
        this.activeSessionID = existing.id;
        this.ocProjectName = existing.title || directory.split('/').pop() || null;
        log('Tracking session:', existing.id, existing.title);
      }
    } catch (err) {
      stderrLog(`[opencode] could not resolve active session — abort/interrupt may not target the right session: ${err}`);
    }

    // Wire SSE events
    this.wireSSEEvents();

    // Start SSE subscription (runs indefinitely, auto-reconnects on its own).
    // First-attempt failure is loud; reconnects stay quiet to avoid log spam.
    this.client.subscribe().catch((err) => stderrLog(`[opencode] SSE subscribe failed: ${err}`));
  }

  // ===== SSE Event Wiring =====

  private wireSSEEvents(): void {
    if (!this.client) return;

    this.client.on('sse', (event: OpenCodeSSEEvent) => {
      const { type, properties } = event.payload;

      switch (type) {
        case 'session.status':
          this.handleSessionStatus(properties);
          break;
        case 'session.idle':
          this.handleSessionIdle(properties);
          break;
        case 'session.created':
          this.handleSessionCreated(properties);
          break;
        case 'session.updated':
          this.handleSessionUpdated(properties);
          break;
        case 'message.part.updated':
          this.handlePartUpdated(properties);
          break;
        case 'message.part.delta':
          this.handlePartDelta(properties);
          break;
        case 'message.updated':
          this.handleMessageUpdated(properties);
          break;
        case 'permission.requested':
          this.handlePermissionRequested(properties);
          break;
        default:
          break;
      }
    });
  }

  // ===== SSE Event Handlers =====

  private handleSessionStatus(props: Record<string, unknown>): void {
    const sessionID = props.sessionID as string;
    const status = props.status as { type: string } | undefined;
    if (!status) return;

    // Auto-track first session we see
    if (!this.activeSessionID && sessionID) {
      this.activeSessionID = sessionID;
    }
    if (sessionID && sessionID !== this.activeSessionID) return;

    if (status.type === 'busy') {
      if (!this.chatStarted) {
        this.chatStarted = true;
        this.chatStartTime = Date.now();
        this.chatToolCount = 0;
        this.chatToolNames = [];
        // Emit chat_start so timeline shows when processing began
        this.emitTimelineEntry({
          ts: this.chatStartTime, type: 'chat_start',
          raw: this.ocProjectName ? `Processing · ${this.ocProjectName}` : 'Processing started',
        });
      }
      this.emitAdapterEvent({ source: 'parser', event: 'spinner_start' });
    }
  }

  private handleSessionIdle(props: Record<string, unknown>): void {
    const sessionID = props.sessionID as string;
    if (sessionID && sessionID !== this.activeSessionID) return;

    this.finishChat();
    this.emitAdapterEvent({ source: 'parser', event: 'idle' });
  }

  private handleSessionCreated(props: Record<string, unknown>): void {
    const info = props.info as OpenCodeSessionInfo | undefined;
    if (!info) return;
    if (!this.activeSessionID) {
      this.activeSessionID = info.id;
      log('Auto-tracking new session:', info.id);
    }
  }

  private handleSessionUpdated(props: Record<string, unknown>): void {
    const info = props.info as OpenCodeSessionInfo | undefined;
    if (!info || info.id !== this.activeSessionID) return;

    if (info.title && info.title !== this.ocProjectName) {
      this.ocProjectName = info.title;
      this.emitAdapterEvent({
        source: 'parser', event: 'project_name',
        data: { name: info.title },
      });
    }
  }

  private handlePartUpdated(props: Record<string, unknown>): void {
    const part = props.part as OpenCodeMessagePart | undefined;
    if (!part || (part.sessionID && part.sessionID !== this.activeSessionID)) return;

    switch (part.type) {
      case 'tool': {
        const toolName = part.tool || 'unknown';
        const status = part.state?.status || 'running';

        this.chatToolCount++;
        if (!this.chatToolNames.includes(toolName)) {
          this.chatToolNames.push(toolName);
        }

        const inputStr = part.state?.input
          ? Object.entries(part.state.input).map(([k, v]) => `${k}: ${v}`).join(', ')
          : '';
        this.emitAdapterEvent({
          source: 'parser', event: 'tool_action',
          data: { toolName, toolArgs: inputStr },
        });

        const raw = `${toolName}${inputStr ? ` ${inputStr.slice(0, 100)}` : ''}`;
        this.emitTimelineEntry({
          ts: Date.now(),
          type: status === 'completed' ? 'tool_resolved' : 'tool_request',
          raw: cleanRawText(raw),
          ...(part.state?.output ? { detail: cleanDetailText(part.state.output.slice(0, 1000)) } : {}),
        });

        // APME: emit tool_call / tool_result / task_boundary spans so the
        // collector knows when a todowrite cycle completes (= task done).
        const ctx = this.buildApmeCtx();
        if (ctx) {
          this.ingestApmeSpans(opencodePartToSpans(ctx, part));
        }
        break;
      }

      case 'text':
        if (part.text) this.accumulatedResponse = part.text;
        break;

      case 'step-finish':
        if (part.tokens) {
          this.emitAdapterEvent({
            source: 'metadata', event: 'usage_info',
            data: {
              inputTokens: part.tokens.input,
              outputTokens: part.tokens.output,
              cacheReadTokens: part.tokens.cache?.read ?? 0,
              cacheWriteTokens: part.tokens.cache?.write ?? 0,
              totalCost: part.cost ?? 0,
            },
          });
        }
        break;
    }
  }

  private handlePartDelta(props: Record<string, unknown>): void {
    const delta = props.delta as string;
    if (delta) this.accumulatedResponse += delta;
  }

  private handleMessageUpdated(props: Record<string, unknown>): void {
    const info = props.info as OpenCodeMessageInfo | undefined;
    if (!info || info.sessionID !== this.activeSessionID) return;

    if (info.role === 'assistant' && info.modelID) {
      this.emitAdapterEvent({
        source: 'parser', event: 'model_info',
        data: { model: info.modelID, provider: info.providerID, agent: info.agent },
      });
    }

    // APME: open / close turns. User messages open a turn (carrying the
    // prompt text); assistant messages close it once the accumulated text
    // response is available. The collector's session_end + todowrite
    // boundary detection still owns task lifecycle — this just feeds the
    // per-turn rows the rubric judge reads.
    const ctx = this.buildApmeCtx();
    if (ctx) {
      const promptText = info.role === 'user' ? this.extractUserPrompt(info) : undefined;
      if (info.role === 'user' && promptText) this.lastUserPrompt = promptText;
      const responseText = info.role === 'assistant' && this.accumulatedResponse
        ? this.accumulatedResponse
        : undefined;
      this.ingestApmeSpans(opencodeMessageToSpans(ctx, info, promptText, responseText));
    }
  }

  /** Best-effort prompt extraction. OpenCode v1 surfaces user prompts via
   *  `message.updated` events that may carry `text`, `content`, or a nested
   *  parts array. Returns undefined when nothing extractable is present so
   *  callers can skip the span. */
  private extractUserPrompt(info: OpenCodeMessageInfo): string | undefined {
    const candidate = (info as unknown as Record<string, unknown>);
    const direct = candidate['text'];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const content = candidate['content'];
    if (typeof content === 'string' && content.trim()) return content.trim();
    const parts = candidate['parts'];
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (p && typeof p === 'object') {
          const pt = (p as Record<string, unknown>).text;
          if (typeof pt === 'string' && pt.trim()) return pt.trim();
        }
      }
    }
    return undefined;
  }

  private handlePermissionRequested(props: Record<string, unknown>): void {
    const sessionID = props.sessionID as string;
    const permissionID = props.permissionID as string;
    if (sessionID !== this.activeSessionID || !permissionID) return;

    this.pendingPermissionID = permissionID;
    const tool = (props.tool as string) || 'tool';
    const description = (props.description as string) || `Allow ${tool}?`;

    this.emitAdapterEvent({
      source: 'parser', event: 'permission_prompt',
      data: {
        message: description,
        options: [
          { label: 'Allow', value: 'allow' },
          { label: 'Deny', value: 'deny' },
        ],
      },
    });
  }

  // ===== Chat lifecycle =====

  private finishChat(): void {
    if (!this.chatStarted) return;

    const duration = Date.now() - this.chatStartTime;
    const durationSec = Math.round(duration / 1000);
    const toolSummary = this.chatToolNames.length > 0
      ? this.chatToolNames.join(', ') : 'no tools';

    if (this.accumulatedResponse) {
      const responseRaw = this.accumulatedResponse.length > 500
        ? this.accumulatedResponse.slice(0, 497) + '...'
        : this.accumulatedResponse;
      this.emitTimelineEntry({
        ts: Date.now(), type: 'chat_response',
        raw: cleanRawText(responseRaw),
        // Chat path — preserve markdown so the dashboard can render heading
        // / table / inline styles. Tool-output detail above stays on
        // cleanDetailText since that's typically JSON / log noise.
        detail: prepareMarkdownDetail(this.accumulatedResponse.slice(0, TIMELINE_CHAT_DETAIL_LIMIT)),
      });
    }

    this.emitTimelineEntry({
      ts: Date.now(), type: 'chat_end',
      raw: cleanRawText(`${durationSec}s · ${this.chatToolCount} tools (${toolSummary})`),
    });

    this.chatStarted = false;
    this.chatStartTime = 0;
    this.chatToolCount = 0;
    this.chatToolNames = [];
    this.accumulatedResponse = '';
  }

  // ===== Helpers =====

  private emitTimelineEntry(entry: TimelineEntry): void {
    this.emitAdapterEvent({ source: 'timeline', entry });
  }
}
