import { describe, expect, it } from 'vitest';
import { HookClaudeSessions } from '../hook-claude-sessions.js';
import { applyAwaitingOverlayToObserved, setAwaitingOverlay, clearAwaitingOverlay } from '../awaiting-overlay.js';

const rows = () => ['a', 'b'].map((id) => ({
  id: `observed:claude:${id}`, state: 'idle', currentTool: undefined as string | undefined,
  currentTask: 'passive task', goal: 'goal', activity: 'activity', modelName: 'opus', pid: 123,
}));

describe('Claude lifecycle roster merge (#367)', () => {
  it('keeps concurrent sessions isolated and preserves passive facts across the whole turn', () => {
    const tracker = new HookClaudeSessions();
    const passive = rows();
    tracker.note('UserPromptSubmit', { session_id: 'a' });
    expect(tracker.applyTo(passive).map((s) => s.state)).toEqual(['processing', 'idle']);
    tracker.note('PreToolUse', { session_id: 'a', tool_use_id: 't1', tool_name: 'Bash', tool_input: { command: 'secret' } });
    expect(tracker.applyTo(passive)[0]).toMatchObject({ state: 'processing', currentTool: 'Bash' });
    tracker.note('PostToolUse', { session_id: 'a', tool_use_id: 't1' });
    expect(tracker.applyTo(passive)[0]).toMatchObject({ state: 'processing', currentTool: undefined });
    tracker.note('Stop', { session_id: 'a' });
    tracker.note('PostToolUseFailure', { session_id: 'a', tool_use_id: 't1' });
    expect(tracker.applyTo(passive)).toEqual(passive);
    expect(passive).toEqual(rows());
  });

  it('retains another parallel tool when one succeeds or fails', () => {
    const tracker = new HookClaudeSessions();
    for (const [id, tool] of [['t1', 'Read'], ['t2', 'Bash']]) {
      tracker.note('PreToolUse', { session_id: 'a', tool_use_id: id, tool_name: tool });
    }
    tracker.note('PostToolUseFailure', { session_id: 'a', tool_use_id: 't2' });
    expect(tracker.applyTo(rows())[0].currentTool).toBe('Read');
    tracker.note('PostToolUse', { session_id: 'a', tool_use_id: 't1' });
    expect(tracker.applyTo(rows())[0]).toMatchObject({ state: 'processing', currentTool: undefined });
  });

  it('never creates a phantom row, suppresses ended rows, and reopens only on SessionStart', () => {
    const tracker = new HookClaudeSessions();
    tracker.note('PreToolUse', { session_id: 'unknown', tool_name: 'Read' });
    expect(tracker.applyTo(rows())).toEqual(rows());
    tracker.note('SessionEnd', { session_id: 'a' });
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'UserPromptSubmit']) {
      expect(tracker.note(event, { session_id: 'a', tool_name: 'Bash' })).toBe(false);
      expect(tracker.applyTo(rows()).map((s) => s.id)).toEqual(['observed:claude:b']);
    }
    tracker.note('SessionStart', { session_id: 'a' });
    expect(tracker.applyTo(rows())).toEqual(rows());
  });

  it('sanitizes and bounds names, ignores unrelated hooks and never changes managed rows', () => {
    const tracker = new HookClaudeSessions();
    expect(tracker.note('codex_tool_start', { session_id: 'a' })).toBe(false);
    expect(tracker.note('PreToolUse', {})).toBe(false);
    tracker.note('PreToolUse', { session_id: 'a', tool_name: '\u001b[31mBash\u0000\n' });
    expect(tracker.applyTo(rows())[0].currentTool).toBe('Bash');
    const managed = [{ id: 'a', state: 'idle' }];
    expect(tracker.applyTo(managed)).toEqual(managed);
    tracker.note('PreToolUse', { session_id: 'a', tool_name: 'a'.repeat(1000) });
    expect(tracker.applyTo(rows())[0].currentTool?.length).toBe(128);
  });

  it('leaves permission overlay precedence and its request identity intact', () => {
    const tracker = new HookClaudeSessions();
    tracker.note('PreToolUse', { session_id: 'a', tool_name: 'Bash' });
    setAwaitingOverlay('a', 'Allow?', 'req-a');
    try {
      expect(applyAwaitingOverlayToObserved(tracker.applyTo(rows()))[0]).toMatchObject({
        state: 'awaiting_permission', requestId: 'req-a', question: 'Allow?', currentTool: 'Bash',
      });
    } finally {
      clearAwaitingOverlay('a');
    }
  });
});
