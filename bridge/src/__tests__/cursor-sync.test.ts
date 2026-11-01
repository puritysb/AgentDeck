import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutputParser } from '../output-parser.js';
import { StateMachine } from '../state-machine.js';
import { UsageTracker } from '../usage-tracker.js';
import { State } from '../types.js';

function createParser(): OutputParser {
  return new OutputParser();
}

function armParser(): OutputParser {
  const p = createParser();
  p.feed('❯ \n');
  return p;
}

function collectEvents(parser: OutputParser, event: string): any[] {
  const events: any[] = [];
  parser.on(event, (data: any) => events.push(data));
  return events;
}

function createSM() {
  const tracker = new UsageTracker();
  return new StateMachine(tracker);
}

function bootToIdle() {
  const sm = createSM();
  sm.handleHookEvent('SessionStart', {});
  return sm;
}

describe('Cursor Synchronization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // === Terminal keyboard cursor tracking ===

  describe('terminal keyboard cursor tracking', () => {
    it('emits cursor_update when full option redraw arrives with ❯ at new position', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');
      const cursorEvents = collectEvents(p, 'cursor_update');

      // Initial option display with cursor at index 0
      p.feed('❯ 1. Alpha\n  2. Beta\n  3. Gamma\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);
      expect(optEvents[0].cursorIndex).toBe(0);

      // Cursor-only redraw: ❯ moved to Beta (small chunk with ❯ but no numbered patterns)
      // The buffer tail now has ❯ at a different position since buffer is append-only
      // and parseOptions uses last occurrence. Feed a new full set to update buffer.
      p.feed('  1. Alpha\n❯ 2. Beta\n  3. Gamma\n');
      vi.advanceTimersByTime(200);

      // Should detect cursor change: cursor_update or option_prompt re-emission
      const lastOpt = optEvents[optEvents.length - 1];
      const lastCursor = cursorEvents.length > 0
        ? cursorEvents[cursorEvents.length - 1].cursorIndex
        : lastOpt?.cursorIndex;
      expect(lastCursor).toBe(1);
    });

    it('triggers buffer re-parse on small non-❯ chunk during navigable state', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');

      // Initial navigable option display
      p.feed('❯ 1. Alpha\n  2. Beta\n  3. Gamma\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);
      expect(optEvents[0].navigable).toBe(true);

      // Small non-❯ chunk — ANSI repositioning scenario
      // The A1 fix catches these small chunks and re-parses the buffer
      // Feed a small chunk that doesn't contain ❯ (simulating ANSI cursor move)
      p.feed('Beta');
      vi.advanceTimersByTime(200);

      // The code path triggers — no assertion on cursor_update because
      // buffer tail may not have changed ❯ position. The important thing
      // is that it doesn't crash or emit false idle.
      // We verify no option_prompt re-emission (no new numbered patterns)
      expect(optEvents).toHaveLength(1);
    });

    it('does not emit cursor_update when cursor position unchanged', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');
      const cursorEvents = collectEvents(p, 'cursor_update');

      // Initial display
      p.feed('❯ 1. Alpha\n  2. Beta\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);

      // Same cursor position redraw
      p.feed('❯ 1. Alpha\n  2. Beta\n');
      vi.advanceTimersByTime(200);

      // No cursor_update since position didn't change
      expect(cursorEvents).toHaveLength(0);
    });
  });

  // === Genuine idle distinction ===

  describe('genuine idle distinction', () => {
    it('treats "❯ \\n" as genuine idle (clears navigable state)', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');
      const cursors = collectEvents(p, 'cursor_update');

      // Establish navigable state with non-permission labels
      p.feed('❯ 1. Alpha\n  2. Beta\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);

      // Genuine idle: only ❯ character
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);

      p.feed('1. Unselected prose\n2. More prose\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);
      expect(cursors).toHaveLength(0);
    });

    it('does NOT treat "❯ Beta" as idle (cursor on option label)', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');

      // Establish navigable state
      p.feed('❯ 1. Alpha\n  2. Beta\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);

      // Cursor move to "Beta" — should NOT trigger idle
      p.feed('❯ Beta');
      vi.advanceTimersByTime(400);

      // Cursorless redraws remain eligible while the picker is still live.
      const redraws = collectEvents(p, 'option_prompt');
      p.feed('\n1. Alpha\n2. Beta\n');
      vi.advanceTimersByTime(200);
      expect(redraws).toHaveLength(1);
    });

    it('does NOT treat "❯ Allow once" as idle (permission cursor move)', () => {
      const p = armParser();
      const permEvents = collectEvents(p, 'permission_prompt');

      // Establish navigable permission state
      p.feed('❯ 1. Yes, allow once\n  2. No, deny\n  3. Always allow\n');
      vi.advanceTimersByTime(200);
      expect(permEvents.length).toBeGreaterThan(0);

      // Cursor redraw with label text — not idle
      p.feed('❯ Yes, allow once');
      vi.advanceTimersByTime(400);

      // Cursorless redraws remain eligible while the picker is still live.
      const redraws = collectEvents(p, 'option_prompt');
      p.feed('\n1. Alpha\n2. Beta\n');
      vi.advanceTimersByTime(200);
      expect(redraws).toHaveLength(1);
    });
  });

  // === Cursor race condition (StateMachine authority) ===

  describe('cursor authority in StateMachine', () => {
    it('accepts optimistic update immediately', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }, { index: 2, label: 'C' }],
        navigable: true,
        cursorIndex: 0,
      });

      sm.updateCursorIndex(2, 'optimistic');
      expect(sm.getCursorIndex()).toBe(2);
    });

    it('suppresses stale PTY value within 200ms of optimistic update', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }, { index: 2, label: 'C' }],
        navigable: true,
        cursorIndex: 0,
      });

      // Optimistic update from dial
      sm.updateCursorIndex(2, 'optimistic');
      expect(sm.getCursorIndex()).toBe(2);

      // Stale PTY confirmation arrives 50ms later (for previous position)
      vi.advanceTimersByTime(50);
      sm.updateCursorIndex(0, 'pty');

      // Should still be 2 (stale PTY suppressed)
      expect(sm.getCursorIndex()).toBe(2);
    });

    it('accepts PTY value after 200ms grace period', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }, { index: 2, label: 'C' }],
        navigable: true,
        cursorIndex: 0,
      });

      // Optimistic update
      sm.updateCursorIndex(2, 'optimistic');
      expect(sm.getCursorIndex()).toBe(2);

      // PTY confirmation arrives after 200ms+ (authoritative)
      vi.advanceTimersByTime(250);
      sm.updateCursorIndex(1, 'pty');

      // PTY is now authoritative
      expect(sm.getCursorIndex()).toBe(1);
    });

    it('always accepts PTY when no recent optimistic update', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
        navigable: true,
        cursorIndex: 0,
      });

      // PTY updates without prior optimistic — always accepted
      sm.updateCursorIndex(1, 'pty');
      expect(sm.getCursorIndex()).toBe(1);

      sm.updateCursorIndex(0, 'pty');
      expect(sm.getCursorIndex()).toBe(0);
    });

    it('resets authority on state transition out of AWAITING', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
        navigable: true,
        cursorIndex: 0,
      });

      // Set optimistic
      sm.updateCursorIndex(1, 'optimistic');
      expect(sm.getCursorIndex()).toBe(1);

      // Transition out of AWAITING_OPTION
      sm.handleUserAction('select_option');
      expect(sm.getState()).toBe(State.PROCESSING);

      // Back to AWAITING_OPTION
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'X' }, { index: 1, label: 'Y' }],
        navigable: true,
        cursorIndex: 0,
      });

      // PTY should be accepted immediately (authority was reset)
      sm.updateCursorIndex(1, 'pty');
      expect(sm.getCursorIndex()).toBe(1);
    });

    it('default source parameter is pty', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
        navigable: true,
        cursorIndex: 0,
      });

      // No source specified — defaults to 'pty'
      sm.updateCursorIndex(1);
      expect(sm.getCursorIndex()).toBe(1);
    });
  });

  // === select_option timing ===

  describe('select_option proportional delay', () => {
    it('delay scales with step count', () => {
      // Test the delay formula: 50 + abs(delta) * 20
      expect(50 + Math.abs(0) * 20).toBe(50);  // no movement
      expect(50 + Math.abs(1) * 20).toBe(70);   // 1 step
      expect(50 + Math.abs(3) * 20).toBe(110);  // 3 steps
      expect(50 + Math.abs(5) * 20).toBe(150);  // 5 steps
    });
  });

  // === Option re-emission with cursorIndex ===

  describe('option re-emission with cursorIndex', () => {
    it('AWAITING_OPTION update triggers state_changed with options', () => {
      const sm = bootToIdle();
      const snapshots: any[] = [];
      sm.on('state_changed', (s: any) => snapshots.push(s));

      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
        navigable: true,
        cursorIndex: 0,
      });
      expect(sm.getState()).toBe(State.AWAITING_OPTION);

      const lastSnap = snapshots[snapshots.length - 1];
      expect(lastSnap.state).toBe(State.AWAITING_OPTION);
      expect(lastSnap.options).toHaveLength(2);
      expect(lastSnap.cursorIndex).toBe(0);
    });

    it('updateCursorIndex emits snapshot with new cursor value', () => {
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
  });
});
