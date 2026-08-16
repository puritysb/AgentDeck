import { createHash, randomBytes } from 'node:crypto';
import { rawSessionId } from '@agentdeck/shared';
import {
  activeKiroCliProcesses,
  collectKiroSessionsFromSnapshots,
  collectProcessInfo,
  cwdForPids,
  isKiroCliProcessCommand,
  isKiroIdeProcessCommand,
  kiroResumeSessionId,
  resolveHostApp,
  type ProcInfo,
} from './passive-observer.js';
import { readKiroNativeSessionSnapshots, type KiroSessionSnapshot } from './kiro-session.js';

export type KiroDiagnosticFormat = 'v2' | 'v3' | 'acp' | 'mixed' | 'unknown';
export type KiroDiagnosticStore = 'sqlite-v2' | 'jsonl-v3' | 'jsonl-legacy' | 'mixed' | 'none';
export type KiroCorrelationConfidence =
  | 'exact-resume-id'
  | 'cwd-newest'
  | 'newest-fallback'
  | 'process-only'
  | 'ide-process-only';

export interface KiroDiagnosticReport {
  schemaVersion: 1;
  timestamp: string;
  platform: NodeJS.Platform;
  privacy: string[];
  config: {
    kiroHomeSource: 'KIRO_HOME' | 'default';
    sessionsPath: '$KIRO_HOME/sessions/cli';
    directoryPresent: boolean;
    v3SessionsPath: '$KIRO_HOME/sessions/<workspace>/<session>';
    v3DirectoryPresent: boolean;
    sqlitePath: '$KIRO_APP_DATA/data.sqlite3';
    sqliteDatabasePresent: boolean;
    sqliteReadable: boolean;
    primaryStore: KiroDiagnosticStore;
  };
  processes: {
    total: number;
    cli: number;
    ide: number;
    entries: Array<{
      pid: number;
      surface: 'cli' | 'ide';
      ttyAttached: boolean;
      cwdKnown: boolean;
      cwdKey?: string;
      hostedByKiro: boolean;
      v3Flag: boolean;
      resumeIdFlag: boolean;
    }>;
  };
  sessions: {
    totalRecords: number;
    inspected: number;
    entries: Array<{
      sessionKey: string;
      cwdKnown: boolean;
      cwdKey?: string;
      ageSeconds: number;
      format: KiroDiagnosticFormat;
      recordKinds: string[];
      hasModel: boolean;
      hasCreatedAt: boolean;
      hasUpdatedAt: boolean;
      state: 'idle' | 'processing';
    }>;
  };
  correlations: Array<{
    pid: number;
    surface: 'kiro-cli' | 'kiro-ide';
    matchedSession: boolean;
    sessionKey?: string;
    cwdKey?: string;
    confidence: KiroCorrelationConfidence;
    state: 'idle' | 'processing';
  }>;
  findings: string[];
}

interface KiroDiagnosticInput {
  processes: ProcInfo[];
  snapshots: KiroSessionSnapshot[];
  cwdByPid?: ReadonlyMap<number, string>;
  totalConversationRecords?: number;
  directoryPresent?: boolean;
  v3DirectoryPresent?: boolean;
  sqliteDatabasePresent?: boolean;
  sqliteReadable?: boolean;
  primaryStore?: KiroDiagnosticStore;
  now?: number;
  platform?: NodeJS.Platform;
  kiroHomeSource?: 'KIRO_HOME' | 'default';
  /** Report-scoped secret; never serialize it. Tests may inject a stable value. */
  salt?: string;
}

/**
 * Collect a shareable Kiro observation report without requiring the daemon.
 * Transcript bodies are parsed locally, but only schema markers and booleans
 * cross this boundary. Paths and session ids use a report-scoped salted key.
 */
