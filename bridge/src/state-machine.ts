import { EventEmitter } from 'events';
import {
  State,
  PermissionMode,
  STUCK_TIMEOUT_MS,
  type StateSnapshot,
  type PromptOption,
  type StateTransition,
  transitions,
} from './types.js';
import type { BillingType } from '@agentdeck/shared';
import { UsageTracker } from './usage-tracker.js';
import { debug } from './logger.js';

/** Extract the most useful field from tool_input for display on E4 */
function formatToolInput(toolName: string | null, input: Record<string, unknown> | undefined): string | null {
  if (!input || !toolName) return null;

  // Tool-specific key extraction
  const keyMap: Record<string, string> = {
    Bash: 'command',
    Read: 'file_path',
    Write: 'file_path',
    Edit: 'file_path',
    Glob: 'pattern',
    Grep: 'pattern',
    WebFetch: 'url',
    WebSearch: 'query',
    Task: 'prompt',
  };

  const key = keyMap[toolName];
  if (key && typeof input[key] === 'string') {
    return truncateToolInput(input[key] as string);
  }

  // Fallback: first short string value
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 200) {
      return truncateToolInput(v);
    }
  }
  return null;
}

function truncateToolInput(s: string): string {
  // Take first line, max 120 chars
  const line = s.split('\n')[0];
  return line.length > 120 ? line.slice(0, 119) + '\u2026' : line;
}

/** Grace period during which hook tool activity may not dismiss a freshly
 *  drawn AWAITING_* prompt — see recoverProcessingFromToolActivity(). */
export const AWAITING_TOOL_DISMISS_GRACE_MS = 1500;

const TERMINAL_UI_EVENTS = new Set([
  'permission_prompt',
  'option_prompt',
  'diff_prompt',
  'suggested_prompt',
  'mode_change',
  'status_line',
  'project_name',
  'model_info',
  'effort_level',
  'remote_url',
]);

export class StateMachine extends EventEmitter {
  private state: State = State.DISCONNECTED;
  private permissionMode: PermissionMode = PermissionMode.DEFAULT;
  private currentTool: string | null = null;
  private toolInput: string | null = null;
  private toolProgress: string | null = null;
  private options: PromptOption[] = [];
  private question: string | null = null;
  private navigable = false;
  private cursorIndex = 0;
  private cursorAuthority: 'pty' | 'optimistic' = 'pty';
  private optimisticCursorTime = 0;
  private projectName: string | null = null;
  private modelName: string | null = null;
  private effortLevel: string | null = null;
  private remoteUrl: string | null = null;
  private billingType: BillingType = 'unknown';
  private suggestedPrompt: string | null = null;
  private lastValidSuggestedPrompt: string | null = null;
  private usageTracker: UsageTracker;
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingEnteredAt = 0;

  constructor(usageTracker: UsageTracker) {
    super();
    this.usageTracker = usageTracker;
  }

