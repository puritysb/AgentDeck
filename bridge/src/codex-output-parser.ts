import stripAnsi from 'strip-ansi';
import { EventEmitter } from 'events';
import type { PromptOption } from './types.js';
import { debug } from './logger.js';

/**
 * Codex CLI output parser — detects state changes from Ink TUI PTY output.
 *
 * Unlike Claude Code's OutputParser which matches specific spinner characters (✢✳✶✻✽),
 * Codex CLI uses Ink (React-based TUI) with braille spinners and structured approval prompts.
 *
 * Emits the same event vocabulary as OutputParser for StateMachine compatibility:
 * - spinner_start, spinner_stop, idle, permission_prompt, option_prompt
 * - tool_action, project_name, model_info
 */

// Braille spinner characters used by Ink/ora
const BRAILLE_SPINNERS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

// Codex processing indicators
// Real PTY output: "Working(0s • esc to interrupt)" and incremental "•Working•orking•rking•"
const THINKING_TEXT = /\b(?:Thinking|Working|Processing|Generating|Waiting)\b/i;
// "Working" followed by timing info "(0s •" or "(1m 2s •"
const CODEX_WORKING_STATUS = /Working\s*\(\d+[sm]?\s*•/;

// Codex idle prompt — ›(U+203A) is the actual Codex prompt char
// › can appear mid-line (after status text); > and ❯ only at line start
const IDLE_PROMPT = /›\s|^[❯>]\s/m;
// Codex status line with model info: "› prompt   gpt-5.4 medium · 47% left · ~/path"
const CODEX_STATUS_LINE = /[❯›]\s.*(?:gpt-|o\d|codex)[\w.-]*\s.*·.*~/;

// Sandbox approval prompts. Require rendered affordance lines: command output
// quoting approval words must not become an invented Allow/Deny interaction.
const APPROVAL_ALLOW = /^[ \t]*(?:Allow[^\r\n?]*\?[ \t]*)?(?:Allow|approve)[ \t]+(?:Deny|deny)[ \t]*$/im;
const APPROVAL_YN = /(?:\(y\)es[ \t]*\/?[ \t]*\(n\)o|\[Y\/n\]|\[y\/N\])[ \t]*[?:]?[ \t]*$/im;
const APPROVAL_ALWAYS = /^[ \t]*(?:[›❯>][ \t]*)?(?:\d+\.[ \t]*)?(?:Allow[ \t]+once|Always[ \t]+allow)(?:[ \t]+(?:Always[ \t]+allow|Deny))*[ \t]*$/im;
const CODEX_COMMAND_APPROVAL =
  /^[ \t]*(?:Would you like to run the following command\?|Press enter to confirm or esc to cancel)[ \t]*$|^[ \t]*(?:[›❯>][ \t]*)?\d+\.[ \t]*(?:Yes,[ \t]*proceed[ \t]*\(y\)|Yes,[ \t]+and[ \t]+don['’]t[ \t]+ask[ \t]+again|No,[ \t]+and[ \t]+tell[ \t]+Codex)/im;

// Tool/command execution indicators
const TOOL_RUNNING = /(?:Running|Executing|Ran)(?:\s+in\s+\S+)?:\s*[`"]?(.+?)[`"]?\s*$/m;
const FILE_OPERATION = /(?:Reading|Writing|Creating|Deleting|Editing|Patching)\s+(.+)/i;

// Model info from Codex startup, status line, or prompt line
// e.g. "gpt-5.4 medium · 47% left" or "model: o3"
const MODEL_INFO = /(?:model|using)\s*:?\s*(gpt-[\w.-]+|o\d[\w.-]*|codex[\w.-]*)/i;
const CODEX_MODEL_IN_STATUS = /(gpt-[\w.-]+|o\d[\w.-]*|codex[\w.-]*)\s+(?:high|medium|low)\s*·/;

// Project/working directory
const WORKDIR = /(?:Working\s+(?:directory|in)|cwd)\s*:?\s*(.+)/i;
const PROJECT_DIR = /[~\/][\w.\-\/]+\/(\w[\w.\-]*)\s*$/m;

const SPINNER_DEBOUNCE_MS = 2000;
const IDLE_DEBOUNCE_MS = 300;
const OPTION_DEBOUNCE_MS = 150;

// Codex's Ink TUI redraws the screen frequently; the same "Running: cmd" line
// can land in several PTY chunks within a single tool invocation, producing
// duplicate tool_action emits. Suppress repeats of the same (tool, args) for
// 4 s. The window is reset at turn boundaries (idle / synthetic spinner_stop)
// so the same command run twice in a row across turns still emits twice.
const TOOL_ACTION_DEDUP_WINDOW_MS = 4000;

export class CodexOutputParser extends EventEmitter {
  private buffer = '';
  private spinnerActive = false;
  private spinnerTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private optionTimer: ReturnType<typeof setTimeout> | null = null;
  private projectName: string | null = null;
  private modelName: string | null = null;
  private seenFirstIdle = false;
  private pendingAnsi = '';
  private lastToolKey: string | null = null;
  private lastToolTs = 0;

  feed(rawData: string): void {
    const data = this.pendingAnsi + rawData;
    this.pendingAnsi = '';

    // Buffer incomplete ANSI escape sequences
    const lastEsc = data.lastIndexOf('\x1b');
    if (lastEsc !== -1 && lastEsc >= data.length - 20) {
      const tail = data.slice(lastEsc);
      if (/^\x1b\[[\d;:]*$/.test(tail) || /^\x1b$/.test(tail) || /^\x1b\](?:(?!\x1b\\|\x07).)*$/.test(tail)) {
        this.pendingAnsi = tail;
        const complete = data.slice(0, lastEsc);
        if (complete.length === 0) return;
        return this.processFeed(complete);
      }
    }
    this.processFeed(data);
  }

  private processFeed(rawData: string): void {
    const spaced = rawData
      .replace(/\x1b\[\d*C/g, ' ')
      .replace(/\x1b\[\d*(?:;\d*)?[Hf]/g, '\n')
      .replace(/\x1b\[\d*[ABEF]/g, '\n');
    const clean = stripAnsi(spaced);
    this.buffer += clean;

    if (this.buffer.length > 8192) {
      this.buffer = this.buffer.slice(-4096);
    }

    const preview = clean.replace(/[\n\r]/g, '\\n').replace(/[\x00-\x1f]/g, '?').slice(0, 100);
    if (preview.trim().length > 0) {
      debug('CodexParser', `feed(${clean.length}): "${preview}"`);
    }

    this.detectPatterns(clean);
  }

  private detectPatterns(chunk: string): void {
    // --- Always extract metadata ---
    this.parseToolAction(chunk);
    this.parseProjectName(chunk);
    this.parseModelInfo(chunk);

    // --- Pre-scan ---
    const haystack = this.buffer.slice(-4096);
    const hasIdlePrompt = IDLE_PROMPT.test(chunk) || CODEX_STATUS_LINE.test(chunk);
    const hasApproval =
      APPROVAL_ALLOW.test(chunk) ||
      APPROVAL_YN.test(chunk) ||
      APPROVAL_ALWAYS.test(chunk) ||
      CODEX_COMMAND_APPROVAL.test(chunk);

    // --- Spinner + prompt handling ---
    const hasSpinner = BRAILLE_SPINNERS.test(chunk) || THINKING_TEXT.test(chunk) || CODEX_WORKING_STATUS.test(chunk);

    // Approval prompt → AWAITING_PERMISSION
    if (hasApproval) {
      if (this.spinnerTimer) { clearTimeout(this.spinnerTimer); this.spinnerTimer = null; }
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

      if (this.spinnerActive) {
        this.spinnerActive = false;
        debug('CodexParser', 'EMIT spinner_stop (approval detected)');
        this.emit('spinner_stop');
      }

      if (this.optionTimer) clearTimeout(this.optionTimer);
      this.optionTimer = setTimeout(() => {
        this.optionTimer = null;
        debug('CodexParser', 'EMIT permission_prompt');
        this.emit('permission_prompt', {
          question: this.extractApprovalQuestion(haystack),
          options: this.extractApprovalOptions(haystack),
          navigable: this.hasNavigableApprovalOptions(haystack),
          cursorIndex: this.extractApprovalCursorIndex(haystack),
        });
      }, OPTION_DEBOUNCE_MS);
      return;
    }

    // Idle prompt detected
    if (hasIdlePrompt) {
      if (!this.seenFirstIdle) {
        this.seenFirstIdle = true;
        debug('CodexParser', 'First idle prompt detected');
      }

      if (this.spinnerTimer) { clearTimeout(this.spinnerTimer); this.spinnerTimer = null; }

      if (this.spinnerActive) {
        this.spinnerActive = false;
        debug('CodexParser', 'EMIT spinner_stop (idle detected)');
        this.emit('spinner_stop');
      }

      // Debounce idle emission. `source: 'prompt'` marks this as a genuine
      // idle (the input prompt actually appeared), as opposed to the
      // spinner-timeout synthetic idles emitted below. Only the prompt
      // source is a reliable turn-end signal for the bridge.
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        debug('CodexParser', 'EMIT idle (prompt)');
        this.resetToolDedup();
        this.emit('idle', { source: 'prompt' });
      }, IDLE_DEBOUNCE_MS);
      return;
    }

    // Spinner / processing detection
    if (hasSpinner && this.seenFirstIdle) {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

      if (!this.spinnerActive) {
        // Debounce: small spinner chunks only → wait before confirming
        if (this.spinnerTimer) clearTimeout(this.spinnerTimer);
        this.spinnerTimer = setTimeout(() => {
          if (!this.spinnerActive) {
            this.spinnerActive = true;
            debug('CodexParser', 'EMIT spinner_start');
            this.emit('spinner_start');
            // Schedule stop timeout in case no more spinner data arrives
            this.spinnerTimer = setTimeout(() => {
              this.spinnerTimer = null;
              if (this.spinnerActive) {
                this.spinnerActive = false;
                debug('CodexParser', 'EMIT spinner_stop (timeout)');
                this.emit('spinner_stop');
                this.resetToolDedup();
                // Synthetic idle: spinner data went silent. This often means
                // a tool is running, not that the turn ended. Mark the source
                // so the bridge can distinguish from genuine prompt idles.
                this.emit('idle', { source: 'timeout' });
              }
            }, SPINNER_DEBOUNCE_MS);
          }
        }, 100);
      } else {
        // Already active — reset the stop timeout
        if (this.spinnerTimer) clearTimeout(this.spinnerTimer);
        this.spinnerTimer = setTimeout(() => {
          this.spinnerTimer = null;
          if (this.spinnerActive) {
            this.spinnerActive = false;
            debug('CodexParser', 'EMIT spinner_stop (timeout)');
            this.emit('spinner_stop');
            this.resetToolDedup();
            this.emit('idle', { source: 'timeout' });
          }
        }, SPINNER_DEBOUNCE_MS);
      }
    }
  }

  private extractApprovalOptions(text: string): PromptOption[] {
    const numbered = this.extractNumberedApprovalOptions(text);
    if (numbered.length > 0) return numbered;

    const options: PromptOption[] = [];
    const push = (label: string, shortcut?: string) => {
      options.push({ index: options.length, label, shortcut });
    };
    if (/Allow\s+once/i.test(text)) push('Allow once', 'y');
    if (/Always\s+allow/i.test(text)) push('Always allow', 'a');
    if (/\bDeny\b/i.test(text)) push('Deny', 'n');
    if (/\(y\)es/i.test(text)) push('Yes', 'y');
    if (/\(n\)o/i.test(text)) push('No', 'n');
    if (options.length === 0) {
      push('Allow', 'y');
      push('Deny', 'n');
    }
    return options;
  }

  private extractNumberedApprovalOptions(text: string): PromptOption[] {
    const options: PromptOption[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      const match = line.match(/^(?:[›❯>]\s*)?(\d+)\.\s+(.+)$/);
      if (!match) continue;
      const index = Number(match[1]) - 1;
      if (!Number.isFinite(index) || index < 0) continue;
      let label = match[2].trim();
      const shortcut = label.match(/\((y|p|n|esc)\)\s*$/i)?.[1]?.toLowerCase();
      label = label
        .replace(/\s*\((?:y|p|n|esc)\)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (label) options.push({ index, label, shortcut });
    }
    return options.sort((a, b) => a.index - b.index);
  }

  private hasNavigableApprovalOptions(text: string): boolean {
    return /^\s*[›❯>]\s*\d+\.\s+/m.test(text);
  }

  private extractApprovalCursorIndex(text: string): number {
    const line = text.split(/\r?\n/).find((l) => /^\s*[›❯>]\s*\d+\.\s+/.test(l));
    const match = line?.match(/^\s*[›❯>]\s*(\d+)\.\s+/);
    const index = match ? Number(match[1]) - 1 : 0;
    return Number.isFinite(index) && index >= 0 ? index : 0;
  }

  private extractApprovalQuestion(text: string): string | null {
    const commandMatch = text.match(/^\s*\$\s+(.+)$/m);
    if (commandMatch) return commandMatch[1].trim();
    if (/Would you like to run the following command\?/i.test(text)) {
      return 'Run command?';
    }
    return null;
  }

  private parseToolAction(chunk: string): void {
    const runMatch = chunk.match(TOOL_RUNNING);
    if (runMatch) {
      this.emitToolAction('shell', runMatch[1]);
      return;
    }
    const fileMatch = chunk.match(FILE_OPERATION);
    if (fileMatch) {
      const op = (chunk.match(/^(Reading|Writing|Creating|Deleting|Editing|Patching)/i)?.[1] ?? 'file').toLowerCase();
      this.emitToolAction(op, fileMatch[1]);
    }
  }

  private emitToolAction(tool: string, args: string): void {
    const key = `${tool} ${args.trim()}`;
    const now = Date.now();
    if (this.lastToolKey === key && now - this.lastToolTs < TOOL_ACTION_DEDUP_WINDOW_MS) {
      return;
    }
    this.lastToolKey = key;
    this.lastToolTs = now;
    debug('CodexParser', `EMIT tool_action: ${tool} ${args}`);
    this.emit('tool_action', { tool, args, toolName: tool, toolArgs: args });
  }

  private resetToolDedup(): void {
    this.lastToolKey = null;
    this.lastToolTs = 0;
  }

  private parseProjectName(chunk: string): void {
    if (this.projectName) return;
    const wdMatch = chunk.match(WORKDIR);
    if (wdMatch) {
      const dirMatch = wdMatch[1].match(/\/(\w[\w.\-]*)$/);
      if (dirMatch) {
        this.projectName = dirMatch[1];
        debug('CodexParser', `EMIT project_name: ${this.projectName}`);
        this.emit('project_name', { name: this.projectName });
        return;
      }
    }
    const dirMatch = chunk.match(PROJECT_DIR);
    if (dirMatch) {
      this.projectName = dirMatch[1];
      debug('CodexParser', `EMIT project_name: ${this.projectName}`);
      this.emit('project_name', { name: this.projectName });
    }
  }

  private parseModelInfo(chunk: string): void {
    const match = chunk.match(MODEL_INFO) || chunk.match(CODEX_MODEL_IN_STATUS);
    if (match && match[1] !== this.modelName) {
      this.modelName = match[1];
      debug('CodexParser', `EMIT model_info: ${this.modelName}`);
      this.emit('model_info', { model: this.modelName });
    }
  }

  getProjectName(): string | null {
    return this.projectName;
  }
}
