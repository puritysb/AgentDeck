import { open, readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { stripUnsafeText } from '@agentdeck/shared';
import { redactSecrets } from './utils/redact-secrets.js';

const MAX_SESSION_FILES = 200;
const MAX_TRANSCRIPT_SAMPLE_BYTES = 1024 * 1024;
const KIRO_PENDING_TURN_MAX_AGE_MS = 10 * 60 * 1000;
const require = createRequire(import.meta.url);

export interface KiroSqliteRow {
  cwd: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  modelName?: string;
  goal?: string;
  response?: string;
  historyCount: number;
  hasAssistant: number;
}

interface ReadonlySqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  pragma(source: string): unknown;
  close(): void;
}

type ReadonlySqliteConstructor = new (
  path: string,
  options: { readonly: boolean; fileMustExist: boolean },
) => ReadonlySqliteDb;

export interface KiroNativeSessionRead {
  snapshots: KiroSessionSnapshot[];
  jsonlDirectoryPresent: boolean;
  v3DirectoryPresent: boolean;
  sqliteDatabasePresent: boolean;
  sqliteReadable: boolean;
  promptHistoryMtimeMs?: number;
}

export interface KiroSessionMetadata {
  sessionId?: string;
  cwd?: string;
  title?: string;
  modelName?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface KiroTranscriptSummary {
  state: 'idle' | 'processing';
  goal?: string;
  currentTask?: string;
  response?: string;
}

export interface KiroSessionSnapshot extends KiroSessionMetadata, KiroTranscriptSummary {
  sessionId: string;
  transcriptPath: string;
  lastActivityAt: number;
  recordKinds: string[];
}

interface KiroSessionCacheEntry {
  transcriptMtimeMs: number;
  transcriptSize: number;
  metadataMtimeMs: number;
  metadataSize: number;
  snapshot: KiroSessionSnapshot;
}

/** Reuses parsed snapshots across the passive observer's five-second polls. */
export class KiroSessionCache {
  private entries = new Map<string, KiroSessionCacheEntry>();

  get(path: string, signature: Omit<KiroSessionCacheEntry, 'snapshot'>): KiroSessionSnapshot | undefined {
    const entry = this.entries.get(path);
    return entry &&
      entry.transcriptMtimeMs === signature.transcriptMtimeMs &&
      entry.transcriptSize === signature.transcriptSize &&
      entry.metadataMtimeMs === signature.metadataMtimeMs &&
      entry.metadataSize === signature.metadataSize
      ? entry.snapshot
      : undefined;
  }

  set(path: string, entry: KiroSessionCacheEntry): void {
    this.entries.set(path, entry);
  }

  retain(paths: ReadonlySet<string>): void {
    for (const path of this.entries.keys()) {
      if (!paths.has(path)) this.entries.delete(path);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Kiro's relocatable config root. `KIRO_HOME` names the root itself. */
export function kiroConfigRoot(): string {
  const configured = process.env.KIRO_HOME?.trim();
  return configured || join(homedir(), '.kiro');
}

export function kiroSessionsDir(): string {
  return join(kiroConfigRoot(), 'sessions', 'cli');
}

export function kiroV3SessionsRoot(): string {
  return join(kiroConfigRoot(), 'sessions');
}

/** Measured Kiro CLI 2.18.1 v2 desktop store. */
export function kiroDataDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim()
      || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'kiro-cli', 'data.sqlite3');
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'kiro-cli', 'data.sqlite3');
}

export function kiroPromptHistoryPath(): string {
  return join(kiroConfigRoot(), '.cli_bash_history');
}

/**
 * Read the stable subset of Kiro's sibling `<session>.json` metadata. Kiro 2.x
 * stores the model under `session_state.rts_model_state.model_info.model_id`;
 * the flatter alternatives keep this reader useful for the incompatible 3.x
 * session format without pretending the undocumented remainder is stable.
 */
export function parseKiroSessionMetadata(raw: string, fallbackSessionId?: string): KiroSessionMetadata {
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { sessionId: fallbackSessionId };
    root = parsed;
  } catch {
    return { sessionId: fallbackSessionId };
  }

