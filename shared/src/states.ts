export enum State {
  DISCONNECTED = 'disconnected',
  IDLE = 'idle',
  PROCESSING = 'processing',
  AWAITING_PERMISSION = 'awaiting_permission',
  AWAITING_OPTION = 'awaiting_option',
  AWAITING_DIFF = 'awaiting_diff',
}

export enum PermissionMode {
  DEFAULT = 'default',
  PLAN = 'plan',
  ACCEPT_EDITS = 'acceptEdits',
  DONT_ASK = 'dontAsk',
  BYPASS_PERMISSIONS = 'bypassPermissions',
}

export type TransitionSource = 'hook' | 'pty' | 'user' | 'internal';

export interface StateTransition {
  from: State | '*';
  to: State;
  trigger: string;
  source: TransitionSource;
  /** Why this edge exists, carried into the generated mirrors.
   *
   *  The rationale for a transition is the part that is expensive to
   *  rediscover and the part a mirror silently loses — the Swift daemon's
   *  copy of this table used to restate it in hand-written comments, which is
   *  a second source of truth for the reasoning even when the rows agree. A
   *  note attaches to the first edge of a group and covers the run. */
  note?: string;
}

export const transitions: StateTransition[] = [
  { from: State.DISCONNECTED, to: State.IDLE, trigger: 'session_start', source: 'hook' },
  { from: State.IDLE, to: State.PROCESSING, trigger: 'user_prompt_submit', source: 'hook' },
  { from: State.IDLE, to: State.PROCESSING, trigger: 'spinner_start', source: 'pty' },
  { from: State.PROCESSING, to: State.IDLE, trigger: 'stop', source: 'hook' },
  { from: State.PROCESSING, to: State.IDLE, trigger: 'idle_detected', source: 'pty' },
  { from: State.AWAITING_PERMISSION, to: State.IDLE, trigger: 'idle_detected', source: 'pty' },
  { from: State.AWAITING_OPTION, to: State.IDLE, trigger: 'idle_detected', source: 'pty' },
  { from: State.AWAITING_DIFF, to: State.IDLE, trigger: 'idle_detected', source: 'pty' },
  { from: State.PROCESSING, to: State.AWAITING_PERMISSION, trigger: 'permission_prompt', source: 'pty' },
  { from: State.IDLE, to: State.AWAITING_PERMISSION, trigger: 'permission_prompt', source: 'pty' },
  { from: State.PROCESSING, to: State.AWAITING_OPTION, trigger: 'option_ui_detected', source: 'pty' },
  { from: State.IDLE, to: State.AWAITING_OPTION, trigger: 'option_ui_detected', source: 'pty' },
  { from: State.PROCESSING, to: State.AWAITING_DIFF, trigger: 'diff_ui_detected', source: 'pty' },
  { from: State.IDLE, to: State.AWAITING_DIFF, trigger: 'diff_ui_detected', source: 'pty' },
  { from: State.AWAITING_PERMISSION, to: State.PROCESSING, trigger: 'user_response', source: 'user' },
  { from: State.AWAITING_PERMISSION, to: State.PROCESSING, trigger: 'user_selection', source: 'user' },
  { from: State.AWAITING_OPTION, to: State.PROCESSING, trigger: 'user_selection', source: 'user' },
  { from: State.AWAITING_DIFF, to: State.PROCESSING, trigger: 'user_response', source: 'user' },
  { from: State.AWAITING_DIFF, to: State.PROCESSING, trigger: 'user_selection', source: 'user' },
  {
    from: State.AWAITING_PERMISSION, to: State.PROCESSING, trigger: 'spinner_start', source: 'pty',
    note: 'Recovery: spinner_start from awaiting states (user responded via keyboard,\n'
      + 'not a device). Only adapters that still emit parser lifecycle events\n'
      + '(OpenCode, OpenClaw) can drive these; Claude/Codex adapters forward\n'
      + 'terminal_ui prompts only, so their keyboard-answer recovery is hook-based.',
  },
  { from: State.AWAITING_OPTION, to: State.PROCESSING, trigger: 'spinner_start', source: 'pty' },
  { from: State.AWAITING_DIFF, to: State.PROCESSING, trigger: 'spinner_start', source: 'pty' },
  {
    from: State.AWAITING_PERMISSION, to: State.PROCESSING, trigger: 'tool_activity', source: 'hook',
    note: 'Hook exits from AWAITING_*: a prompt answered at the keyboard produces no\n'
      + 'user/device action and (for Claude/Codex) no parser signal, so the\n'
      + 'lifecycle hooks that keep firing are the only truthful dismissal evidence:\n'
      + 'tool activity means the turn is running again, stop means the turn ended,\n'
      + 'and a new user_prompt_submit means a new turn started. Without these the\n'
      + 'session wedges in AWAITING_* forever once the user touches the terminal.',
  },
  { from: State.AWAITING_OPTION, to: State.PROCESSING, trigger: 'tool_activity', source: 'hook' },
  { from: State.AWAITING_DIFF, to: State.PROCESSING, trigger: 'tool_activity', source: 'hook' },
  { from: State.AWAITING_PERMISSION, to: State.IDLE, trigger: 'stop', source: 'hook' },
  { from: State.AWAITING_OPTION, to: State.IDLE, trigger: 'stop', source: 'hook' },
  { from: State.AWAITING_DIFF, to: State.IDLE, trigger: 'stop', source: 'hook' },
  { from: State.AWAITING_PERMISSION, to: State.PROCESSING, trigger: 'user_prompt_submit', source: 'hook' },
  { from: State.AWAITING_OPTION, to: State.PROCESSING, trigger: 'user_prompt_submit', source: 'hook' },
  { from: State.AWAITING_DIFF, to: State.PROCESSING, trigger: 'user_prompt_submit', source: 'hook' },
  {
    from: State.IDLE, to: State.PROCESSING, trigger: 'tool_activity', source: 'hook',
    note: 'Hook-miss recovery: tool activity arriving while IDLE proves a turn is\n'
      + 'running even when its user_prompt_submit was dropped.',
  },
  {
    from: State.PROCESSING, to: State.IDLE, trigger: 'stuck_timeout', source: 'internal',
    note: 'stuck_timeout: only PROCESSING recovers after STUCK_TIMEOUT_MS (Claude hung).\n'
      + 'AWAITING_* intentionally have NO wall-clock backstop — an unanswered prompt\n'
      + 'is a genuine, indefinitely-valid wait (the user may be away); it only leaves\n'
      + 'via a real signal (hook tool_activity/stop/user_prompt_submit, parser\n'
      + 'spinner_start/idle_detected where still emitted, or a user response), and\n'
      + 'a truly-dead session is reaped by liveness, not a timer. A blind awaiting\n'
      + 'timer wrongly forced real prompts to IDLE and vanished them from dashboards.',
  },
  { from: '*', to: State.DISCONNECTED, trigger: 'session_end', source: 'hook' },
  { from: '*', to: State.IDLE, trigger: 'interrupt', source: 'user' },
];

export interface PromptOption {
  index: number;
  label: string;
  shortcut?: string;
  recommended?: boolean;
  selected?: boolean;
  kind?: 'choice' | 'freeform_input';
}

export interface StateSnapshot {
  state: State;
  permissionMode: PermissionMode;
  currentTool: string | null;
  toolInput: string | null;
  toolProgress: string | null;
  options: PromptOption[];
  question: string | null;
  navigable: boolean;
  cursorIndex: number;
  projectName: string | null;
  modelName: string | null;
  effortLevel: string | null;
  billingType: import('./protocol.js').BillingType;
  sessionDurationSec: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  estimatedCostUsd: number | null;
  sessionPercent: number | null;
  costSpent: number | null;
  costLimit: number | null;
  resetTime: string | null;
  resetDate: string | null;
  suggestedPrompt: string | null;
  remoteUrl: string | null;
}
