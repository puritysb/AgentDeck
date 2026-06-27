import { describe, it, expect } from 'vitest';
import {
  cleanDetailText,
  cleanRawText,
  cleanNopMarkers,
  extractSemanticCore,
  isRepetitiveEntry,
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