  const sessionState = objectAt(root, 'session_state');
  const rtsState = sessionState ? objectAt(sessionState, 'rts_model_state') : null;
  const modelInfo = rtsState ? objectAt(rtsState, 'model_info') : null;
  const sessionId = firstString(root, ['session_id', 'sessionId', 'id']) ?? fallbackSessionId;
  const cwd = firstString(root, ['cwd', 'working_directory', 'workspace_root']);
  const title = firstString(root, ['title', 'name', 'summary']);
  const workspacePaths = arrayAt(root, 'workspacePaths') ?? arrayAt(root, 'rootPaths') ?? [];
  const workspacePath = workspacePaths.find((value): value is string => typeof value === 'string' && Boolean(value));
  const modelName =
    (modelInfo ? firstString(modelInfo, ['model_id', 'modelId', 'name']) : undefined) ??
    firstString(root, ['model', 'model_id', 'modelId']);

  return {
    ...(sessionId ? { sessionId: sessionId.slice(0, 256) } : {}),
    ...((cwd ?? workspacePath) ? { cwd: (cwd ?? workspacePath)!.slice(0, 4096) } : {}),
    ...(title ? { title: title.trim().slice(0, 160) } : {}),
    ...(modelName ? { modelName: modelName.slice(0, 160) } : {}),
    ...(timestampMs(firstString(root, ['created_at', 'createdAt', 'started_at'])) !== undefined
      ? { createdAt: timestampMs(firstString(root, ['created_at', 'createdAt', 'started_at'])) }
      : {}),
    ...(timestampMs(firstString(root, ['updated_at', 'updatedAt', 'last_activity_at', 'lastModifiedAt'])) !== undefined
      ? { updatedAt: timestampMs(firstString(root, ['updated_at', 'updatedAt', 'last_activity_at', 'lastModifiedAt'])) }
      : {}),
  };
}

/**
 * Summarize measured Kiro 2.x records, v3 `payload.type` envelopes, and ACP
 * notifications. Unknown records are ignored: a Kiro
 * upgrade may reduce detail, but must never make daemon observation fail.
 */
