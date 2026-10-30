import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ANTIGRAVITY_POLICY as P } from './antigravity-policy.generated.js';
import { parseAntigravityTranscript } from './apme/antigravity-transcript.js';

export interface AntigravityTurnIdentity { id: string; stepIndex: number; startedAtMs: number }
export interface AntigravityObservation {
  conversationId: string;
  status: 'known' | 'unknown' | 'stale';
  reason: string;
  state?: 'idle' | 'processing';
  goal?: string;
  model?: string;
  currentTask?: string;
  currentTurnId?: string;
  startedAtMs?: number;
  updatedAtMs?: number;
  modifiedAtMs?: number;
  turns: AntigravityTurnIdentity[];
}
export interface AntigravityScan {
  status: 'known' | 'unknown';
  reason: string;
  observations: AntigravityObservation[];
}
const safeID = new RegExp(P.conversationPattern);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function time(v: unknown): number | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)) return;
  const n = Date.parse(v);
  if (!Number.isSafeInteger(n) || n <= 0) return;
  const canonical = v.includes('.') ? v.replace(/\.(\d+)Z$/, (_, digits: string) => '.' + digits.padEnd(3, '0') + 'Z') : v.replace('Z', '.000Z');
  return new Date(n).toISOString() === canonical ? n : undefined;
}
export function observeAntigravityTranscript(conversationId: string, raw: string, modifiedAtMs: number, nowMs: number): AntigravityObservation {
  const base: AntigravityObservation = { conversationId, status: 'unknown', reason: 'unreadable_records', turns: [], modifiedAtMs };
  if (!safeID.test(conversationId)) return { ...base, reason: 'invalid_identity' };
  if (![modifiedAtMs, nowMs].every(n => Number.isSafeInteger(n) && n > 0) || modifiedAtMs > nowMs + P.futureSkewMs) return { ...base, reason: 'invalid_time' };
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  const records: Record<string, unknown>[] = [];
  let malformedTail = false;
  let gapAt = -1;
  let tailRaw = raw;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === P.gapMarker) { gapAt = records.length; tailRaw = lines.slice(i + 1).join('\n'); continue; }
    try {
      const value: unknown = JSON.parse(lines[i]);
      if (object(value)) records.push(value);
      else if (i === lines.length - 1) malformedTail = true;
    } catch { if (i === lines.length - 1) malformedTail = true; }
  }
  if (malformedTail) return { ...base, reason: 'incomplete_tail' };
  const last = records.at(-1);
  if (!last || !Number.isSafeInteger(last.step_index) || (last.step_index as number) < 0) return base;
  const byStep = new Map<number, Record<string, unknown>>();
  for (const record of records) {
    if (Number.isSafeInteger(record.step_index) && (record.step_index as number) >= 0) byStep.set(record.step_index as number, record);
  }
  const ordered = [...byStep.entries()].sort(([a], [b]) => a - b);
  const latest = ordered.at(-1)?.[1];
  const updatedAtMs = time(latest?.created_at);
  if (!latest || !updatedAtMs || updatedAtMs > nowMs + P.futureSkewMs) return { ...base, reason: 'invalid_time' };
  const turns = ordered.flatMap(([index, record]) => {
    const startedAtMs = time(record.created_at);
    return record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT' && startedAtMs && startedAtMs <= nowMs + P.futureSkewMs
      ? [{ id: `${conversationId}:step:${index}:${startedAtMs}`, stepIndex: index, startedAtMs }] : [];
  });
  if (!turns.length) return { ...base, reason: 'missing_turn_identity' };
  const lastUser = ordered.filter(([, rec]) => rec.type === 'USER_INPUT').at(-1)?.[1];
  if (!lastUser || lastUser.source !== 'USER_EXPLICIT' || !time(lastUser.created_at)) return { ...base, reason: 'missing_turn_identity' };
  if (turns.at(-1)!.startedAtMs > updatedAtMs) return { ...base, reason: 'inconsistent_time' };
  if (gapAt >= 0 && !records.slice(gapAt).some(rec => rec.type === 'USER_INPUT' && rec.source === 'USER_EXPLICIT' && time(rec.created_at))) return { ...base, reason: 'missing_turn_identity' };
  const details = { turns: turns.slice(-P.maxTurns), currentTurnId: turns.at(-1)!.id, startedAtMs: turns[0].startedAtMs, updatedAtMs };
  if (nowMs - modifiedAtMs > P.rosterWindowMs || nowMs - updatedAtMs > P.rosterWindowMs) return { ...base, ...details, status: 'stale', reason: 'history' };
  if (latest.status !== 'RUNNING' && latest.status !== 'DONE') return { ...base, ...details, reason: 'unknown_step_status' };
  if (latest.status === 'RUNNING' && (nowMs - updatedAtMs > P.activeWindowMs || nowMs - modifiedAtMs > P.activeWindowMs)) return { ...base, ...details, status: 'stale', reason: 'unconfirmed_work' };
  const summary = parseAntigravityTranscript(lines.join('\n'));
  const tail = gapAt < 0 ? summary : parseAntigravityTranscript(tailRaw);
  if (tail.model) tail.model = Array.from(tail.model).slice(0, P.labelCodePoints).join('');
  if (tail.currentTask) tail.currentTask = Array.from(tail.currentTask).slice(0, P.labelCodePoints).join('');
  return { ...base, ...details, status: 'known', reason: 'step_evidence', state: latest.status === 'RUNNING' ? 'processing' : 'idle',
    ...(summary.goal ? { goal: summary.goal } : {}), ...(tail.model ? { model: tail.model } : {}), ...(tail.currentTask ? { currentTask: tail.currentTask } : {}) };
}

