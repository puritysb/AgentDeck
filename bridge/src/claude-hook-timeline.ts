import type { TimelineEntry } from '@agentdeck/shared';

const MAX_SUMMARY = 180;
const SECRET = /((?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*)[^\s,;]+/gi;

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.replace(SECRET, '$1[redacted]').slice(0, MAX_SUMMARY);
}

function inputSummary(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return safeText(input);
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'command', 'cmd', 'query', 'pattern']) {
    const value = safeText(record[key]);
    if (value) return value;
  }
  return undefined;
}

export interface ClaudeHookTimelinePayload {
  session_id?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: unknown;
}

/** Convert Claude's Pre/PostToolUse hooks into bounded, opt-in timeline rows. */
export function claudeHookTimelineEntry(
  eventName: string,
  payload: ClaudeHookTimelinePayload,
  ts = Date.now(),
): TimelineEntry | null {
  if (eventName !== 'PreToolUse' && eventName !== 'PostToolUse' && eventName !== 'PostToolUseFailure') {
    return null;
  }
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : undefined;
  const toolName = safeText(payload.tool_name) ?? 'Tool';
  const toolUseId = typeof payload.tool_use_id === 'string' && payload.tool_use_id ? payload.tool_use_id : undefined;
  const summary = inputSummary(payload.tool_input);
  const failed = eventName === 'PostToolUseFailure';
  const type = eventName === 'PreToolUse' ? 'tool_request' : 'tool_resolved';
  const state = eventName === 'PreToolUse' ? 'requested' : failed ? 'failed' : 'completed';
  const raw = `${toolName} ${state}`;
  const detail = failed
    ? (safeText(payload.error) ?? summary)
    : eventName === 'PreToolUse'
      ? summary
      : (safeText(payload.tool_response) ?? summary);
  return {
    ts,
    type,
    raw,
    ...(detail ? { detail } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    agentType: 'claude-code',
    toolEvent: true,
  };
}
