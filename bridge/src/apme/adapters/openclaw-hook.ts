/**
 * OpenClaw Gateway event → TelemetrySpan adapter.
 *
 * OpenClaw is a chat-style remote agent reached over a WebSocket Gateway
 * (`shared/src/gateway-protocol.ts`). Unlike Claude Code (Stop hook +
 * PostToolUse TodoWrite) and Codex CLI (hook system), OpenClaw never emits a
 * structured "task complete" signal — it streams `chat.delta` chunks during
 * generation and a single `chat.final` per assistant turn. With nothing
 * stronger to anchor a task to, OpenClaw previously fell back to
 * `session_end` only, collapsing every chat session to a single APME task
 * and defeating per-task evaluation.
 *
 * # Boundary signal: idle_gap (90 s)
 *
 * The chosen boundary is **idle_gap**: after `chat.final`, if the user
 * doesn't send a new `chat.send` within 90 seconds, treat the conversation
 * as one closed task. Rationale, derived from inspecting the chat-final /
 * chat-delta fixture set (`tests/parity/gateway-frames/`) and the four
 * scenario classes that ship in the audit plan:
 *
 *   (a) Single Q/A         → 1 final, no follow-up → idle_gap fires once.
 *   (b) Multi-turn collab  → user keeps replying within 90 s → 1 task
 *                            (collaboration stays together).
 *   (c) Long task w/ Qs    → same as (b), user clarifications keep the
 *                            idle timer reset until the agent fully closes
 *                            the topic.
 *   (d) Abrupt new topic   → if the pivot happens within 90 s of the
 *                            previous final, this v1 will lump both into
 *                            one task. Acceptable v1 limitation —
 *                            user-driven `manual` boundary or longer
 *                            silence between topics splits them. A future
 *                            topic-shift embedder is the obvious next step.
 *
 * 90 s is conservative: long enough that genuine multi-turn debugging
 * stays together, short enough that a real "I'm done, walking away"
 * gesture closes the task within a normal coffee break. The threshold is
 * exposed as `OPENCLAW_IDLE_GAP_MS` so a downstream consumer can override
 * for a hot-research session if needed.
 *
 * # Alternative boundaries considered (rejected for v1)
 *
 *   - `chat.final` per turn: too granular — every user/assistant turn pair
 *     would be its own task. Defeats the "what did the agent accomplish"
 *     framing — evaluation should span the work, not the words.
 *   - Embedding-based topic shift: cost-heavy + cold-start fragile. Not v1.
 *   - Gateway `taskCompleted` event: no such event in `GatewayEventPayload`
 *     union. Adding it requires the OpenClaw server to emit it, which the
 *     bridge can't unilaterally do.
 *
 * # Wiring
 *
 * `bridge/src/adapters/openclaw.ts` calls `openclawChatEventToSpans(ctx,
 * payload)` from its `chat` event branch and forwards the resulting spans
 * to `apme.collector.ingestSpan`. The idle timer is owned by the OpenClaw
 * adapter (not this module) because it needs access to the active session
 * id and an actual `setTimeout`. This module is pure — given a payload it
 * returns the spans the adapter should currently emit, no side effects.
 */

import { randomUUID } from 'crypto';
import type {
  AdapterContext,
  TelemetrySpan,
  TelemetryAttributes,
  ChatEventPayload,
  SessionToolPayload,
  SessionMessagePayload,
} from '@agentdeck/shared';
import { spanNameForKind } from '@agentdeck/shared';

/** Default idle-gap threshold after `chat.final` before we close the task. */
export const OPENCLAW_IDLE_GAP_MS = 90_000;

/**
 * `ChatEventPayload` widened with the turn facts only the OpenClaw adapter
 * holds. The Gateway's `chat` error frame carries just
 * `errorMessage`/`errorKind`/`stopReason`/`runId` — no provider, no model, and
 * nothing about what the turn had already done — so "how long did it run" and
 * "which tools ran" have to come from the adapter's own turn counters.
 *
 * Kept here rather than on `ChatEventPayload` (`shared/src/gateway-protocol.ts`)
 * because that type describes the wire, and these fields are not on the wire.
 * `ChatEventPayload` is assignable to this, so existing callers are unaffected.
 */
