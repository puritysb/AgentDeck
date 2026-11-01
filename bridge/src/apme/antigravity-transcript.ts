/**
 * Antigravity (`agy` CLI) transcript parsing.
 *
 * The agy CLI persists each conversation as a plain JSONL transcript at
 *   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 * one JSON object per step:
 *   { step_index, source, type, status, created_at, content?, thinking?, tool_calls? }
 *
 * Unlike Claude/Codex, the model id is NOT on each record. It surfaces in the
 * first USER_INPUT's `<USER_SETTINGS_CHANGE>` tag ("...from None to <MODEL>.")
 * when a model is selected for the conversation; otherwise the global default
 * in `settings.json` applies. The session log carries a live override line too,
 * but the per-conversation transcript is the cleanest attribution source.
 *
 * These pure functions are shared by the passive observer (creature + model
 * display) and the APME ingester (run/turn model attribution) so agy gets the
 * same scorecard treatment as the other agents.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ANTIGRAVITY_POLICY } from '../antigravity-policy.generated.js';

export interface AntigravityTranscriptSummary {
  goal?: string;
  state: 'idle' | 'processing' | 'unknown';
  currentTask?: string;
  /** Human model label from the transcript's last USER_SETTINGS_CHANGE, if any
   *  (e.g. "GPT-OSS 120B (Medium)", "Gemini 3.5 Flash (Medium)"). */
  model?: string;
}

interface AgyRecord {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}

/** Step types that represent the agent doing tool work (drives currentTask). */
const TOOL_TYPES = new Set<string>(ANTIGRAVITY_POLICY.toolTypes);

export function antigravityRoot(): string {
  return join(homedir(), '.gemini', 'antigravity-cli');
}

/** Parse an agy transcript sample into goal / state / currentTask / model. */
export function parseAntigravityTranscript(raw: string): AntigravityTranscriptSummary {
  const records: AgyRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line.trim());
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value as AgyRecord);
    } catch { /* skip malformed line */ }
  }

  let goal: string | undefined;
  let model: string | undefined;
  let currentTask: string | undefined;
  // Track the newest step to read its live status. agy appends a `RUNNING`
  // record when a step starts and a `DONE` record when it finishes, so the
  // transcript accumulates historical `RUNNING` entries that are never
  // rewritten. A session is processing ONLY while its newest step is still
  // RUNNING — scanning every record for RUNNING would freeze a finished
  // session into "processing" forever (verified: real transcripts carry
  // dozens of stray RUNNING records after the last DONE step).
  let latestStep: AgyRecord | undefined;

  for (const rec of records) {
    if (rec.type === 'USER_INPUT' && typeof rec.content === 'string') {
      if (!goal) {
        const req = rec.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
        if (req && req[1].trim()) goal = cleanGoal(req[1]);
      }
      // "The user changed setting `Model Selection` from None to GPT-OSS 120B (Medium)."
      // Take the latest one seen → the model active for this conversation.
      const change = rec.content.match(/Model Selection`?\s+from\s+.*?\s+to\s+(.+?)\.(?:\s|$)/);
      if (change && change[1].trim()) model = change[1].trim();
    }
    if (rec.type && TOOL_TYPES.has(rec.type)) {
      const tools = Array.isArray(rec.tool_calls) && rec.tool_calls.every(item => item && typeof item === 'object' && !Array.isArray(item)) ? rec.tool_calls : undefined;
      const name = tools?.[0]?.name;
      currentTask = typeof name === 'string' && name.length > 0 ? name : rec.type.toLowerCase();
    }
    // Records arrive in file order (newest last within the tail), so prefer a
    // higher step_index and otherwise advance on every record so records
    // without step_index still resolve to the newest by position.
    if (
      latestStep === undefined ||
      (rec.step_index ?? -1) >= (latestStep.step_index ?? -1)
    ) {
      latestStep = rec;
    }
  }

  const processing = latestStep?.status === 'RUNNING';
  return { goal, model, currentTask, state: !latestStep ? 'unknown' : processing ? 'processing' : 'idle' };
}

function cleanGoal(s: string): string {
  return Array.from(s.replace(/\s+/g, ' ').trim()).slice(0, ANTIGRAVITY_POLICY.labelCodePoints).join('');
}

/** Global default model from settings.json (fallback when a conversation never
 *  recorded an explicit model selection). */
export function antigravityDefaultModel(): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(antigravityRoot(), 'settings.json'), 'utf8')) as { model?: string };
    return typeof j.model === 'string' ? j.model : undefined;
  } catch { return undefined; }
}

/** Resolve the conversationId for a workspace cwd via the last-opened cache. */
export function antigravityConversationId(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    const j = JSON.parse(
      readFileSync(join(antigravityRoot(), 'cache', 'last_conversations.json'), 'utf8'),
    ) as Record<string, string>;
    return typeof j[cwd] === 'string' ? j[cwd] : undefined;
  } catch { return undefined; }
}

export function antigravityTranscriptPath(conversationId: string): string {
  return join(antigravityRoot(), 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}
