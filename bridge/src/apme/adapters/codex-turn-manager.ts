/**
 * Hook-owned Codex turn timeline.
 *
 * Lifecycle hooks and the notify turn-complete fallback own boundaries. The
 * response body comes from Codex's rollout JSONL (or an inline hook field),
 * never from terminal output. This keeps managed and directly-run Codex on the
 * same structured observation path.
 */

import type { AdapterContext, AgentType, TimelineEntry } from '@agentdeck/shared';
import type { AdapterHookEvent } from '@agentdeck/shared';
import {
  cleanRawText,
  prepareMarkdownDetail,
  extractTopicHintWithKind,
  promptSnippetFallback,
} from '@agentdeck/shared';
import type { BridgeCore } from '../../bridge-core.js';
import type { ApmeModule } from '../index.js';
import { codexTurnOutcomeFromRollout, type CodexTurnOutcome } from '../../codex-rollout-response.js';
import { timelineEntryToSpans } from './timeline.js';
import { classifyAndEnqueueTurn } from '../classify-turn.js';

const CODEX_PROMPT_FILL_WINDOW_MS = 5_000;
const CODEX_PROMPT_DUP_WINDOW_MS = 15_000;

type OutcomeReader = (sessionId: string) => CodexTurnOutcome;

export class CodexTurnManager {
  private chatStart: number | null = null;
  private lastPromptText: string | null = null;
  private codexSessionId: string | null = null;

  constructor(
    private readonly core: BridgeCore,
    private readonly apme: ApmeModule,
    private readonly sessionId: string,
    private readonly agentType: AgentType,
    private readonly readOutcome: OutcomeReader = codexTurnOutcomeFromRollout,
  ) {}

  onHookEvent(evt: AdapterHookEvent): void {
    this.codexSessionId = extractCodexSessionId(evt.data) ?? this.codexSessionId;

    if (evt.event === 'codex_user_prompt_submit') {
      const prompt = extractPrompt(evt.data ?? {});
      if (this.chatStart !== null) {
        const age = Date.now() - this.chatStart;
        const isDupEcho = prompt.length > 0 && this.lastPromptText === prompt && age < CODEX_PROMPT_DUP_WINDOW_MS;
        if (isDupEcho) return;
        const isLateTextFill = this.lastPromptText === null && age < CODEX_PROMPT_FILL_WINDOW_MS;
        if (!isLateTextFill) this.closeOpenTurn();
      }
      this.openTimelineChatStart(prompt || undefined);
      return;
    }

    if (evt.event === 'codex_tool_start') {
      const tool = nonEmptyString(evt.data.tool_name) ?? 'tool';
      const args = formatToolArgs(evt.data.tool_input);
      const raw = args ? `${tool} ${args}` : tool;
      this.openTimelineChatStart();
      this.addTimelineEntry({
        ts: Date.now(),
        type: 'tool_request',
        raw: raw.length > 500 ? `${raw.slice(0, 497)}...` : raw,
        detail: args ? args.slice(0, 1000) : undefined,
        agentType: 'codex-cli',
        ...(this.chatStart !== null ? { startedAt: this.chatStart } : {}),
      });
      return;
    }

    if (evt.event === 'codex_stop' || evt.event === 'codex_turn_complete') {
      this.closeOpenTurn(outcomeFromHook(evt.data));
    }
  }

  cleanup(): void {
    // Kept for the adapter lifecycle contract; hook-owned turns have no timers.
  }

  private closeOpenTurn(inline?: CodexTurnOutcome): void {
    if (this.chatStart === null) return;
    const rollout = this.codexSessionId ? this.readOutcome(this.codexSessionId) : { text: '' };
    this.closeTurn(this.chatStart, preferOutcome(inline, rollout));
  }

  private makeCtx(): AdapterContext {
    return {
      sessionId: this.sessionId,
      agentType: this.agentType,
      traceId: this.apme.collector.getRunId(this.sessionId) ?? this.sessionId,
      cwd: process.cwd(),
      activeTurnId: this.apme.collector.getActiveTurnId(this.sessionId) ?? undefined,
    };
  }

  private addTimelineEntry(entry: TimelineEntry): void {
    this.core.bridgeTimeline.addEntry(entry);
  }

  private addEntryAndIngest(entry: TimelineEntry): void {
    this.core.bridgeTimeline.addEntry(entry);
    const ctx = this.makeCtx();
    for (const span of timelineEntryToSpans(ctx, entry)) {
      this.apme.collector.ingestSpan(this.sessionId, span);
    }
  }

