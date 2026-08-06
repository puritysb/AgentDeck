import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setAwaitingOverlay,
  setPermissionNotificationOverlay,
  setAskUserQuestionOverlay,
  advanceAskUserQuestionOverlay,
  getAskUserQuestionAnswers,
  getAwaitingOverlay,
  clearAwaitingOverlay,
  clearAskUserQuestionOverlay,
  looksLikePermissionMessage,
  isPermissionNotification,
  shouldGatePreToolUse,
  applyAwaitingOverlayToObserved,
  _resetAwaitingOverlay,
} from '../awaiting-overlay.js';

describe('awaiting-overlay', () => {
  beforeEach(() => {
    _resetAwaitingOverlay();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('set then get returns the trimmed question', () => {
    setAwaitingOverlay('sid-1', '  Claude needs your   permission to use Bash  ');
    expect(getAwaitingOverlay('sid-1')).toMatchObject({ question: 'Claude needs your permission to use Bash', requestId: undefined });
  });

  it('carries an optional requestId (actionable PreToolUse gate)', () => {
    setAwaitingOverlay('sid-1b', 'Allow Bash: npm test?', 'req-123');
    expect(getAwaitingOverlay('sid-1b')).toMatchObject({ question: 'Allow Bash: npm test?', requestId: 'req-123' });
  });

  it('preserves a structured AskUserQuestion as a display-only option lifecycle', () => {
    expect(setAskUserQuestionOverlay('sid-ask', 'toolu-ask-1', {
      questions: [{
        question: '응답 대기 PR/이슈에 stale nudge를 게시할까요?',
        header: '유예기간',
        options: [
          { label: '14일 유예 후 close', description: '표준 유예' },
          { label: '7일 유예 후 close', description: '빠른 정리' },
          { label: '지금은 보고만', description: '게시 보류' },
        ],
        multiSelect: false,
      }],
    })).toBe(true);

    expect(getAwaitingOverlay('sid-ask')).toMatchObject({
      kind: 'option',
      state: 'awaiting_option',
      question: '응답 대기 PR/이슈에 stale nudge를 게시할까요?',
      toolUseId: 'toolu-ask-1',
      options: [
        { index: 0, label: '14일 유예 후 close' },
        { index: 1, label: '7일 유예 후 close' },
        { index: 2, label: '지금은 보고만' },
      ],
    });
    expect(getAwaitingOverlay('sid-ask')).not.toHaveProperty('promptType');
    expect(getAwaitingOverlay('sid-ask')).not.toHaveProperty('requestId');
  });

  it('rejects malformed AskUserQuestion payloads instead of surfacing a dead prompt', () => {
    expect(setAskUserQuestionOverlay('sid-bad', 'toolu-bad', {})).toBe(false);
    expect(setAskUserQuestionOverlay('sid-bad', 'toolu-bad', {
      questions: [{ question: 'No choices', options: [] }],
    })).toBe(false);
    expect(getAwaitingOverlay('sid-bad')).toBeUndefined();
  });

  it('does not let a generic permission Notification overwrite AskUserQuestion', () => {
    setAskUserQuestionOverlay('sid-preserve', 'toolu-preserve', {
      questions: [{
        question: 'Which deadline?',
        options: [{ label: '14 days' }, { label: '7 days' }],
      }],
    });
    expect(setPermissionNotificationOverlay(
      'sid-preserve',
      'Claude needs your permission',
    )).toBe(false);
    expect(getAwaitingOverlay('sid-preserve')).toMatchObject({
      kind: 'option',
      state: 'awaiting_option',
      question: 'Which deadline?',
    });
  });

  it('returns undefined for an unknown session', () => {
    expect(getAwaitingOverlay('nope')).toBeUndefined();
  });

  it('survives a long away-wait, then expires past the generous backstop', () => {
    setAwaitingOverlay('sid-2', 'wants to run a command');
    expect(getAwaitingOverlay('sid-2')).toBeDefined();
    // A genuine prompt the user hasn't answered in half an hour is still shown.
    vi.advanceTimersByTime(30 * 60_000);
    expect(getAwaitingOverlay('sid-2')).toBeDefined();
    // Only a truly orphaned entry clears, well past any realistic wait.
    vi.advanceTimersByTime(6 * 60 * 60_000 + 1);
    expect(getAwaitingOverlay('sid-2')).toBeUndefined();
  });

  it('re-setting refreshes the TTL (a follow-up prompt keeps the overlay alive)', () => {
    setAwaitingOverlay('sid-2b', 'first prompt');
    vi.advanceTimersByTime(4 * 60_000);
    setAwaitingOverlay('sid-2b', 'second prompt');
    // A fresh re-set keeps the entry alive; the question updates to the latest.
    vi.advanceTimersByTime(4 * 60_000);
    expect(getAwaitingOverlay('sid-2b')).toMatchObject({ question: 'second prompt', requestId: undefined });
  });

  it('clear removes the entry and reports whether one existed', () => {
    setAwaitingOverlay('sid-3', 'permission to use Edit');
    expect(clearAwaitingOverlay('sid-3')).toBe(true);
    expect(getAwaitingOverlay('sid-3')).toBeUndefined();
    expect(clearAwaitingOverlay('sid-3')).toBe(false);
  });

  it('caps question length at 120 chars', () => {
    setAwaitingOverlay('sid-4', 'x'.repeat(300));
    expect(getAwaitingOverlay('sid-4')!.question.length).toBe(120);
  });

  describe('looksLikePermissionMessage', () => {
    it('matches genuine permission prompts', () => {
      expect(looksLikePermissionMessage('Claude needs your permission to use Bash')).toBe(true);
      expect(looksLikePermissionMessage('Claude needs your permission to run this command')).toBe(true);
      expect(looksLikePermissionMessage('Requesting permission to use Edit')).toBe(true);
    });
    it('rejects the idle ping, non-permission status text, and empty messages', () => {
      expect(looksLikePermissionMessage('')).toBe(false);
      // The 60s idle reminder fires through the SAME Notification hook — it must
      // NOT flip a session to attention (this was the false-positive root cause).
      expect(looksLikePermissionMessage('Claude is waiting for your input')).toBe(false);
      expect(looksLikePermissionMessage('Claude has been idle for 60 seconds')).toBe(false);
      expect(looksLikePermissionMessage('Claude wants to run npm test')).toBe(false);
    });
  });

  describe('isPermissionNotification', () => {
    it('uses notification_type when present — only permission_prompt awaits', () => {
      expect(isPermissionNotification('permission_prompt', 'anything')).toBe(true);
      // Other structured types must NOT flip to attention, even if the message
      // happens to contain permission-ish words.
      expect(isPermissionNotification('idle_prompt', 'Claude needs your permission')).toBe(false);
      expect(isPermissionNotification('auth_success', 'permission to use')).toBe(false);
      expect(isPermissionNotification('elicitation_dialog', 'requesting permission')).toBe(false);
    });
    it('falls back to the message regex only when notification_type is absent', () => {
      expect(isPermissionNotification(undefined, 'Claude needs your permission to use Bash')).toBe(true);
      expect(isPermissionNotification(undefined, 'Claude is waiting for your input')).toBe(false);
      expect(isPermissionNotification('', 'requesting permission')).toBe(true);
    });
  });

  describe('shouldGatePreToolUse', () => {
    it('gates in default / unknown modes (Claude may prompt)', () => {
      expect(shouldGatePreToolUse('default', 'Bash')).toBe(true);
      expect(shouldGatePreToolUse(undefined, 'Bash')).toBe(true);
      expect(shouldGatePreToolUse('something-new', 'Write')).toBe(true);
    });
    it('never gates when Claude will not prompt or execute', () => {
      // `auto` belongs here: the policy engine auto-approves outside the
      // settings allowlist files, so gating it produced false attention
      // popups (+25s hold latency) for calls the user was never asked about.
      for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
        expect(shouldGatePreToolUse('bypassPermissions', tool)).toBe(false);
        expect(shouldGatePreToolUse('dontAsk', tool)).toBe(false);
        expect(shouldGatePreToolUse('auto', tool)).toBe(false);
        expect(shouldGatePreToolUse('plan', tool)).toBe(false);
      }
    });
    it('acceptEdits auto-approves edits but still gates Bash', () => {
      expect(shouldGatePreToolUse('acceptEdits', 'Edit')).toBe(false);
      expect(shouldGatePreToolUse('acceptEdits', 'Write')).toBe(false);
      expect(shouldGatePreToolUse('acceptEdits', 'MultiEdit')).toBe(false);
      expect(shouldGatePreToolUse('acceptEdits', 'NotebookEdit')).toBe(false);
      expect(shouldGatePreToolUse('acceptEdits', 'Bash')).toBe(true);
    });
  });

  describe('applyAwaitingOverlayToObserved', () => {
    const observed = (id: string, state: string) => ({ id, state });

    it('flips a matching observed session to awaiting_permission with the question', () => {
      setAwaitingOverlay('uuid-abc', 'Claude needs your permission to use Bash');
      const out = applyAwaitingOverlayToObserved([
        observed('observed:claude:uuid-abc', 'processing'),
        observed('observed:claude:uuid-other', 'idle'),
      ]);
      expect(out[0]).toMatchObject({
        state: 'awaiting_permission',
        question: 'Claude needs your permission to use Bash',
      });
      // Unaffected session passes through unchanged.
      expect(out[1]).toEqual({ id: 'observed:claude:uuid-other', state: 'idle' });
    });

    it('matches the uuid after stripping the observed:claude: / observed:codex: prefix', () => {
      setAwaitingOverlay('uuid-xyz', 'wants to run a command');
      const claude = applyAwaitingOverlayToObserved([observed('observed:claude:uuid-xyz', 'processing')]);
      expect(claude[0].state).toBe('awaiting_permission');
      const codex = applyAwaitingOverlayToObserved([observed('observed:codex:uuid-xyz', 'processing')]);
      expect(codex[0].state).toBe('awaiting_permission');
    });

    it('leaves sessions untouched when no overlay exists', () => {
      const input = [observed('observed:claude:fresh', 'processing')];
      expect(applyAwaitingOverlayToObserved(input)).toEqual(input);
    });

    it('propagates the requestId for actionable gates', () => {
      setAwaitingOverlay('uuid-gate', 'Allow Bash: ls?', 'req-xyz');
      const out = applyAwaitingOverlayToObserved([observed('observed:claude:uuid-gate', 'processing')]);
      expect(out[0]).toMatchObject({ state: 'awaiting_permission', question: 'Allow Bash: ls?', requestId: 'req-xyz' });
    });

    it('renders AskUserQuestion as awaiting_option with real choices and no actionable requestId', () => {
      setAskUserQuestionOverlay('uuid-option', 'toolu-option', {
        questions: [{
          question: '유예기간은?',
          options: [{ label: '14일' }, { label: '7일' }],
          multiSelect: false,
        }],
      });
      const out = applyAwaitingOverlayToObserved([
        observed('observed:claude:uuid-option', 'processing'),
      ]);
      expect(out[0]).toMatchObject({
        state: 'awaiting_option',
        question: '유예기간은?',
        requestId: undefined,
        options: [
          { index: 0, label: '14일' },
          { index: 1, label: '7일' },
        ],
      });
      expect(out[0]).not.toHaveProperty('promptType');
    });
  });

  // The ESC-stuck fix: a display-only permission prompt fires no hook when the
  // user presses ESC, so the ONLY signal it was dismissed is that the session's
  // transcript advanced (a `[Request interrupted…]` record) after the overlay
  // was set. The overlay must yield to that recency, not sit until the 6h TTL.
  describe('transcript-recency supersession (ESC-dismissed prompt)', () => {
    const withActivity = (id: string, state: string, lastActivityAt?: number) =>
      ({ id, state, lastActivityAt });

    it('drops a display-only overlay once the transcript moves past it, and purges the entry', () => {
      const sid = 'uuid-esc';
      setAwaitingOverlay(sid, 'Claude needs your permission to use Bash');
      const setAt = Date.now();
      // Transcript wrote a record 2s after the prompt (answered OR ESC'd).
      const out = applyAwaitingOverlayToObserved([
        withActivity(`observed:claude:${sid}`, 'idle', setAt + 2_000),
      ]);
      // No override — the session shows its own (post-interrupt idle) state.
      expect(out[0]).toMatchObject({ id: `observed:claude:${sid}`, state: 'idle' });
      expect(out[0]).not.toHaveProperty('question');
      // And the stuck entry is gone from the map (no waiting out the 6h TTL).
      expect(getAwaitingOverlay(sid)).toBeUndefined();
    });

    it('keeps the overlay while the transcript stays frozen (genuine wait)', () => {
      const sid = 'uuid-wait';
      setAwaitingOverlay(sid, 'Claude needs your permission to use Bash');
      const setAt = Date.now();
      // The tool_use write precedes the Notification, so the frozen transcript's
      // mtime is at/just-before setAt — well within the margin. Overlay holds.
      const out = applyAwaitingOverlayToObserved([
        withActivity(`observed:claude:${sid}`, 'processing', setAt - 3_000),
      ]);
      expect(out[0]).toMatchObject({ state: 'awaiting_permission' });
      expect(getAwaitingOverlay(sid)).toBeDefined();
    });

    it('holds within the jitter margin (a write at ~setAt is not a resolution)', () => {
      const sid = 'uuid-margin';
      setAwaitingOverlay(sid, 'permission to use Edit');
      const setAt = Date.now();
      const out = applyAwaitingOverlayToObserved([
        withActivity(`observed:claude:${sid}`, 'processing', setAt + 500),
      ]);
      expect(out[0]).toMatchObject({ state: 'awaiting_permission' });
    });

    it('keeps the overlay when the session carries no transcript recency', () => {
      const sid = 'uuid-notx';
      setAwaitingOverlay(sid, 'permission to use Bash');
      const out = applyAwaitingOverlayToObserved([
        withActivity(`observed:claude:${sid}`, 'idle', undefined),
      ]);
      expect(out[0]).toMatchObject({ state: 'awaiting_permission' });
    });

    it('never drops a held device-approval gate on recency (its tool is blocked, resolve via onResolved)', () => {
      const sid = 'uuid-held';
      setAwaitingOverlay(sid, 'Allow Bash: rm?', 'req-held');
      const setAt = Date.now();
      const out = applyAwaitingOverlayToObserved([
        withActivity(`observed:claude:${sid}`, 'processing', setAt + 60_000),
      ]);
      expect(out[0]).toMatchObject({ state: 'awaiting_permission', requestId: 'req-held' });
      expect(getAwaitingOverlay(sid)).toBeDefined();
    });

    it('never drops AskUserQuestion on transcript mtime movement during a genuine wait', () => {
      const sid = 'uuid-option-wait';
      setAskUserQuestionOverlay(sid, 'toolu-wait', {
        questions: [{
          question: 'Pick a deadline',
          options: [{ label: '14 days' }, { label: '7 days' }],
        }],
      });
      const setAt = Date.now();
      // Live regression: the file mtime advanced minutes after the generic
      // permission Notification even though PostToolUse did not arrive for
      // another 17 minutes. Option lifecycle must ignore raw mtime.
      const out = applyAwaitingOverlayToObserved([
        withActivity(`observed:claude:${sid}`, 'processing', setAt + 3 * 60_000),
      ]);
      expect(out[0]).toMatchObject({ state: 'awaiting_option', question: 'Pick a deadline' });
      expect(getAwaitingOverlay(sid)).toBeDefined();
    });
  });

  describe('AskUserQuestion tool lifecycle', () => {
    beforeEach(() => {
      setAskUserQuestionOverlay('sid-tool', 'toolu-current', {
        questions: [{
          question: 'Choose one',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      });
    });

    it('ignores unrelated or stale tool completions', () => {
      expect(clearAskUserQuestionOverlay('sid-tool', 'toolu-other')).toBe(false);
      expect(clearAskUserQuestionOverlay('sid-tool', undefined)).toBe(false);
      expect(getAwaitingOverlay('sid-tool')).toBeDefined();
    });

    it('clears only the matching PostToolUse/PostToolUseFailure id', () => {
      expect(clearAskUserQuestionOverlay('sid-tool', 'toolu-current')).toBe(true);
      expect(getAwaitingOverlay('sid-tool')).toBeUndefined();
    });
  });

  // A single AskUserQuestion call may carry up to four question groups, but
  // SessionInfo has room for one. Groups are therefore presented in sequence:
  // flattening them into one index space is what let a press aimed at group 1
  // select an option of group 2.
  describe('multi-group AskUserQuestion progression', () => {
    const threeGroups = {
      questions: [
        { question: 'Pick a language', options: [{ label: 'TypeScript' }, { label: 'Swift' }] },
        { question: 'Pick a target', options: [{ label: 'macOS' }, { label: 'Android' }], multiSelect: true },
        { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'Not yet' }] },
      ],
    };

    beforeEach(() => {
      setAskUserQuestionOverlay('sid-multi', 'toolu-multi', threeGroups);
    });

    it('presents the first group and keeps the rest for later', () => {
      const ov = getAwaitingOverlay('sid-multi')!;
      expect(ov.question).toBe('Pick a language');
      expect(ov.options?.map((o) => o.label)).toEqual(['TypeScript', 'Swift']);
      expect(ov.groups).toHaveLength(3);
      expect(ov.activeGroup).toBe(0);
      expect(ov.promptType).toBeUndefined();
    });

    it('advances one group per answer and projects its question/options', () => {
      expect(advanceAskUserQuestionOverlay('sid-multi', 'Swift')).toBe('advanced');
      const second = getAwaitingOverlay('sid-multi')!;
      expect(second.question).toBe('Pick a target');
      expect(second.options?.map((o) => o.label)).toEqual(['macOS', 'Android']);
      expect(second.activeGroup).toBe(1);
      // promptType tracks the ACTIVE group, so it must appear here…
      expect(second.promptType).toBe('multi_select');

      expect(advanceAskUserQuestionOverlay('sid-multi', 'macOS')).toBe('advanced');
      const third = getAwaitingOverlay('sid-multi')!;
      expect(third.question).toBe('Ship it?');
      // …and disappear again, or a plain question renders as multi-select.
      expect(third.promptType).toBeUndefined();
    });

    it('reports completion on the last group and keeps every Q→A pair', () => {
      advanceAskUserQuestionOverlay('sid-multi', 'Swift');
      advanceAskUserQuestionOverlay('sid-multi', 'macOS');
      expect(advanceAskUserQuestionOverlay('sid-multi', 'Yes')).toBe('complete');
      expect(getAskUserQuestionAnswers('sid-multi')).toEqual([
        { question: 'Pick a language', label: 'Swift' },
        { question: 'Pick a target', label: 'macOS' },
        { question: 'Ship it?', label: 'Yes' },
      ]);
      // The prompt stays until PostToolUse (injection path) or the ask-gate's
      // own resolution clears it — completion is not a clear.
      expect(getAwaitingOverlay('sid-multi')).toBeDefined();
    });

    it('surfaces group position to devices only when there is more than one', () => {
      const row = (uuid: string): { id: string; askGroupIndex?: number; askGroupCount?: number } =>
        ({ id: `observed:claude:${uuid}` });

      const [multi] = applyAwaitingOverlayToObserved([row('sid-multi')]);
      expect(multi.askGroupIndex).toBe(0);
      expect(multi.askGroupCount).toBe(3);
      advanceAskUserQuestionOverlay('sid-multi', 'Swift');
      expect(applyAwaitingOverlayToObserved([row('sid-multi')])[0].askGroupIndex).toBe(1);

      setAskUserQuestionOverlay('sid-single', 'toolu-single', {
        questions: [{ question: 'Only one', options: [{ label: 'OK' }] }],
      });
      const [single] = applyAwaitingOverlayToObserved([row('sid-single')]);
      expect(single.askGroupIndex).toBeUndefined();
      expect(single.askGroupCount).toBeUndefined();
    });

    it('skips malformed groups instead of presenting a dead prompt', () => {
      setAskUserQuestionOverlay('sid-mixed', 'toolu-mixed', {
        questions: [
          { question: '   ', options: [{ label: 'A' }] },     // no question text
          { question: 'Real one', options: [{ label: 'A' }] },
          { question: 'No options', options: [{ label: '  ' }] },
        ],
      });
      const ov = getAwaitingOverlay('sid-mixed')!;
      expect(ov.groups).toHaveLength(1);
      expect(ov.question).toBe('Real one');
      expect(advanceAskUserQuestionOverlay('sid-mixed', 'A')).toBe('complete');
    });

    it('ignores advancement when no option prompt is pending', () => {
      expect(advanceAskUserQuestionOverlay('sid-unknown', 'A')).toBe('ignored');
      setAwaitingOverlay('sid-perm', 'Allow Bash?');
      expect(advanceAskUserQuestionOverlay('sid-perm', 'A')).toBe('ignored');
    });

    it('clears every group on the matching PostToolUse', () => {
      advanceAskUserQuestionOverlay('sid-multi', 'Swift');
      expect(clearAskUserQuestionOverlay('sid-multi', 'toolu-multi')).toBe(true);
      expect(getAwaitingOverlay('sid-multi')).toBeUndefined();
    });
  });

  // Locks the daemon-server notification-branch contract restored on
  // 2026-07-05 (display-only; the held PreToolUse gate stays removed).
  // Mirrors the /hooks/ handler sequence in daemon-server.ts.
  describe('display-only notification flow (daemon restore contract)', () => {
    const observed = (id: string, state: string) => ({ id, state });

    it('permission_prompt notification → awaiting with NO requestId; next hook clears', () => {
      const sid = 'uuid-flow';
      // 1. Notification hook arrives — gate on the authoritative type.
      expect(isPermissionNotification('permission_prompt', 'Claude needs your permission to use Bash')).toBe(true);
      setAwaitingOverlay(sid, 'Claude needs your permission to use Bash'); // no requestId — display-only
      // 2. Observed enrich renders respond-in-terminal (requestId undefined).
      const out = applyAwaitingOverlayToObserved([observed(`observed:claude:${sid}`, 'processing')]);
      expect(out[0]).toMatchObject({ state: 'awaiting_permission', requestId: undefined });
      // 3. The user answered in the terminal → the tool fires → clear.
      expect(clearAwaitingOverlay(sid)).toBe(true);
      expect(applyAwaitingOverlayToObserved([observed(`observed:claude:${sid}`, 'processing')])[0].state)
        .toBe('processing');
    });

    it('idle ping / auto-approved tool never sets the overlay (the 2026-06-27 false-attention bug)', () => {
      // Idle reminder rides the same Notification hook — must not gate.
      expect(isPermissionNotification('idle_prompt', 'Claude is waiting for your input')).toBe(false);
      // Auto-approved tools fire PreToolUse but never a permission
      // Notification — so no overlay is ever set for them; nothing to assert
      // beyond the gate above rejecting non-permission types.
      expect(isPermissionNotification(undefined, 'Running npm test')).toBe(false);
    });
  });
});
