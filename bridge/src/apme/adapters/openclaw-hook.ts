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
    return spans;
  }

  if (payload.state === 'aborted') {
    // Treat as a manual boundary — user explicitly stopped this turn. The
    // composite outcome derivation will see the absence of a complete
    // response and score accordingly.
    return [make('task_boundary', { 'agentdeck.boundary_signal': 'manual' })];
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
 * Convert a Gateway `session.tool` event into spans. This granular per-tool
 * stream carries the tool INPUT/OUTPUT that the coarse `chat.final` tools array
 * lacks — and it was previously silently dropped (openclaw.ts default case), so
 * the sample's tool trajectory had no detail. A `running`/`pending` status maps
 * to a `tool_call` (opens a pending ToolEvent); a terminal status maps to a
 * `tool_result` (resolves it). Pure — no side effects.
 */
export function openclawSessionToolToSpans(
  ctx: AdapterContext,
  payload: SessionToolPayload,
): TelemetrySpan[] {
  const name = payload.name ?? payload.tool;
  if (!name) return [];
  const ts = typeof payload.ts === 'number' ? payload.ts : Date.now();
  const status = (payload.status ?? '').toLowerCase();
  const pending = status === '' || status === 'running' || status === 'pending' || status === 'started' || status === 'in_progress';
  const kind: TelemetrySpan['kind'] = pending ? 'tool_call' : 'tool_result';
  const attrs: TelemetryAttributes = {
    'agentdeck.agent_type': ctx.agentType,
    ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
    'gen_ai.tool.name': name,
    'agentdeck.tool_name': name,
    'agentdeck.raw_payload': {
      ...(payload.status ? { status: payload.status } : {}),
      ...(payload.input !== undefined ? { tool_input: payload.input } : {}),
      ...(payload.output !== undefined ? { tool_response: payload.output } : {}),
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
 * Convert a Gateway `session.out-of-band message` into a turn span. User
 * messages open a turn (turn_start); assistant messages set the response
 * (turn_response). Previously dropped, so gateway-initiated turns (cron,
 * automations) had no captured prompt/response in the sample.
 */
export function openclawSessionMessageToSpans(
  ctx: AdapterContext,
  payload: SessionMessagePayload,
): TelemetrySpan[] {
  const text = (typeof payload.text === 'string' ? payload.text : undefined)
    ?? (typeof payload.content === 'string' ? payload.content : undefined);
  if (!text || !text.trim()) return [];
  const ts = typeof payload.ts === 'number' ? payload.ts : Date.now();
  const role = (payload.role ?? '').toLowerCase();
  const kind: TelemetrySpan['kind'] = role === 'assistant' ? 'turn_response' : 'turn_start';
  const attrs: TelemetryAttributes = {
    'agentdeck.agent_type': ctx.agentType,
    ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
    ...(kind === 'turn_start' ? { 'agentdeck.prompt_text': text } : { 'agentdeck.response_text': text }),
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
