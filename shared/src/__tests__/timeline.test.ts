import { describe, it, expect } from 'vitest';
import {
  cleanDetailText,
  cleanRawText,
  cleanNopMarkers,
  deduplicateEntry,
  extractSemanticCore,
  isRepetitiveEntry,
  normalizeCommandPrompt,
  parseSlashCommandPrompt,
  isAssistantProgressUpdate,
  normalizeTimelineEntryForStorage,
  parseLogLine,
  shouldDropLowSignalTimelineEntry,
  summarizeOpenClawCronPrompt,
  type TimelineEntry,
} from '../timeline.js';

// ============================================================
// cleanDetailText
// ============================================================
describe('cleanDetailText', () => {
  it('returns empty/falsy input unchanged', () => {
    expect(cleanDetailText('')).toBe('');
    expect(cleanDetailText(null as unknown as string)).toBe(null);
  });

  it('strips markdown bold', () => {
    expect(cleanDetailText('**hello** world')).toBe('hello world');
  });

  it('strips markdown headings', () => {
    expect(cleanDetailText('## Heading\ntext')).toBe('Heading\ntext');
    expect(cleanDetailText('### Deep heading')).toBe('Deep heading');
  });

  it('strips code fences', () => {
    expect(cleanDetailText('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('strips inline backticks', () => {
    expect(cleanDetailText('use `foo()` here')).toBe('use foo() here');
  });

  it('strips markdown links', () => {
    expect(cleanDetailText('[click](https://example.com)')).toBe('click');
  });

  it('strips blockquotes', () => {
    expect(cleanDetailText('> quoted text')).toBe('quoted text');
  });

  it('strips list markers', () => {
    expect(cleanDetailText('- item one\n* item two')).toBe('item one\nitem two');
  });

  it('collapses multiple blank lines', () => {
    expect(cleanDetailText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('filters system JSON blobs (connectionId)', () => {
    expect(cleanDetailText('{"connectionId":"abc","stateVersion":3}')).toBe('');
  });

  it('extracts error from JSON blob', () => {
    expect(cleanDetailText('{"error":"timeout occurred"}')).toBe('timeout occurred');
  });

  it('compacts other JSON', () => {
    const json = '{"key":"value","num":42}';
    expect(cleanDetailText(json)).toBe(json);
  });
});

// ============================================================
// cleanRawText
// ============================================================
describe('cleanRawText', () => {
  it('strips bold, headings, links, backticks', () => {
    expect(cleanRawText('**bold** `code` [link](url) ## heading')).toBe('bold code link ## heading');
  });

  it('returns empty/falsy unchanged', () => {
    expect(cleanRawText('')).toBe('');
  });
});

// ============================================================
// cleanNopMarkers
// ============================================================
describe('cleanNopMarkers', () => {
  it('removes NOP markers', () => {
    expect(cleanNopMarkers('NOP task done')).toBe('task done');
    expect(cleanNopMarkers('NOOP action')).toBe('action');
    expect(cleanNopMarkers('Nop result')).toBe('result');
  });

  it('collapses resulting blank lines', () => {
    expect(cleanNopMarkers('NOP\n\n\n\ntext')).toBe('text');
  });

  it('returns empty/falsy unchanged', () => {
    expect(cleanNopMarkers('')).toBe('');
  });
});

// ============================================================
// storage normalization / low-signal filtering
// ============================================================
describe('normalizeTimelineEntryForStorage', () => {
  it('summarizes OpenClaw cron model_call prompts instead of storing shell-like instructions', () => {
    const entry = normalizeTimelineEntryForStorage({
      ts: 100,
      type: 'model_call',
      raw: '[cron:abc self-improvement-daily-review-2350] 입력 수집:\n1. ls -lt 사용\n2. tail -50 사용',
      detail: '[cron:abc self-improvement-daily-review-2350] 입력 수집:\n1. ls -lt 사용\n2. tail -50 사용',
      agentType: 'openclaw',
      automated: true,
    });

    expect(entry).toMatchObject({
      raw: '자동 작업 · self improvement daily review 2350',
      detail: undefined,
      automated: true,
      summaryKind: 'heuristic',
    });
  });

  it('drops low-signal OpenClaw placeholder tool rows', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'tool_exec',
      raw: 'tool · failed',
      detail: 'status: failed',
      agentType: 'openclaw',
    })).toBe(true);
  });

  it('keeps OpenClaw placeholder tool rows when detail carries input or output', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'tool_exec',
      raw: 'tool · running',
      detail: 'status: running\ninput: {"command":"ls -la"}',
      agentType: 'openclaw',
    })).toBe(false);
  });

  it('keeps coalesced Codex subagent lifecycle rows', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'tool_exec',
      raw: 'Subagent reviewer · Started',
      agentType: 'codex-cli',
      sessionId: 'codex:thread-1',
    })).toBe(false);
  });

  it('drops OpenClaw NO_REPLY polling responses from the user-facing timeline', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'chat_response',
      raw: 'Still translating - 2 entries in progress. No action needed.\n\nNO_REPLY',
      detail: 'Two entries still translating -> pipeline not done yet.\n\nNO_REPLY',
      agentType: 'openclaw',
      projectName: 'OpenClaw',
    })).toBe(true);
  });

  it('drops OpenClaw automated polling chat starts from the user-facing timeline', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'chat_start',
      raw: 'Still translating - 2 entries in progress, 1 failed. Not all terminal yet.',
      agentType: 'openclaw',
      projectName: 'OpenClaw',
      automated: true,
    })).toBe(true);
  });

  it('drops Claude task notification chat starts from the user-facing timeline', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'chat_start',
      raw: 'Entry [2] (Pride and Prejudice',
      detail: '<task-notification>\n<summary>Background command completed</summary>',
      agentType: 'claude-code',
      projectName: 'AgentDeck',
    })).toBe(true);
  });

  it('keeps OpenClaw LINE userId notification failures visible', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'chat_response',
      raw: 'Pride and Prejudice published - LINE notification failed (userId 미등록, 4/21부터 지속)\n\nNO_REPLY',
      detail: 'LINE target ID is still unconfigured. Notification remains pending.',
      agentType: 'openclaw',
      projectName: 'OpenClaw',
    })).toBe(false);
  });

  it('drops Codex command tool rows even when detail carries input', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'tool_exec',
      raw: 'Bash: rg -n "Timeline" apple/AgentDeck',
      detail: 'status: running\n{"cmd":"rg -n Timeline"}',
      agentType: 'codex-cli',
      projectName: 'AgentDeck',
      sessionId: 'codex:thread-1',
    })).toBe(true);
  });

  it('drops OpenCode tool rows so a tool-heavy turn does not flood the strip', () => {
    for (const raw of ['bash', 'bash completed', 'read completed', 'todowrite']) {
      expect(shouldDropLowSignalTimelineEntry({
        ts: 100,
        type: 'tool_exec',
        raw,
        agentType: 'opencode',
        projectName: 'OpenClaw',
        sessionId: 'opencode:ses_09e7',
      })).toBe(true);
    }
    // chat rows for the same session are kept — only tool_exec is suppressed.
    expect(shouldDropLowSignalTimelineEntry({
      ts: 101,
      type: 'chat_start',
      raw: 'openclaw 업데이트되었다 반영하고 점검하라',
      agentType: 'opencode',
      sessionId: 'opencode:ses_09e7',
    })).toBe(false);
  });

  it('drops Antigravity tool rows too (forward-compat with the observed classifier)', () => {
    expect(shouldDropLowSignalTimelineEntry({
      ts: 100,
      type: 'tool_exec',
      raw: 'bash',
      agentType: 'antigravity',
      sessionId: 'antigravity:sess-1',
    })).toBe(true);
  });

  it('extracts readable labels from cron headers', () => {
    expect(summarizeOpenClawCronPrompt('[cron:id ai-eval-kindergarten-daily] body'))
      .toBe('자동 작업 · ai eval kindergarten daily');
  });
});