export function parseKiroTranscript(raw: string): KiroTranscriptSummary {
  let turnOpen = false;
  let goal: string | undefined;
  let currentTask: string | undefined;
  let response: string | undefined;

  const notePrompt = (text: string) => {
    const cleaned = cleanKiroGoal(text);
    if (!goal && cleaned) goal = cleaned;
    turnOpen = true;
    currentTask = undefined;
  };
  const noteAssistant = (text: string) => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned) response = cleaned.slice(-1000);
  };

  for (const value of parseJsonl(raw)) {
    const envelope = objectAt(value, 'payload') ?? value;
    const kind = firstString(envelope, ['kind', 'type']);
    const data = objectAt(envelope, 'data') ?? envelope;

    if (kind === 'user') {
      notePrompt(contentText(data));
      continue;
    }
    if (kind === 'turn_start') {
      turnOpen = true;
      continue;
    }
    if (kind === 'assistant') {
      // Kiro writes one `assistant` record per operation, and the LAST one in a
      // v3 turn is routinely `operationType: "Reasoning"` — a chain-of-thought
      // block whose content Kiro has already redacted to a literal "...". Since
      // the newest assistant record wins, taking it unconditionally captured
      // that placeholder as the reply for every v3 session (measured against 6
      // real transcripts: all six came out with response === "...", discarding
      // the `operationType: "Say"` record that held the actual answer).
      //
      // Excluded by operation name, not by matching the "..." text: that string
      // is a display artifact free to change, while the operation is the
      // structural fact. Reasoning content must stay out of the timeline and
      // APME on its own merits anyway.
      if (firstString(envelope, ['operationType']) !== 'Reasoning') {
        noteAssistant(contentText(data));
      }
      turnOpen = true;
      continue;
    }

    if (kind === 'Prompt') {
      notePrompt(contentText(data));
      continue;
    }
    if (kind === 'AssistantMessage') {
      const blocks = arrayAt(data, 'content') ?? [];
      let hasToolUse = false;
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        const blockKind = firstString(block, ['kind', 'type']);
        if (blockKind === 'text') noteAssistant(valueText(block.data) ?? firstString(block, ['text']) ?? '');
        if (blockKind === 'toolUse' || blockKind === 'tool_use') {
          hasToolUse = true;
          currentTask = kiroToolTask(block);
        }
      }
      // A final text-only AssistantMessage closes a 2.x turn. Tool-use
      // messages remain open until a later assistant message completes it.
      turnOpen = hasToolUse;
      continue;
    }
    if (kind === 'ToolResults' || kind === 'ToolResult') {
      turnOpen = true;
      continue;
    }
    if (kind === 'TurnEnd' || kind === 'turn_end') {
      turnOpen = false;
      currentTask = undefined;
      continue;
    }

    const method = firstString(value, ['method']);
    const params = objectAt(value, 'params');
    if (method === 'session/prompt' && params) {
      notePrompt(contentText(params));
      continue;
    }
    if (method !== 'session/notification' || !params) continue;

    const update = objectAt(params, 'update') ?? params;
    const updateType = normalizeUpdateType(
      firstString(update, ['sessionUpdate', 'session_update', 'type', 'kind']) ?? '',
    );
    if (updateType === 'agentmessagechunk') {
      noteAssistant(contentText(update));
      turnOpen = true;
    } else if (updateType === 'toolcall') {
      turnOpen = true;
      currentTask = kiroToolTask(update);
    } else if (updateType === 'toolcallupdate') {
      turnOpen = true;
      currentTask = kiroToolTask(update) ?? currentTask;
    } else if (updateType === 'turnend') {
      turnOpen = false;
      currentTask = undefined;
    }
  }

  return {
    state: turnOpen ? 'processing' : 'idle',
    ...(goal ? { goal } : {}),
    ...(currentTask ? { currentTask } : {}),
    ...(response ? { response } : {}),
  };
}

/**
 * Return schema markers only. Safe for diagnostics: values, prompt text,
 * tool input, response text, and message ids never leave this function.
 */
export function kiroTranscriptRecordKinds(raw: string): string[] {
  const kinds = new Set<string>();
  for (const value of parseJsonl(raw)) {
    const envelope = objectAt(value, 'payload') ?? value;
    const kind = firstString(envelope, ['kind', 'type']);
    if (kind) kinds.add(safeKiroRecordKind(kind));
    const method = firstString(value, ['method']);
    if (method) kinds.add(safeKiroMethod(method));
    if (method === 'session/notification') {
      const params = objectAt(value, 'params');
      const update = params ? (objectAt(params, 'update') ?? params) : null;
      const updateType = update ? firstString(update, ['sessionUpdate', 'session_update', 'type', 'kind']) : undefined;
      if (updateType) kinds.add(`session/notification:${safeKiroUpdateType(updateType)}`);
    }
  }
  return [...kinds].sort();
}

function safeKiroRecordKind(value: string): string {
  return [
    'Prompt', 'AssistantMessage', 'ToolResults', 'ToolResult', 'TurnEnd',
    'user', 'assistant', 'turn_start', 'turn_end', 'session_start',
    'session_event', 'session_metadata', 'usage_summary', 'ContextualHookInvoked',
  ].includes(value)
    ? value
    : 'other';
}

function safeKiroMethod(value: string): string {
  return ['session/prompt', 'session/notification'].includes(value) ? value : 'other';
}

