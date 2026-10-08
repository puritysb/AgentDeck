// session-activity.ts — per-session "what is this agent doing right now" one-liner.
//
// A single shared source so glance surfaces (XTeink X3 rows, TRMNL list) render
// the same clean, natural-language text instead of a raw tool path. Two layers:
//
//   1. quickActivity()  — synchronous heuristic (clean current action). Always
//      available, instant, used for the immediate broadcast.
//   2. Foundation Models upgrade — when the macOS 26+ FM helper is reachable
//      (bundled in the @agentdeck/bridge package, NOT the App Store target), the
//      current action is rephrased into a short natural-language summary, cached
//      per session and surfaced on the NEXT periodic sessions_list broadcast (no
//      explicit re-broadcast needed). Falls back to the heuristic when FM is
//      unavailable or errors. Cost-free (on-device), see feedback_cost_sensitive_defaults.
//
import { CLAUDE_BACKGROUND_POLICY } from './claude-background-tasks.js';
import { callFoundationModelsHelper, probeFoundationModelsHelper } from './foundation-models-helper.js';
import { stripUnsafeText, ciWaitDetail } from '@agentdeck/shared';
import { debug } from './logger.js';
import type { EnrichedSession } from './session-aggregator.js';

/** "Edit /a/b/c.ts" → "Edit c.ts"; "Bash cd /x; rm…" → "Bash cd…". Mirrors
 *  cleanAction in shared/src/trmnl-layout.ts (kept local to avoid a cross-package
 *  export churn while that file is under active concurrent edit). */
function cleanAction(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const sp = s.indexOf(' ');
  if (sp < 0) return s;
  const verb = s.slice(0, sp);
  const rest = s.slice(sp + 1).trim();
  const firstTok = rest.split(/\s+/)[0] || '';
  if (firstTok.includes('/')) {
    const base = firstTok.split('/').filter(Boolean).pop() || firstTok;
    return `${verb} ${base}`;
  }
  return rest.length > 22 ? `${verb} ${rest.slice(0, 21)}…` : `${verb} ${rest}`;
}

/** Tool name → present-continuous verb for a natural reading. */
function verbForm(tool: string): string {
  const map: Record<string, string> = {
    Edit: 'Editing', MultiEdit: 'Editing', Write: 'Writing', NotebookEdit: 'Editing',
    Read: 'Reading', Bash: 'Running', Grep: 'Searching', Glob: 'Finding',
    Task: 'Delegating', WebFetch: 'Fetching', WebSearch: 'Searching', TodoWrite: 'Planning',
  };
  return map[tool] ?? tool;
}

/** Synchronous, always-available clean one-liner. */
export function quickActivity(s: EnrichedSession): string | undefined {
  const state = s.state ?? '';
  // Strip PTY escape/control bytes first — a raw ESC in these strings used to
  // break the SVG parse downstream and blank the TRMNL/D200H frame.
  if (state.startsWith('awaiting') && s.question && s.question.trim()) {
    return stripUnsafeText(s.question.trim()).slice(0, 72);
  }
  // currentTask, when present, is the full "Verb /path" action — clean the path off.
  const task = stripUnsafeText((s.currentTask ?? '').trim());
  if (task) {
    const cleaned = cleanAction(task);
    // If it's "Verb basename", prefer the present-continuous verb.
    const sp = cleaned.indexOf(' ');
    if (sp > 0) return `${verbForm(cleaned.slice(0, sp))} ${cleaned.slice(sp + 1)}`;
    return cleaned;
  }
  if (s.currentTool && s.currentTool.trim()) return verbForm(stripUnsafeText(s.currentTool.trim()));
  if (s.goal && s.goal.trim()) return cleanAction(stripUnsafeText(s.goal.trim()));
  return undefined;
}

