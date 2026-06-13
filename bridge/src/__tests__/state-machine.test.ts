import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateMachine } from '../state-machine.js';
import { UsageTracker } from '../usage-tracker.js';
import { State, PermissionMode } from '../types.js';

function createSM() {
  const tracker = new UsageTracker();
  const sm = new StateMachine(tracker);
  return sm;
}

/** Boot state machine to IDLE (simulating session start) */
function bootToIdle() {
  const sm = createSM();
  sm.handleHookEvent('SessionStart', {});
  expect(sm.getState()).toBe(State.IDLE);
  return sm;
}

describe('StateMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // === Basic Transitions ===

  describe('basic transitions', () => {
    it('starts in DISCONNECTED', () => {
      const sm = createSM();
      expect(sm.getState()).toBe(State.DISCONNECTED);
    });

    it('SessionStart → IDLE', () => {
      const sm = createSM();
      sm.handleHookEvent('SessionStart', {});
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('UserPromptSubmit → PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('Stop → IDLE from PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleHookEvent('Stop', {});
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('SessionEnd → DISCONNECTED from any state', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleHookEvent('SessionEnd', {});
      expect(sm.getState()).toBe(State.DISCONNECTED);
    });
  });

  // === Permission Flow ===

  describe('permission flow', () => {
    it('permission_prompt → AWAITING_PERMISSION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
        question: 'Allow?',
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);
    });

    it('user respond → PROCESSING from AWAITING_PERMISSION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      sm.handleUserAction('respond');
      expect(sm.getState()).toBe(State.PROCESSING);
    });
  });

  // === Option Flow ===

  describe('option flow', () => {
    it('option_prompt → AWAITING_OPTION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_OPTION);
    });

    it('select_option → PROCESSING from AWAITING_OPTION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }],
      });
      sm.handleUserAction('select_option');
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('option_prompt carries the question into the snapshot', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
        question: 'Which approach do you prefer?',
      });
      expect(sm.getSnapshot().question).toBe('Which approach do you prefer?');
    });
  });

  // === Diff Flow ===

  describe('diff flow', () => {
    it('diff_prompt → AWAITING_DIFF', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('diff_prompt', {
        options: [{ index: 0, label: 'Accept' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_DIFF);
    });

    it('respond → PROCESSING from AWAITING_DIFF', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('diff_prompt', {
        options: [{ index: 0, label: 'Accept' }],
      });
      sm.handleUserAction('respond');
      expect(sm.getState()).toBe(State.PROCESSING);
    });
  });

  // === Interrupt ===

  describe('interrupt', () => {
    it('interrupt → IDLE from PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleUserAction('interrupt');
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('interrupt → IDLE from AWAITING_PERMISSION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      sm.handleUserAction('interrupt');
      expect(sm.getState()).toBe(State.IDLE);
    });
  });

  // === Strict Transition Validation ===

  describe('strict transitions', () => {
    it('allows IDLE → AWAITING_PERMISSION (prompt without spinner)', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);
    });

    it('blocks invalid transition: DISCONNECTED → PROCESSING', () => {
      const sm = createSM();
      sm.handleHookEvent('UserPromptSubmit', {});
      expect(sm.getState()).toBe(State.DISCONNECTED);
    });

    it('allows wildcard session_end from any state', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);
      sm.handleHookEvent('SessionEnd', {});
      expect(sm.getState()).toBe(State.DISCONNECTED);
    });
  });

  // === Stuck Timeout ===

  describe('stuck timeout', () => {
    it('PROCESSING for >5min → auto-recovery to IDLE', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      expect(sm.getState()).toBe(State.PROCESSING);

      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('AWAITING_PERMISSION survives the 5min PROCESSING window but recovers after the 10min backstop', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);

      // Does not fire at the shorter PROCESSING threshold — a long user pause is legitimate.
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);

      // Backstop fires after the full 10min so a parser-missed recovery can't strand it.
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('AWAITING_OPTION recovers after the 10min backstop', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_OPTION);

      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.AWAITING_OPTION);

      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('AWAITING_DIFF recovers after the 10min backstop', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('diff_prompt', {
        options: [{ index: 0, label: 'Accept' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_DIFF);

      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.AWAITING_DIFF);

      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('AWAITING backstop resets when the user responds (no false recovery)', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);

      // User responds via keyboard before the backstop — PTY spinner recovers to PROCESSING.
      vi.advanceTimersByTime(9 * 60 * 1000);
      sm.handleParserEvent('spinner_start', {});
      expect(sm.getState()).toBe(State.PROCESSING);

      // The original awaiting backstop must not fire now that we've moved on.
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('AWAITING backstop re-arms on PTY activity (silence-based, not a hard cap from entry)', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);

      // PTY activity at 9min (prompt still rendering / user reading) re-arms the timer.
      vi.advanceTimersByTime(9 * 60 * 1000);
      sm.onPtyActivity();

      // 5 more min (14 total since entry) — a hard cap would have fired; the re-arm keeps it.
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);

      // 10min of genuine silence since the last activity — now the backstop fires.
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('timer resets on state change before timeout', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      expect(sm.getState()).toBe(State.PROCESSING);

      // Advance 4 min, then trigger Stop → IDLE → no timeout
      vi.advanceTimersByTime(4 * 60 * 1000);
      sm.handleHookEvent('Stop', {});
      expect(sm.getState()).toBe(State.IDLE);

      // Advance past the original 5 min mark — should still be IDLE
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('no timeout in IDLE state', () => {
      const sm = bootToIdle();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(sm.getState()).toBe(State.IDLE);
    });
  });

  // === Parser Events ===

  describe('parser events', () => {
    it('spinner_start → PROCESSING from IDLE', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('spinner_start');
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('spinner_stop → IDLE from PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('spinner_start');
      sm.handleParserEvent('spinner_stop');
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('idle → IDLE from PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('idle');
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('mode_change updates permission mode', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('mode_change', { mode: 'plan' });
      expect(sm.getSnapshot().permissionMode).toBe(PermissionMode.PLAN);

      sm.handleParserEvent('mode_change', { mode: 'acceptEdits' });
      expect(sm.getSnapshot().permissionMode).toBe(PermissionMode.ACCEPT_EDITS);

      sm.handleParserEvent('mode_change', { mode: 'default' });
      expect(sm.getSnapshot().permissionMode).toBe(PermissionMode.DEFAULT);
    });
  });

  // === Snapshot ===

  describe('snapshot', () => {
    it('emits state_changed on transitions', () => {
      const sm = createSM();
      const snapshots: any[] = [];
      sm.on('state_changed', (s: any) => snapshots.push(s));

      sm.handleHookEvent('SessionStart', {});
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[snapshots.length - 1].state).toBe(State.IDLE);
    });

    it('includes tool info in snapshot', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleHookEvent('PreToolUse', { tool_name: 'Read' });

      const snap = sm.getSnapshot();
      expect(snap.currentTool).toBe('Read');
      expect(snap.toolProgress).toBe('Using Read');
    });

    it('clears tool info on PostToolUse', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleHookEvent('PreToolUse', { tool_name: 'Read' });
      sm.handleHookEvent('PostToolUse', {});

      const snap = sm.getSnapshot();
      expect(snap.currentTool).toBeNull();
      expect(snap.toolProgress).toBeNull();
    });

    it('includes project name and model', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('project_name', { name: 'AgentDeck' });
      sm.handleParserEvent('model_info', { model: 'claude-opus-4' });

      const snap = sm.getSnapshot();
      expect(snap.projectName).toBe('AgentDeck');
      expect(snap.modelName).toBe('claude-opus-4');
    });
  });

  // === Billing Type Detection ===

  describe('billingType detection', () => {
    it('defaults to unknown', () => {
      const sm = bootToIdle();
      expect(sm.getSnapshot().billingType).toBe('unknown');
    });

    it('detects subscription from "Claude Max" plan', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('model_info', { model: 'claude-opus-4', plan: 'Claude Max' });
      expect(sm.getSnapshot().billingType).toBe('subscription');
    });

    it('detects subscription from "Max" (case-insensitive)', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('model_info', { model: 'claude-opus-4', plan: 'max plan' });
      expect(sm.getSnapshot().billingType).toBe('subscription');
    });

    it('detects api from "api.anthropic.com"', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('model_info', { model: 'claude-opus-4', plan: 'api.anthropic.com' });
      expect(sm.getSnapshot().billingType).toBe('api');
    });

    it('detects api (case-insensitive)', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('model_info', { model: 'claude-sonnet-4', plan: 'API key' });
      expect(sm.getSnapshot().billingType).toBe('api');
    });

    it('stays unknown for unrecognized plan', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('model_info', { model: 'claude-opus-4', plan: 'some-other-plan' });
      expect(sm.getSnapshot().billingType).toBe('unknown');
    });

    it('stays unknown when plan is absent', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('model_info', { model: 'claude-opus-4' });
      expect(sm.getSnapshot().billingType).toBe('unknown');
    });

    it('persists billingType across subsequent model_info without plan', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('model_info', { model: 'claude-opus-4', plan: 'Claude Max' });
      expect(sm.getSnapshot().billingType).toBe('subscription');

      // Later model_info without plan should not reset billingType
      sm.handleParserEvent('model_info', { model: 'claude-sonnet-4' });
      expect(sm.getSnapshot().billingType).toBe('subscription');
    });

    it('emits state_changed when billingType is set', () => {
      const sm = bootToIdle();
      const snapshots: any[] = [];
      sm.on('state_changed', (s: any) => snapshots.push(s));

      sm.handleParserEvent('model_info', { model: 'claude-opus-4', plan: 'api.anthropic.com' });
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[snapshots.length - 1].billingType).toBe('api');
    });
  });

  // === Spinner recovery from AWAITING states ===

  describe('spinner_start recovery from awaiting states', () => {
    it('spinner_start transitions from AWAITING_OPTION to PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', { options: [{ index: 0, label: 'Default' }] });
      expect(sm.getState()).toBe(State.AWAITING_OPTION);

      sm.handleParserEvent('spinner_start');
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('spinner_start transitions from AWAITING_PERMISSION to PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('permission_prompt', { options: [{ index: 0, label: 'Yes', shortcut: 'y' }] });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);

      sm.handleParserEvent('spinner_start');
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('spinner_start transitions from AWAITING_DIFF to PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('diff_prompt', { options: [{ index: 0, label: 'Apply', shortcut: 'a' }] });
      expect(sm.getState()).toBe(State.AWAITING_DIFF);

      sm.handleParserEvent('spinner_start');
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('clears options and navigable state on spinner_start from AWAITING_OPTION', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'Default' }],
        navigable: true,
        cursorIndex: 1,
      });
      expect(sm.getSnapshot().options).toHaveLength(1);
      expect(sm.getSnapshot().navigable).toBe(true);

      sm.handleParserEvent('spinner_start');
      expect(sm.getState()).toBe(State.PROCESSING);
      expect(sm.getSnapshot().options).toHaveLength(0);
      expect(sm.getSnapshot().navigable).toBe(false);
      expect(sm.getSnapshot().cursorIndex).toBe(0);
    });

    it('stores navigable and cursorIndex from permission_prompt', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('permission_prompt', {
        options: [
          { index: 0, label: 'Yes', shortcut: 'y' },
          { index: 1, label: 'No', shortcut: 'n' },
          { index: 2, label: 'Always allow', shortcut: 'a' },
        ],
        navigable: true,
        cursorIndex: 0,
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);
      expect(sm.getSnapshot().navigable).toBe(true);
      expect(sm.getSnapshot().cursorIndex).toBe(0);
    });

    it('cursor index tracking via updateCursorIndex', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }, { index: 2, label: 'C' }],
        navigable: true,
        cursorIndex: 0,
      });

      sm.updateCursorIndex(2);
      expect(sm.getCursorIndex()).toBe(2);

      sm.updateCursorIndex(1);
      expect(sm.getCursorIndex()).toBe(1);
    });
  });

  // === Cursor Authority ===

  describe('cursor authority (optimistic vs pty)', () => {
    it('optimistic source updates cursor immediately', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
        navigable: true,
        cursorIndex: 0,
      });

      sm.updateCursorIndex(1, 'optimistic');
      expect(sm.getCursorIndex()).toBe(1);
    });

    it('suppresses stale PTY within 200ms of optimistic', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }, { index: 2, label: 'C' }],
        navigable: true,
        cursorIndex: 0,
      });

      sm.updateCursorIndex(2, 'optimistic');
      vi.advanceTimersByTime(100);
      sm.updateCursorIndex(0, 'pty'); // stale
      expect(sm.getCursorIndex()).toBe(2);
    });

    it('accepts PTY after 200ms grace period', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }, { index: 2, label: 'C' }],
        navigable: true,
        cursorIndex: 0,
      });

      sm.updateCursorIndex(2, 'optimistic');
      vi.advanceTimersByTime(250);
      sm.updateCursorIndex(1, 'pty');
      expect(sm.getCursorIndex()).toBe(1);
    });

    it('emits state_changed on optimistic update', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
        navigable: true,
        cursorIndex: 0,
      });

      const snapshots: any[] = [];
      sm.on('state_changed', (s: any) => snapshots.push(s));

      sm.updateCursorIndex(1, 'optimistic');
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].cursorIndex).toBe(1);
    });

    it('does NOT emit state_changed when stale PTY is suppressed', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
        navigable: true,
        cursorIndex: 0,
      });

      sm.updateCursorIndex(1, 'optimistic');

      const snapshots: any[] = [];
      sm.on('state_changed', (s: any) => snapshots.push(s));

      vi.advanceTimersByTime(50);
      sm.updateCursorIndex(0, 'pty'); // stale, should be suppressed
      expect(snapshots).toHaveLength(0);
    });
  });

  // === Codex CLI lifecycle hooks ===
  // Mirror the Claude transitions so the same downstream display/eval
  // logic reacts to either hook family. Schema source: Codex stdin JSON
  // forwarded by ~/.codex/config.toml command hooks.

  describe('codex_* hook events', () => {
    function bootCodexToIdle() {
      const sm = createSM();
      sm.handleHookEvent('codex_session_start', {});
      expect(sm.getState()).toBe(State.IDLE);
      return sm;
    }

    it('codex_session_start → IDLE', () => {
      const sm = createSM();
      sm.handleHookEvent('codex_session_start', {});
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('codex_user_prompt_submit → PROCESSING', () => {
      const sm = bootCodexToIdle();
      sm.handleHookEvent('codex_user_prompt_submit', { prompt: 'fix this' });
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('codex_tool_start sets currentTool from tool_name', () => {
      const sm = bootCodexToIdle();
      sm.handleHookEvent('codex_user_prompt_submit', {});
      sm.handleHookEvent('codex_tool_start', {
        tool_name: 'shell',
        tool_input: { command: 'ls' },
      });
      const snap = sm.getSnapshot();
      expect(snap.currentTool).toBe('shell');
    });

    it('codex_tool_end clears currentTool', () => {
      const sm = bootCodexToIdle();
      sm.handleHookEvent('codex_user_prompt_submit', {});
      sm.handleHookEvent('codex_tool_start', { tool_name: 'shell' });
      sm.handleHookEvent('codex_tool_end', { tool_name: 'shell' });
      const snap = sm.getSnapshot();
      expect(snap.currentTool).toBeNull();
    });

    it('codex_stop → IDLE from PROCESSING', () => {
      const sm = bootCodexToIdle();
      sm.handleHookEvent('codex_user_prompt_submit', {});
      expect(sm.getState()).toBe(State.PROCESSING);
      sm.handleHookEvent('codex_stop', {});
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('codex_turn_complete is a snapshot-emit no-op for state', () => {
      const sm = bootCodexToIdle();
      sm.handleHookEvent('codex_user_prompt_submit', {});
      sm.handleHookEvent('codex_stop', {});
      // codex_turn_complete after stop should not bounce state.
      sm.handleHookEvent('codex_turn_complete', {});
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('full codex lifecycle preserves state transitions', () => {
      const sm = createSM();
      sm.handleHookEvent('codex_session_start', {});
      expect(sm.getState()).toBe(State.IDLE);
      sm.handleHookEvent('codex_user_prompt_submit', { prompt: 'q' });
      expect(sm.getState()).toBe(State.PROCESSING);
      sm.handleHookEvent('codex_tool_start', { tool_name: 'shell' });
      expect(sm.getState()).toBe(State.PROCESSING);
      sm.handleHookEvent('codex_tool_end', { tool_name: 'shell' });
      expect(sm.getState()).toBe(State.PROCESSING);
      sm.handleHookEvent('codex_stop', {});
      expect(sm.getState()).toBe(State.IDLE);
    });
  });
});
