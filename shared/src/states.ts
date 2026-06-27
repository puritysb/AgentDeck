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
  // Recovery: spinner_start from awaiting states (user responded via keyboard, not Stream Deck)
  { from: State.AWAITING_PERMISSION, to: State.PROCESSING, trigger: 'spinner_start', source: 'pty' },
  { from: State.AWAITING_OPTION, to: State.PROCESSING, trigger: 'spinner_start', source: 'pty' },
  { from: State.AWAITING_DIFF, to: State.PROCESSING, trigger: 'spinner_start', source: 'pty' },
  // stuck_timeout: PROCESSING recovers after STUCK_TIMEOUT_MS; AWAITING_* have a
  // much longer backstop (AWAITING_STUCK_TIMEOUT_MS) for the rare case where the
  // PTY parser misses the recovery spinner/idle and no follow-up hook arrives.
  { from: State.PROCESSING, to: State.IDLE, trigger: 'stuck_timeout', source: 'internal' },
  { from: State.AWAITING_PERMISSION, to: State.IDLE, trigger: 'stuck_timeout', source: 'internal' },
  { from: State.AWAITING_OPTION, to: State.IDLE, trigger: 'stuck_timeout', source: 'internal' },
  { from: State.AWAITING_DIFF, to: State.IDLE, trigger: 'stuck_timeout', source: 'internal' },
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