  handleHookEvent(eventName: string, data: Record<string, unknown>): void {
    debug('SM', `hookEvent: ${eventName} (current: ${this.state})`);
    switch (eventName) {
      case 'SessionStart':
        this.usageTracker.start();
        this.transition(State.IDLE, 'session_start', 'hook');
        break;

      case 'UserPromptSubmit':
        this.suggestedPrompt = null;
        this.lastValidSuggestedPrompt = null;
        this.transition(State.PROCESSING, 'user_prompt_submit', 'hook');
        break;

      case 'PreToolUse': {
        const toolName = (data.tool_name as string) || null;
        const toolInputData = data.tool_input as Record<string, unknown> | undefined;
        this.currentTool = toolName;
        this.toolInput = formatToolInput(toolName, toolInputData);
        this.toolProgress = `Using ${toolName}`;
        // Tool activity proves the turn is running: recovers AWAITING_* after a
        // keyboard-answered prompt and IDLE after a dropped user_prompt_submit.
        // A no-op from PROCESSING (transition table rejects it).
        this.recoverProcessingFromToolActivity();
        this.emitSnapshot();
        break;
      }

      case 'PostToolUse': {
        this.usageTracker.addToolCall(data);
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.recoverProcessingFromToolActivity();
        this.emitSnapshot();
        break;
      }

      case 'Stop':
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.navigable = false;
        this.cursorIndex = 0;
        this.transition(State.IDLE, 'stop', 'hook');
        break;

      case 'SessionEnd':
        this.modelName = null;
        this.effortLevel = null;
        this.billingType = 'unknown';
        this.transition(State.DISCONNECTED, 'session_end', 'hook');
        break;

      case 'Notification': {
        if (typeof data.input_tokens === 'number' && typeof data.output_tokens === 'number') {
          this.usageTracker.addTokens(
            data.input_tokens as number,
            data.output_tokens as number,
          );
        }
        break;
      }

      // ── Codex CLI lifecycle hooks ──
      // Installed by hooks/src/codex-install.ts into ~/.codex/config.toml.
      // Mirrors Claude semantics so the same downstream display/eval logic
      // reacts to either. Schema source: Codex CLI hook payload (stdin JSON).
      case 'codex_session_start':
        // Reuse Claude trigger labels: the state-transition contract
        // (DISCONNECTED|IDLE → IDLE for session_start, IDLE → PROCESSING
        // for user_prompt_submit) is identical, so the transitions table
        // in shared/src/states.ts doesn't need codex_*-prefixed entries.
        this.usageTracker.start();
        this.transition(State.IDLE, 'session_start', 'hook');
        break;

      case 'codex_user_prompt_submit':
        this.suggestedPrompt = null;
        this.lastValidSuggestedPrompt = null;
        this.transition(State.PROCESSING, 'user_prompt_submit', 'hook');
        break;

      case 'codex_tool_start': {
        const toolName = (data.tool_name as string) || null;
        const toolInputData = data.tool_input as Record<string, unknown> | undefined;
        this.currentTool = toolName;
        this.toolInput = formatToolInput(toolName, toolInputData);
        this.toolProgress = toolName ? `Using ${toolName}` : null;
        // Same recovery contract as Claude PreToolUse (see above).
        this.recoverProcessingFromToolActivity();
        this.emitSnapshot();
        break;
      }

      case 'codex_tool_end': {
        this.usageTracker.addToolCall(data);
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.recoverProcessingFromToolActivity();
        this.emitSnapshot();
        break;
      }

      case 'codex_stop':
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.navigable = false;
        this.cursorIndex = 0;
        this.transition(State.IDLE, 'stop', 'hook');
        break;

      case 'codex_turn_complete':
        // Notify is the structured fallback when the Stop hook does not fire.
        // It must close the same state as codex_stop; duplicate completion is
        // harmless because transition() suppresses identical snapshots.
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.navigable = false;
        this.cursorIndex = 0;
        this.transition(State.IDLE, 'stop', 'hook');
        break;

      default:
        break;
    }
  }

  handleParserEvent(eventName: string, data?: Record<string, unknown>): void {
    debug('SM', `parserEvent: ${eventName} (current: ${this.state})`);
    switch (eventName) {
      case 'permission_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.question = (data?.question as string) || null;
        this.navigable = (data?.navigable as boolean) ?? false;
        this.cursorIndex = (data?.cursorIndex as number) ?? 0;
        this.transition(State.AWAITING_PERMISSION, 'permission_prompt', 'pty');
        break;
      }

      case 'option_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.question = (data?.question as string) || null;
        this.navigable = (data?.navigable as boolean) ?? false;
        this.cursorIndex = (data?.cursorIndex as number) ?? 0;
        if (this.state === State.AWAITING_OPTION) {
          // Already in AWAITING_OPTION — just update options and re-emit snapshot
          // (debounced chunks may re-parse with more complete data)
          debug('SM', `option_prompt update: ${this.options.length} options, nav=${this.navigable}, cursor=${this.cursorIndex}`);
          this.emitSnapshot();
        } else {
          this.transition(State.AWAITING_OPTION, 'option_ui_detected', 'pty');
        }
        break;
      }

