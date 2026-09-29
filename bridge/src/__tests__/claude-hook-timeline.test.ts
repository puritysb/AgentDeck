import { describe, expect, it } from 'vitest';
import { claudeHookTimelineEntry } from '../claude-hook-timeline.js';

describe('claude hook timeline projection', () => {
  it('creates a bounded request with correlation and safe input summary', () => {
    const entry = claudeHookTimelineEntry('PreToolUse', {
      session_id: 'session-1', tool_name: 'Bash', tool_use_id: 'tool-1',
      tool_input: { command: 'curl token=secret-value' },
    }, 100);
    expect(entry).toMatchObject({
      ts: 100, type: 'tool_request', raw: 'Bash requested', sessionId: 'session-1',
      toolUseId: 'tool-1', toolEvent: true,
    });
    expect(entry?.detail).toBe('curl token=[redacted]');
  });

  it('maps success and failure completions without exposing arbitrary payloads', () => {
    expect(claudeHookTimelineEntry('PostToolUse', {
      session_id: 's', tool_name: 'Read', tool_use_id: 't', tool_response: 'ok',
    }, 200)).toMatchObject({ type: 'tool_resolved', raw: 'Read completed', detail: 'ok' });
    expect(claudeHookTimelineEntry('PostToolUseFailure', {
      session_id: 's', tool_name: 'Bash', tool_use_id: 't', error: 'token=abc failed',
    }, 300)).toMatchObject({ type: 'tool_resolved', raw: 'Bash failed', detail: 'token=[redacted] failed' });
  });

  it('ignores unrelated hook events', () => {
    expect(claudeHookTimelineEntry('Stop', { session_id: 's' }, 1)).toBeNull();
  });
});
