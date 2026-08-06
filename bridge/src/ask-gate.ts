import type { PromptOption } from '@agentdeck/shared';

/**
 * Decisions for the AskUserQuestion ask-gate — the rung that answers an
 * observed session's question by holding its PreToolUse hook open.
 *
 * These live outside `daemon-server.ts` because both of them are easy to get
 * subtly, silently wrong: one decides whether to make the user wait, the other
 * decides whether to commit an irreversible answer on their behalf. Neither
 * shows up in a stack trace when it misfires — the terminal just sits blank, or
 * the agent proceeds with an option nobody chose.
 */

/** What the passive observer knows about where an observed session is running. */
export interface AskGateHost {
  /** Controlling terminal, when the session runs in a real one. */
  tty?: string;
  /** Owning GUI app, for app-hosted sessions with no tty. */
  appName?: string;
}

export interface AskGateDecision {
  hold: boolean;
  reason: string;
}

/**
 * Should this AskUserQuestion be held open for a device to answer?
 *
 * Holding costs whoever is sitting at that terminal the whole hold duration —
 * their question picker does not appear until the hook returns. So it is only
 * worth it when the daemon has no faster way to deliver the answer AND some
 * device is actually showing the prompt.
 *
 * That second condition is why `observed` being absent means DON'T hold: the
 * observer's roster is the only source of `observed:claude:*` rows, so a
 * session it has not seen is a session no device has on screen. Holding there
 * stalls a question with nobody to answer it — the precise inverse of the
 * intent. It happens for real: a session younger than the 5s scan interval, or
 * any `ps` failure, empties that roster.
 */
export function askGateDecision(opts: {
  enabled: boolean;
  clientCount: number;
  /** The session's observer row, or undefined if it has not been seen. */
  observed: AskGateHost | undefined;
}): AskGateDecision {
  if (!opts.enabled) return { hold: false, reason: 'disabled' };
  if (opts.clientCount < 1) return { hold: false, reason: 'no clients' };
  if (!opts.observed) return { hold: false, reason: 'session not on any device roster yet' };
  if (opts.observed.tty || opts.observed.appName) {
    return { hold: false, reason: 'terminal reachable — inject instead' };
  }
  return { hold: true, reason: 'no way to type into this session' };
}

export type AskPressVerdict =
  | { ok: true; label: string }
  | { ok: false; reason: string; resync: boolean };

/** The overlay fields a press is validated against. */
export interface AskPressOverlay {
  question?: string;
  options?: PromptOption[];
  toolUseId?: string;
}

/**
 * Is this device press a valid answer to the question currently held open?
 *
 * Every rejection here is a press that would otherwise commit an answer the
 * user did not give, so the checks are deliberately strict:
 *
 *  - **The press must name the question it answers.** Not decoration: several
 *    device surfaces map a hardware "approve" key to `select_option(0)` as a
 *    stand-in for a yes/no gate (ESP32 `hudSendApprove`, NFC `approve` tags).
 *    Against a permission gate that is meaningful. Against a four-way question
 *    it is a guess, and this rung would submit it as the user's stated answer,
 *    irreversibly. A surface that renders the real options can name the one it
 *    is answering; a binary approve key cannot, which is exactly the line we
 *    want. `resync: false` — the sender has no question view to correct.
 *  - **The named question must be the live one.** A grouped prompt moves on as
 *    each question is answered, so an index pressed against the previous one
 *    would land in a different option list.
 *  - **The gate must own this overlay.** A malformed follow-up call can leave a
 *    previous prompt resident; answering that one would report the wrong
 *    question back to the agent.
 */
export function askPressVerdict(opts: {
  overlay: AskPressOverlay | undefined;
  /** tool_use_id the gate was opened for. */
  gateToolUseId?: string;
  command: Record<string, unknown>;
}): AskPressVerdict {
  const { overlay, gateToolUseId, command } = opts;
  if (command.type !== 'select_option') {
    return { ok: false, reason: `ask-gate expects select_option, got ${String(command.type)}`, resync: false };
  }
  if (!overlay?.question) {
    return { ok: false, reason: 'no question is open', resync: true };
  }
  if (gateToolUseId && overlay.toolUseId && gateToolUseId !== overlay.toolUseId) {
    return { ok: false, reason: 'held gate belongs to a different tool call', resync: true };
  }
  const echo = typeof command.question === 'string' ? command.question : undefined;
  if (!echo) {
    return { ok: false, reason: 'answer did not name its question', resync: false };
  }
  if (echo !== overlay.question) {
    return { ok: false, reason: 'answers a question the prompt has moved past', resync: true };
  }
  if (typeof command.index !== 'number') {
    return { ok: false, reason: 'no option index', resync: false };
  }
  const label = overlay.options?.find((o) => o.index === command.index)?.label;
  if (!label) {
    return { ok: false, reason: `option ${command.index} is not in the live list`, resync: true };
  }
  return { ok: true, label };
}
