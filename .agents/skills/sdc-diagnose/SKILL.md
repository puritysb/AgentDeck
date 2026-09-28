---
name: sdc-diagnose
description: Diagnose AgentDeck Stream Deck/PTY option synchronization, cursor state, hook ingestion, and bridge state-machine issues. Collects diagnostics, searches known failure patterns, adds focused regression tests, and verifies with pnpm tests.
---

# AgentDeck Diagnostic Skill

Canonical diagnostic procedure for AgentDeck bridge synchronization issues between device displays and agent terminals (cursor desync, false idle, stale options, action dispatch races, hook ingestion gaps, state-machine regressions). This file is the single source of truth — `.claude/skills/sdc-diagnose` is a tracked directory symlink to this skill.

## Step 1: Collect Diagnostic Data

From the repo root, try the live bridge first. Start narrow: ~100 journal entries, filtered to the event types the Step 2 patterns use. Widen (`--tail 300`, then drop the filter) only when the window does not contain the failure.

```bash
cd "$(git rev-parse --show-toplevel)"
EVENTS='state_change|hook|error|option_prompt|navigate_option|cursor_update|select_option|idle|codex_'
agentdeck diag --tail 100 2>/dev/null | grep -E "$EVENTS" | tail -100 \
  || echo "Bridge not running (or no matching events) — using journal files directly"
```

If the bridge isn't running, read journal/log files directly, with the same filter:

```bash
ls -t ~/.agentdeck/journal/*.jsonl 2>/dev/null | head -3
ls -t ~/.agentdeck/journal/*.jsonl 2>/dev/null | head -1 | xargs tail -n 400 | grep -E "$EVENTS" | tail -100
grep -E "$EVENTS" /tmp/sdc-debug.log 2>/dev/null | tail -100 || echo "No debug log found"
```

If access fails, follow `CLAUDE.md` Agent working agreements for execution-policy failures. Treat unreadable diagnostics as unknown, not proof that the bridge is stopped.

## Step 2: Analyze for Known Failure Patterns

### 2a. Cursor Desync
`navigate_option` followed by a stale `cursor_update` with conflicting indices.
```
Pattern: navigate_option cursor=X->Y ... cursor_update cursorIndex=X (reverted)
Root cause: PTY confirmation overwrites optimistic update
Fix: cursor authority system (A3) — optimistic suppresses PTY within 200ms
```

### 2b. False Idle
`option_prompt` followed by `idle` within 500ms.
```
Pattern: option_prompt (N options) ... idle_detected (< 500ms gap)
Root cause: Small chunk with "❯ No" misclassified as idle prompt
Fix: Semantic idle check (A2) — only "❯" or ">" as sole non-ws content
```

### 2c. Stale Options
`option_prompt` with missing or non-contiguous indices.
```
Pattern: option_prompt indices=[0,1,3] (missing 2)
Root cause: Buffer corruption or partial redraw parsed as complete
Fix: Buffer tail re-parse with debounce
```

### 2d. Action Dispatch Race
`select_option` overlapping rapid state transitions.
```
Pattern: select_option ... state AWAITING->PROCESSING->AWAITING (rapid cycle)
Root cause: Enter sent before arrow navigation completes
Fix: Proportional delay (A4) — 50 + |delta| * 20ms
```

### 2e. ANSI Cursor Invisible
Terminal keyboard input without a corresponding `cursor_update` for >500ms.
```
Pattern: (arrow key in terminal) ... no cursor_update for >500ms
Root cause: ink repositions cursor via ANSI sequences without ❯ in chunk
Fix: ANSI reposition detection (A1) — re-parse buffer on small non-❯ chunks
```

### 2f. Codex Hook Gap
Missing `codex_user_prompt_submit`, `codex_tool_start`, `codex_tool_end`, or `codex_stop` in daemon hook logs.
```
Pattern: Codex session active but lifecycle hooks absent from hook log
Root cause: ~/.codex/config.toml hooks not installed/migrated, or fence corrupted
Fix: re-run `agentdeck codex` (installs/migrates) or inspect installCodexHooksIfNeeded
```

## Step 3: Add Regression Tests

Add focused tests near the subsystem under change:

- Parser / state-machine / cursor issues: `bridge/src/__tests__/cursor-sync.test.ts`, `state-machine.test.ts`, or parser tests.
- Codex hook issues: `hooks/src/__tests__/codex-install.test.ts`, `bridge/src/__tests__/state-machine.test.ts`, or the Codex APME adapter tests.
- Apple timeline/rendering issues: `apple/AgentDeckTests/`.

Template (cursor desync, vitest):
```typescript
it('reproduces cursor desync from journal entry', () => {
  const sm = bootToIdle();
  sm.handleParserEvent('option_prompt', {
    options: [/* options from journal */],
    navigable: true,
    cursorIndex: 0,
  });

  sm.updateCursorIndex(/* target */, 'optimistic');
  vi.advanceTimersByTime(/* gap from journal */);
  sm.updateCursorIndex(/* stale PTY value */, 'pty');

  expect(sm.getCursorIndex()).toBe(/* expected */);
});
```

## Step 4: Run & Verify

Run the narrowest useful tests first, then broaden when shared behavior changed:

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm test
pnpm -r exec tsc --noEmit
```

Check that all existing tests pass, new regression tests pass, and there are no TypeScript errors.

## Step 5: Report

```
## Diagnostic Report

### Issues Found
1. [PATTERN]: Description
   - Journal entries: [timestamps]
   - Expected: X
   - Actual: Y
   - Fix: [A1/A2/A3/A4/A5/codex] — description

### Tests Generated
- <file>: N new tests
- Regression coverage: [patterns covered]

### Verification
- pnpm test: PASS/FAIL
- TypeScript: PASS/FAIL

### Recommendations
- [Any additional fixes or monitoring suggestions]
```

## Key Files Reference

| File | Purpose |
|------|---------|
| `bridge/src/output-parser.ts` | PTY output parsing, cursor detection |
| `bridge/src/state-machine.ts` | State transitions, cursor authority |
| `bridge/src/index.ts` | Bridge wiring, command handlers |
| `bridge/src/__tests__/cursor-sync.test.ts` | Cursor sync test suite |
| `hooks/src/codex-install.ts` | Codex lifecycle hook installer (hook-gap issues) |
| `~/.agentdeck/journal/` | Event journal files |
| `/tmp/sdc-debug.log` | Debug log (when `-d` flag used) |
