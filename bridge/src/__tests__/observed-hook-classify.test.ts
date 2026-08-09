import { describe, it, expect } from 'vitest';
import { classifyObservedHookEvent } from '../daemon-server.js';

/**
 * Regression guard for observed-session hook classification: the daemon's
 * `/hooks/` handler routes Claude (PascalCase), Codex (`codex_*`), and
 * OpenCode (`opencode_*`) lifecycle events through ONE pipeline keyed off
 * the agent-neutral `boundary`. Before this existed, `codex_*` names fell
 * through every gate (openRun / chat_start / stop-completion), so a direct
 * `codex` run produced zero timeline rows and its APME ingestHook silently
 * no-oped for want of a run — the "Codex/OpenCode records invisible on the
 * timeline" bug.
 */
describe('classifyObservedHookEvent', () => {
  it('passes Claude-mapped events through with claude-code attribution', () => {
    expect(classifyObservedHookEvent('UserPromptSubmit', 'user_prompt_submit'))
      .toEqual({ boundary: 'user_prompt_submit', agentType: 'claude-code' });
    expect(classifyObservedHookEvent('Stop', 'stop'))
      .toEqual({ boundary: 'stop', agentType: 'claude-code' });
    expect(classifyObservedHookEvent('SessionEnd', 'session_end'))
      .toEqual({ boundary: 'session_end', agentType: 'claude-code' });
  });

  it('maps codex_* lifecycle names to their boundary with codex-cli attribution', () => {
    expect(classifyObservedHookEvent('codex_session_start', 'codex_session_start'))
      .toEqual({ boundary: 'session_start', agentType: 'codex-cli' });
    expect(classifyObservedHookEvent('codex_user_prompt_submit', 'codex_user_prompt_submit'))
      .toEqual({ boundary: 'user_prompt_submit', agentType: 'codex-cli' });
    expect(classifyObservedHookEvent('codex_tool_start', 'codex_tool_start'))
      .toEqual({ boundary: 'tool_start', agentType: 'codex-cli' });
    expect(classifyObservedHookEvent('codex_tool_end', 'codex_tool_end'))
      .toEqual({ boundary: 'tool_end', agentType: 'codex-cli' });
    expect(classifyObservedHookEvent('codex_stop', 'codex_stop'))
      .toEqual({ boundary: 'stop', agentType: 'codex-cli' });
  });

  it('maps codex notify turn_complete to stop (single completion row per turn)', () => {
    expect(classifyObservedHookEvent('codex_turn_complete', 'codex_turn_complete'))
      .toEqual({ boundary: 'stop', agentType: 'codex-cli' });
  });

  it('keeps Codex subagent hooks attributed to Codex', () => {
    expect(classifyObservedHookEvent('codex_subagent_start', 'codex_subagent_start'))
      .toEqual({ boundary: 'codex_subagent_start', agentType: 'codex-cli' });
    expect(classifyObservedHookEvent('codex_subagent_stop', 'codex_subagent_stop'))
      .toEqual({ boundary: 'codex_subagent_stop', agentType: 'codex-cli' });
  });

  it('maps opencode_* plugin events to their boundary with opencode attribution', () => {
    expect(classifyObservedHookEvent('opencode_session_start', 'opencode_session_start'))
      .toEqual({ boundary: 'session_start', agentType: 'opencode' });
    expect(classifyObservedHookEvent('opencode_user_prompt_submit', 'opencode_user_prompt_submit'))
      .toEqual({ boundary: 'user_prompt_submit', agentType: 'opencode' });
    expect(classifyObservedHookEvent('opencode_stop', 'opencode_stop'))
      .toEqual({ boundary: 'stop', agentType: 'opencode' });
  });

  it('maps hermes_* plugin events to their boundary with hermes attribution', () => {
    expect(classifyObservedHookEvent('hermes_session_start', 'hermes_session_start'))
      .toEqual({ boundary: 'session_start', agentType: 'hermes' });
    expect(classifyObservedHookEvent('hermes_user_prompt_submit', 'hermes_user_prompt_submit'))
      .toEqual({ boundary: 'user_prompt_submit', agentType: 'hermes' });
    expect(classifyObservedHookEvent('hermes_tool_start', 'hermes_tool_start'))
      .toEqual({ boundary: 'tool_start', agentType: 'hermes' });
    expect(classifyObservedHookEvent('hermes_stop', 'hermes_stop'))
      .toEqual({ boundary: 'stop', agentType: 'hermes' });
  });

  it('accepts antigravity_* for forward-compatibility (no installer yet)', () => {
    expect(classifyObservedHookEvent('antigravity_user_prompt_submit', 'antigravity_user_prompt_submit'))
      .toEqual({ boundary: 'user_prompt_submit', agentType: 'antigravity' });
    expect(classifyObservedHookEvent('antigravity_stop', 'antigravity_stop'))
      .toEqual({ boundary: 'stop', agentType: 'antigravity' });
  });

  it('leaves unknown or unprefixed names untouched (claude fallback)', () => {
    // A future agent prefix must be added explicitly — no accidental matches.
    expect(classifyObservedHookEvent('gemini_stop', 'gemini_stop'))
      .toEqual({ boundary: 'gemini_stop', agentType: 'claude-code' });
    // Unknown codex-prefixed suffixes stay verbatim rather than half-mapping.
    expect(classifyObservedHookEvent('codex_bogus', 'codex_bogus'))
      .toEqual({ boundary: 'codex_bogus', agentType: 'claude-code' });
  });
});