  private openTimelineChatStart(text?: string): number {
    if (this.chatStart !== null) {
      if (text && !this.lastPromptText) {
        this.lastPromptText = text;
        this.core.bridgeTimeline.upsertEntry({
          ts: this.chatStart,
          type: 'chat_start',
          raw: text.length > 500 ? `${text.slice(0, 497)}...` : text,
          ...(text.length > 100 ? { detail: text.slice(0, 1000) } : {}),
          agentType: 'codex-cli',
          startedAt: this.chatStart,
        });
      }
      return this.chatStart;
    }

    const now = Date.now();
    this.chatStart = now;
    this.lastPromptText = text || null;
    this.addTimelineEntry({
      ts: now,
      type: 'chat_start',
      raw: text ? (text.length > 500 ? `${text.slice(0, 497)}...` : text) : 'Codex turn started',
      ...(text && text.length > 100 ? { detail: text.slice(0, 1000) } : {}),
      agentType: 'codex-cli',
      startedAt: now,
    });
    return now;
  }

  private closeTurn(startedAt: number, outcome: CodexTurnOutcome): void {
    if (this.chatStart !== startedAt) return;
    const endedAt = Date.now();
    const promptText = this.lastPromptText;
    this.chatStart = null;
    this.lastPromptText = null;

    const response = outcome.text.trim();
    const error = outcome.error?.trim() ?? '';
    const body = response || error;
    if (body) {
      const raw = response
        ? body.length > 200
          ? `${body.slice(0, 197)}...`
          : body
        : `Error: ${body.length > 190 ? `${body.slice(0, 187)}...` : body}`;
      this.addEntryAndIngest({
        ts: endedAt - 1,
        type: 'chat_response',
        raw: cleanRawText(raw),
        detail: prepareMarkdownDetail(body.slice(0, 3000)) || undefined,
        agentType: 'codex-cli',
        startedAt,
        endedAt,
      });
      void classifyAndEnqueueTurn(this.apme, this.sessionId);
    }

    this.apme.collector.closeTurnForSession(this.sessionId);
    const duration = Math.round((endedAt - startedAt) / 1000);
    const responseHint = body
      ? extractTopicHintWithKind(body)
      : { hint: null, kind: null as 'topic' | 'fallback' | null };
    const promptHint = promptText
      ? extractTopicHintWithKind(promptText)
      : { hint: null, kind: null as 'topic' | 'fallback' | null };
    const label =
      responseHint.hint ?? promptHint.hint ?? promptSnippetFallback(promptText, 60) ?? 'Codex turn completed';
    const summaryKind: 'heuristic' | 'none' =
      responseHint.kind === 'topic' || promptHint.kind === 'topic' ? 'heuristic' : 'none';

    this.addTimelineEntry({
      ts: endedAt,
      type: 'chat_end',
      raw: `${label} · ${duration}s`,
      ...(body ? { detail: prepareMarkdownDetail(body.slice(0, 1000)) || undefined } : {}),
      agentType: 'codex-cli',
      startedAt,
      endedAt,
      summaryKind,
    });
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractPrompt(data: Record<string, unknown>): string {
  const message = data.message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
  }
  return nonEmptyString(data.prompt) ?? nonEmptyString(data.user_prompt) ?? '';
}

function extractCodexSessionId(data: Record<string, unknown>): string | null {
  for (const key of [
    'thread_id',
    'threadId',
    'thread-id',
    'codex.thread_id',
    'session_id',
    'sessionId',
    'session-id',
  ]) {
    const value = nonEmptyString(data[key]);
    const normalized = value?.replace(/^codex:/, '');
    if (normalized && /^[0-9a-f-]{8,}$/i.test(normalized)) return normalized;
  }
  return null;
}

function outcomeFromHook(data: Record<string, unknown>): CodexTurnOutcome {
  for (const key of ['last_assistant_message', 'last-assistant-message', 'response', 'output', 'result']) {
    const text = nonEmptyString(data[key]);
    if (text) return { text };
  }
  // Only an explicit `error` key maps to an error. `message` must NOT: on
  // every other Codex event it carries content, and across 311 recorded real
  // codex_stop payloads (≤0.146.0) neither key ever appeared — so a future
  // benign `message` rendering every turn as "Error: …" is the costly
  // misread, while a hypothetical message-shaped error only loses a label.
  const error = nonEmptyString(data.error);
  return { text: '', ...(error ? { error } : {}) };
}

function preferOutcome(inline: CodexTurnOutcome | undefined, rollout: CodexTurnOutcome): CodexTurnOutcome {
  if (inline?.text) return inline;
  if (rollout.text) return rollout;
  if (inline?.error) return inline;
  return rollout;
}

function formatToolArgs(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string') return obj.command;
    if (typeof obj.cmd === 'string') return obj.cmd;
    try {
      return JSON.stringify(obj);
    } catch {
      return '';
    }
  }
  return '';
}
