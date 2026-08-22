import { spawn } from 'child_process';
import {
  codexSnapshotMatchesAccountPlan,
  codexSnapshotOutranks,
  isModelScopedCodexLimit,
} from '@agentdeck/shared';
import type { CodexCredits, CodexRateLimits, CodexRateLimitWindow } from '@agentdeck/shared';

/**
 * Active Codex rate-limit read via the local `codex app-server` JSON-RPC.
 *
 * The passive reader (`codex-rate-limits.ts`) recovers usage from the
 * `rate_limits` block Codex embeds in every `token_count` rollout line. That
 * makes the reading a BYPRODUCT OF A SUCCESSFUL TURN — and the state a user most
 * wants to see, "the weekly quota is exhausted", is exactly the state in which no
 * turn can complete. So the passive number freezes one turn short of the wall
 * (observed 2026-08-05: rollouts stop at 94% at 03:38 KST while the account had
 * actually reached 100%) and cannot recover until the window resets days later.
 * Usage spent on another surface entirely — Codex Cloud tasks, another machine —
 * is likewise invisible, because no local rollout ever learns about it.
 *
 * The user's own Codex CLI answers the question directly:
 *
 *   $ codex app-server            # JSON-RPC over stdio
 *   → {"id":2,"result":{"rateLimits":{"limitId":"codex","primary":
 *       {"usedPercent":100,"windowDurationMins":10080,"resetsAt":1786459585},
 *       "secondary":null,"planType":"plus",
 *       "rateLimitReachedType":"rate_limit_reached", ...}}}
 *
 * Same posture as the rest of the Codex integration: the user's own local CLI
 * with the user's own credentials — AgentDeck contacts no OpenAI endpoint itself.
 *
 * Daemon-only and throttled: spawning a process is Node-daemon territory (session
 * bridges keep device/host modules off, and the sandboxed macOS App Store daemon
 * must never spawn anything — it keeps the passive read). While Codex is actively
 * working, the passive reading is free and exact, so the live query only fires
 * once the rollout snapshot has gone quiet.
 */

/** Hard ceiling on one query — the child is killed and the read reported as a
 *  miss rather than left to hang (external-peer await always carries a timeout). */
const QUERY_TIMEOUT_MS = 8000;
/** Never spawn more often than this, regardless of how often usage is built. */
const MIN_QUERY_INTERVAL_MS = 5 * 60 * 1000;
/** A passive snapshot younger than this means Codex is being used right now;
 *  the rollout is authoritative and cheaper, so skip the spawn. */
const PASSIVE_FRESH_MS = 2 * 60 * 1000;
/** After this many consecutive misses (no Codex CLI installed, not logged in,
 *  protocol changed), back off hard instead of spawning every interval. */
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;

const INITIALIZE_REQUEST_ID = 1;
const RATE_LIMITS_REQUEST_ID = 2;

interface RawLiveWindow {
  usedPercent?: number;
  /** The app-server spells the window length differently from the rollout
   *  (`windowDurationMins` vs `window_minutes`); accept both. */
  windowDurationMins?: number;
  windowMinutes?: number;
  resetsAt?: number;
}

interface RawLiveCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string | number;
}

interface RawLiveRateLimits {
  primary?: RawLiveWindow | null;
  secondary?: RawLiveWindow | null;
  planType?: string;
  limitId?: string;
  /** Set only on a limit scoped to one model/feature — see `isModelScopedCodexLimit`. */
  limitName?: string | null;
  credits?: RawLiveCredits | null;
}

function toWindow(raw?: RawLiveWindow | null): CodexRateLimitWindow | undefined {
  if (!raw || typeof raw.usedPercent !== 'number') return undefined;
  const windowMinutes = typeof raw.windowDurationMins === 'number'
    ? raw.windowDurationMins
    : typeof raw.windowMinutes === 'number'
      ? raw.windowMinutes
      : undefined;
  if (typeof windowMinutes !== 'number') return undefined;
  return {
    usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
    windowMinutes,
    resetsAt:
      typeof raw.resetsAt === 'number' && raw.resetsAt > 0
        ? new Date(raw.resetsAt * 1000).toISOString()
        : undefined,
  };
}

function toCredits(raw?: RawLiveCredits | null): CodexCredits | undefined {
  if (!raw || (typeof raw.hasCredits !== 'boolean' && typeof raw.unlimited !== 'boolean' && raw.balance == null)) {
    return undefined;
  }
  return {
    hasCredits: raw.hasCredits === true,
    unlimited: raw.unlimited === true,
    balance: raw.balance != null ? String(raw.balance) : undefined,
  };
}

/**
 * Map an `account/rateLimits/read` result onto the wire shape. `capturedAt` is
 * the instant WE asked — unlike the passive read (which carries the rollout
 * line's own timestamp), a live answer is current by construction, and that is
 * what clears the age footnote downstream. Exported for unit testing.
 */
