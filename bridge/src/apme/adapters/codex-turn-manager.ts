/**
 * CodexTurnManager — turn-boundary reconstruction for Codex CLI sessions.
 *
 * Two signal sources are wired into one state machine:
 *
 * 1. **Hook mode** (primary) — `~/.codex/config.toml` lifecycle hooks send
 *    `codex_user_prompt_submit` / `codex_tool_start` / `codex_tool_end` /
 *    `codex_stop` to the daemon. These are unambiguous turn boundaries.
 *    APME span ingestion for hooks happens in `bridge/src/index.ts`'s
 *    hook branch via `codexHookToSpans` — this manager only adds the
 *    timeline-visible entries (chat_start / tool_request / chat_response /
 *    chat_end) so the dashboard sees them.
 *
 * 2. **PTY-parser fallback** (legacy / hook-miss path) — when no codex_*
 *    hook has fired in the last 30 s, the manager falls back to the
 *    pre-hook PTY-only logic: spinner_start opens a turn, prompt-source
 *    idle (with deferred close + status-line false-positive guard +
 *    tool-silence latch + PTY tail snapshot) closes it.
 *
 * The 30 s "hook-fresh" window demotes parser signals to no-ops while
 * hooks are flowing, which eliminates the seven-state-variable race we
 * landed seven Codex review iterations on. If hooks stop firing (Codex
 * Ink-TUI repaint glitch), parser fallback re-engages automatically.
 *
 * Extracted from `bridge/src/index.ts wireAgentApme` so the codex segment
 * can be unit-tested with fake collector / fake ringbuffer / fake adapter.
 */

import type { AdapterContext, AgentType, TimelineEntry } from '@agentdeck/shared';
import type { AdapterHookEvent, AdapterParserEvent } from '@agentdeck/shared';
import type { BridgeCore } from '../../bridge-core.js';
import type { ApmeModule } from '../index.js';
import type { PtyRingBuffer } from '../../pty-ringbuffer.js';
import { cleanRawText, cleanDetailText, prepareMarkdownDetail } from '@agentdeck/shared';
import { extractTopicHintWithKind, promptSnippetFallback } from '@agentdeck/shared';
import { timelineEntryToSpans } from './timeline.js';
import { classifyAndEnqueueTurn } from '../classify-turn.js';

const TIMELINE_CHAT_DETAIL_LIMIT = 6000;

// PTY parser deferred-close window. The parser fires `idle{source: prompt}`
// on any `›\s` match — including the status line shown mid-processing — so
// we wait this long before committing chat_end. A new spinner_start within
// the window cancels the close, which is how we differentiate spurious
// mid-turn idles from real turn ends.
const CODEX_IDLE_CLOSE_DELAY_MS = 1500;
// Upper bound on the tool-silence flag's lifetime when the parser sees a
// timeout-source idle after a tool_action. If Codex finishes the final
// tool and prints the response WITHOUT re-engaging the spinner, no
// spinner_start arrives to clear the flag and any prompt-idle is
// suppressed. After this window we clear the flag defensively and replay
// the suppressed idle as an immediate close.
const CODEX_TOOL_SILENCE_MAX_MS = 15_000;
// How recent a hook must be for the manager to consider hook signals
// authoritative and demote PTY parser signals to no-ops. Any longer and
// we re-arm the parser fallback in case hooks have stopped firing.
const CODEX_HOOK_FRESHNESS_MS = 30_000;

export class CodexTurnManager {
  // ── PTY-mode turn-boundary state (legacy) ──
  private chatStart: number | null = null;
  private lastPromptText: string | null = null;
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private inToolSilence = false;
  private toolActiveSinceLastSpinner = false;
  private toolSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPromptIdle = false;
  private pendingTailSnapshot: string | null = null;
  // ── Hook-mode tracking ──
  private hookActive = false;
  private lastHookTs = 0;

  constructor(
    private readonly core: BridgeCore,
    private readonly apme: ApmeModule,
    private readonly ptyRingBuffer: PtyRingBuffer,
    private readonly sessionId: string,
    private readonly agentType: AgentType,
  ) {}

