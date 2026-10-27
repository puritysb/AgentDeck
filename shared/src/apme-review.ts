/** Task review storage and bounded evidence selection. Swift is generated. */
export const APME_EVIDENCE_STRATEGY = 'first-latest-validation-v1';
export const APME_TURN_EVIDENCE_CAP = 10;
export const APME_EVENT_EVIDENCE_CAP = 30;
export const APME_PROMPT_TEXT_CAP = 1500;
export const APME_RESPONSE_TEXT_CAP = 2500;
export const APME_TOOL_OUTPUT_CAP = 600;
export const APME_EVIDENCE_CLIP_MARKER = ' … [middle omitted] … ';
export const APME_FEEDBACK_NOTE_BYTES = 4096;
export const APME_FEEDBACK_VERDICTS = ['completed', 'partial', 'incorrect', 'clear'] as const;
export const APME_VALIDATION_PATTERN = '(^|[^a-z0-9_])(test|tests|pytest|vitest|xcodebuild|gradle|build|lint|typecheck|verify|passed|failed)([^a-z0-9_]|$)';
export const APME_REVIEW_SQL = `
CREATE TABLE IF NOT EXISTS task_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK(verdict IN ('completed','partial','incorrect','clear')),
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_feedback_latest ON task_feedback(task_id,id DESC);
CREATE TABLE IF NOT EXISTS task_judge_attempts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at INTEGER NOT NULL
);
`;

/** Keep original intent and final result, then recent validation, then context.
 * Returns chronological indices; never pretends omitted evidence was examined. */
export function apmeEvidenceIndices(count: number, cap: number, preferred: number[] = []): number[] {
  if (cap <= 0 || count <= 0) return [];
  const picked = new Set<number>();
  const add = (i: number) => { if (picked.size < cap && i >= 0 && i < count) picked.add(i); };
  add(0); add(count - 1);
  for (const i of [...preferred].reverse()) add(i);
  for (let i = count - 2; i >= 1; i--) add(i);
  return [...picked].sort((a, b) => a - b);
}

export function isApmeValidationEvent(event: { kind: string; [key: string]: unknown }): boolean {
  if (event.kind !== 'tool') return false;
  if (event.status === 'error' || event.error) return true;
  try { return new RegExp(APME_VALIDATION_PATTERN, 'i').test(JSON.stringify(event)); } catch { return false; }
}

/** Code-point bounds agree with Swift's Unicode scalars, including emoji. */
export function clipApmeEvidenceText(text: string, cap: number): string {
  const points = Array.from(text), marker = Array.from(APME_EVIDENCE_CLIP_MARKER);
  if (points.length <= cap) return text;
  if (cap <= marker.length) return points.slice(0, Math.max(0, cap)).join('');
  const head = Math.floor((cap - marker.length) / 2), tail = cap - marker.length - head;
  return points.slice(0, head).join('') + APME_EVIDENCE_CLIP_MARKER + points.slice(-tail).join('');
}

export function apmeTurnEvidenceIndices(turns: Array<{ response?: unknown }>, cap = APME_TURN_EVIDENCE_CAP): number[] {
  const answered = turns.flatMap((turn, i) => typeof turn.response === 'string' && turn.response.length ? [i] : []);
  return apmeEvidenceIndices(turns.length, cap, answered.slice(-1));
}