describe('isAssistantProgressUpdate', () => {
  it('detects non-terminal build/status updates', () => {
    expect(isAssistantProgressUpdate(
      "Android build is still running (its | tail buffers output until completion, so no interim lines). I'll continue once the completion event arrives.",
    )).toBe(true);
  });

  it('does not classify final completion reports as progress', () => {
    expect(isAssistantProgressUpdate(
      'Completed. Android build passed, node build is green, and macOS Swift build succeeded.',
    )).toBe(false);
  });
});

// ============================================================
// extractSemanticCore
// ============================================================
describe('extractSemanticCore', () => {
  it('strips duration suffix for chat_end', () => {
    expect(extractSemanticCore('작업 완료 · 3 tools · 12s', 'chat_end')).toBe('작업 완료');
  });

  it('keeps full text for chat_end without separator', () => {
    expect(extractSemanticCore('simple end', 'chat_end')).toBe('simple end');
  });

  it('keeps full text for non-chat_end types', () => {
    expect(extractSemanticCore('start · extra', 'chat_start')).toBe('start · extra');
  });

  it('trims whitespace', () => {
    expect(extractSemanticCore('  padded  ', 'chat_start')).toBe('padded');
  });
});

// ============================================================
// isRepetitiveEntry
// ============================================================
describe('isRepetitiveEntry', () => {
  const makeEntry = (raw: string, type: 'chat_end' | 'chat_start' = 'chat_end', ts = 1000): TimelineEntry => ({
    ts, type, raw, detail: undefined,
  });

  it('detects exact duplicate chat_end entries', () => {
    const recent = [makeEntry('작업 완료 · 2 tools · 5s', 'chat_end', 500)];
    const entry = makeEntry('작업 완료 · 3 tools · 12s', 'chat_end', 800);
    expect(isRepetitiveEntry(entry, recent)).toBe(0);
  });

  it('detects keyword-similar entries', () => {
    const recent = [makeEntry('WhatsApp 연결 상태 확인 완료', 'chat_end', 500)];
    const entry = makeEntry('WhatsApp 연결 확인 상태 완료', 'chat_end', 800);
    expect(isRepetitiveEntry(entry, recent)).toBe(0);
  });

  it('returns -1 for non-matching entries', () => {
    const recent = [makeEntry('파일 수정 작업', 'chat_end', 500)];
    const entry = makeEntry('데이터베이스 백업 완료', 'chat_end', 800);
    expect(isRepetitiveEntry(entry, recent)).toBe(-1);
  });

  it('ignores entries outside window', () => {
    const recent = [makeEntry('같은 작업 완료', 'chat_end', 100)];
    const entry = makeEntry('같은 작업 완료', 'chat_end', 3_700_000);
    expect(isRepetitiveEntry(entry, recent)).toBe(-1);
  });

  it('only applies to chat_end, chat_start, and error types', () => {
    const recent: TimelineEntry[] = [{ ts: 500, type: 'tool_request', raw: 'same tool' }];
    const entry: TimelineEntry = { ts: 800, type: 'tool_request', raw: 'same tool' };
    expect(isRepetitiveEntry(entry, recent)).toBe(-1);
  });

  it('dedupes repeated error entries within 1h window', () => {
    const recent: TimelineEntry[] = [{ ts: 500, type: 'error', raw: 'same error' }];
    const entry: TimelineEntry = { ts: 800, type: 'error', raw: 'same error' };
    expect(isRepetitiveEntry(entry, recent)).toBe(0);
  });

  it('matches chat_start entries', () => {
    const recent = [makeEntry('프롬프트 전송', 'chat_start', 500)];
    const entry = makeEntry('프롬프트 전송', 'chat_start', 800);
    expect(isRepetitiveEntry(entry, recent)).toBe(0);
  });

  // ---- automated entry dedup ----

  it('dedupes automated entries regardless of content', () => {
    const recent: TimelineEntry[] = [
      { ts: 500, type: 'chat_end', raw: 'WhatsApp 연결 확인 완료 · 3s', automated: true },
    ];
    const entry: TimelineEntry = {
      ts: 800, type: 'chat_end', raw: '완전히 다른 자동 작업 결과', automated: true,
    };
    expect(isRepetitiveEntry(entry, recent)).toBe(0);
  });

  it('exempts error rows from the content-agnostic automated collapse', () => {
    // The flag-only merge exists to stop cron chatter flooding the strip. On
    // an `error` row it would collapse two automated turns that failed for
    // completely different reasons into one row wearing the newer message —
    // and the window is 8 h, so a whole day of distinct failures reads as one.
    const recent: TimelineEntry[] = [
      { ts: 500, type: 'error', raw: 'The AI service is temporarily overloaded.', automated: true },
    ];
    const different: TimelineEntry = {
      ts: 800, type: 'error', raw: 'API key has run out of credits.', automated: true,
    };
    expect(isRepetitiveEntry(different, recent)).toBe(-1);

    // A genuinely recurring failure still collapses, by similarity.
    const same: TimelineEntry = {
      ts: 900, type: 'error', raw: 'The AI service is temporarily overloaded.', automated: true,
    };
    expect(isRepetitiveEntry(same, recent)).toBe(0);
  });

  it('does not dedup automated vs non-automated', () => {
    const recent: TimelineEntry[] = [
      { ts: 500, type: 'chat_end', raw: 'WhatsApp 연결 확인 완료', automated: true },
    ];
    const entry: TimelineEntry = {
      ts: 800, type: 'chat_end', raw: '사용자 요청 작업 완료',
    };
    // Different content, one automated one not — should NOT match
    expect(isRepetitiveEntry(entry, recent)).toBe(-1);
  });

  it('uses 8h window for automated entries', () => {
    const eightHoursAgo = 8 * 3_600_000 - 100; // just within 8h
    const recent: TimelineEntry[] = [
      { ts: 100, type: 'chat_end', raw: '자동 작업 A', automated: true },
    ];
    const entry: TimelineEntry = {
      ts: eightHoursAgo, type: 'chat_end', raw: '자동 작업 B', automated: true,
    };
    expect(isRepetitiveEntry(entry, recent)).toBe(0);
  });

  it('expires automated dedup after 8h', () => {
    const recent: TimelineEntry[] = [
      { ts: 100, type: 'chat_end', raw: '자동 작업 A', automated: true },
    ];
    const entry: TimelineEntry = {
      ts: 8 * 3_600_000 + 200, type: 'chat_end', raw: '자동 작업 B', automated: true,
    };
    expect(isRepetitiveEntry(entry, recent)).toBe(-1);
  });
});