  // ── Public entry points ────────────────────────────────────────────

  /** Process a codex_* hook event. Hooks are authoritative — they own
   *  the turn boundaries while fresh. APME span ingestion already happens
   *  in `bridge/src/index.ts` via `codexHookToSpans`; this method only
   *  adds the timeline-visible entries the dashboard renders. */
  onHookEvent(evt: AdapterHookEvent): void {
    this.hookActive = true;
    this.lastHookTs = Date.now();

    if (evt.event === 'codex_user_prompt_submit') {
      const prompt = extractPrompt(evt.data ?? {});
      this.openTimelineChatStart(prompt || undefined);
      return;
    }

    if (evt.event === 'codex_tool_start') {
      const data = (evt.data ?? {}) as Record<string, unknown>;
      const tool = typeof data.tool_name === 'string' && data.tool_name ? data.tool_name : 'tool';
      const args = formatToolArgs(data.tool_input);
      const raw = args ? `${tool} ${args}` : tool;
      this.openTimelineChatStart();
      this.toolActiveSinceLastSpinner = true;
      this.addTimelineEntry({
        ts: Date.now(),
        type: 'tool_request',
        raw: raw.length > 500 ? raw.slice(0, 497) + '...' : raw,
        detail: args && args.length > 0 ? args.slice(0, 1000) : undefined,
        agentType: 'codex-cli',
        ...(this.chatStart !== null ? { startedAt: this.chatStart } : {}),
      });
      return;
    }

    if (evt.event === 'codex_tool_end') {
      // Tool finished — stale `›` chunks no longer mean mid-tool.
      this.inToolSilence = false;
      return;
    }

    if (evt.event === 'codex_stop') {
      // Hook is authoritative — close synchronously. PTY-side timers /
      // pending state get cleared so a late parser idle can't double-fire.
      if (this.idleCloseTimer) { clearTimeout(this.idleCloseTimer); this.idleCloseTimer = null; }
      this.exitToolSilence();
      this.pendingPromptIdle = false;
      this.pendingTailSnapshot = null;
      this.toolActiveSinceLastSpinner = false;
      if (this.chatStart !== null) {
        this.closeTurn(this.chatStart);
      }
      return;
    }
  }

