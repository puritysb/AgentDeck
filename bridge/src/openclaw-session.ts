/**
 * openclaw-session.ts — single injector for the virtual OpenClaw Gateway
 * session. Shared by the CLI session bridge (index.ts) and the daemon hub
 * (daemon-server.ts) so both apply the SSOT predicate identically and can never
 * drift. Mirror of Swift `buildSessionsListEvent`.
 */
import { isOpenClawSessionActive, hasOpenClawSession } from '@agentdeck/shared';
import type { OpenClawApprovalPrompt, OpenClawPluginApprovalPrompt } from '@agentdeck/shared';
import type { EnrichedSession } from './session-aggregator.js';

/**
 * `OpenClawApprovalPrompt` (exec) always carries `command` — even an empty
 * string, never `undefined` (`parseExecApprovalRequest` always sets it).
 * `OpenClawPluginApprovalPrompt` has no `command` field at all. This is the
 * one field-shape difference cheap enough to branch on without a `kind` tag
 * threading through the wire type.
 */
function isPluginApprovalPrompt(
  approval: OpenClawApprovalPrompt | OpenClawPluginApprovalPrompt,
): approval is OpenClawPluginApprovalPrompt {
  return !('command' in approval);
}

/**
 * Id of the virtual Gateway session row. Defined here because this injector is
 * what creates it; import it instead of retyping the literal, which is how a
 * comparison against it silently stops matching.
 */
export const OPENCLAW_SESSION_ID = 'openclaw-gateway';

export interface InjectOpenClawOptions {
  /** SSOT gate — inject only when the Gateway is authenticated. */
  gatewayConnected: boolean;
  /** Daemon-hub extras (the CLI bridge omits these → a minimal session row). */
  state?: string;
  projectName?: string;
  modelName?: string;
  controlMode?: 'managed';
  /**
   * The approval the Gateway is blocked on, when there is one — exec
   * (`exec.approval.*`) or plugin (`plugin.approval.*`, issue #309), whichever
   * the adapter's `activePendingApproval()` currently presents. Every deck
   * surface already renders `question`/`options` off the session row and only
   * falls back to the dead-end "PERMIT? / answer in terminal" tile when they are
   * absent — which they always were, because this row never carried them. The
   * Gateway session has no terminal to answer in, so that fallback left the user
   * with no route at all.
   */
  approval?: OpenClawApprovalPrompt | OpenClawPluginApprovalPrompt | null;
}

/**
 * Append the virtual `openclaw` session iff the Gateway is authenticated
 * (`gatewayConnected`) and one isn't already present. Reachability
 * (`gatewayAvailable`) and health alone must NEVER materialize a session — that
 * kept a phantom OpenClaw alive on devices after it was off.
 */
export function injectOpenClawSession(
  sessions: EnrichedSession[],
  opts: InjectOpenClawOptions,
): EnrichedSession[] {
  if (!isOpenClawSessionActive({ gatewayConnected: opts.gatewayConnected })) return sessions;
  if (hasOpenClawSession(sessions)) return sessions;
  const injected: EnrichedSession = {
    id: OPENCLAW_SESSION_ID,
    port: 18789,
    projectName: opts.projectName ?? 'OpenClaw',
    agentType: 'openclaw',
    alive: true,
  };
  if (opts.state !== undefined) injected.state = opts.state;
  if (opts.modelName !== undefined) injected.modelName = opts.modelName;
  if (opts.controlMode !== undefined) injected.controlMode = opts.controlMode;
  if (opts.approval) {
    // A user pressing Allow must know WHICH kind of thing they are allowing —
    // an exec approval is a shell command; a plugin approval is whatever a
    // plugin (or a trusted in-process agent runtime) asked for, which reads
    // very differently ("Send message to #ops" is not a command line). The
    // `[Plugin]` prefix rides the one field every surface already renders
    // (`question`), so no wire-shape change is needed on any device.
    const isPlugin = isPluginApprovalPrompt(opts.approval);
    injected.question = isPlugin ? `[Plugin] ${opts.approval.question}` : opts.approval.question;
    // The question is the command (or plugin title); `questionDetail` is
    // everything that makes it a decision — the policy reason approval was
    // demanded, the cwd, and WHICH OpenClaw session asked. All three were
    // parsed and then dropped here, so a deck asked the user to approve a bare
    // `sed -n` with no reason and no way to tell a cron heartbeat apart from a
    // model-eval run (measured 2026-08-23: every approval came from
    // `agent:main:eval-…__r2`, while the row said only "OpenClaw").
    const detailLines = [
      ...(opts.approval.detail ? opts.approval.detail.split('\n') : []),
      ...(opts.approval.sessionKey ? [`session: ${opts.approval.sessionKey}`] : []),
    ].map((l) => l.trim()).filter(Boolean);
    if (detailLines.length > 0) injected.questionDetail = detailLines.join('\n');
    injected.options = opts.approval.options.map((o) => ({
      index: o.index, label: o.label, shortcut: o.shortcut,
    }));
    injected.promptType = 'yes_no_always';
    // The daemon can deliver this answer over the Gateway RPC, so the option
    // cells are live rather than display-only. `requestId` stays absent: it
    // makes surfaces render a binary Allow/Deny gate over a list that may carry
    // three real choices.
    injected.liveAnswerable = true;
  }
  return [...sessions, injected];
}