// ============================================================
// parseLogLine
// ============================================================
describe('parseLogLine', () => {
  it('returns null for null/undefined/non-object', () => {
    expect(parseLogLine(null)).toBeNull();
    expect(parseLogLine(undefined)).toBeNull();
    expect(parseLogLine('string')).toBeNull();
    expect(parseLogLine(42)).toBeNull();
  });

  it('returns null for empty message', () => {
    expect(parseLogLine({ time: '2025-01-01T00:00:00Z' })).toBeNull();
  });

  // --- Legacy structured format ---
  it('returns null for model start/complete (suppressed)', () => {
    expect(parseLogLine({ model: 'gpt-4o', action: 'start' })).toBeNull();
    expect(parseLogLine({ model: 'gpt-4o', action: 'complete' })).toBeNull();
    expect(parseLogLine({ model: 'gpt-4o', action: 'response' })).toBeNull();
  });

  it('parses memory/recall (legacy structured)', () => {
    const result = parseLogLine({ component: 'memory', action: 'recall', query: 'user preferences' });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('memory_recall');
    expect(result!.raw).toContain('user preferences');
  });

  it('parses tool execution (legacy structured)', () => {
    const result = parseLogLine({ tool: 'read_file', detail: '/src/index.ts' });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('tool_exec');
    expect(result!.raw).toContain('read_file');
    expect(result!.raw).toContain('/src/index.ts');
  });

  // --- OpenClaw message-text based ---
  it('filters gateway/ws subsystem', () => {
    expect(parseLogLine({
      message: 'chat.send completed', subsystem: 'gateway/ws',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('filters infrastructure noise', () => {
    expect(parseLogLine({ message: 'Agents: 3 active', time: '2025-01-01T00:00:00Z' })).toBeNull();
    expect(parseLogLine({ message: 'Heartbeat interval: 30s', time: '2025-01-01T00:00:00Z' })).toBeNull();
    expect(parseLogLine({ message: 'WhatsApp:', time: '2025-01-01T00:00:00Z' })).toBeNull();
  });

  it('filters channel infra reconnect noise', () => {
    expect(parseLogLine({
      message: 'Web connection closed, retrying',
      subsystem: 'channel', time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('filters connection status JSON blobs', () => {
    expect(parseLogLine({
      message: '{"connectionId":"abc123","status":"connected"}',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('filters transient fetch timeouts', () => {
    expect(parseLogLine({
      message: 'web_fetch timed out for https://example.com',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('filters edit mismatch errors (agent retries)', () => {
    expect(parseLogLine({
      message: 'edit failed: Could not find the exact text',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('filters failover cascade noise', () => {
    expect(parseLogLine({
      message: 'FailoverError: LLM request timed out.',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('parses genuine errors', () => {
    const result = parseLogLine({
      message: 'Database connection failed: ECONNREFUSED',
      level: 'error',
      time: '2025-01-01T00:00:00Z',
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('error');
  });

  it('parses error from message pattern (not level)', () => {
    const result = parseLogLine({
      message: 'EACCES: permission denied on /etc/config',
      time: '2025-01-01T00:00:00Z',
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('error');
  });

  it('filters model/inference patterns (suppressed)', () => {
    expect(parseLogLine({
      message: 'inference completed for model gpt-4',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('does not synthesize memory_recall from message text alone', () => {
    // Heuristic word-match removed — real memory/recall activity flows
    // through the Gateway adapter, not log scraping.
    expect(parseLogLine({
      message: 'memory recall: user context loaded',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('does not synthesize tool_exec from message text alone', () => {
    // Heuristic word-match removed — real tool activity flows through the
    // Gateway adapter.
    expect(parseLogLine({
      message: 'tool execution: grep for pattern',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });

  it('parses ISO timestamp correctly via error pattern', () => {
    // Message contains "failed" + "error" → error matcher; preserves the
    // ISO timestamp.
    const result = parseLogLine({
      message: 'command failed with error',
      time: '2025-06-15T10:30:00Z',
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('error');
    expect(result!.ts).toBe(new Date('2025-06-15T10:30:00Z').getTime());
  });

  it('falls back to Date.now() for invalid timestamp on error message', () => {
    const before = Date.now();
    const result = parseLogLine({
      message: 'command execution error occurred',
      time: 'invalid-date',
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe('error');
    expect(result!.ts).toBeGreaterThanOrEqual(before);
  });

  it('truncates long tool raw to 500 chars', () => {
    const longDetail = 'x'.repeat(600);
    const result = parseLogLine({ tool: 'bash', detail: longDetail });
    expect(result).not.toBeNull();
    expect(result!.raw.length).toBeLessThanOrEqual(500);
    expect(result!.raw).toContain('...');
  });

  it('filters whatsapp noise from channel infra subsystem', () => {
    expect(parseLogLine({
      message: 'WebSocket error connecting to whatsapp',
      module: 'whatsapp',
      time: '2025-01-01T00:00:00Z',
    })).toBeNull();
  });
});

describe('parseSlashCommandPrompt', () => {
  it('parses a bare command', () => {
    expect(parseSlashCommandPrompt('/merge')).toEqual({ command: '/merge' });
    expect(parseSlashCommandPrompt('  /session-end  ')).toEqual({ command: '/session-end' });
  });

  it('parses a command with arguments', () => {
    expect(parseSlashCommandPrompt('/merge --squash now')).toEqual({ command: '/merge', args: '--squash now' });
  });

  it('parses plugin-scoped command names', () => {
    expect(parseSlashCommandPrompt('/plugin:cmd arg')).toEqual({ command: '/plugin:cmd', args: 'arg' });
  });

  it('parses the Claude Code command XML envelope', () => {
    const xml = '<command-message>merge</command-message>\n<command-name>/merge</command-name>\n<command-args>--squash</command-args>';
    expect(parseSlashCommandPrompt(xml)).toEqual({ command: '/merge', args: '--squash' });
  });

  it('normalizes an envelope name missing the leading slash', () => {
    expect(parseSlashCommandPrompt('<command-name>merge</command-name>')).toEqual({ command: '/merge' });
  });

  it('rejects ordinary prompts and filesystem paths', () => {
    expect(parseSlashCommandPrompt('그냥 질문입니다')).toBeNull();
    expect(parseSlashCommandPrompt('/Users/x/file.txt 읽어줘')).toBeNull();
    expect(parseSlashCommandPrompt('/usr/bin/env 확인')).toBeNull();
    expect(parseSlashCommandPrompt('')).toBeNull();
    expect(parseSlashCommandPrompt(undefined)).toBeNull();
  });
});

describe('normalizeCommandPrompt', () => {
  it('collapses an XML envelope to "/name args"', () => {
    const xml = '<command-message>merge</command-message>\n<command-name>/merge</command-name>\n<command-args>--squash</command-args>';
    expect(normalizeCommandPrompt(xml)).toBe('/merge --squash');
  });

  it('passes ordinary prompts through unchanged', () => {
    expect(normalizeCommandPrompt('/merge')).toBe('/merge');
    expect(normalizeCommandPrompt('일반 프롬프트')).toBe('일반 프롬프트');
  });
});

describe('deduplicateEntry — interrupted close + cross-session guards', () => {
  const mk = (over: Partial<TimelineEntry>): TimelineEntry => ({
    ts: 1000, type: 'chat_end', raw: 'x', ...over,
  });

  it('never repetitive-merges rows from different sessions', () => {
    const a = mk({ ts: 1000, type: 'chat_response', raw: '빌드 수정 완료 결과 정리', sessionId: 'A' });
    const b = mk({ ts: 2000, type: 'chat_response', raw: '빌드 수정 완료 결과 정리 보고', sessionId: 'B' });
    const result = deduplicateEntry(b, [a]);
    expect(result.action).toBe('add');
  });

  it('adds interrupted chat_end rows instead of merging them by semantic core', () => {
    const a = mk({ ts: 1000, raw: 'Interrupted · 42s', sessionId: 'A' });
    // Same session, later interrupted close of a DIFFERENT turn — must not
    // merge away (that would reopen the earlier turn's spinner).
    const b = mk({ ts: 500_000, raw: 'Interrupted · ~2m', sessionId: 'A' });
    const result = deduplicateEntry(b, [a]);
    expect(result.action).toBe('add');
  });
});
