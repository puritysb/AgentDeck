/**
 * Which OpenClaw Gateway session a device's prompt, stop or setting is aimed at.
 *
 * One Gateway connection sees every session the agent has. Measured on the
 * owner's store (2026-10-10): one `agent:main:main`, one `agent:main:voice`,
 * dashboard chats, a LINE group — and 465 `agent:main:eval-…` keys, cron jobs
 * (`agent:main:cron:<id>`), heartbeats (`…:heartbeat`), preflight / probe /
 * diagnostic runs. Both adapters aimed `chat.send`, `chat.abort` and
 * `sessions.patch` at whichever key a chat event named last (and, at connect,
 * at the most recently updated key), so a cron tick or an eval run between
 * two deck presses moved the user's next prompt into that run.
 *
 * The rule keeps two keys apart: the ACTIVITY key (whatever just spoke —
 * still drives state and timeline) and the STEERING key (where the user's
 * actions go). Only a key with a conversation shape can become the steering
 * key. The shapes are an allow-list, because the background shapes are open
 * ended (every eval suite and probe mints a new prefix): a conversation shape
 * this list does not know yet is not steerable by passive observation, and
 * when the Gateway lists no conversation key at all the caller keeps the old
 * most-recent behaviour (unknown never strands the deck).
 *
 * `pnpm generate-openclaw-session-key-rules` emits the Swift mirror
 * (`OpenClawSessionKeyRules.generated.swift`); the byte gate is
 * `openclaw-session-key-sync.test.ts`, behaviour is pinned by
 * `shared/openclaw-session-key-vectors.json`, replayed by both suites.
 */

/** Conversation shapes, as regex sources over the whole key. */
export const OPENCLAW_CONVERSATION_KEY_PATTERNS: readonly string[] = [
  // The agent's home conversation and its voice conversation.
  '^agent:[^:]+:(?:main|voice)$',
  // A Control UI (dashboard) chat.
  '^agent:[^:]+:dashboard:[^:]+$',
  // A messaging-channel conversation (`agent:main:line:group:<id>`, `…:telegram:dm:<id>`).
  '^agent:[^:]+:[a-z0-9_-]+:(?:group|dm|direct|channel|thread):[^:]+$',
];

const CONVERSATION_RES = OPENCLAW_CONVERSATION_KEY_PATTERNS.map((p) => new RegExp(p));

export function isOpenClawConversationKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && CONVERSATION_RES.some((re) => re.test(key));
}

/**
 * The steering key to adopt from a `sessions.list` answer, most recent first:
 * the newest conversation key, else (no conversation key listed at all) the
 * newest key — the previous behaviour, so a Gateway whose keys this rule does
 * not know still receives the deck's prompts.
 */
export function pickOpenClawSteeringKey(keysNewestFirst: readonly string[]): string | null {
  return keysNewestFirst.find((key) => isOpenClawConversationKey(key)) ?? keysNewestFirst[0] ?? null;
}

/**
 * The steering key after a Gateway event names `eventKey`: a conversation key
 * takes over (the user is talking there now); a background key never does,
 * except when there is no steering key yet (nothing better is known).
 */
export function nextOpenClawSteeringKey(current: string | null, eventKey: string | null | undefined): string | null {
  if (!eventKey) return current;
  if (isOpenClawConversationKey(eventKey)) return eventKey;
  return current ?? eventKey;
}
