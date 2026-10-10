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
 * actions go). Only the user's own conversation can become the steering key:
 * the Gateway's configured main session (`hello-ok.snapshot.sessionDefaults
 * .mainSessionKey`, whatever `session.mainKey` names it), plus an allow-list
 * of shapes — background shapes are open ended (every eval suite and probe
 * mints a new prefix). A messaging GROUP / channel / thread is other people's
 * room (the owner's LINE group: `session_scope='group'`), so it never takes
 * the deck by being active: the user's next prompt would join that room's
 * transcript. `sessions.list` is paged (default 100 rows), so after an eval
 * batch no conversation may be listed: the Gateway's main key is then the
 * target, and only with neither does the caller keep the old most-recent
 * behaviour (unknown never strands the deck).
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
  // A one-to-one messaging conversation (`agent:main:telegram:dm:<id>`).
  // Groups, channels and threads are other people's rooms and are excluded.
  '^agent:[^:]+:[a-z0-9_-]+:(?:dm|direct):[^:]+$',
];

const CONVERSATION_RES = OPENCLAW_CONVERSATION_KEY_PATTERNS.map((p) => new RegExp(p));

export function isOpenClawConversationKey(key: string | null | undefined, mainSessionKey?: string | null): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (mainSessionKey && key === mainSessionKey) return true;
  return CONVERSATION_RES.some((re) => re.test(key));
}

/**
 * The steering key to adopt from a `sessions.list` answer, most recent first:
 * the newest conversation key, else the Gateway's main session key, else the
 * newest key — the previous behaviour, so a Gateway whose keys this rule does
 * not know still receives the deck's prompts.
 */
export function pickOpenClawSteeringKey(
  keysNewestFirst: readonly string[],
  mainSessionKey?: string | null,
): string | null {
  return keysNewestFirst.find((key) => isOpenClawConversationKey(key, mainSessionKey))
    ?? (mainSessionKey || null)
    ?? keysNewestFirst[0]
    ?? null;
}

/**
 * The steering key after a Gateway event names `eventKey`: a conversation key
 * takes over (the user is talking there now); a background key never does,
 * except when nothing is known yet (no steering key and no main key).
 */
export function nextOpenClawSteeringKey(
  current: string | null,
  eventKey: string | null | undefined,
  mainSessionKey?: string | null,
): string | null {
  if (!eventKey) return current;
  if (isOpenClawConversationKey(eventKey, mainSessionKey)) return eventKey;
  return current ?? (mainSessionKey || null) ?? eventKey;
}

/** `hello-ok.snapshot.sessionDefaults.mainSessionKey`, when the Gateway sent one. */
export function openClawMainSessionKeyFromHello(hello: unknown): string | null {
  if (!hello || typeof hello !== 'object') return null;
  const snapshot = (hello as Record<string, unknown>).snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const defaults = (snapshot as Record<string, unknown>).sessionDefaults;
  if (!defaults || typeof defaults !== 'object') return null;
  const key = (defaults as Record<string, unknown>).mainSessionKey;
  return typeof key === 'string' && key.length > 0 && key.length <= 512 ? key : null;
}
