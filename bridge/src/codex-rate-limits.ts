import fs from 'fs';
import os from 'os';
import path from 'path';
import { codexSnapshotOutranks, isModelScopedCodexLimit } from '@agentdeck/shared';
import type { CodexCredits, CodexRateLimits, CodexRateLimitWindow } from '@agentdeck/shared';

/**
 * Read Codex (ChatGPT) usage limits from the user's own local session rollout
 * files. Codex CLI persists a `rate_limits` snapshot inside every `token_count`
 * event it writes to `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`:
 *
 *   { "type":"event_msg", "payload": { "type":"token_count",
 *       "rate_limits": { "primary":{"used_percent":8,"window_minutes":300,"resets_at":...},
 *                        "secondary":{"used_percent":1,"window_minutes":10080,"resets_at":...},
 *                        "plan_type":"plus" } } }
 *
 * This mirrors the Claude 5h/7d quota the dashboard already shows. Reading the
 * user's own local files (the same posture as `readCodexAuthStatus` reading
 * `~/.codex/auth.json`) — no Codex/OpenAI API is contacted.
 *
 * Credit-based plans report a different shape — the 5h/7d windows are null and
 * a `credits` block + `limit_id` carry the metering instead:
 *
 *   { "rate_limits": { "limit_id":"premium", "primary":null, "secondary":null,
 *       "credits":{"has_credits":false,"unlimited":false,"balance":"0"} } }
 *
 * The parser keeps these snapshots so the dashboard can show a credits readout
 * rather than silently dropping the Codex gauge.
 */

interface RawWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}
interface RawCredits {
  has_credits?: boolean;
  unlimited?: boolean;
  balance?: string | number;
}
interface RawRateLimits {
  primary?: RawWindow;
  secondary?: RawWindow;
  plan_type?: string;
  limit_id?: string;
  /** Present only on a limit scoped to one model/feature ("GPT-5.3-Codex-Spark").
   *  The account-wide families report null — see `isModelScopedCodexLimit`. */
  limit_name?: string | null;
  credits?: RawCredits;
}

const defaultSessionsRoot = (): string => path.join(os.homedir(), '.codex', 'sessions');

interface RolloutCandidate {
  full: string;
  mtime: number;
}

/** List immediate subdirectory names of `dir`, sorted newest-first (numeric,
 *  so "10" > "9"). Returns [] on any read error. */
function sortedSubdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/** Collect the newest `maxDays` day-directories under a year/month/day tree,
 *  walking back across month and year boundaries when a level runs short, so a
 *  session that spans midnight (whose rollout stays in the older day-dir) is
 *  still reachable. Returns absolute day-directory paths, newest-first. */
function newestDayDirs(root: string, maxDays: number): string[] {
  const out: string[] = [];
  for (const year of sortedSubdirs(root)) {
    const yearDir = path.join(root, year);
    for (const month of sortedSubdirs(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of sortedSubdirs(monthDir)) {
        out.push(path.join(monthDir, day));
        if (out.length >= maxDays) return out;
      }
    }
  }
  return out;
}

/** Gather rollout files across the newest few day-directories and return them
 *  sorted by mtime descending (capped). Selecting by mtime *across* day-dirs —
 *  not just within the single newest day-dir — is what lets a still-appending
 *  session started on a previous day win over a fresh-but-empty session that
 *  merely created a newer day-directory. */
function candidateRolloutFiles(root: string, maxDays = 3, maxFiles = 6): RolloutCandidate[] {
  if (!fs.existsSync(root)) return [];
  const files: RolloutCandidate[] = [];
  for (const dayDir of newestDayDirs(root, maxDays)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dayDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const full = path.join(dayDir, f);
      try {
        files.push({ full, mtime: fs.statSync(full).mtimeMs });
      } catch {
        /* ignore unreadable entry */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, maxFiles);
}

/** Scan every candidate and return the best usable rate-limits snapshot.
 *
 * File mtime only identifies which rollouts are active enough to inspect. It
 * cannot decide which ACCOUNT snapshot is newest when several Codex sessions
 * append concurrently: a reasoning/tool line can make one file newest while
 * its last rate_limits line is older than a snapshot in another file. Choosing
 * the first usable file made usage move backwards or appear frozen.
 *
 * `accountPlan` (the live tier from `auth.json`) makes the ranking plan-aware —
 * see `codexSnapshotOutranks`. Without it a Codex session left open across a
 * plan change wins on recency forever with a snapshot that is voided one step
 * later, blanking every gauge while a valid snapshot sits in another rollout.
 * Omitting it (tests, an API-key install with no tier) keeps pure newest-wins. */
function parseFirstUsable(
  candidates: RolloutCandidate[],
  accountPlan?: string,
): CodexRateLimits | null {
  let best: CodexRateLimits | null = null;
  let bestCapturedAtMs = -Infinity;
  for (const { full, mtime } of candidates) {
    const tail = readTail(full);
    const parsed = tail ? parseCodexRateLimitsFromText(tail) : null;
    if (parsed) {
      // Freshness anchor. Prefer the snapshot LINE's own timestamp over the file
      // mtime: a rollout keeps growing with lines that carry no `rate_limits`
      // (reasoning, tool output), so mtime drifts forward while the newest usage
      // reading stays put — that would under-report the age of exactly the frozen
      // snapshot this anchor exists to expose. mtime is the fallback.
      parsed.capturedAt = parsed.capturedAt ?? new Date(mtime).toISOString();
      const capturedAtMs = new Date(parsed.capturedAt).getTime();
      if (
        !best ||
        codexSnapshotOutranks(
          { planType: parsed.planType, capturedAtMs },
          { planType: best.planType, capturedAtMs: bestCapturedAtMs },
          accountPlan,
        )
      ) {
        best = parsed;
        bestCapturedAtMs = capturedAtMs;
      }
    }
  }
  return best;
}

/**
 * Read the newest usable Codex rate-limits snapshot from a sessions tree.
 * Exported (root-injectable) for unit testing; `readCodexRateLimits` wraps this
 * with mtime caching against the live `~/.codex/sessions` tree.
 */
export function pickCodexRateLimits(
  root: string = defaultSessionsRoot(),
  accountPlan?: string,
): CodexRateLimits | null {
  return parseFirstUsable(candidateRolloutFiles(root), accountPlan);
}

/** Read the trailing bytes of a file without slurping the whole rollout (these
 *  can grow to many MB). The newest `rate_limits` line is always near the end. */
function readTail(file: string, maxBytes = 262144): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
  }
}

