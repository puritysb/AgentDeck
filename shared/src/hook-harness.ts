/**
 * Which harness a hook POST came from — decided by the payload, never by the
 * endpoint name alone, and never by the model (#490).
 *
 * The daemons route a hook by the name it was POSTed under: `codex_*`,
 * `opencode_*`, `hermes_*` … carry their harness in the prefix, and every
 * unprefixed name (`/hooks/Stop`, `/hooks/PreToolUse`, the Swift `/hook`
 * body's `event`) was read as Claude Code. Codex speaks the same lifecycle
 * vocabulary (`hook_event_name: "Stop"`, `session_id`, `transcript_path`,
 * `last_assistant_message`), and Codex can be made to run a Claude-shaped hook
 * command — its `/import` copies Claude Code's settings and hooks — so a Codex
 * turn reaching an unprefixed endpoint was ingested as a Claude Code session:
 * Swift minted a `claude-code` row keyed by the Codex thread and stamped the
 * payload's `gpt-*` model on it, and both daemons emitted the turn's
 * `chat_response` a second time under the Claude icon (2026-10-09, App Store
 * 1.8.0 audit).
 *
 * The rule: an unprefixed hook whose payload carries Codex's own identity is
 * re-routed to the `codex_*` event it is, so it converges on the Codex
 * session key and the Codex pipeline's existing exactly-once guards; a Codex
 * payload for an event Codex has no AgentDeck route for is dropped. Identity
 * evidence is structural and Codex-only:
 *   - a thread id under one of Codex's keys (`thread-id`, `thread_id`,
 *     `threadId`, `codex.thread_id`, `thread.id`) — Claude payloads have none;
 *   - the legacy `notify` payload type `agent-turn-complete`;
 *   - a `transcript_path` that is a Codex rollout (`rollout-<stamp>-<id>.jsonl`)
 *     — Claude's transcript is `<session-uuid>.jsonl` under `projects/`;
 *   - a `turn_id` with NO `transcript_path` — an ephemeral Codex run
 *     (`codex exec --ephemeral`, or a turn before its rollout exists) sends
 *     `transcript_path: null`, while every Claude hook names its transcript.
 *     `turn_id` alone is not evidence: Claude's `MessageDisplay` hook carries
 *     one, and a future Claude lifecycle field must not flip its harness.
 * `model`/`modelProvider` are deliberately NOT evidence: `claude-glm` is Claude
 * Code serving a non-Anthropic model, and a Codex provider can serve anything.
 *
 * Swift: `CodexHookHarness.generated.swift` (`pnpm generate-hook-harness`, byte
 * gate `hook-harness-sync.test.ts`). Both suites replay `shared/hook-harness-vectors.json`.
 */

/** Keys under which Codex builds have carried the thread id (CodexHookIdentity). */
export const CODEX_THREAD_ID_KEYS = ['thread-id', 'thread_id', 'threadId', 'codex.thread_id', 'thread.id'] as const;

/** Codex notify's payload `type` for a finished turn. */
export const CODEX_NOTIFY_TURN_COMPLETE_TYPE = 'agent-turn-complete';

/** Codex rollout basename (`rollout-2026-10-11T10-25-44-<uuid>.jsonl`),
 *  matched case-insensitively. Claude's transcript is `<session-uuid>.jsonl`. */
export const CODEX_ROLLOUT_BASENAME_PATTERN = String.raw`^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f-]{8,}\.jsonl$`;

/** Event-name prefixes that already name their harness; never re-routed. */
export const HOOK_HARNESS_PREFIXES = ['codex_', 'opencode_', 'antigravity_', 'kiro_', 'hermes_'] as const;

/** Unprefixed lifecycle names (Claude PascalCase, Swift's snake_case mapping,
 *  or Codex notify's hyphenated type), normalized by dropping case, `_` and
 *  `-`, to the `codex_*` event the Codex pipeline understands. A Codex payload
 *  under any other name is dropped. */
export const CODEX_HOOK_ROUTES: Readonly<Record<string, string>> = {
  sessionstart: 'codex_session_start',
  userpromptsubmit: 'codex_user_prompt_submit',
  pretooluse: 'codex_tool_start',
  toolstart: 'codex_tool_start',
  posttooluse: 'codex_tool_end',
  toolend: 'codex_tool_end',
  posttoolusefailure: 'codex_tool_end',
  toolfailure: 'codex_tool_end',
  stop: 'codex_stop',
  permissionrequest: 'codex_permission_request',
  interrupt: 'codex_interrupt',
  subagentstart: 'codex_subagent_start',
  subagentstop: 'codex_subagent_stop',
  agentturncomplete: 'codex_turn_complete',
  turncomplete: 'codex_turn_complete',
};

/** Per Codex event, the payload fields (first non-empty wins) that tell two
 *  instances of that event within one thread apart. */
export const CODEX_HOOK_FINGERPRINT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  codex_user_prompt_submit: ['turn_id', 'turn-id'],
  codex_stop: ['turn_id', 'turn-id'],
  codex_interrupt: ['turn_id', 'turn-id'],
  codex_turn_complete: ['turn_id', 'turn-id'],
  codex_tool_start: ['tool_use_id'],
  codex_tool_end: ['tool_use_id'],
  codex_permission_request: ['tool_use_id'],
  codex_session_start: ['source'],
  codex_subagent_start: ['agent_id'],
  codex_subagent_stop: ['agent_id'],
};