export type OpenClawChatEventInput = ChatEventPayload & {
  /** Gateway `errorKind`, e.g. "unavailable". */
  errorKind?: string;
  /** Gateway `stopReason` for the failed run. */
  stopReason?: string;
  /** Seconds the turn ran before failing. 0/absent when unknown. */
  durationSec?: number;
  /** Tool names used in the failed turn, first-use order. */
  toolNames?: readonly string[];
};

/** Cap for the one-line label. Matches the slice `sample-to-timeline.ts`
 *  applies when projecting an `info` event, so the projected row and the
 *  adapter's own row stay byte-equal (see `openclawChatErrorLabel`). */
const ERROR_LABEL_MAX = 120;
/** Cap for the detail block. Matches the projection's slice for the same reason. */
const ERROR_DETAIL_MAX = 1000;

/**
 * One-line failure label for a `chat` error frame.
 *
 * **Single source on purpose.** The adapter writes this string into the
 * timeline row's `raw`, and the same string rides the `agent_error` span into
 * the trajectory as the `info` event's label. Under
 * `AGENTDECK_TIMELINE_PROJECTION=1` the projection turns that `info` event
 * back into an `error` row — if the two strings differed the user would see
 * the same failure twice; being byte-equal, the timeline store's exact-dedup
 * (same type + raw within 8 s) collapses them.
 */
export function openclawChatErrorLabel(payload: OpenClawChatEventInput): string {
  const message = (payload.error ?? '').trim();
  if (message) return message.slice(0, ERROR_LABEL_MAX);
  const kind = (payload.errorKind ?? '').trim();
  // Previously this fell back to the bare word "unknown", which as a whole
  // timeline row told the reader nothing at all.
  return (kind ? `Chat error (${kind})` : 'Chat error').slice(0, ERROR_LABEL_MAX);
}

/**
 * Context block for the failure row's `detail`. The gateway message alone
 * ("The AI service is temporarily overloaded") says what the provider replied
 * but nothing about *this* turn, so reading the timeline used to require
 * opening the OpenClaw gateway log to learn anything else. The run id is the
 * join key into that log, hence its inclusion.
 *
 * Returns undefined when there is nothing beyond the label — a `detail` that
 * merely repeats `raw` is noise on every surface that renders both.
 */
