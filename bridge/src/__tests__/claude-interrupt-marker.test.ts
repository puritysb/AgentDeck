/**
 * The interrupt-marker predicate — one rule, three consumers (passive
 * observer, turn watchdog, APME collector).
 *
 * What it has to get right is not "does this line contain the words". A
 * transcript routinely QUOTES the marker inside a tool_result — any session
 * that greps its own logs writes one — and reading that as a cancel would
 * force-close a live turn and file it under the wrong bucket.
 */

import { describe, it, expect } from 'vitest';
import { isClaudeInterruptRecord, isClaudeInterruptMessage } from '../claude-interrupt-marker.js';

const MARKER = '[Request interrupted by user]';
const MARKER_TOOL = '[Request interrupted by user for tool use]';

describe('isClaudeInterruptRecord', () => {
  it('matches both marker spellings Claude Code writes', () => {
    for (const text of [MARKER, MARKER_TOOL]) {
      expect(isClaudeInterruptRecord({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })).toBe(true);
    }
  });

  it('matches on `interruptedMessageId` even if the marker text changes', () => {
    // Newer builds stamp the field; it is the structural signal the English
    // sentence cannot drift away from.
    expect(isClaudeInterruptRecord({
      type: 'user',
      interruptedMessageId: 'msg_01',
      message: { role: 'user', content: [{ type: 'text', text: 'anything at all' }] },
    })).toBe(true);
  });

  it('does NOT match the marker quoted inside a tool_result', () => {
    expect(isClaudeInterruptRecord({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `grep hit: ${MARKER}` }] },
    })).toBe(false);
  });

  it('does NOT match an assistant that mentions the marker', () => {
    expect(isClaudeInterruptRecord({
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `I saw ${MARKER}` }] },
    })).toBe(false);
  });

  it('does not match ordinary records or junk', () => {
    expect(isClaudeInterruptRecord({ type: 'user', message: { role: 'user', content: 'hello' } })).toBe(false);
    expect(isClaudeInterruptRecord({ type: 'file-history-snapshot' })).toBe(false);
    expect(isClaudeInterruptRecord(null)).toBe(false);
    expect(isClaudeInterruptRecord('a string')).toBe(false);
  });

  it('tolerates an empty `interruptedMessageId` instead of trusting its presence', () => {
    expect(isClaudeInterruptRecord({
      type: 'user',
      interruptedMessageId: '',
      message: { role: 'user', content: [{ type: 'text', text: 'normal prompt' }] },
    })).toBe(false);
  });
});

describe('isClaudeInterruptMessage', () => {
  it('reads string content as well as text blocks', () => {
    expect(isClaudeInterruptMessage({ role: 'user', content: MARKER })).toBe(true);
    expect(isClaudeInterruptMessage({ role: 'user', content: [{ type: 'text', text: MARKER_TOOL }] })).toBe(true);
    expect(isClaudeInterruptMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] })).toBe(false);
    expect(isClaudeInterruptMessage(undefined)).toBe(false);
  });
});