/** Per Codex event, the payload text (first non-empty wins) whose hash joins
 *  the fingerprint. A twin carries the same text; a Stop that a blocking hook
 *  turned into a continuation (`stop_hook_active`), or input steered into a
 *  running turn, shares the turn id but not the text — and is a real event. */
export const CODEX_HOOK_FINGERPRINT_CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  codex_user_prompt_submit: ['prompt', 'user_prompt'],
  codex_stop: ['last_assistant_message'],
  codex_turn_complete: ['last-assistant-message', 'last_assistant_message'],
};

/** How long a delivered Codex hook instance suppresses its twin. Codex runs a
 *  hook event's commands back to back, each bounded at 0.8 s of curl. */
export const CODEX_HOOK_REPLAY_WINDOW_MS = 10_000;

const ROLLOUT_RE = new RegExp(CODEX_ROLLOUT_BASENAME_PATTERN, 'i');

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stripCodexPrefix(id: string): string {
  return id.startsWith('codex:') ? id.slice('codex:'.length) : id;
}

/** The Codex thread id a payload names under one of Codex's thread keys
 *  (bare — a `codex:` prefix is stripped), or undefined. */
export function codexThreadIdFromPayload(payload: Record<string, unknown>): string | undefined {
  for (const key of CODEX_THREAD_ID_KEYS) {
    const raw = nonEmptyString(payload[key]);
    if (raw) return stripCodexPrefix(raw);
  }
  return undefined;
}

/** True when the payload carries evidence only Codex produces. */
export function isCodexHookPayload(payload: Record<string, unknown>): boolean {
  if (codexThreadIdFromPayload(payload)) return true;
  if (payload.type === CODEX_NOTIFY_TURN_COMPLETE_TYPE) return true;
  const tp = nonEmptyString(payload.transcript_path);
  if (tp === undefined) return nonEmptyString(payload.turn_id) !== undefined;
  return ROLLOUT_RE.test(tp.split(/[\\/]/).pop() ?? '');
}

export type HookHarnessRoute =
  /** Not a re-route: ingest under the name it arrived with. */
  | { kind: 'as-posted' }
  /** A Codex payload under an unprefixed name: ingest as `event`. */
  | { kind: 'codex'; event: string }
  /** A Codex payload for an event with no Codex route: ingest nothing. */
  | { kind: 'drop' };

/** Decide how an incoming hook is ingested. `eventName` is the name as the
 *  daemon received it (`Stop`, `stop`, `codex_stop`, `agent-turn-complete`). */
export function routeHookHarness(eventName: string, payload: Record<string, unknown>): HookHarnessRoute {
  if (HOOK_HARNESS_PREFIXES.some((p) => eventName.startsWith(p))) return { kind: 'as-posted' };
  if (!isCodexHookPayload(payload)) return { kind: 'as-posted' };
  // Codex notify names its event in the body, whatever URL it was POSTed to.
  const key = payload.type === CODEX_NOTIFY_TURN_COMPLETE_TYPE
    ? 'agentturncomplete'
    : eventName.toLowerCase().replace(/[_-]/g, '');
  const event = CODEX_HOOK_ROUTES[key];
  return event ? { kind: 'codex', event } : { kind: 'drop' };
}

/**
 * One Codex hook delivered twice — once by AgentDeck's own `codex_*` hook and
 * once through a Claude-shaped command Codex also runs — is one event. The
 * fingerprint names the event instance: the route plus the thread and the
 * field that distinguishes two instances of that event within a thread, plus
 * a hash of the event's text where one instance id can carry two texts.
 * Undefined when the payload lacks the discriminator: without it two real
 * events could share a key, so the caller must not deduplicate (the
 * timeline's own turn guards still apply).
 */
export function codexHookFingerprint(event: string, payload: Record<string, unknown>): string | undefined {
  const thread = nonEmptyString(payload.session_id) ?? codexThreadIdFromPayload(payload);
  if (!thread) return undefined;
  let discriminator: string | undefined;
  for (const field of CODEX_HOOK_FINGERPRINT_FIELDS[event] ?? []) {
    discriminator = nonEmptyString(payload[field]);
    if (discriminator) break;
  }
  if (!discriminator) return undefined;
  const key = `${event}|${stripCodexPrefix(thread)}|${discriminator}`;
  const contentFields = CODEX_HOOK_FINGERPRINT_CONTENT_FIELDS[event];
  if (!contentFields) return key;
  let content = '';
  for (const field of contentFields) {
    const value = payload[field];
    if (typeof value === 'string' && value) { content = value; break; }
  }
  return `${key}|${fnv1a32Utf16(content)}`;
}

/** FNV-1a (32-bit) over UTF-16 code units, as 8 lowercase hex digits — the
 *  Swift mirror hashes `String.utf16`, so both daemons agree byte for byte. */
export function fnv1a32Utf16(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