  /** Process a PTY parser event. While a hook is fresh, this is a no-op
   *  for turn-boundary signals (hook owns them). Outside the freshness
   *  window we run the legacy PTY-only state machine. */
  onParserEvent(evt: AdapterParserEvent): void {
    if (this.hookFresh()) return;

    if (evt.event === 'spinner_start') {
      // Two cases:
      //   1. A prompt-idle was suppressed by tool-silence and now spinner
      //      is starting fresh — that's the user submitting the NEXT
      //      prompt, so the previous turn really did end. Close it
      //      synchronously before opening the new one (using the tail
      //      snapshot taken at latch time so the response doesn't pick
      //      up turn N+1's input).
      //   2. No pending suppression — Codex is just continuing the same
      //      turn (e.g. resuming after a bash result). Cancel any pending
      //      deferred close (status-line false positive) and keep the
      //      existing chat_start.
      if (this.pendingPromptIdle && this.chatStart !== null) {
        const prevStart = this.chatStart;
        const snapshot = this.pendingTailSnapshot;
        this.closeTurn(prevStart, snapshot ?? undefined);
      }
      this.pendingPromptIdle = false;
      this.pendingTailSnapshot = null;
      if (this.idleCloseTimer) { clearTimeout(this.idleCloseTimer); this.idleCloseTimer = null; }
      this.exitToolSilence();
      this.toolActiveSinceLastSpinner = false;
      this.ensureChatStart();
      return;
    }

    if (evt.event === 'tool_action') {
      const data = (evt.data ?? {}) as Record<string, unknown>;
      const tool = typeof data.tool === 'string' && data.tool ? data.tool : 'tool';
      const args = typeof data.args === 'string' ? data.args : '';
      const raw = args ? `${tool} ${args}` : tool;
      this.ensureChatStart();
      this.toolActiveSinceLastSpinner = true;
      // Parser path: APME ingestion has to come from us (no hook adapter
      // upstream). addEntryAndIngest fires both the timeline entry and
      // the `tool_call` span via timelineEntryToSpans → ingestSpan →
      // ingestHook PreToolUse, incrementing turns.tool_calls.
      this.addEntryAndIngest({
        ts: Date.now(),
        type: 'tool_request',
        raw: raw.length > 500 ? raw.slice(0, 497) + '...' : raw,
        detail: args && args !== raw ? args.slice(0, 1000) : undefined,
        agentType: 'codex-cli',
        ...(this.chatStart !== null ? { startedAt: this.chatStart } : {}),
      });
      return;
    }

    if (evt.event === 'idle') {
      const idleSource = (evt.data as Record<string, unknown> | undefined)?.source;
      if (idleSource === 'timeout') {
        // Synthetic idle from spinner-data silence. Only treat as mid-tool
        // if a tool actually ran in this thinking segment — end-of-turn
        // quiet (final response with no further spinning) also produces
        // a timeout idle and must NOT block the next prompt-idle close.
        if (this.toolActiveSinceLastSpinner) {
          this.inToolSilence = true;
          // Bound the silence: if no spinner_start arrives within the
          // grace window, Codex finished the tool and ended the turn
          // without re-engaging the spinner (e.g. tool output IS the
          // final response). On timer fire we clear the flag and replay
          // any suppressed prompt-idle as an immediate close.
          if (this.toolSilenceTimer) clearTimeout(this.toolSilenceTimer);
          this.toolSilenceTimer = setTimeout(() => {
            this.toolSilenceTimer = null;
            this.inToolSilence = false;
            if (this.pendingPromptIdle) {
              const snapshot = this.pendingTailSnapshot;
              this.pendingPromptIdle = false;
              this.pendingTailSnapshot = null;
              if (this.chatStart !== null) {
                // Close immediately rather than via scheduleClose: we
                // already waited the full silence window, and any
                // further deferral would let a quickly-typed next
                // prompt cancel the close entirely.
                this.closeTurn(this.chatStart, snapshot ?? undefined);
              }
            }
          }, CODEX_TOOL_SILENCE_MAX_MS);
        }
        return;
      }
      if (idleSource !== 'prompt') return;
      if (this.chatStart === null) return;
      if (this.inToolSilence) {
        // Latch this prompt-idle, with a PTY tail snapshot pinned to
        // *this* moment. Either the auto-clear timer will replay it
        // (turn really ended without re-spinning) or the next
        // spinner_start will close turn N before opening N+1. Both
        // paths use the snapshot — the live tail by then would be
        // contaminated with N+1's input/processing.
        this.pendingPromptIdle = true;
        this.pendingTailSnapshot = this.ptyRingBuffer.getTail(5000);
        return;
      }
      // Defer the close. A new spinner_start within the delay cancels
      // this timer, which is how we reject status-line false positives
      // (the status row also matches IDLE_PROMPT) without a wall-clock
      // guard that would also drop real fast turns.
      this.scheduleClose(this.chatStart);
      return;
    }
  }

