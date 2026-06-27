/**
 * Claude Code hook → TelemetrySpan adapter.
 *
 * Translates the per-event hook payload (UserPromptSubmit / PreToolUse /
 * PostToolUse / Stop / SessionStart / SessionEnd / shutdown / …) emitted by
 * Claude Code 2.1+ into AgentDeck telemetry spans.
 *
 * `/clear` is detected here and emitted as a `task_boundary` span so the
 * collector can run `splitRun` before processing it as a normal prompt —
 * preserving the legacy behavior where the slash-command never becomes a
 * real task prompt.
 */

import { randomUUID } from 'crypto';
import type {
  AdapterContext,
  TelemetrySpan,
  TelemetryAttributes,
} from '@agentdeck/shared';
import { spanNameForKind } from '@agentdeck/shared';

export function claudeHookToSpans(
  ctx: AdapterContext,
  event: string,
  data: Record<string, unknown>,
): TelemetrySpan[] {
  const ts = Date.now();
  const baseAttrs: TelemetryAttributes = {
    'agentdeck.agent_type': ctx.agentType,
    ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
  };
  const make = (
    kind: TelemetrySpan['kind'],
    attributes: TelemetryAttributes,
  ): TelemetrySpan => ({
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: ctx.activeTurnId,
    name: spanNameForKind(kind),
    kind,
    ts,
    attributes: { ...baseAttrs, ...attributes },
  });

  if (event === 'UserPromptSubmit') {
    const prompt = extractPrompt(data);
    if (isTaskNotificationPrompt(prompt)) return [];
    if (/^\s*\/clear\s*$/i.test(prompt)) {
      return [make('task_boundary', { 'agentdeck.boundary_signal': 'clear' })];
    }
    return [
      make('turn_start', {
        'agentdeck.prompt_text': prompt,
        'agentdeck.raw_payload': data,
      }),
    ];
  }

  if (event === 'PreToolUse') {
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : undefined;
    return [
      make('tool_call', {
        ...(toolName ? { 'gen_ai.tool.name': toolName, 'agentdeck.tool_name': toolName } : {}),
        'agentdeck.raw_payload': data,
      }),
    ];
  }

  if (event === 'PostToolUse') {
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : undefined;
    return [
      make('tool_result', {
        ...(toolName ? { 'gen_ai.tool.name': toolName, 'agentdeck.tool_name': toolName } : {}),
        'agentdeck.raw_payload': data,
      }),
    ];
  }

  // Everything else (Stop, SessionStart, SessionEnd, Notification, shutdown, ...)
  // is recorded verbatim. The collector still inserts a `steps` row so timeline
  // and classifier/audit queries see them.
  return [
    make('raw_step', {
      'agentdeck.raw_event': event,
      'agentdeck.raw_payload': data,
    }),
  ];
}

/** Claude Code sends `{ message: { content: "..." } }`. Some legacy clients send
 *  `{ prompt: "..." }`. Returns `''` if no recognizable shape — caller handles. */
function extractPrompt(data: Record<string, unknown>): string {
  const fromMessage = (() => {
    const msg = data.message;
    if (msg && typeof msg === 'object') {
      const content = (msg as Record<string, unknown>).content;
      return typeof content === 'string' ? content : '';
    }
    return '';
  })();
  if (fromMessage) return fromMessage;
  return typeof data.prompt === 'string' ? data.prompt : '';
}

function isTaskNotificationPrompt(prompt: string): boolean {
  return prompt.trim().toLowerCase().startsWith('<task-notification>');
}