export function parseLiveCodexRateLimits(result: unknown, capturedAt: string): CodexRateLimits | null {
  const res = result as {
    rateLimits?: RawLiveRateLimits;
    rateLimitsByLimitId?: Record<string, RawLiveRateLimits>;
  } | null;
  // The top-level block is the account's today, and that is what the Codex CLI
  // itself presents. But the app-server also returns every family keyed by id,
  // so when the top level is scoped to one model there is still an account-wide
  // answer in the map — take it rather than reporting a single model's quota as
  // the account's. (Not currently reachable; the guard costs one lookup and the
  // alternative is the rollout bug in a place with no second source.)
  const rl = pickAccountWideLiveLimits(res?.rateLimits, res?.rateLimitsByLimitId);
  if (!rl || typeof rl !== 'object') return null;
  const primary = toWindow(rl.primary);
  const secondary = toWindow(rl.secondary);
  const credits = toCredits(rl.credits);
  const limitId = typeof rl.limitId === 'string' ? rl.limitId : undefined;
  if (!primary && !secondary && !credits && !limitId) return null;
  return {
    primary,
    secondary,
    planType: typeof rl.planType === 'string' ? rl.planType : undefined,
    limitId,
    credits,
    capturedAt,
  };
}

/**
 * The account-wide limit block among what `account/rateLimits/read` returned.
 *
 * Prefers the top-level `rateLimits` (what the Codex CLI shows) and falls back
 * to the first unnamed entry of `rateLimitsByLimitId`. Returns null when every
 * family is model-scoped: "no account-wide reading" is the honest answer, and
 * the caller then keeps whatever the rollout path found rather than adopting one
 * model's quota as the account's. Exported for unit testing.
 */
export function pickAccountWideLiveLimits(
  top?: RawLiveRateLimits | null,
  byLimitId?: Record<string, RawLiveRateLimits> | null,
): RawLiveRateLimits | null {
  if (top && !isModelScopedCodexLimit(top.limitName)) return top;
  for (const candidate of Object.values(byLimitId ?? {})) {
    if (candidate && !isModelScopedCodexLimit(candidate.limitName)) return candidate;
  }
  return null;
}

function codexBinary(): string {
  return process.env.AGENTDECK_CODEX_BIN || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
}

/**
 * How to hand the Codex binary to `spawn`.
 *
 * Windows ships the CLI as `codex.cmd`, and since the CVE-2024-27980 fix
 * (Node 18.20.2 / 20.12.2 / 21.7.3+, so every Node this repo supports) `spawn`
 * REFUSES a `.cmd`/`.bat` target unless `shell: true` — it throws EINVAL. Without
 * this the live query would fail on every Windows host, and because a miss is
 * indistinguishable from "no Codex installed" it would settle into the 30-minute
 * failure backoff and never say why. Under a shell the command line is re-parsed,
 * so a path containing spaces has to carry its own quotes.
 *
 * Exported for unit testing: the branch is unreachable on the CI platform.
 */
export function codexSpawnPlan(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; shell: boolean } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return { command: binary, shell: false };
  return { command: /\s/.test(binary) ? `"${binary}"` : binary, shell: true };
}

/**
 * Spawn `codex app-server`, ask for the account rate limits, kill it, and return
 * the parsed snapshot. Resolves null on any miss (binary absent, protocol
 * mismatch, timeout) — never rejects, so callers can treat it as best-effort.
 */
export async function queryCodexRateLimitsLive(
  opts: { binary?: string; args?: string[]; timeoutMs?: number } = {},
): Promise<CodexRateLimits | null> {
  const binary = opts.binary ?? codexBinary();
  const args = opts.args ?? ['app-server'];
  const timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS;

  const plan = codexSpawnPlan(binary);

  return new Promise<CodexRateLimits | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.command, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: plan.shell });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value: CodexRateLimits | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
        // Under a shell the child is cmd.exe and the real server is its grandchild;
        // terminating the shell alone would orphan a Codex process every 5 minutes.
        if (plan.shell && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
        }
      } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    // The daemon must never be held open by a probe.
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', () => finish(null));
    // A server that exits on its own never answered us.
    child.on('exit', () => finish(null));
    child.stdin?.on('error', () => finish(null));

    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: unknown };
        try {
          msg = JSON.parse(line) as { id?: unknown; result?: unknown };
        } catch {
          continue; // notifications may interleave; keep reading
        }
        if (msg?.id === RATE_LIMITS_REQUEST_ID) {
          finish(parseLiveCodexRateLimits(msg.result, new Date().toISOString()));
          return;
        }
      }
    });

    const frames = [
      { jsonrpc: '2.0', id: INITIALIZE_REQUEST_ID, method: 'initialize', params: { clientInfo: { name: 'agentdeck', title: 'AgentDeck', version: '1.0.0' } } },
      { jsonrpc: '2.0', method: 'initialized', params: {} },
      { jsonrpc: '2.0', id: RATE_LIMITS_REQUEST_ID, method: 'account/rateLimits/read', params: {} },
    ];
    try {
      child.stdin?.write(frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
    } catch {
      finish(null);
    }
  });
}