  /** Clear timers so a session shutdown leaves no lingering work. */
  cleanup(): void {
    if (this.idleCloseTimer) { clearTimeout(this.idleCloseTimer); this.idleCloseTimer = null; }
    if (this.toolSilenceTimer) { clearTimeout(this.toolSilenceTimer); this.toolSilenceTimer = null; }
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private hookFresh(): boolean {
    return this.hookActive && (Date.now() - this.lastHookTs) < CODEX_HOOK_FRESHNESS_MS;
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

  /** Add a timeline entry AND feed it through APME ingestion. Use this
   *  on the PTY-fallback path where no upstream hook adapter has done
   *  the ingestion. */
  private addEntryAndIngest(entry: TimelineEntry): void {
    this.core.bridgeTimeline.addEntry(entry);
    const ctx = this.makeCtx();
    for (const span of timelineEntryToSpans(ctx, entry)) {
      this.apme.collector.ingestSpan(this.sessionId, span);
    }
  }

  /** Hook-path chat_start opener: timeline entry only. The APME turn
   *  was opened upstream by codexHookToSpans → ingestSpan(turn_start)
   *  in the index.ts hook branch. Re-ingesting here would close the
   *  just-opened turn and immediately reopen another. */
  private openTimelineChatStart(text?: string): number {
    if (this.chatStart !== null) {
      // Upsert prompt text into the existing entry if we now have it.
      if (text && !this.lastPromptText) {
        this.lastPromptText = text;
        const raw = text.length > 500 ? text.slice(0, 497) + '...' : text;
        const detail = text.length > 100
          ? (text.length > 1000 ? text.slice(0, 997) + '...' : text)
          : undefined;
        this.core.bridgeTimeline.upsertEntry({
          ts: this.chatStart,
          type: 'chat_start',
          raw,
          ...(detail ? { detail } : {}),
          agentType: 'codex-cli',
          startedAt: this.chatStart,
        });
      }
      return this.chatStart;
    }
    const now = Date.now();
    this.chatStart = now;
    this.lastPromptText = text || null;
    const raw = text
      ? (text.length > 500 ? text.slice(0, 497) + '...' : text)
      : 'Codex turn started';
    const detail = text && text.length > 100
      ? (text.length > 1000 ? text.slice(0, 997) + '...' : text)
      : undefined;
    this.addTimelineEntry({
      ts: now,
      type: 'chat_start',
      raw,
      ...(detail ? { detail } : {}),
      agentType: 'codex-cli',
      startedAt: now,
    });
    return now;
  }

  /** PTY-path chat_start opener: timeline entry AND APME ingestion. */
  private ensureChatStart(text?: string): number {
    if (this.chatStart !== null) {
      if (text && !this.lastPromptText) {
        this.lastPromptText = text;
        const raw = text.length > 500 ? text.slice(0, 497) + '...' : text;
        const detail = text.length > 100
          ? (text.length > 1000 ? text.slice(0, 997) + '...' : text)
          : undefined;
        this.core.bridgeTimeline.upsertEntry({
          ts: this.chatStart,
          type: 'chat_start',
          raw,
          ...(detail ? { detail } : {}),
          agentType: 'codex-cli',
          startedAt: this.chatStart,
        });
      }
      return this.chatStart;
    }
    const now = Date.now();
    this.chatStart = now;
    this.lastPromptText = text || null;
    const raw = text
      ? (text.length > 500 ? text.slice(0, 497) + '...' : text)
      : 'Codex turn started';
    const detail = text && text.length > 100
      ? (text.length > 1000 ? text.slice(0, 997) + '...' : text)
      : undefined;
    this.addEntryAndIngest({
      ts: now,
      type: 'chat_start',
      raw,
      ...(detail ? { detail } : {}),
      agentType: 'codex-cli',
      startedAt: now,
    });
    return now;
  }

  /** Close the turn that started at `startedAt`: extract the response
   *  tail (live ringbuffer or passed snapshot), emit chat_response +
   *  chat_end timeline entries, and ingest the response span. The
   *  snapshot path is used when closing in response to a delayed signal
   *  (auto-clear timer or next spinner_start) — by that point the live
   *  ringbuffer contains turn N+1 content that would contaminate N's
   *  response. */
  private closeTurn(startedAt: number, tailSnapshot?: string): void {
    if (this.chatStart !== startedAt) return;
    const endedAt = Date.now();
    this.chatStart = null;
    this.lastPromptText = null;
    const tail = tailSnapshot ?? this.ptyRingBuffer.getTail(5000);
    const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
    const clean = lines.filter(l =>
      !/^[✢✳✶✻✽⏸⏵❯─>]/.test(l) &&
      !/planmode|plan\s*mode|shift\+tab|accept\s*edits/i.test(l) &&
      !/\?\s*for\s*shortcuts/.test(l),
    );
    const response = clean.slice(-5).join('\n');
    if (response.length > 2) {
      const respRaw = response.length > 200 ? response.slice(0, 197) + '...' : response;
      // chat_response routes through addEntryAndIngest so a turn_response
      // span calls setTurnResponse on APME's active turn (works in both
      // hook and PTY modes — the chat_response timeline → ingestSpan
      // path attaches to whichever turn the collector currently has
      // open).
      this.addEntryAndIngest({
        ts: endedAt - 1,
        type: 'chat_response',
        raw: cleanRawText(respRaw),
        detail: prepareMarkdownDetail(response.slice(0, 3000)) || undefined,
        agentType: 'codex-cli',
        startedAt,
        endedAt,
      });
      void classifyAndEnqueueTurn(this.apme, this.sessionId);
    }
    // Finalize the APME turn row: flushes endedAt + buffered tool_calls /
    // file counters to the store. Order matters — setTurnResponse and
    // classifyAndEnqueueTurn above need the turn to still be ACTIVE
    // (they read from sessionToTurn). After this call the turn moves
    // into sessionToLastTurnId; setLastClosedTurnResponse from any
    // late chat_end fallback would target this turn.
    this.apme.collector.closeTurnForSession(this.sessionId);
    const duration = Math.round((endedAt - startedAt) / 1000);
    // Same kind-classification as wireClaudeCodeTimeline / openclaw adapter.
    // 'topic' → real heuristic; fallback / generic label → 'none' so client
    // suppresses the (likely-redundant) detail pane.
    const respHint = response ? extractTopicHintWithKind(response) : { hint: null, kind: null };
    const promptHint = this.lastPromptText ? extractTopicHintWithKind(this.lastPromptText) : { hint: null, kind: null };
    let label: string;
    let summaryKind: 'heuristic' | 'none';
    if (respHint.kind === 'topic' && respHint.hint) {
      label = respHint.hint;
      summaryKind = 'heuristic';
    } else if (promptHint.kind === 'topic' && promptHint.hint) {
      label = promptHint.hint;
      summaryKind = 'heuristic';
    } else if (respHint.hint || promptHint.hint) {
      label = (respHint.hint || promptHint.hint)!;
      summaryKind = 'none';
    } else {
      label = promptSnippetFallback(this.lastPromptText, 60) ?? 'Codex turn completed';
      summaryKind = 'none';
    }
    // chat_end is timeline-only (display marker for duration + topic).
    // The `turn_response` mapping with `fallback_to_last_closed` would
    // otherwise attach this response to the previously closed turn —
    // wrong target. Response already on current turn from chat_response.
    this.addTimelineEntry({
      ts: endedAt,
      type: 'chat_end',
      raw: `${label} · ${duration}s`,
      detail: response.length > 2
        ? prepareMarkdownDetail(response.slice(0, TIMELINE_CHAT_DETAIL_LIMIT)) || undefined
        : undefined,
      agentType: 'codex-cli',
      startedAt,
      endedAt,
      summaryKind,
    });
  }

  private scheduleClose(startedAt: number, tailSnapshot?: string): void {
    if (this.idleCloseTimer) clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = setTimeout(() => {
      this.idleCloseTimer = null;
      this.closeTurn(startedAt, tailSnapshot);
    }, CODEX_IDLE_CLOSE_DELAY_MS);
  }

  private exitToolSilence(): void {
    this.inToolSilence = false;
    if (this.toolSilenceTimer) {
      clearTimeout(this.toolSilenceTimer);
      this.toolSilenceTimer = null;
    }
  }
}

// ── Local helpers ────────────────────────────────────────────────────

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
  if (typeof data.user_prompt === 'string') return data.user_prompt;
  return '';
}

function formatToolArgs(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    // Codex hook payloads typically pack the bash command in `command` or
    // `cmd`. Best-effort extraction; fall through to JSON for everything
    // else so the tool args are still visible on the timeline.
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string') return obj.command;
    if (typeof obj.cmd === 'string') return obj.cmd;
    try { return JSON.stringify(obj); } catch { return ''; }
  }
  return '';
}