export function openclawChatErrorDetail(payload: OpenClawChatEventInput): string | undefined {
  const lines: string[] = [];
  const message = (payload.error ?? '').trim();
  if (message) lines.push(message);

  const facts: string[] = [];
  const duration = payload.durationSec ?? 0;
  if (duration > 0) facts.push(`failed after ${duration}s`);
  const tools = (payload.toolNames ?? []).filter((t) => !!t && t.trim());
  if (tools.length) facts.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.join(', ')}`);
  if (facts.length) lines.push(facts.join(' · '));

  const ids: string[] = [];
  const kind = (payload.errorKind ?? '').trim();
  if (kind) ids.push(`kind ${kind}`);
  const stopReason = (payload.stopReason ?? '').trim();
  if (stopReason) ids.push(`stop ${stopReason}`);
  const runId = (payload.runId ?? '').trim();
  if (runId) ids.push(`run ${runId.slice(0, 8)}`);
  if (ids.length) lines.push(ids.join(' · '));

  if (lines.length === 0) return undefined;
  if (lines.length === 1 && lines[0] === openclawChatErrorLabel(payload)) return undefined;
  return lines.join('\n').slice(0, ERROR_DETAIL_MAX);
}

/**
 * Convert a Gateway `chat` event payload into the spans the APME collector
 * should ingest right now. Does NOT emit the idle-gap `task_boundary` —
 * that's owned by the adapter's timer (it needs setTimeout + per-session
 * state). Callers should also fire `emitIdleGapTaskBoundary(...)` when the
 * idle timer expires.
 */
export function openclawChatEventToSpans(
  ctx: AdapterContext,
  payload: OpenClawChatEventInput,
): TelemetrySpan[] {
  const ts = Date.now();
  const baseAttrs: TelemetryAttributes = {
    'agentdeck.agent_type': ctx.agentType,
    ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
    ...(payload.runId ? { 'agentdeck.run_id': payload.runId } : {}),
    ...(payload.sessionKey ? { 'agentdeck.gateway_session_key': payload.sessionKey } : {}),
  };
  const make = (
    kind: TelemetrySpan['kind'],
    attributes: TelemetryAttributes = {},
  ): TelemetrySpan => ({
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: ctx.activeTurnId,
    name: spanNameForKind(kind),
    kind,
    ts,
    attributes: { ...baseAttrs, ...attributes },
  });

  if (payload.state === 'delta') {
    // Deltas are streaming chunks — only the first delta of a new turn is
    // load-bearing for APME (opens the turn). The OpenClaw adapter detects
    // "first delta" via `chatStarted` and is responsible for emitting the
    // turn_start when calling us. We don't emit on every delta — that
    // would balloon the steps table and add no eval signal.
    return [];
  }

  if (payload.state === 'final') {
    const spans: TelemetrySpan[] = [];
    if (payload.response) {
      spans.push(make('turn_response', { 'agentdeck.response_text': payload.response }));
    }
    if (Array.isArray(payload.tools)) {
      for (const t of payload.tools) {
        if (!t.name) continue;
        spans.push(make('tool_result', {
          'gen_ai.tool.name': t.name,
          'agentdeck.tool_name': t.name,
          ...(t.status ? { 'agentdeck.tool_status': t.status } : {}),
        }));
      }
    }
    // `chat.final` IS OpenClaw's stop signal — close the turn on it rather than
    // waiting for the next `turn_start`. Without this a single-turn
    // conversation left its turn open until the whole run closed, so the turn
    // carried no duration and its tool tally was never flushed. Measured
    // 2026-08-23: openclaw was the ONLY agent with turns still open under an
    // already-closed task.
    spans.push(make('turn_end', { 'agentdeck.turn_end_source': 'stop' }));
    return spans;
  }

  if (payload.state === 'aborted') {
    // Treat as a manual boundary — user explicitly stopped this turn. The
    // composite outcome derivation will see the absence of a complete
    // response and score accordingly. The turn closes as `interrupted`, which
    // is its own bucket and NOT a lost stop signal: the user cancelled, so no
    // normal close was ever due.
    return [
      make('turn_end', { 'agentdeck.turn_end_source': 'interrupted' }),
      make('task_boundary', { 'agentdeck.boundary_signal': 'manual' }),
    ];
  }

  if (payload.state === 'error') {
    // Error doesn't close the task — the agent might retry on the same
    // prompt, so the boundary stays with the adapter's idle-gap timer (which
    // it re-arms here, exactly as it does after `final`; before that it armed
    // nothing and a prompt that ERRORED and was then abandoned left the task
    // open forever, which starves the eval).
    //
    // What this span adds is the *reason*. Returning [] meant a failed turn
    // reached the trajectory as a turn_start with no response and no
    // annotation — byte-identical to a turn whose response event was dropped,
    // so neither a judge nor a human could tell a provider outage from a bug
    // in our own capture.
    const detail = openclawChatErrorDetail(payload);
    return [make('agent_error', {
      'agentdeck.error_label': openclawChatErrorLabel(payload),
      ...(detail ? { 'agentdeck.error_detail': detail } : {}),
    })];
  }

  return [];
}

/**
 * Text carried by an OpenClaw message `content`, which is a string for user
 * messages and an array of typed blocks for assistant / toolResult ones.
 *
 * Shape taken from the live store (`~/.openclaw/agents/<agent>/sessions/*.jsonl`)
 * and from the Gateway's own projection (`projectChatDisplayMessage`, which
 * preserves `{role, content}` verbatim) — NOT from an assumed flat
 * `{role, text}`, which is what the previous version of this function read and
 * why it would have found nothing even once the frames started arriving.
 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('');
}

/** `toolCall` blocks inside an assistant message's `content` array. */
function toolCallBlocks(content: unknown): Array<{ id?: string; name: string; arguments?: unknown }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id?: string; name: string; arguments?: unknown }> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (b.type !== 'toolCall' || typeof b.name !== 'string' || !b.name) continue;
    out.push({
      ...(typeof b.id === 'string' ? { id: b.id } : {}),
      name: b.name,
      ...(b.arguments !== undefined ? { arguments: b.arguments } : {}),
    });
  }
  return out;
}