// ── Foundation Models upgrade (cached, debounced, best-effort) ──
interface CacheEntry { sig: string; summary?: string; at: number }
const cache = new Map<string, CacheEntry>();
const inflight = new Set<string>();
let fmAvailable: boolean | null = null; // null = not yet probed
const MIN_SUMMARIZE_INTERVAL_MS = 15_000;

function signature(s: EnrichedSession): string {
  return [s.state, s.currentTool, s.currentTask, s.question, s.goal].map((v) => v ?? '').join('|');
}

const FM_INSTRUCTIONS =
  'You label a coding agent\'s current work for a tiny status display. Reply with ONE short ' +
  'present-tense phrase (max 8 words, no period, no quotes) describing what the agent is doing, ' +
  'e.g. "Editing the auth module" or "Running the test suite". English only.';

function buildContext(s: EnrichedSession): string {
  const parts: string[] = [];
  if (s.projectName) parts.push(`Project: ${s.projectName}`);
  if (s.agentType) parts.push(`Agent: ${s.agentType}`);
  if (s.currentTool) parts.push(`Current tool: ${s.currentTool}`);
  if (s.currentTask) parts.push(`Action: ${s.currentTask}`);
  if (s.goal) parts.push(`Goal: ${s.goal}`);
  if (s.state?.startsWith('awaiting') && s.question) parts.push(`Awaiting answer to: ${s.question}`);
  return parts.join('\n');
}

function sanitize(text: string): string | undefined {
  const t = text.replace(/^["'\s]+|["'\s.]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > 72 ? `${t.slice(0, 71)}…` : t;
}

/** Fire-and-forget FM summarization; result lands in `cache` for the next broadcast. */
function maybeSummarize(s: EnrichedSession): void {
  const sig = signature(s);
  const existing = cache.get(s.id);
  if (existing && existing.sig === sig) return; // already current
  if (existing && Date.now() - existing.at < MIN_SUMMARIZE_INTERVAL_MS) return; // debounce churn
  if (inflight.has(s.id)) return;
  // Nothing meaningful to summarize → don't spin up FM.
  if (!s.currentTool && !s.currentTask && !s.goal && !(s.state?.startsWith('awaiting'))) return;

  inflight.add(s.id);
  void (async () => {
    try {
      if (fmAvailable === null) fmAvailable = (await probeFoundationModelsHelper()).available;
      if (!fmAvailable) {
        cache.set(s.id, { sig, summary: undefined, at: Date.now() }); // mark probed; heuristic wins
        return;
      }
      const text = await callFoundationModelsHelper(buildContext(s), FM_INSTRUCTIONS);
      cache.set(s.id, { sig, summary: sanitize(text), at: Date.now() });
    } catch (err) {
      debug('APME', `session-activity FM summarize failed sid=${s.id.slice(0, 16)}: ${String(err).slice(0, 120)}`);
      cache.set(s.id, { sig, summary: undefined, at: Date.now() });
    } finally {
      inflight.delete(s.id);
    }
  })();
}

/**
 * Resolve the per-session activity line. Returns the cached FM summary when it
 * matches the current session signature, else the synchronous heuristic — and
 * kicks off an async FM summarization whose result surfaces on a later broadcast.
 */
export function activityFor(s: EnrichedSession): string | undefined {
  if (s.state === 'processing' && s.currentTool === CLAUDE_BACKGROUND_POLICY.tool && s.activity) return s.activity;
  if (s.waitingOn && !s.state?.startsWith('awaiting')) return ciWaitDetail(s.waitingOn) ?? undefined;
  const quick = quickActivity(s);
  const cached = cache.get(s.id);
  maybeSummarize(s);
  if (cached && cached.sig === signature(s) && cached.summary) return cached.summary;
  return quick;
}

/** Drop a session's cached summary (call on session removal). */
export function clearSessionActivity(sessionId: string): void {
  cache.delete(sessionId);
  inflight.delete(sessionId);
}

/** Test seam — reset FM availability + cache. */
export function resetSessionActivityForTests(): void {
  cache.clear();
  inflight.clear();
  fmAvailable = null;
}