function inside(root: string, components: string[], directory: boolean): string {
  let path = root;
  const rootStat = lstatSync(path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe_source');
  for (let i = 0; i < components.length; i++) {
    path = join(path, components[i]);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (i < components.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('unsafe_source');
  }
  return path;
}
function bounded(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { if (!fstatSync(fd).isFile()) throw new Error('unsafe_source'); const data = Buffer.alloc(limit + 1); const n = readSync(fd, data, 0, data.length, 0); if (n > limit) throw new Error('oversize'); return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, n)); }
  finally { closeSync(fd); }
}
function transcript(path: string): { raw: string; modified: number } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('unsafe_source');
    const size = before.size;
    const max = P.headBytes + P.tailBytes;
    const read = (at: number, length: number) => { const bytes = Buffer.alloc(length); return bytes.subarray(0, readSync(fd, bytes, 0, length, at)); };
    let data: Buffer;
    if (size <= max) data = read(0, size);
    else {
      const head = read(0, P.headBytes); const tail = read(size - P.tailBytes, P.tailBytes);
      const end = head.lastIndexOf(10); const start = tail.indexOf(10);
      if (end < 0 || start < 0) throw new Error('oversize_record');
      data = Buffer.concat([head.subarray(0, end + 1), Buffer.from(P.gapMarker + '\n'), tail.subarray(start + 1)]);
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('changed_during_read');
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { raw, modified: Math.floor(after.mtimeMs) };
  } finally { closeSync(fd); }
}
export function scanAntigravityRoot(root: string, nowMs = Date.now()): AntigravityScan {
  const observations: AntigravityObservation[] = [];
  const started = performance.now();
  try {
    const brain = inside(root, ['brain'], true);
    // Do not turn an unreadable directory or an unvisited suffix into an empty source.
    const names = readdirSync(brain).sort();
    if (names.length > P.maxDirectories) return { status: 'unknown', reason: 'directory_limit', observations: [] };
    let fallbackModel: string | undefined;
    try {
      const settings: unknown = JSON.parse(bounded(inside(root, ['settings.json'], false), P.metadataBytes));
      if (object(settings) && typeof settings.model === 'string') fallbackModel = Array.from(settings.model).slice(0, P.labelCodePoints).join('');
    } catch { /* optional display metadata */ }
    for (const id of names) {
      if (performance.now() - started > P.scanBudgetMs) return { status: 'unknown', reason: 'scan_deadline', observations: [] };
      if (!safeID.test(id)) continue;
      try {
        const path = inside(root, ['brain', id, '.system_generated', 'logs', 'transcript.jsonl'], false);
        const modified = Math.floor(lstatSync(path).mtimeMs);
        if (nowMs - modified > P.rosterWindowMs) {
          observations.push({ conversationId: id, status: 'stale', reason: 'history', turns: [] });
          continue;
        }
        const sample = transcript(path);
        const observation = observeAntigravityTranscript(id, sample.raw, sample.modified, Math.floor(nowMs));
        if (observation.status === 'known' && !observation.model && fallbackModel !== undefined && !sample.raw.includes(P.gapMarker)) observation.model = fallbackModel;
        observations.push(observation);
      } catch {
        observations.push({ conversationId: id, status: 'unknown', reason: 'unreadable_source', turns: [] });
      }
    }
    observations.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0) || (a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0));
    return { status: 'known', reason: 'scanned', observations: observations.slice(0, P.maxSessions) };
  } catch { return { status: 'unknown', reason: 'unreadable_source', observations: [] }; }
}
// Display-only metadata, never follows workspace paths or reads OAuth credentials.
export function antigravityProjectNames(root: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(bounded(inside(root, ['cache', 'last_conversations.json'], false), P.metadataBytes));
    if (!object(value)) return {};
    const candidates = new Map<string, Set<string>>();
    for (const [path, id] of Object.entries(value)) {
      if (typeof id !== 'string' || !safeID.test(id)) continue;
      const leaf = path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
      if (!leaf || leaf === '.' || leaf === '..') continue;
      const names = candidates.get(id) ?? new Set<string>(); names.add(leaf); candidates.set(id, names);
    }
    return Object.fromEntries([...candidates].flatMap(([id, names]) => names.size === 1 ? [[id, [...names][0]]] : []));
  } catch { return {}; }
}

export function antigravityWorkspaceConversations(root: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(bounded(inside(root, ['cache', 'last_conversations.json'], false), P.metadataBytes));
    if (!object(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && safeID.test(entry[1])));
  } catch { return {}; }
}