function toCredits(raw?: RawCredits): CodexCredits | undefined {
  if (!raw || (typeof raw.has_credits !== 'boolean' && typeof raw.unlimited !== 'boolean' && raw.balance == null)) {
    return undefined;
  }
  return {
    hasCredits: raw.has_credits === true,
    unlimited: raw.unlimited === true,
    balance: raw.balance != null ? String(raw.balance) : undefined,
  };
}

/** Normalize a rollout line's `timestamp` to ISO-8601, or undefined when the
 *  line carries none / an unparseable one (older rollout formats). */
function parseRolloutTimestamp(ts?: string): string | undefined {
  if (typeof ts !== 'string' || !ts) return undefined;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function toWindow(raw?: RawWindow): CodexRateLimitWindow | undefined {
  if (!raw || typeof raw.used_percent !== 'number' || typeof raw.window_minutes !== 'number') {
    return undefined;
  }
  const resetsAt =
    typeof raw.resets_at === 'number' && raw.resets_at > 0 ? new Date(raw.resets_at * 1000).toISOString() : undefined;
  return {
    usedPercent: Math.min(100, Math.max(0, raw.used_percent)),
    windowMinutes: raw.window_minutes,
    resetsAt,
  };
}

/**
 * Parse the newest `rate_limits` snapshot out of a chunk of rollout JSONL text
 * (typically the file tail). Scans lines from the end so the most recent
 * snapshot wins. Exported for unit testing. Returns null when no usable
 * rate-limit line is found.
 */
export function parseCodexRateLimitsFromText(text: string): CodexRateLimits | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes('rate_limits')) continue;
    try {
      const obj = JSON.parse(line) as {
        timestamp?: string;
        payload?: { type?: string; rate_limits?: RawRateLimits };
      };
      const rl = obj?.payload?.rate_limits;
      if (!rl) continue;
      // A per-model limit is a different QUANTITY, not a staler one, so keep
      // scanning instead of returning it: within one session the family
      // alternates hour to hour, and the account-wide line usually sits further
      // back in this same tail. Returning null for the file would throw that
      // line away along with the scoped one.
      if (isModelScopedCodexLimit(rl.limit_name)) continue;
      const primary = toWindow(rl.primary);
      const secondary = toWindow(rl.secondary);
      const credits = toCredits(rl.credits);
      const limitId = typeof rl.limit_id === 'string' ? rl.limit_id : undefined;
      // Credit-based plans (e.g. limit_id "premium") report null windows and
      // convey usage via the credits block instead — keep those snapshots too.
      if (!primary && !secondary && !credits && !limitId) continue;
      return {
        primary,
        secondary,
        planType: typeof rl.plan_type === 'string' ? rl.plan_type : undefined,
        limitId,
        credits,
        capturedAt: parseRolloutTimestamp(obj.timestamp),
      };
    } catch {
      // Possibly a truncated first line from the tail window; keep scanning.
    }
  }
  return null;
}

// Cache keyed on EVERY candidate rollout's path + mtime. Multiple Codex
// sessions append concurrently, and the freshest rate_limits snapshot may live
// outside candidates[0]. Keying on only that first file let a newer snapshot in
// another candidate remain invisible until the first file changed again.
let cacheKey = '';
let cacheValue: CodexRateLimits | null = null;

export function readCodexRateLimits(
  root: string = defaultSessionsRoot(),
  accountPlan?: string,
): CodexRateLimits | null {
  const candidates = candidateRolloutFiles(root);
  // The account tier is part of the key, not just the files: the selection is
  // plan-aware, so the same set of rollouts ranks differently the instant the
  // user's plan changes. Keying on files alone would serve the pre-upgrade
  // winner until some rollout happened to be touched again.
  const key = `${accountPlan ?? ''}|${candidates.map(({ full, mtime }) => `${full}:${mtime}`).join('|')}`;
  if (candidates.length > 0 && key === cacheKey) return cacheValue;

  const parsed = parseFirstUsable(candidates, accountPlan);
  cacheKey = key;
  cacheValue = parsed;
  return parsed;
}