export async function collectKiroDiagnosticReport(): Promise<KiroDiagnosticReport> {
  const processes = await collectProcessInfo();
  const kiroProcesses = processes.filter(
    (proc) => isKiroCliProcessCommand(proc.command) || isKiroIdeProcessCommand(proc.command),
  );
  const cwdByPid = await cwdForPids(kiroProcesses.map((proc) => proc.pid));
  const native = await readKiroNativeSessionSnapshots();
  const availableStores = [
    native.sqliteReadable ? 'sqlite-v2' : undefined,
    native.v3DirectoryPresent ? 'jsonl-v3' : undefined,
    native.jsonlDirectoryPresent ? 'jsonl-legacy' : undefined,
  ].filter((store): store is Exclude<KiroDiagnosticStore, 'mixed' | 'none'> => Boolean(store));
  const primaryStore: KiroDiagnosticStore = availableStores.length > 1
    ? 'mixed'
    : availableStores[0] ?? 'none';
  return buildKiroDiagnosticReport({
    processes,
    snapshots: native.snapshots,
    cwdByPid,
    totalConversationRecords: native.snapshots.length,
    directoryPresent: native.jsonlDirectoryPresent,
    v3DirectoryPresent: native.v3DirectoryPresent,
    sqliteDatabasePresent: native.sqliteDatabasePresent,
    sqliteReadable: native.sqliteReadable,
    primaryStore,
    kiroHomeSource: process.env.KIRO_HOME?.trim() ? 'KIRO_HOME' : 'default',
  });
}