function safeKiroUpdateType(value: string): string {
  const normalized = normalizeUpdateType(value);
  const known: Record<string, string> = {
    agentmessagechunk: 'AgentMessageChunk',
    toolcall: 'ToolCall',
    toolcallupdate: 'ToolCallUpdate',
    turnend: 'TurnEnd',
  };
  return known[normalized] ?? 'other';
}

function cleanKiroGoal(raw: string): string {
  const value = stripUnsafeText(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^\/[a-z][\w-]*\s*$/i.test(value) ? '' : value.slice(0, 120);
}

/** Read the newest bounded set of Kiro CLI session pairs. */
export async function readKiroSessionSnapshots(
  sessionsDir = kiroSessionsDir(),
  maxSessions = MAX_SESSION_FILES,
  cache?: KiroSessionCache,
): Promise<KiroSessionSnapshot[]> {
  let names: string[];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .slice(0, 2000);
  } catch {
    return [];
  }

  const files: Array<{ name: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    try {
      const info = await stat(join(sessionsDir, name));
      if (info.isFile()) files.push({ name, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      /* file disappeared during the scan */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const snapshots: KiroSessionSnapshot[] = [];
  const retainedPaths = new Set<string>();
  for (const file of files.slice(0, Math.max(0, maxSessions))) {
    const sessionId = basename(file.name, '.jsonl');
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) continue;
    const transcriptPath = join(sessionsDir, file.name);
    const metadataPath = join(sessionsDir, `${sessionId}.json`);
    const metadataInfo = await stat(metadataPath).catch(() => undefined);
    const signature = {
      transcriptMtimeMs: file.mtimeMs,
      transcriptSize: file.size,
      metadataMtimeMs: metadataInfo?.mtimeMs ?? 0,
      metadataSize: metadataInfo?.size ?? 0,
    };
    retainedPaths.add(transcriptPath);
    const cached = cache?.get(transcriptPath, signature);
    if (cached) {
      snapshots.push(cached);
      continue;
    }
    const [metadataRaw, transcriptRaw] = await Promise.all([
      readFile(metadataPath, 'utf8').catch(() => ''),
      readHeadAndTail(transcriptPath, 64 * 1024, MAX_TRANSCRIPT_SAMPLE_BYTES).catch(() => ''),
    ]);
    const metadata = parseKiroSessionMetadata(metadataRaw, sessionId);
    const summary = parseKiroTranscript(transcriptRaw);
    const snapshot: KiroSessionSnapshot = {
      ...metadata,
      ...summary,
      sessionId,
      transcriptPath,
      lastActivityAt: metadata.updatedAt ?? file.mtimeMs,
      goal: summary.goal ?? metadata.title,
      recordKinds: kiroTranscriptRecordKinds(transcriptRaw),
    };
    snapshots.push(snapshot);
    cache?.set(transcriptPath, { ...signature, snapshot });
  }
  cache?.retain(retainedPaths);
  return snapshots;
}

/** Read Kiro CLI 3.0's measured `<workspace>/<session>/messages.jsonl` store. */
export async function readKiroV3SessionSnapshots(
  sessionsRoot = kiroV3SessionsRoot(),
  maxSessions = MAX_SESSION_FILES,
  cache?: KiroSessionCache,
): Promise<KiroSessionSnapshot[]> {
  const candidates: Array<{
    sessionId: string;
    transcriptPath: string;
    metadataPath: string;
    transcriptMtimeMs: number;
    transcriptSize: number;
    metadataMtimeMs: number;
    metadataSize: number;
  }> = [];
  try {
    const workspaces = await readdir(sessionsRoot, { withFileTypes: true });
    for (const workspace of workspaces.slice(0, 2000)) {
      if (!workspace.isDirectory() || workspace.isSymbolicLink() || workspace.name === 'cli') continue;
      const workspacePath = join(sessionsRoot, workspace.name);
      const sessions = await readdir(workspacePath, { withFileTypes: true }).catch(() => []);
      for (const session of sessions.slice(0, 2000)) {
        if (!session.isDirectory() || session.isSymbolicLink() || !/^[A-Za-z0-9_-]{1,256}$/.test(session.name)) continue;
        const transcriptPath = join(workspacePath, session.name, 'messages.jsonl');
        const metadataPath = join(workspacePath, session.name, 'session.json');
        const [transcriptInfo, metadataInfo] = await Promise.all([
          stat(transcriptPath).catch(() => undefined),
          stat(metadataPath).catch(() => undefined),
        ]);
        if (!transcriptInfo?.isFile() || !metadataInfo?.isFile()) continue;
        candidates.push({
          sessionId: session.name,
          transcriptPath,
          metadataPath,
          transcriptMtimeMs: transcriptInfo.mtimeMs,
          transcriptSize: transcriptInfo.size,
          metadataMtimeMs: metadataInfo.mtimeMs,
          metadataSize: metadataInfo.size,
        });
      }
    }
  } catch {
    return [];
  }
  candidates.sort((a, b) => Math.max(b.transcriptMtimeMs, b.metadataMtimeMs)
    - Math.max(a.transcriptMtimeMs, a.metadataMtimeMs));

  const snapshots: KiroSessionSnapshot[] = [];
  const retainedPaths = new Set<string>();
  for (const candidate of candidates.slice(0, Math.max(0, maxSessions))) {
    const signature = {
      transcriptMtimeMs: candidate.transcriptMtimeMs,
      transcriptSize: candidate.transcriptSize,
      metadataMtimeMs: candidate.metadataMtimeMs,
      metadataSize: candidate.metadataSize,
    };
    retainedPaths.add(candidate.transcriptPath);
    const cached = cache?.get(candidate.transcriptPath, signature);
    if (cached) {
      snapshots.push(cached);
      continue;
    }
    const [metadataRaw, transcriptRaw] = await Promise.all([
      readFile(candidate.metadataPath, 'utf8').catch(() => ''),
      readHeadAndTail(candidate.transcriptPath, 64 * 1024, MAX_TRANSCRIPT_SAMPLE_BYTES).catch(() => ''),
    ]);
    const metadata = parseKiroSessionMetadata(metadataRaw, candidate.sessionId);
    const summary = parseKiroTranscript(transcriptRaw);
    const snapshot: KiroSessionSnapshot = {
      ...metadata,
      ...summary,
      sessionId: metadata.sessionId ?? candidate.sessionId,
      transcriptPath: candidate.transcriptPath,
      lastActivityAt: metadata.updatedAt
        ?? Math.max(candidate.transcriptMtimeMs, candidate.metadataMtimeMs),
      goal: summary.goal ?? metadata.title,
      recordKinds: kiroTranscriptRecordKinds(transcriptRaw),
    };
    snapshots.push(snapshot);
    cache?.set(candidate.transcriptPath, { ...signature, snapshot });
  }
  cache?.retain(retainedPaths);
  return snapshots;
}

/**
 * Read every currently-known native Kiro store without changing how Kiro is
 * launched. Kiro CLI 2.18.1 on macOS persists `conversations_v2` in its app
 * SQLite database; v3 writes nested `session.json` + `messages.jsonl` pairs.
 * Legacy flat JSONL remains a fallback. Sources are merged by session id.
 */
export async function readKiroNativeSessionSnapshots(
  maxSessions = MAX_SESSION_FILES,
  cache?: KiroSessionCache,
): Promise<KiroNativeSessionRead> {
  const jsonlDir = kiroSessionsDir();
  const v3Root = kiroV3SessionsRoot();
  const dbPath = kiroDataDbPath();
  const [jsonlInfo, v3Info, dbInfo, promptHistoryInfo] = await Promise.all([
    stat(jsonlDir).catch(() => undefined),
    stat(v3Root).catch(() => undefined),
    stat(dbPath).catch(() => undefined),
    stat(kiroPromptHistoryPath()).catch(() => undefined),
  ]);
  const jsonlDirectoryPresent = Boolean(jsonlInfo?.isDirectory());
  const v3DirectoryPresent = Boolean(v3Info?.isDirectory());
  const sqliteDatabasePresent = Boolean(dbInfo?.isFile());
  const jsonl = jsonlDirectoryPresent
    ? await readKiroSessionSnapshots(jsonlDir, maxSessions, v3DirectoryPresent ? undefined : cache)
    : [];
  const v3 = v3DirectoryPresent
    ? await readKiroV3SessionSnapshots(v3Root, maxSessions, cache)
    : [];
  const sqlite = sqliteDatabasePresent
    ? readKiroSqliteSessionSnapshots(dbPath, maxSessions)
    : { snapshots: [], readable: false };

  const byId = new Map<string, KiroSessionSnapshot>();
  const promptHistoryMtimeMs = promptHistoryInfo?.isFile()
    ? promptHistoryInfo.mtimeMs
    : undefined;
  const sqliteSnapshots = applyKiroPendingTurnMarker(sqlite.snapshots, promptHistoryMtimeMs);
  for (const snapshot of [...jsonl, ...sqliteSnapshots, ...v3]) {
    const previous = byId.get(snapshot.sessionId);
    if (!previous || snapshot.lastActivityAt >= previous.lastActivityAt) {
      byId.set(snapshot.sessionId, snapshot);
    }
  }
  let snapshots = [...byId.values()]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, Math.max(0, maxSessions));
  return {
    snapshots,
    jsonlDirectoryPresent,
    v3DirectoryPresent,
    sqliteDatabasePresent,
    sqliteReadable: sqlite.readable,
    ...(promptHistoryMtimeMs !== undefined ? { promptHistoryMtimeMs } : {}),
  };
}

/**
 * Kiro appends the submitted prompt to `.cli_bash_history` immediately, but
 * only commits `conversations_v2` after the response completes. A newer prompt
 * history mtime therefore brackets the current turn without reading its text.
 * The marker is global, so only the newest persisted conversation is promoted;
 * simultaneous Kiro chats remain an explicitly ambiguous best effort.
 */
export function applyKiroPendingTurnMarker(
  snapshots: KiroSessionSnapshot[],
  promptHistoryMtimeMs: number | undefined,
  now = Date.now(),
): KiroSessionSnapshot[] {
  if (
    snapshots.length === 0
    || promptHistoryMtimeMs === undefined
    || promptHistoryMtimeMs <= snapshots[0].lastActivityAt
    || now - promptHistoryMtimeMs > KIRO_PENDING_TURN_MAX_AGE_MS
  ) {
    return snapshots;
  }
  return snapshots.map((snapshot, index) => index === 0
    ? { ...snapshot, state: 'processing', lastActivityAt: promptHistoryMtimeMs }
    : snapshot);
}

function readKiroSqliteSessionSnapshots(
  dbPath: string,
  maxSessions: number,
): { snapshots: KiroSessionSnapshot[]; readable: boolean } {
  let db: ReadonlySqliteDb | undefined;
  try {
    const Ctor = require('better-sqlite3') as ReadonlySqliteConstructor;
    db = new Ctor(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const rows = db.prepare(`
      SELECT
        key AS cwd,
        conversation_id AS sessionId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        json_extract(value, '$.model_info.model_id') AS modelName,
        json_extract(value, '$.history[0].user.content.Prompt.prompt') AS goal,
        json_extract(value, '$.history[#-1].assistant.Response.content') AS response,
        json_array_length(json_extract(value, '$.history')) AS historyCount,
        CASE WHEN json_type(value, '$.history[#-1].assistant') = 'object' THEN 1 ELSE 0 END AS hasAssistant
      FROM conversations_v2
      WHERE json_valid(value)
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(Math.max(0, maxSessions)) as KiroSqliteRow[];
    return { snapshots: parseKiroSqliteRows(rows, dbPath), readable: true };
  } catch {
    return { snapshots: [], readable: false };
  } finally {
    try { db?.close(); } catch { /* best effort read-only handle */ }
  }
}

/** Convert only the allowlisted conversation columns selected above. */
export function parseKiroSqliteRows(rows: readonly KiroSqliteRow[], dbPath: string): KiroSessionSnapshot[] {
  const snapshots: KiroSessionSnapshot[] = [];
  for (const row of rows) {
    if (
      typeof row.sessionId !== 'string'
      || !/^[A-Za-z0-9_-]{1,256}$/.test(row.sessionId)
      || typeof row.cwd !== 'string'
      || typeof row.createdAt !== 'number'
      || typeof row.updatedAt !== 'number'
    ) continue;
    const goal = typeof row.goal === 'string' ? cleanKiroGoal(row.goal) : '';
    const response = typeof row.response === 'string'
      ? stripUnsafeText(row.response).replace(/\s+/g, ' ').trim().slice(-1000)
      : '';
    snapshots.push({
      sessionId: row.sessionId,
      transcriptPath: dbPath,
      cwd: row.cwd.slice(0, 4096),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastActivityAt: row.updatedAt,
      ...(typeof row.modelName === 'string' ? { modelName: row.modelName.slice(0, 160) } : {}),
      state: 'idle',
      ...(goal ? { goal } : {}),
      ...(response ? { response } : {}),
      recordKinds: [
        'ConversationV2',
        ...(row.historyCount > 0 ? ['Prompt'] : []),
        ...(row.hasAssistant ? ['AssistantMessage'] : []),
      ],
    });
  }
  return snapshots;
}

async function readHeadAndTail(path: string, headBytes: number, tailBytes: number): Promise<string> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size <= headBytes + tailBytes) {
      const buffer = Buffer.alloc(size);
      await file.read(buffer, 0, size, 0);
      return buffer.toString('utf8');
    }
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    await file.read(head, 0, headBytes, 0);
    await file.read(tail, 0, tailBytes, size - tailBytes);
    const tailText = tail.toString('utf8');
    const firstNewline = tailText.indexOf('\n');
    return `${head.toString('utf8')}\n${firstNewline >= 0 ? tailText.slice(firstNewline + 1) : ''}`;
  } finally {
    await file.close();
  }
}

function kiroToolTask(record: Record<string, unknown>): string | undefined {
  const raw = isRecord(record.data) ? record.data : record;
  const name = firstString(raw, ['name', 'tool_name', 'toolName', 'title']) ?? 'tool';
  const input = objectAt(raw, 'input') ?? objectAt(raw, 'tool_input') ?? objectAt(raw, 'rawInput');
  if (!input) return name;
  for (const key of ['path', 'file_path', 'command', 'cmd', 'query', 'url']) {
    const value = valueText(input[key]);
    if (value) return `${name} ${redactSecrets(value).replace(/\s+/g, ' ').slice(0, 80)}`;
  }
  return name;
}

function contentText(record: Record<string, unknown>): string {
  const direct = firstString(record, ['text', 'message', 'prompt']);
  if (direct) return direct;
  const content = record.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!isRecord(block)) return '';
      const kind = firstString(block, ['kind', 'type']);
      return kind === 'text' ? (valueText(block.data) ?? firstString(block, ['text']) ?? '') : '';
    })
    .filter(Boolean)
    .join(' ');
}

function parseJsonl(raw: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 10 * 1024 * 1024) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) values.push(parsed);
    } catch {
      /* partial tail line */
    }
  }
  return values;
}

function normalizeUpdateType(value: string): string {
  return value.replace(/[^a-z]/gi, '').toLowerCase();
}

function timestampMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function valueText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] | null {
  const value = record[key];
  return Array.isArray(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