      case 'diff_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.transition(State.AWAITING_DIFF, 'diff_ui_detected', 'pty');
        break;
      }

      case 'suggested_prompt': {
        this.suggestedPrompt = (data?.text as string) ?? null;
        if (this.suggestedPrompt) {
          this.lastValidSuggestedPrompt = this.suggestedPrompt;
        }
        this.emitSnapshot();
        break;
      }

      case 'spinner_start':
        this.suggestedPrompt = null;
        if (this.state !== State.PROCESSING) {
          // Clean up awaiting state data if recovering from a prompt
          if (
            this.state === State.AWAITING_OPTION ||
            this.state === State.AWAITING_PERMISSION ||
            this.state === State.AWAITING_DIFF
          ) {
            this.options = [];
            this.question = null;
            this.navigable = false;
            this.cursorIndex = 0;
            this.toolInput = null;
          }
          this.transition(State.PROCESSING, 'spinner_start', 'pty');
        }
        break;

      case 'spinner_stop':
        // Spinner stopped — if we're in an active state, go to IDLE
        if (
          this.state === State.PROCESSING ||
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_OPTION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.currentTool = null;
          this.toolInput = null;
          this.toolProgress = null;
          this.options = [];
          this.question = null;
          this.navigable = false;
          this.cursorIndex = 0;
          this.transition(State.IDLE, 'idle_detected', 'pty');
        }
        break;

      case 'idle':
        if (
          this.state === State.PROCESSING ||
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_OPTION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.currentTool = null;
          this.toolInput = null;
          this.toolProgress = null;
          this.options = [];
          this.question = null;
          this.navigable = false;
          this.cursorIndex = 0;
          this.transition(State.IDLE, 'idle_detected', 'pty');
        }
        break;

      case 'mode_change': {
        const mode = data?.mode as string | undefined;
        if (mode === 'plan') {
          this.setPermissionMode(PermissionMode.PLAN);
        } else if (mode === 'acceptEdits') {
          this.setPermissionMode(PermissionMode.ACCEPT_EDITS);
        } else {
          this.setPermissionMode(PermissionMode.DEFAULT);
        }
        break;
      }

      // --- Metadata events (don't change state, update display data) ---
      case 'status_line': {
        // Token/duration from PTY status line: "1m 0s · ↓ 1.9k tokens"
        const durationSec = data?.durationSec as number | undefined;
        const tokens = data?.tokens as number | undefined;
        if (durationSec != null) {
          this.usageTracker.setDuration(durationSec);
        }
        if (tokens != null) {
          this.usageTracker.setOutputTokens(tokens);
        }
        this.emitSnapshot();
        break;
      }

      case 'tool_action': {
        const toolName = data?.toolName as string | undefined;
        const toolArgs = data?.toolArgs as string | undefined;
        if (toolName) {
          this.currentTool = toolName;
          this.toolProgress = `Using ${toolName}`;
          // PTY args as fallback when hook data hasn't provided toolInput
          if (toolArgs && !this.toolInput) {
            this.toolInput = toolArgs;
          }
          this.usageTracker.incrementToolCalls();
          this.emitSnapshot();
        }
        break;
      }

      case 'project_name': {
        const name = data?.name as string | undefined;
        if (name) {
          this.projectName = name;
          debug('SM', `project: ${name}`);
          this.emitSnapshot();
        }
        break;
      }

      case 'model_info': {
        const model = data?.model as string | undefined;
        const plan = data?.plan as string | undefined;
        if (model) {
          this.modelName = model;
          debug('SM', `model: ${model}`);
        }
        if (plan) {
          if (/max/i.test(plan)) {
            this.billingType = 'subscription';
          } else if (/api/i.test(plan)) {
            this.billingType = 'api';
          }
          debug('SM', `billingType: ${this.billingType} (plan="${plan}")`);
        }
        if (model || plan) {
          this.emitSnapshot();
        }
        break;
      }

      case 'effort_level': {
        const level = data?.level as string | undefined;
        if (level) {
          this.effortLevel = level;
          debug('SM', `effortLevel: ${level}`);
          this.emitSnapshot();
        }
        break;
      }

      case 'remote_url': {
        const url = data?.url as string | undefined;
        if (url) {
          this.remoteUrl = url;
          debug('SM', `remoteUrl: ${url}`);
          this.emitSnapshot();
        }
        break;
      }

      default:
        break;
    }
  }

  /** Apply optional managed-terminal UI detail without letting screen
   * observation become a lifecycle authority. Structured hooks/events own
   * processing/idle, tools, timeline and APME; this whitelist exists only for
   * affordances the agent lifecycle payload does not expose yet. */
  handleTerminalUiEvent(eventName: string, data?: Record<string, unknown>): void {
    if (!TERMINAL_UI_EVENTS.has(eventName)) {
      debug('SM', `terminal UI event ignored by policy: ${eventName}`);
      return;
    }
    this.handleParserEvent(eventName, data);
  }

  /** Update billing type from external source (e.g., OAuth API response) if still unknown */
  inferBillingType(inferred: 'subscription' | 'api'): void {
    if (this.billingType === 'unknown') {
      this.billingType = inferred;
      debug('SM', `billingType inferred from API: ${inferred}`);
      this.emitSnapshot();
    }
  }

  handleUserAction(action: string): void {
    switch (action) {
      case 'respond':
        if (
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.options = [];
          this.question = null;
          this.navigable = false;
          this.cursorIndex = 0;
          this.toolInput = null;
          this.transition(State.PROCESSING, 'user_response', 'user');
        }
        break;

      case 'select_option':
        if (
          this.state === State.AWAITING_OPTION ||
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.options = [];
          this.question = null;
          this.navigable = false;
          this.cursorIndex = 0;
          this.toolInput = null;
          this.transition(State.PROCESSING, 'user_selection', 'user');
        }
        break;

      case 'send_prompt':
        if (this.state === State.IDLE) {
          this.suggestedPrompt = null;
          this.transition(State.PROCESSING, 'user_prompt_submit', 'hook');
        }
        break;

      case 'interrupt':
        this.currentTool = null;
        this.toolInput = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.navigable = false;
        this.cursorIndex = 0;
        this.transition(State.IDLE, 'interrupt', 'user');
        break;

      default:
        break;
    }
  }

  /** Tool activity (PreToolUse/PostToolUse and Codex equivalents) is dismissal
   *  evidence for AWAITING_* only after a short grace period: a parallel tool
   *  finishing — or a hook curl landing late — can arrive while a just-drawn
   *  prompt is genuinely open, and dismissing it would hide an answerable
   *  prompt from every device. A keyboard-answered prompt always produces
   *  later tool activity or a stop, so a dismissal skipped here is retried by
   *  the next hook. From IDLE (dropped user_prompt_submit) there is no prompt
   *  to protect, so recovery is immediate. */
  private recoverProcessingFromToolActivity(): void {
    const inAwaiting =
      this.state === State.AWAITING_PERMISSION ||
      this.state === State.AWAITING_OPTION ||
      this.state === State.AWAITING_DIFF;
    if (inAwaiting && Date.now() - this.awaitingEnteredAt < AWAITING_TOOL_DISMISS_GRACE_MS) {
      debug('SM', 'tool_activity within awaiting grace — keeping prompt');
      return;
    }
    this.transition(State.PROCESSING, 'tool_activity', 'hook');
  }

  transition(to: State, trigger: string, source: string): void {
    const valid = transitions.some(
      (t: StateTransition) =>
        (t.from === this.state || t.from === '*') &&
        t.to === to &&
        t.trigger === trigger,
    );

    if (!valid) {
      debug('SM', `Invalid transition blocked: ${this.state} -> ${to} (trigger: ${trigger}, source: ${source})`);
      return;
    }

    const prev = this.state;
    this.state = to;

    // Leaving AWAITING_*: the prompt on screen is gone, so the prompt fields
    // must not outlive it — a stale answerable question on a device would
    // inject keystrokes into a running turn. Cleared here (not per-caller) so
    // every exit path agrees.
    if (
      (prev === State.AWAITING_OPTION ||
        prev === State.AWAITING_PERMISSION ||
        prev === State.AWAITING_DIFF) &&
      to !== prev
    ) {
      this.options = [];
      this.question = null;
      this.navigable = false;
      this.cursorIndex = 0;
      this.cursorAuthority = 'pty';
    }
    if (
      to !== prev &&
      (to === State.AWAITING_OPTION ||
        to === State.AWAITING_PERMISSION ||
        to === State.AWAITING_DIFF)
    ) {
      this.awaitingEnteredAt = Date.now();
    }

    // Manage stuck-state timer. PROCESSING recovers after STUCK_TIMEOUT_MS
    // (Claude seems hung). AWAITING_* get NO wall-clock backstop: an unanswered
    // permission/option/diff prompt is a genuine, indefinitely-valid wait — the
    // user may be away for hours. A blind timer can't tell "away" from "parser
    // missed the recovery", so it wrongly forced a real prompt to IDLE and made
    // the session's creature vanish from the dashboard. Awaiting only leaves via
    // a real signal (hook tool_activity / stop / user_prompt_submit, parser
    // spinner_start / idle_detected where still emitted, or a user response);
    // a truly-dead session is reaped by liveness (PID death / /health grace),
    // not by this timer.
    this.resetStuckTimer();
    if (to === State.PROCESSING) {
      this.armStuckTimer(STUCK_TIMEOUT_MS);
    }

    if (prev !== to) {
      debug('SM', `${prev} -> ${to} (trigger: ${trigger}, source: ${source})`);
      this.emitSnapshot();
    }
  }

  /** Reset the stuck timer on PTY activity. Only PROCESSING carries a hang
   *  timeout; AWAITING_* has no wall-clock backstop (see transition()), so there
   *  is nothing to re-arm for those states. */
  onPtyActivity(): void {
    if (!this.stuckTimer) return;
    if (this.state === State.PROCESSING) {
      debug('SM', 'PTY activity — resetting PROCESSING stuck timer');
      this.armStuckTimer(STUCK_TIMEOUT_MS);
    }
  }

  /** (Re)arm the stuck-state backstop. On fire, clears tool/prompt metadata and
   *  recovers to IDLE — the safe terminal state for any hung/abandoned state. */
  private armStuckTimer(timeoutMs: number): void {
    this.resetStuckTimer();
    const fromState = this.state;
    this.stuckTimer = setTimeout(() => {
      debug('SM', `Stuck timeout: ${fromState} for >${timeoutMs / 1000}s, recovering to IDLE`);
      this.currentTool = null;
      this.toolInput = null;
      this.toolProgress = null;
      this.options = [];
      this.question = null;
      this.navigable = false;
      this.cursorIndex = 0;
      this.transition(State.IDLE, 'stuck_timeout', 'internal');
    }, timeoutMs);
  }

  private resetStuckTimer(): void {
    if (this.stuckTimer) {
      clearTimeout(this.stuckTimer);
      this.stuckTimer = null;
    }
  }

  private emitSnapshot(): void {
    this.emit('state_changed', this.getSnapshot());
  }

  /** Update cursor index with source discrimination to prevent race conditions.
   *  'optimistic' — from StreamDeck dial navigation (immediate, may be overridden by PTY)
   *  'pty' — from parser cursor_update (authoritative, but may be stale during rapid navigation)
   */
  updateCursorIndex(idx: number, source: 'pty' | 'optimistic' = 'pty'): void {
    if (source === 'optimistic') {
      this.cursorIndex = idx;
      this.cursorAuthority = 'optimistic';
      this.optimisticCursorTime = Date.now();
      this.emitSnapshot();
    } else {
      // PTY confirmation: always accept unless very recent optimistic update
      const elapsed = Date.now() - this.optimisticCursorTime;
      if (this.cursorAuthority === 'pty' || elapsed > 200) {
        this.cursorIndex = idx;
        this.cursorAuthority = 'pty';
        this.emitSnapshot();
      }
      // else: suppress stale PTY value (optimistic update is fresher)
    }
  }

  getCursorIndex(): number {
    return this.cursorIndex;
  }

  getOptionsCount(): number {
    return this.options.length;
  }

  getSnapshot(): StateSnapshot {
    const usage = this.usageTracker.getSnapshot();
    return {
      state: this.state,
      permissionMode: this.permissionMode,
      currentTool: this.currentTool,
      toolInput: this.toolInput,
      toolProgress: this.toolProgress,
      options: this.options,
      question: this.question,
      navigable: this.navigable,
      cursorIndex: this.cursorIndex,
      projectName: this.projectName,
      modelName: this.modelName,
      effortLevel: this.effortLevel,
      billingType: this.billingType,
      sessionDurationSec: usage.sessionDurationSec,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      toolCalls: usage.toolCalls,
      estimatedCostUsd: usage.estimatedCostUsd,
      sessionPercent: usage.sessionPercent,
      costSpent: usage.costSpent,
      costLimit: usage.costLimit,
      resetTime: usage.resetTime,
      resetDate: usage.resetDate,
      suggestedPrompt: this.suggestedPrompt,
      remoteUrl: this.remoteUrl,
    };
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.emitSnapshot();
  }

  getState(): State {
    return this.state;
  }

  /** Get last valid suggested prompt (for reconnection recovery when suggestedPrompt is already null) */
  getLastValidSuggestedPrompt(): string | null {
    return this.lastValidSuggestedPrompt;
  }
}