/**
 * Convert a Gateway `session.tool` event into spans.
 *
 * **Real shape** (`dist/server-chat-wgxNCdC3.js`, the `agentPayload` spread):
 * `{...agentEvent, sessionKey, agentId?, spawnedBy?, isHeartbeat?, ...snapshot}`
 * where the agent event is `{runId, stream:'tool', seq, ts, data}` and `data`
 * is `{phase:'start'|'result', name, toolCallId, meta?, args?, isError?, result?}`.
 * The previous version read a flat `{name|tool, status, input, output}` — a
 * shape the Gateway has never sent — so every field would have come back
 * undefined and the function would have returned `[]` for every real frame.
 *
 * `phase:'start'` opens a pending ToolEvent; `phase:'result'` resolves it.
 */
export function openclawSessionToolToSpans(
  ctx: AdapterContext,
  payload: SessionToolPayload,
): TelemetrySpan[] {
  const data = (payload.data ?? {}) as {
    phase?: unknown; name?: unknown; toolCallId?: unknown;
    args?: unknown; result?: unknown; isError?: unknown;
  };
  const name = typeof data.name === 'string' && data.name ? data.name : undefined;
  if (!name) return [];
  const phase = typeof data.phase === 'string' ? data.phase : '';
  // Anything that is not an explicit terminal phase is treated as still
  // running — the permissive direction, since a `tool_call` with no matching
  // `tool_result` reads as "unfinished" while the reverse invents a
  // completion that never happened.
  const isResult = phase === 'result' || phase === 'end' || phase === 'error';
  const kind: TelemetrySpan['kind'] = isResult ? 'tool_result' : 'tool_call';
  const ts = typeof payload.ts === 'number' ? payload.ts : Date.now();
  const status = isResult ? (data.isError === true ? 'error' : 'success') : 'running';
  const attrs: TelemetryAttributes = {
    'agentdeck.agent_type': ctx.agentType,
    ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
    ...(payload.sessionKey ? { 'agentdeck.gateway_session_key': payload.sessionKey } : {}),
    'gen_ai.tool.name': name,
    'agentdeck.tool_name': name,
    'agentdeck.raw_payload': {
      status,
      ...(typeof data.toolCallId === 'string' ? { tool_call_id: data.toolCallId } : {}),
      ...(data.args !== undefined ? { tool_input: data.args } : {}),
      ...(data.result !== undefined ? { tool_response: data.result } : {}),
    },
  };
  return [{
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: ctx.activeTurnId,
    name: spanNameForKind(kind),
    kind,
    ts,
    attributes: attrs,
  }];
}

/**
 * Convert a Gateway `session.message` event into spans.
 *
 * **This is the only channel that carries the user's prompt.** The `chat`
 * frame is assistant-only (`emitChatDelta` / `emitChatTerminal` build
 * `message:{role:'assistant',…}` and nothing else), so before this event was
 * subscribed to, no `turn_start` was ever emitted for a conversation started
 * in the OpenClaw app — and a `turn_response` with no open turn is dropped by
 * `Collector.setTurnResponse`. That is why 657 of 665 recorded OpenClaw runs
 * hold zero turns.
 *
 * **Real shape**: `{sessionKey, agentId?, senderIsOwner?, message, messageId?,
 * messageSeq?, ...sessionSnapshot}` where `message` is
 * `{role:'user'|'assistant'|'toolResult', content, …}` — `content` a string for
 * user messages, an array of typed blocks otherwise. Assistant messages also
 * carry `provider` / `model` / `usage:{input,output}`, the per-turn facts the
 * `chat` frame never reports.
 *
 * **Ownership, so nothing is counted twice.** The two Gateway channels carry
 * overlapping halves, so each fact has exactly one source here:
 *   - the prompt comes from this event (nothing else has it);
 *   - tool calls come from `session.tool`, which carries args AND result —
 *     the `toolCall` blocks in an assistant message are deliberately ignored;
 *   - the response is emitted from here too, because a run the Gateway hides
 *     from the control UI never reaches us as a `chat` final at all. When both
 *     arrive they carry the same text, and the sample layer dedups on
 *     `kind|turnIndex|hash(text)` while `turns.response` is simply rewritten
 *     with the same value.
 */