/** Pure projection kept separate so privacy invariants can be regression-tested. */
export function buildKiroDiagnosticReport(input: KiroDiagnosticInput): KiroDiagnosticReport {
  const now = input.now ?? Date.now();
  const cwdByPid = input.cwdByPid ?? new Map<number, string>();
  const salt = input.salt ?? randomBytes(32).toString('hex');
  const opaqueKey = (kind: 'sid' | 'cwd', value: string) =>
    `${kind}-${createHash('sha256').update(salt).update('\0').update(value).digest('hex').slice(0, 12)}`;
  const byPid = new Map(input.processes.map((proc) => [proc.pid, proc]));
  const cli = activeKiroCliProcesses(input.processes);
  const ide = input.processes.filter((proc) => isKiroIdeProcessCommand(proc.command));
  const kiroProcesses = [...cli, ...ide.filter((proc) => !cli.some((item) => item.pid === proc.pid))];
  const observed = collectKiroSessionsFromSnapshots(input.processes, input.snapshots, cwdByPid, now);
  const observedByPid = new Map(observed.map((session) => [session.pid, session]));

  const processEntries = kiroProcesses.map((proc) => {
    const cwd = cwdByPid.get(proc.pid);
    const cliSurface = isKiroCliProcessCommand(proc.command);
    return {
      pid: proc.pid,
      surface: cliSurface ? ('cli' as const) : ('ide' as const),
      ttyAttached: Boolean(proc.tty && proc.tty !== '??'),
      cwdKnown: Boolean(cwd),
      ...(cwd ? { cwdKey: opaqueKey('cwd', cwd) } : {}),
      hostedByKiro: resolveHostApp(proc.pid, byPid)?.toLowerCase() === 'kiro',
      v3Flag: /(?:^|\s)--v3(?:\s|$)/.test(proc.command),
      resumeIdFlag: Boolean(kiroResumeSessionId(proc.command)),
    };
  });

  const sessionEntries = input.snapshots.map((snapshot) => {
    const recordKinds = safeDiagnosticRecordKinds(snapshot.recordKinds);
    return {
      sessionKey: opaqueKey('sid', snapshot.sessionId),
      cwdKnown: Boolean(snapshot.cwd),
      ...(snapshot.cwd ? { cwdKey: opaqueKey('cwd', snapshot.cwd) } : {}),
      ageSeconds: Math.max(0, Math.round((now - snapshot.lastActivityAt) / 1000)),
      format: diagnosticFormat(recordKinds),
      recordKinds,
      hasModel: Boolean(snapshot.modelName),
      hasCreatedAt: snapshot.createdAt !== undefined,
      hasUpdatedAt: snapshot.updatedAt !== undefined,
      state: snapshot.state,
    };
  });

  const correlations = kiroProcesses
    .map((proc) => {
      const session = observedByPid.get(proc.pid);
      if (!session) return undefined;
      const rawId = rawSessionId(session.id);
      const snapshot = input.snapshots.find((item) => item.sessionId === rawId);
      const cwd = session.cwd ?? cwdByPid.get(proc.pid);
      const explicitId = kiroResumeSessionId(proc.command);
      const sameCwd = Boolean(
        snapshot?.cwd && cwdByPid.get(proc.pid) && sameDiagnosticPath(snapshot.cwd, cwdByPid.get(proc.pid)!),
      );
      const surface = session.agentType === 'kiro-ide' ? ('kiro-ide' as const) : ('kiro-cli' as const);
      const confidence: KiroCorrelationConfidence = snapshot
        ? explicitId === snapshot.sessionId
          ? 'exact-resume-id'
          : sameCwd
            ? 'cwd-newest'
            : 'newest-fallback'
        : surface === 'kiro-ide'
          ? 'ide-process-only'
          : 'process-only';
      return {
        pid: proc.pid,
        surface,
        matchedSession: Boolean(snapshot),
        ...(snapshot ? { sessionKey: opaqueKey('sid', snapshot.sessionId) } : {}),
        ...(cwd ? { cwdKey: opaqueKey('cwd', cwd) } : {}),
        confidence,
        state: session.state === 'processing' ? ('processing' as const) : ('idle' as const),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const findings: string[] = [];
  if (kiroProcesses.length === 0) {
    findings.push('No running Kiro process detected. Start Kiro normally and rerun this command.');
  }
  const sqliteReadable = input.sqliteReadable ?? false;
  const jsonlPresent = input.directoryPresent ?? true;
  const v3Present = input.v3DirectoryPresent ?? false;
  const primaryStore = input.primaryStore
    ?? ([sqliteReadable, v3Present, jsonlPresent].filter(Boolean).length > 1
      ? 'mixed'
      : sqliteReadable ? 'sqlite-v2' : v3Present ? 'jsonl-v3' : jsonlPresent ? 'jsonl-legacy' : 'none');
  if (input.sqliteDatabasePresent && !sqliteReadable && !jsonlPresent && !v3Present) {
    findings.push('Kiro SQLite conversation store is present but unreadable or uses an unrecognized schema.');
  } else if (primaryStore === 'none') {
    findings.push('No supported Kiro conversation store was found.');
  } else if ((input.totalConversationRecords ?? input.snapshots.length) === 0) {
    findings.push('The Kiro conversation store is readable but contains no sessions.');
  }
  if (correlations.some((entry) => !entry.matchedSession && entry.surface === 'kiro-cli')) {
    findings.push('At least one Kiro CLI process could not be correlated with a conversation record.');
  }
  if (sessionEntries.some((entry) => entry.format === 'unknown')) {
    findings.push('At least one inspected transcript uses an unrecognized record format.');
  }
  const knownCliCwds = cli.map((proc) => cwdByPid.get(proc.pid)).filter((cwd): cwd is string => Boolean(cwd));
  if (new Set(knownCliCwds).size < knownCliCwds.length) {
    findings.push('Multiple Kiro CLI processes share a cwd; newest-session correlation may be ambiguous.');
  }
  if (findings.length === 0) findings.push('Kiro passive observation prerequisites look healthy.');

  return {
    schemaVersion: 1,
    timestamp: new Date(now).toISOString(),
    platform: input.platform ?? process.platform,
    privacy: [
      'No prompt, response, tool input, command line, session title, model name, or tty name is included.',
      'Session ids and cwd paths are replaced with report-scoped salted keys.',
    ],
    config: {
      kiroHomeSource: input.kiroHomeSource ?? 'default',
      sessionsPath: '$KIRO_HOME/sessions/cli',
      directoryPresent: jsonlPresent,
      v3SessionsPath: '$KIRO_HOME/sessions/<workspace>/<session>',
      v3DirectoryPresent: v3Present,
      sqlitePath: '$KIRO_APP_DATA/data.sqlite3',
      sqliteDatabasePresent: input.sqliteDatabasePresent ?? false,
      sqliteReadable,
      primaryStore,
    },
    processes: {
      total: kiroProcesses.length,
      cli: cli.length,
      ide: ide.length,
      entries: processEntries,
    },
    sessions: {
      totalRecords: input.totalConversationRecords ?? input.snapshots.length,
      inspected: input.snapshots.length,
      entries: sessionEntries,
    },
    correlations,
    findings,
  };
}

export function formatKiroDiagnosticReport(report: KiroDiagnosticReport): string {
  const lines = [
    'Kiro diagnostic (privacy-safe)',
    `Time: ${report.timestamp}`,
    `Platform: ${report.platform}`,
    `Kiro home: ${report.config.kiroHomeSource}`,
    `Conversation store: ${report.config.primaryStore}`,
    `SQLite v2: ${report.config.sqliteDatabasePresent ? (report.config.sqliteReadable ? 'available' : 'present but unreadable') : 'missing'} (${report.config.sqlitePath})`,
    `JSONL v3: ${report.config.v3DirectoryPresent ? 'available' : 'missing'} (${report.config.v3SessionsPath})`,
    `Legacy JSONL fallback: ${report.config.directoryPresent ? 'available' : 'missing'} (${report.config.sessionsPath})`,
    `Processes: ${report.processes.total} (${report.processes.cli} CLI, ${report.processes.ide} IDE)`,
    `Conversation records: ${report.sessions.totalRecords} (${report.sessions.inspected} inspected)`,
    '',
    'Correlations:',
  ];
  if (report.correlations.length === 0) lines.push('- none');
  for (const entry of report.correlations) {
    const target = entry.sessionKey ?? 'no conversation record';
    lines.push(`- pid ${entry.pid}: ${entry.surface} -> ${target} (${entry.confidence}, ${entry.state})`);
  }
  lines.push('', 'Transcript formats:');
  if (report.sessions.entries.length === 0) lines.push('- none');
  for (const entry of report.sessions.entries) {
    const kinds = entry.recordKinds.length > 0 ? entry.recordKinds.join(', ') : 'no recognized markers';
    lines.push(`- ${entry.sessionKey}: ${entry.format}; ${kinds}; age ${entry.ageSeconds}s`);
  }
  lines.push('', 'Findings:', ...report.findings.map((finding) => `- ${finding}`));
  lines.push('', `Privacy: ${report.privacy.join(' ')}`);
  return lines.join('\n');
}

function diagnosticFormat(kinds: readonly string[]): KiroDiagnosticFormat {
  const v2 = kinds.some((kind) => ['ConversationV2', 'Prompt', 'AssistantMessage', 'ToolResults', 'ToolResult'].includes(kind));
  const v3 = kinds.some((kind) => ['user', 'assistant', 'turn_start', 'turn_end', 'session_start'].includes(kind));
  const acp = kinds.some((kind) => kind === 'session/prompt' || kind.startsWith('session/notification'));
  if ([v2, v3, acp].filter(Boolean).length > 1) return 'mixed';
  if (v2) return 'v2';
  if (v3) return 'v3';
  if (acp) return 'acp';
  return 'unknown';
}

function safeDiagnosticRecordKinds(kinds: readonly string[]): string[] {
  const known = new Set([
    'ConversationV2',
    'user',
    'assistant',
    'turn_start',
    'turn_end',
    'session_start',
    'session_event',
    'session_metadata',
    'usage_summary',
    'ContextualHookInvoked',
    'Prompt',
    'AssistantMessage',
    'ToolResults',
    'ToolResult',
    'TurnEnd',
    'turn_end',
    'session/prompt',
    'session/notification',
    'session/notification:AgentMessageChunk',
    'session/notification:ToolCall',
    'session/notification:ToolCallUpdate',
    'session/notification:TurnEnd',
    'session/notification:other',
    'other',
  ]);
  return [...new Set(kinds.map((kind) => (known.has(kind) ? kind : 'other')))].sort();
}

function sameDiagnosticPath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, '');
  const left = normalize(a);
  const right = normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