function capturedAtMs(rl?: CodexRateLimits | null): number {
  if (!rl?.capturedAt) return 0;
  const ms = new Date(rl.capturedAt).getTime();
  return isNaN(ms) ? 0 : ms;
}

/**
 * Choose between the passive rollout reading and the live app-server reading.
 *
 * Plan agreement first, capture time second (`codexSnapshotOutranks`). Recency
 * alone let the wrong one win in exactly the case the live query exists to
 * cover: a Codex session opened before a plan change keeps writing old-plan
 * rollout snapshots with ever-newer timestamps, so the live answer — correct,
 * current, and the ONLY source carrying the new tier — lost every comparison and
 * was then voided as a mismatch. A snapshot with no `capturedAt` at all loses to
 * a stamped one within its match class; ties keep the passive reading, which is
 * the on-disk ground truth. Exported for unit testing.
 */
export function pickBestCodexRateLimits(
  passive: CodexRateLimits | null,
  live: CodexRateLimits | null,
  accountPlan?: string,
): CodexRateLimits | null {
  if (!live) return passive;
  if (!passive) return live;
  return codexSnapshotOutranks(
    { planType: live.planType, capturedAtMs: capturedAtMs(live) },
    { planType: passive.planType, capturedAtMs: capturedAtMs(passive) },
    accountPlan,
  )
    ? live
    : passive;
}

/** Throttle policy, kept pure so the cadence is testable without spawning. */
export function shouldQueryCodexRateLimitsLive(input: {
  nowMs: number;
  lastAttemptMs: number;
  consecutiveFailures: number;
  passiveCapturedAtMs: number;
  /** False when the passive snapshot is stamped with a plan the account no
   *  longer holds — i.e. it is about to be voided and carries no usable number.
   *  Defaults to true so callers that know no account tier behave as before. */
  passivePlanMatchesAccount?: boolean;
}): boolean {
  const {
    nowMs,
    lastAttemptMs,
    consecutiveFailures,
    passiveCapturedAtMs,
    passivePlanMatchesAccount = true,
  } = input;
  const interval =
    consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? FAILURE_BACKOFF_MS : MIN_QUERY_INTERVAL_MS;
  // Spawn throttles are unconditional: a mismatch is a reason to prefer the live
  // read, never a licence to spawn a subprocess on every usage build.
  if (lastAttemptMs > 0 && nowMs - lastAttemptMs < interval) return false;
  // Codex is mid-turn: the rollout is already writing fresh readings — but only
  // if those readings are usable at all. A snapshot stamped with a retired plan
  // is voided downstream, so "the passive read is fresh" would suppress the one
  // source that still has a number, precisely while Codex is being used hardest.
  if (
    passivePlanMatchesAccount &&
    passiveCapturedAtMs > 0 &&
    nowMs - passiveCapturedAtMs < PASSIVE_FRESH_MS
  ) {
    return false;
  }
  return true;
}

let cachedLive: CodexRateLimits | null = null;
let lastAttemptMs = 0;
let consecutiveFailures = 0;
let inFlight = false;

/** Last live snapshot, or null if none has been obtained. */
export function getLiveCodexRateLimits(): CodexRateLimits | null {
  return cachedLive;
}

/**
 * Daemon entry point: return the better of the passive and live readings, and
 * kick off a throttled background refresh when the passive one has gone quiet
 * OR has been minted under a plan the account no longer holds. Fire-and-forget
 * by design — the current call is answered from cache so usage building never
 * awaits a subprocess.
 *
 * `accountPlan` is the live tier from `auth.json`. Passing it is what lets both
 * halves of this function tell "old" from "void"; omitting it keeps the previous
 * newest-wins behaviour.
 */
export function codexRateLimitsWithLiveRefresh(
  passive: CodexRateLimits | null,
  accountPlan?: string,
): CodexRateLimits | null {
  if (process.env.AGENTDECK_CODEX_LIVE_USAGE !== '0') {
    const nowMs = Date.now();
    if (
      !inFlight &&
      shouldQueryCodexRateLimitsLive({
        nowMs,
        lastAttemptMs,
        consecutiveFailures,
        passiveCapturedAtMs: capturedAtMs(passive),
        passivePlanMatchesAccount: codexSnapshotMatchesAccountPlan(passive?.planType, accountPlan),
      })
    ) {
      inFlight = true;
      lastAttemptMs = nowMs;
      void queryCodexRateLimitsLive()
        .then((live) => {
          if (live) {
            cachedLive = live;
            consecutiveFailures = 0;
          } else {
            consecutiveFailures += 1;
          }
        })
        .catch(() => {
          consecutiveFailures += 1;
        })
        .finally(() => {
          inFlight = false;
        });
    }
  }
  return pickBestCodexRateLimits(passive, cachedLive, accountPlan);
}

/** Test hook — clears the module-level cache and throttle state. */
export function __resetCodexRateLimitsLiveForTest(): void {
  cachedLive = null;
  lastAttemptMs = 0;
  consecutiveFailures = 0;
  inFlight = false;
}