export function openclawSessionMessageToSpans(
  ctx: AdapterContext,
  payload: SessionMessagePayload,
): TelemetrySpan[] {
  const message = payload.message as
    | {
      role?: unknown; content?: unknown; provider?: unknown; model?: unknown;
      usage?: unknown; timestamp?: unknown;
    }
    | undefined;
  if (!message || typeof message !== 'object') return [];
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  // Measured: the `session.message` frame carries no top-level `ts` (its top
  // level is the session snapshot), but the message itself is stamped. Using
  // `Date.now()` for a message the Gateway already dated would put every event
  // at delivery time instead of at the time it happened.
  const stamped = (message as { timestamp?: unknown }).timestamp;
  const ts = typeof payload.ts === 'number' ? payload.ts
    : (typeof stamped === 'number' ? stamped : Date.now());
  const base: TelemetryAttributes = {
    'agentdeck.agent_type': ctx.agentType,
    ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
    ...(payload.sessionKey ? { 'agentdeck.gateway_session_key': payload.sessionKey } : {}),
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
    attributes: { ...base, ...attributes },
  });

  const text = messageText(message.content).trim();

  if (role === 'user') {
    if (!text) return [];
    return [make('turn_start', { 'agentdeck.prompt_text': text })];
  }

  if (role === 'assistant') {
    const spans: TelemetrySpan[] = [];
    // Per-turn provider/model/usage. These ride the store and this event but
    // never the `chat` frame, so without them a turn's model is whatever the
    // run-level `updateModel` last wrote — which on a multi-model agent is the
    // wrong answer for most turns rather than a missing one.
    const usage = message.usage as {
      input?: unknown; output?: unknown; cost?: { total?: unknown };
    } | undefined;
    const cost = usage?.cost?.total;
    const model = typeof message.model === 'string' ? message.model : undefined;
    const provider = typeof message.provider === 'string' ? message.provider : undefined;
    if (model || provider || usage) {
      spans.push(make('session_meta', {
        ...(model ? { 'gen_ai.request.model': model } : {}),
        ...(provider ? { 'gen_ai.system': provider } : {}),
        ...(typeof usage?.input === 'number' ? { 'agentdeck.usage.input_tokens': usage.input } : {}),
        ...(typeof usage?.output === 'number' ? { 'agentdeck.usage.output_tokens': usage.output } : {}),
        ...(typeof cost === 'number' ? { 'agentdeck.usage.cost_usd': cost } : {}),
      }));
    }
    if (text) spans.push(make('turn_response', { 'agentdeck.response_text': text }));
    return spans;
  }

  // `toolResult` messages duplicate what `session.tool` already reports with
  // more detail (it carries the args too), so they are deliberately dropped
  // rather than counted a second time against the turn's tool tally.
  return [];
}

/**
 * Build the spans the adapter should emit when its idle-gap timer expires.
 * Returned as a function (not a constant) because the timestamp is "now"
 * at expiry, not "now" at adapter construction.
 */
export function openclawIdleGapTaskBoundary(ctx: AdapterContext): TelemetrySpan {
  return {
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: ctx.activeTurnId,
    name: spanNameForKind('task_boundary'),
    kind: 'task_boundary',
    ts: Date.now(),
    attributes: {
      'agentdeck.agent_type': ctx.agentType,
      ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
      'agentdeck.boundary_signal': 'idle_gap',
    },
  };
}

/**
 * Build the user-prompt span the adapter should emit on `chat.send`. Kept
 * here for symmetry with `claude-hook.ts::claudeHookToSpans` and so future
 * test fixtures can exercise the boundary detector without spinning a real
 * Gateway connection.
 */
export function openclawChatSendToSpan(
  ctx: AdapterContext,
  prompt: string,
): TelemetrySpan {
  return {
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: undefined,
    name: spanNameForKind('turn_start'),
    kind: 'turn_start',
    ts: Date.now(),
    attributes: {
      'agentdeck.agent_type': ctx.agentType,
      ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
      'agentdeck.prompt_text': prompt,
    },
  };
}
