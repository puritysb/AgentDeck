/**
 * Codex CLI hook → TelemetrySpan adapter.
 *
 * Mirror of `claude-hook.ts:claudeHookToSpans` for the codex_* event family
 * installed by `hooks/src/codex-install.ts`. Codex hook payloads use the
 * same shape as Claude (stdin JSON forwarded as the POST body) — only the
 * event name prefix differs — so the span shapes are kept aligned with the
 * Claude adapter so downstream APME ingestion handles both transparently.
 *
 * Schema source: Codex CLI command-hook stdin JSON; canonical reference is
 * apple/AgentDeck/Daemon/Server/DaemonServer.swift:handleHookEvent (codex
 * branches) and the `~/.codex/config.toml` body assembled by
 * hooks/src/codex-install.ts:managedBlockBody.
 */

import { randomUUID } from 'crypto';
import type {
  AdapterContext,
  TelemetrySpan,
  TelemetryAttributes,
} from '@agentdeck/shared';
import { spanNameForKind } from '@agentdeck/shared';

export function codexHookToSpans(
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

  if (event === 'codex_user_prompt_submit') {
    const prompt = extractPrompt(data);
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

  if (event === 'codex_tool_start') {
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : undefined;
    return [
      make('tool_call', {
        ...(toolName ? { 'gen_ai.tool.name': toolName, 'agentdeck.tool_name': toolName } : {}),
        'agentdeck.raw_payload': data,
      }),
    ];
  }

  if (event === 'codex_tool_end') {
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : undefined;
    return [
      make('tool_result', {
        ...(toolName ? { 'gen_ai.tool.name': toolName, 'agentdeck.tool_name': toolName } : {}),
        'agentdeck.raw_payload': data,
      }),
    ];
  }

  // codex_session_start, codex_stop, codex_turn_complete, etc. are recorded
  // verbatim so the collector still writes a `steps` row for audit and
  // classifier queries. State transitions (IDLE / PROCESSING) live in
  // state-machine.ts:handleHookEvent — APME doesn't need its own.
  return [
    make('raw_step', {
      'agentdeck.raw_event': event,
      'agentdeck.raw_payload': data,
    }),
  ];
}

/** Codex hook payload uses Claude-compatible shapes when the upstream CLI
 *  forwards them (the stdin JSON is whatever Codex's lifecycle hook layer
 *  emits). Most variants nest the prompt under `message.content`; some
 *  embed a top-level `prompt`. Returns `''` if neither shape is present. */
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
  if (typeof data.prompt === 'string') return data.prompt;
  // Codex sometimes sends `{ user_prompt: "..." }`; accept that shape too.
  if (typeof data.user_prompt === 'string') return data.user_prompt;
  return '';
}
