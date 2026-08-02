import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { EnrichedSession } from './session-aggregator.js';
import { resolveProjectNameFromCwdCached } from './utils/project-name.js';
import { stripUnsafeText, rawSessionId } from '@agentdeck/shared';
import {
  parseAntigravityTranscript,
  antigravityDefaultModel,
  antigravityConversationId,
  antigravityTranscriptPath,
  type AntigravityTranscriptSummary,
} from './apme/antigravity-transcript.js';

export type ObservedState = 'idle' | 'processing';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Controlling terminal short name ("ttys008") or "??" for none. */
  tty?: string;
  rssKb: number;
  command: string;
}

export interface TranscriptSummary {
  modelName?: string;
  state: ObservedState;
  currentTask?: string;
  /** One-line gist of the session's purpose — the first real user prompt. */
  goal?: string;
  totalTokens?: number;
  contextPercent?: number;
}

/** Pull display text out of a Claude user message (string or text blocks). */
function claudeUserText(message: Record<string, unknown> | null | undefined): string {
  if (!message) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => isRecord(b) && stringAt(b, 'type') === 'text')
      .map((b) => stringAt(b as Record<string, unknown>, 'text') ?? '')
      .join(' ');
  }
  return '';
}

/**
 * Condense a first user prompt into a one-line session goal: strip injected
 * tags/markup + slash-command noise, collapse whitespace, cap length. Returns ''
 * for non-substantive openers (bare slash commands, empty after cleaning).
 */
export function cleanGoal(raw: string): string {
  let s = stripUnsafeText(raw)
    .replace(/<[^>]+>/g, ' ') // strip <system-reminder> / <command-*> wrappers, keep inner text
    .replace(/\s+/g, ' ')
    .trim();
  // A leading bare slash-command ("/clear", "/compact") isn't a goal.
  if (/^\/[a-z][\w-]*\s*$/i.test(s)) return '';
  // Drop a leading "Caveat: …" preamble Claude Code injects ahead of the prompt.
  s = s.replace(/^Caveat:.*?(?:\.\s|$)/i, '').trim();
  return s.slice(0, 120);
}

interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

export interface ObservedSession extends EnrichedSession {
  /** Controlling terminal ("ttys008") — the observed-answer injection target. */
  tty?: string;
  /** Owning .app for GUI-hosted sessions ("Claude", "ChatGPT") — the app-hosted
   *  injection target when there is no tty. */
  appName?: string;
  controlMode: 'observed';
  pid: number;
  cwd?: string;
  currentTask?: string;
  goal?: string;
  contextPercent?: number;
  totalTokens?: number;
  /** Epoch ms of the transcript's last write (file mtime), when a transcript
   *  was found. Used by the awaiting overlay to detect that a permission prompt
   *  was resolved without a hook (ESC/cancel): the transcript stays frozen
   *  while genuinely waiting, so any write after the overlay was set means the
   *  prompt is over. Absent when no transcript could be located. */
  lastActivityAt?: number;
}

const SCAN_INTERVAL_MS = 5_000;
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_SAMPLE_BYTES = 1024 * 1024;
/** Rollout silence (no writes) after which an end-event-less turn is presumed dead. */
const STALE_TURN_MS = 10 * 60 * 1000;

export class PassiveSessionObserver {
  private lastScanAt = 0;
  private cached: ObservedSession[] = [];
  private scanInFlight = false;

  /** Fired after a background scan changed the cached list. Wire to a
   *  debounced sessions broadcast so fresh observations reach clients
   *  without the enricher ever blocking on the scan. */
  onRefreshed: (() => void) | undefined;

  /**
   * Returns the cached observed sessions immediately and, when the cache is
   * stale (≥ SCAN_INTERVAL_MS), kicks off a background rescan. The scan used
   * to run synchronously inside this call — `execFileSync('ps')` over every
   * process plus `lsof` per Codex pid — which stalled the daemon's event
   * loop (and therefore hook HTTP handling) for tens to hundreds of ms on
   * every cache refresh, since the enricher invokes this on each
   * sessions_list broadcast.
   */
  collect(managedSessions: EnrichedSession[]): ObservedSession[] {
    const now = Date.now();
    if (now - this.lastScanAt >= SCAN_INTERVAL_MS && !this.scanInFlight) {
      this.lastScanAt = now;
      this.scanInFlight = true;
      void this.scan(managedSessions)
        .catch(() => { this.cached = []; })
        .finally(() => { this.scanInFlight = false; });
    }
    return this.cached;
  }

  private async scan(managedSessions: EnrichedSession[]): Promise<void> {
    const processes = await collectProcessInfo();
    const observed = [
      ...collectClaudeSessions(processes),
      ...(await collectCodexSessions(processes)),
      ...(await collectOpenCodeSessions(processes)),
      ...(await collectAntigravitySessions(processes)),
    ];
    const next = dedupeObservedSessions(observed, managedSessions, processes);
    // Only notify on real change — an unconditional callback would emit a
    // sessions broadcast every SCAN_INTERVAL even when nothing moved.
    const changed = JSON.stringify(next) !== JSON.stringify(this.cached);
    this.cached = next;
    if (changed) this.onRefreshed?.();
  }
}

export function parseProcessTable(output: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      tty: match[4] === '??' ? undefined : match[4],
      command: match[5] ?? '',
    });
  }
  return rows.filter((p) => p.pid > 0 && p.command.length > 0);
}

export function parseClaudeTranscript(raw: string): TranscriptSummary {
  let modelName: string | undefined;
  let currentTask: string | undefined;
  let goal: string | undefined;
  let totalTokens = 0;
  let lastContextTokens = 0;
  let contextWindow = 0;
  let realUserOpen = false;
  let latestAssistantHadTool = false;

  for (const parsed of parseJsonl(raw)) {
    if (!isRecord(parsed)) continue;
    const value = parsed;
    const type = stringAt(value, 'type');
    const timestamp = stringAt(value, 'timestamp');
    if (!timestamp) {
      // Timestamp absence is normal for summary records; ignore them.
    }

    if (type === 'assistant') {
      realUserOpen = false;
      latestAssistantHadTool = false;
      const message = objectAt(value, 'message');
      if (!message) continue;
      modelName = stringAt(message, 'model') ?? modelName;

      const usage = objectAt(message, 'usage');
      if (usage) {
        const input = numberAt(usage, 'input_tokens');
        const output = numberAt(usage, 'output_tokens');
        const cacheRead = numberAt(usage, 'cache_read_input_tokens');
        const cacheCreate = numberAt(usage, 'cache_creation_input_tokens');
        totalTokens += input + output + cacheRead + cacheCreate;
        lastContextTokens = input + cacheRead;
      }

      const content = arrayAt(message, 'content');
      if (!content) continue;
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (stringAt(block, 'type') !== 'tool_use') continue;
        latestAssistantHadTool = true;
        const tool = stringAt(block, 'name') ?? 'tool';
        const arg = extractClaudeToolArg(block);
        currentTask = arg ? `${tool} ${arg}` : tool;
      }
    } else if (type === 'user') {
      const message = objectAt(value, 'message');
      if (isClaudeInterruptMessage(message)) {
        // ESC / interrupt aborts the in-flight turn: the pending tool_use will
        // never resolve and no assistant reply follows, so the session is idle
        // (awaiting the user's next prompt), NOT processing. Without this the
        // `[Request interrupted by user…]` marker reads as a fresh user turn
        // (realUserOpen) and the observed session shows a false 'processing'
        // spinner after a cancel — and after the awaiting overlay is dropped,
        // that stale 'processing' is what the ESC'd session would otherwise
        // fall back to.
        realUserOpen = false;
        latestAssistantHadTool = false;
        currentTask = undefined;
      } else if (!isClaudeToolResultUserMessage(message)) {
        realUserOpen = true;
        currentTask = undefined;
        latestAssistantHadTool = false;
        // First substantive user prompt = the session goal.
        if (!goal) {
          const cleaned = cleanGoal(claudeUserText(message));
          if (cleaned) goal = cleaned;
        }
      }
    }
  }

  contextWindow = contextWindowForModel(modelName);
  return {
    modelName,
    state: realUserOpen || latestAssistantHadTool ? 'processing' : 'idle',
    currentTask,
    goal,
    totalTokens: totalTokens || undefined,
    contextPercent: contextWindow > 0 && lastContextTokens > 0
      ? (lastContextTokens / contextWindow) * 100
      : undefined,
  };
}

export function parseCodexRollout(raw: string): TranscriptSummary & { sessionId?: string; cwd?: string; startedAt?: number; effort?: string; hasPendingCalls?: boolean } {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let startedAt: number | undefined;
  let modelName: string | undefined;
  let effort: string | undefined;
  let currentTask: string | undefined;
  let goal: string | undefined;
  let totalTokens = 0;
  let lastContextTokens = 0;
  let contextWindow = 0;
  // A turn is in flight from task_started/user_message until task_complete/
  // turn_aborted. Mid-turn events (agent_message, function_call) must NOT end
  // it: most of a working turn is the thinking gap between a tool result and
  // the next tool call, and flipping to idle there makes an actively-working
  // Codex render as motionless on the dashboard.
  let turnActive = false;
  const pendingCalls = new Map<string, string>();

  for (const parsed of parseJsonl(raw)) {
    if (!isRecord(parsed)) continue;
    const value = parsed;
    const type = stringAt(value, 'type');
    if (type === 'session_meta') {
      const payload = objectAt(value, 'payload');
      if (!payload) continue;
      sessionId = stringAt(payload, 'id') ?? sessionId;
      cwd = stringAt(payload, 'cwd') ?? cwd;
      startedAt = timestampMs(stringAt(payload, 'timestamp')) ?? startedAt;
    } else if (type === 'event_msg') {
      const payload = objectAt(value, 'payload');
      if (!payload) continue;
      switch (stringAt(payload, 'type')) {
        case 'task_started':
          turnActive = true;
          contextWindow = numberAt(payload, 'model_context_window') || contextWindow;
          break;
        case 'user_message':
          turnActive = true;
          // Turn boundary: calls left dangling by the head/tail sampling gap
          // must not leak into the new turn's state.
          pendingCalls.clear();
          if (!goal) {
            const cleaned = cleanGoal(stringAt(payload, 'message') ?? stringAt(payload, 'text') ?? '');
            if (cleaned) goal = cleaned;
          }
          break;
        case 'agent_message':
          // Mid-turn assistant messages are routine; only task_complete /
          // turn_aborted ends the turn.
          break;
        case 'task_complete':
        case 'turn_aborted':
          turnActive = false;
          // The turn is over — any unmatched function_call is a sampling
          // artifact (its output fell in the gap between the head and tail
          // windows), not an in-flight tool. Without this, a long rollout
          // whose file ends in task_complete reads as 'processing' forever.
          pendingCalls.clear();
          break;
        case 'token_count': {
          const info = objectAt(payload, 'info');
          if (!info) break;
          const total = objectAt(info, 'total_token_usage');
          if (total) {
            totalTokens =
              numberAt(total, 'input_tokens') +
              numberAt(total, 'output_tokens') +
              (numberAt(total, 'cached_input_tokens') || numberAt(total, 'cache_read_input_tokens'));
          }
          const last = objectAt(info, 'last_token_usage');
          if (last) {
            lastContextTokens =
              numberAt(last, 'input_tokens') +
              (numberAt(last, 'cached_input_tokens') || numberAt(last, 'cache_read_input_tokens'));
          }
          contextWindow = numberAt(info, 'model_context_window') || contextWindow;
          break;
        }
        default:
          if (stringAt(payload, 'type')?.endsWith('_end')) {
            const callId = stringAt(payload, 'call_id');
            if (callId) pendingCalls.delete(callId);
          }
      }
    } else if (type === 'response_item') {
      const payload = objectAt(value, 'payload');
      if (!payload) continue;
      if (stringAt(payload, 'type') === 'function_call') {
        const name = stringAt(payload, 'name') ?? 'tool';
        const arg = extractCodexToolArg(stringAt(payload, 'arguments') ?? '');
        const task = arg ? `${name} ${arg}` : name;
        const callId = stringAt(payload, 'call_id');
        if (callId) pendingCalls.set(callId, task);
        currentTask = task;
      } else if (stringAt(payload, 'type') === 'function_call_output') {
        const callId = stringAt(payload, 'call_id');
        if (callId) pendingCalls.delete(callId);
        currentTask = lastMapValue(pendingCalls);
      }
    } else if (type === 'turn_context') {
      const payload = objectAt(value, 'payload');
      if (!payload) continue;
      modelName = stringAt(payload, 'model') ?? modelName;
      effort = stringAt(payload, 'effort') ?? effort;
      contextWindow = numberAt(payload, 'model_context_window') || contextWindow;
    }
  }

  const state = turnActive || pendingCalls.size > 0 ? 'processing' : 'idle';
  return {
    hasPendingCalls: pendingCalls.size > 0,
    sessionId,
    cwd,
    startedAt,
    modelName: effort && modelName ? `${modelName} ${effort}` : modelName,
    effort,
    state,
    currentTask,
    goal,
    totalTokens: totalTokens || undefined,
    contextPercent: contextWindow > 0 && lastContextTokens > 0
      ? (lastContextTokens / contextWindow) * 100
      : undefined,
  };
}

async function collectProcessInfo(): Promise<ProcInfo[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-eo', 'pid=,ppid=,rss=,tty=,command='], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, // git-bash ps.exe pops a console window every 5s scan on Windows without this
    });
    return parseProcessTable(stdout);
  } catch {
    return [];
  }
}

/** Extract the enclosing macOS app name from an executable path, e.g.
 *  "/Applications/ChatGPT.app/Contents/Resources/codex …" → "ChatGPT". */
export function appNameFromCommand(command: string): string | undefined {
  const m = command.match(/\/([^/]+)\.app\//);
  return m ? m[1] : undefined;
}

/** Walk up the process tree (bounded) looking for the .app bundle that hosts
 *  this process. GUI-hosted agent sessions (Claude.app, ChatGPT.app) have no
 *  tty, so the owning app is how the injector finds their UI. */
export function resolveHostApp(
  pid: number,
  byPid: Map<number, ProcInfo>,
  maxDepth = 6,
): string | undefined {
  let cur = byPid.get(pid);
  for (let i = 0; i < maxDepth && cur; i++) {
    const name = appNameFromCommand(cur.command);
    if (name) return name;
    if (!cur.ppid || cur.ppid <= 1) break;
    cur = byPid.get(cur.ppid);
  }
  return undefined;
}

function collectClaudeSessions(processes: ProcInfo[]): ObservedSession[] {
  const configDirs = claudeConfigDirs();
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const sessions: ObservedSession[] = [];
  for (const proc of processes) {
    if (!cmdHasBinary(proc.command, 'claude') || proc.command.includes('--print')) continue;
    const sessionFile = findClaudeSessionFile(configDirs, proc.pid);
    if (!sessionFile) continue;
    const transcript = findClaudeTranscript(configDirs, sessionFile.cwd, sessionFile.sessionId);
    // Head+tail so the FIRST user prompt (the session goal, at the file start) is
    // parsed alongside recent activity (at the tail).
    const summary = transcript
      ? parseClaudeTranscript(readFileHeadAndTail(transcript, 64 * 1024, MAX_TAIL_BYTES))
      : { state: 'idle' as const };
    sessions.push({
      id: `observed:claude:${sessionFile.sessionId}`,
      port: 0,
      pid: proc.pid,
      projectName: projectNameFromCwd(sessionFile.cwd),
      agentType: 'claude-code',
      alive: true,
      state: summary.state,
      modelName: summary.modelName,
      startedAt: new Date(sessionFile.startedAt).toISOString(),
      controlMode: 'observed',
      cwd: sessionFile.cwd,
      tty: proc.tty,
      appName: proc.tty ? undefined : resolveHostApp(proc.pid, byPid),
      currentTask: summary.currentTask,
      goal: summary.goal,
      contextPercent: summary.contextPercent,
      totalTokens: summary.totalTokens,
      lastActivityAt: transcript ? fileMtimeMs(transcript) : undefined,
    });
  }
  return sessions;
}

async function collectCodexSessions(processes: ProcInfo[]): Promise<ObservedSession[]> {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const codex = processes.filter((p) =>
    cmdHasBinary(p.command, 'codex') &&
    !p.command.includes('app-server') &&
    !p.command.includes('grep')
  );
  const rolloutByPid = await mapCodexPidsToRollouts(codex.map((p) => p.pid));
  const sessions: ObservedSession[] = [];
  for (const proc of codex) {
    const rollout = rolloutByPid.get(proc.pid);
    if (!rollout) continue;
    const sample = readFileHeadAndTail(rollout, 256 * 1024, MAX_SAMPLE_BYTES);
    if (!sample) continue;
    const parsed = parseCodexRollout(sample);
    // Ghost backstop: a turn whose end event never made it into the rollout
    // (killed mid-turn, writer race) would read as processing forever. A live
    // turn between tool calls writes the rollout every few seconds, so a long
    // silence with no in-flight tool means the turn is dead. In-flight tools
    // (pending call) are exempt — a quiet 10-minute build is legitimate.
    let state = parsed.state;
    if (state === 'processing' && !parsed.hasPendingCalls && rolloutAgeMs(rollout) > STALE_TURN_MS) {
      state = 'idle';
    }
    const sessionId = parsed.sessionId ?? String(proc.pid);
    const cwd = parsed.cwd;
    sessions.push({
      id: `observed:codex:${sessionId}`,
      port: 0,
      pid: proc.pid,
      projectName: cwd ? projectNameFromCwd(cwd) : 'Codex',
      agentType: 'codex-cli',
      // Same injection targets as observed Claude: answering or dictating into
      // a Codex session means typing into the terminal that owns it.
      tty: proc.tty,
      appName: proc.tty ? undefined : resolveHostApp(proc.pid, byPid),
      alive: true,
      state,
      modelName: parsed.modelName,
      startedAt: parsed.startedAt ? new Date(parsed.startedAt).toISOString() : new Date().toISOString(),
      controlMode: 'observed',
      cwd,
      currentTask: parsed.currentTask,
      goal: parsed.goal,
      contextPercent: parsed.contextPercent,
      totalTokens: parsed.totalTokens,
    });
  }
  return sessions;
}

/**
 * Surface standalone `opencode` processes (not launched via `agentdeck opencode`).
 * Unlike Claude Code / Codex, OpenCode has no lifecycle hooks, so without this a
 * directly-run `opencode` is invisible to the daemon and its creature never appears.
 * OpenCode keeps no easily-parsed per-PID session state, so we report it as alive/idle
 * with the project derived from the process cwd — enough to surface the creature.
 */
async function collectOpenCodeSessions(processes: ProcInfo[]): Promise<ObservedSession[]> {
  const procs = processes.filter((p) =>
    cmdHasBinary(p.command, 'opencode') &&
    !p.command.includes('grep') &&
    !p.command.includes(' mcp') &&
    !p.command.includes('agentdeck')
  );
  if (procs.length === 0) return [];
  const cwdByPid = await cwdForPids(procs.map((p) => p.pid));
  return procs.map((proc) => {
    const cwd = cwdByPid.get(proc.pid);
    return {
      id: `observed:opencode:${proc.pid}`,
      port: 0,
      pid: proc.pid,
      projectName: cwd ? projectNameFromCwd(cwd) : 'OpenCode',
      agentType: 'opencode' as const,
      alive: true,
      state: 'idle' as const,
      startedAt: new Date().toISOString(),
      controlMode: 'observed' as const,
      cwd,
    };
  });
}

/**
 * Surface standalone Antigravity processes for the CLI daemon. Antigravity hooks
 * can provide structured events when explicitly configured, but passive
 * discovery still gives hardware/UI a stable creature anchor for users running
 * the IDE outside AgentDeck-managed launch paths.
 */
async function collectAntigravitySessions(processes: ProcInfo[]): Promise<ObservedSession[]> {
  const procs = processes.filter((p) => isAntigravityProcessCommand(p.command));
  if (procs.length === 0) return [];
  const cwdByPid = await cwdForPids(procs.map((p) => p.pid));
  const defaultModel = antigravityDefaultModel();
  return procs.map((proc) => {
    const cwd = cwdByPid.get(proc.pid);
    const realCwd = cwd && cwd !== '/' ? cwd : undefined;
    // Resolve the active conversation for this workspace and parse its
    // transcript for model / goal / state. Falls back to a pid-keyed id and the
    // global default model when no conversation can be located.
    const convId = antigravityConversationId(realCwd);
    let summary: AntigravityTranscriptSummary | null = null;
    if (convId) {
      const sample = readFileHeadAndTail(antigravityTranscriptPath(convId), 64 * 1024, MAX_SAMPLE_BYTES);
      if (sample) summary = parseAntigravityTranscript(sample);
    }
    return {
      id: convId ? `observed:antigravity:${convId}` : `observed:antigravity:${proc.pid}`,
      port: 0,
      pid: proc.pid,
      projectName: realCwd ? projectNameFromCwd(realCwd) : 'Antigravity',
      agentType: 'antigravity' as const,
      alive: true,
      state: summary?.state ?? 'idle',
      modelName: summary?.model ?? defaultModel,
      goal: summary?.goal,
      currentTask: summary?.currentTask,
      startedAt: new Date().toISOString(),
      controlMode: 'observed' as const,
      cwd: realCwd,
    };
  });
}

export function isAntigravityProcessCommand(command: string): boolean {
  return (
    // `agy` is the Antigravity CLI binary (Homebrew cask). This is the one the
    // user actually runs for coding; the GUI app patterns below were the only
    // matches in the original "creature foundation", which left the CLI blind.
    cmdHasBinary(command, 'agy') ||
    cmdHasBinary(command, 'antigravity') ||
    /\/Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/.test(command) ||
    /\bAntigravity(?:\s|$)/.test(command)
  ) &&
    !/\bAntigravity Helper\b/.test(command) &&
    !command.includes('grep') &&
    !command.includes('agentdeck');
}

/** cwd path for each pid via `lsof -d cwd` (best-effort; empty map on failure). */
async function cwdForPids(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  try {
    const args = ['-a', '-d', 'cwd', '-Fn', ...pids.map((p) => `-p${p}`)];
    const { stdout } = await execFileAsync('lsof', args, {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    });
    let cur: number | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) cur = Number(line.slice(1));
      else if (line.startsWith('n') && cur != null) map.set(cur, line.slice(1));
    }
  } catch {
    // lsof unavailable / permission — fall back to no cwd (projectName "OpenCode").
  }
  return map;
}

function dedupeObservedSessions(
  observed: ObservedSession[],
  managedSessions: EnrichedSession[],
  processes: ProcInfo[],
): ObservedSession[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const managedIds = new Set(managedSessions.map((s) => s.id));
  const managedPids = managedSessions
    .map((s) => (s as EnrichedSession & { pid?: number }).pid)
    .filter((pid): pid is number => typeof pid === 'number' && pid > 0);

  return observed.filter((session) => {
    if (managedIds.has(session.id)) return false;
    const rawId = rawSessionId(session.id);
    if (managedIds.has(rawId)) return false;
    return !managedPids.some((pid) => pid === session.pid || isDescendantOf(session.pid, pid, byPid));
  });
}

function claudeConfigDirs(): string[] {
  const dirs = [join(homedir(), '.claude')];
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && !dirs.includes(envDir)) dirs.push(envDir);
  return dirs.filter((dir) => existsSync(dir));
}

function findClaudeSessionFile(configDirs: string[], pid: number): ClaudeSessionFile | null {
  for (const dir of configDirs) {
    const path = join(dir, 'sessions', `${pid}.json`);
    if (!safeRegularFile(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<{
        pid: number;
        sessionId: string;
        cwd: string;
        startedAt: number;
      }>;
      if (typeof parsed.pid !== 'number' || typeof parsed.sessionId !== 'string' ||
          typeof parsed.cwd !== 'string' || typeof parsed.startedAt !== 'number') {
        continue;
      }
      return {
        pid: parsed.pid,
        sessionId: parsed.sessionId.slice(0, 256),
        cwd: parsed.cwd.slice(0, 4096),
        startedAt: parsed.startedAt,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function findClaudeTranscript(configDirs: string[], cwd: string, sessionId: string): string | null {
  const encoded = encodeClaudeCwd(cwd);
  for (const dir of configDirs) {
    const projects = join(dir, 'projects');
    const primary = join(projects, encoded, `${sessionId}.jsonl`);
    if (safeRegularFile(primary)) return primary;
    try {
      for (const entry of readdirSync(projects, { withFileTypes: true }).slice(0, 250)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
        if (safeRegularFile(candidate)) return candidate;
      }
    } catch {
      // Missing projects dir is normal for fresh installs.
    }
  }
  return null;
}

async function mapCodexPidsToRollouts(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  if (process.platform === 'linux') {
    const map = new Map<number, string>();
    for (const pid of pids) {
      try {
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          const path = readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (isCodexRolloutPath(path)) {
            map.set(pid, path);
            break;
          }
        }
      } catch {
        // /proc permission/race failures are normal.
      }
    }
    return map;
  }

  try {
    const args = ['-F', 'pn', ...pids.map((pid) => `-p${pid}`)];
    const { stdout } = await execFileAsync('lsof', args, {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseLsofRollouts(stdout);
  } catch {
    return new Map();
  }
}

export function parseLsofRollouts(output: string): Map<number, string> {
  const map = new Map<number, string>();
  let currentPid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1));
    } else if (line.startsWith('n') && currentPid != null) {
      const path = line.slice(1);
      if (isCodexRolloutPath(path)) map.set(currentPid, path);
    }
  }
  return map;
}

function rolloutAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Epoch-ms of a file's last write, or undefined if it can't be stat'd. */
function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function readFileHeadAndTail(path: string, headBytes: number, tailBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    if (size <= headBytes + tailBytes) {
      const buffer = Buffer.alloc(size);
      readSync(fd, buffer, 0, size, 0);
      return buffer.toString('utf8');
    }

    const head = Buffer.alloc(headBytes);
    readSync(fd, head, 0, headBytes, 0);
    const tail = Buffer.alloc(tailBytes);
    readSync(fd, tail, 0, tailBytes, size - tailBytes);
    const tailText = tail.toString('utf8');
    const firstNewline = tailText.indexOf('\n');
    return `${head.toString('utf8')}\n${firstNewline >= 0 ? tailText.slice(firstNewline + 1) : ''}`;
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function parseJsonl(raw: string): unknown[] {
  const values: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 10 * 1024 * 1024) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // Partial tail lines and malformed records are ignored.
    }
  }
  return values;
}

function extractClaudeToolArg(block: Record<string, unknown>): string {
  const input = objectAt(block, 'input');
  if (!input) return '';
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url']) {
    const value = stringAt(input, key);
    if (value) return shortenArg(value);
  }
  return '';
}

function extractCodexToolArg(args: string): string {
  if (!args) return '';
  try {
    const value = JSON.parse(args) as unknown;
    if (!isRecord(value)) return '';
    for (const key of ['file_path', 'path']) {
      const raw = stringAt(value, key);
      if (raw) return shortenArg(basename(raw));
    }
    for (const key of ['cmd', 'command', 'chars', 'target', 'session_id']) {
      const raw = valueToString(value[key]);
      if (raw) return shortenArg(raw);
    }
  } catch {
    return '';
  }
  return '';
}

function valueToString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => typeof v === 'string' ? v : '').filter(Boolean).join(' ') || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function shortenArg(value: string): string {
  return redactSecrets(value).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function redactSecrets(value: string): string {
  const patterns = ['sk-ant-', 'sk-proj-', 'sk-or-', 'sk_live_', 'sk_test_', 'ghp_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-', 'Bearer '];
  let result = value;
  for (const pattern of patterns) {
    let idx = result.indexOf(pattern);
    while (idx >= 0) {
      const tokenStart = idx + pattern.length;
      const endOffset = result.slice(tokenStart).search(/\s/);
      const end = endOffset >= 0 ? tokenStart + endOffset : result.length;
      result = `${result.slice(0, idx)}[REDACTED]${result.slice(end)}`;
      idx = result.indexOf(pattern, idx + '[REDACTED]'.length);
    }
  }
  return result;
}

function isClaudeToolResultUserMessage(message: Record<string, unknown> | null): boolean {
  const content = message ? arrayAt(message, 'content') : null;
  return !!content?.length && content.every((block) => isRecord(block) && stringAt(block, 'type') === 'tool_result');
}

/** Does a user record carry Claude Code's interrupt/cancel marker
 *  (`[Request interrupted by user…]`) rather than real user prose? Emitted when
 *  the user presses ESC on a prompt or mid-turn — it fires no lifecycle hook,
 *  so the transcript is the only place the cancel is observable. */
function isClaudeInterruptMessage(message: Record<string, unknown> | null): boolean {
  return /\[Request interrupted by user/i.test(claudeUserText(message));
}

function contextWindowForModel(modelName?: string): number {
  if (!modelName) return 0;
  const lower = modelName.toLowerCase();
  if (lower.includes('1m') || lower.includes('1000000')) return 1_000_000;
  if (lower.includes('haiku')) return 200_000;
  if (lower.includes('sonnet')) return 200_000;
  if (lower.includes('opus')) return 200_000;
  return 0;
}

function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[\/_.]/g, '-');
}

// Shared resolver (git root → package.json name → basename) so a session
// observed passively gets the SAME label as one launched via `agentdeck
// <agent>` in the same directory — bare basename made e.g. a Claude app
// session in <repo>/bridge show "bridge" while its PTY twin showed the repo
// name, breaking #N dedup and Codex display folding across launch paths.
function projectNameFromCwd(cwd: string): string {
  return resolveProjectNameFromCwdCached(cwd);
}

function safeRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isCodexRolloutPath(path: string): boolean {
  const name = basename(path);
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

function cmdHasBinary(command: string, name: string): boolean {
  return command
    .split(/\s+/)
    .slice(0, 2)
    .some((token) => basename(token) === name);
}

function isDescendantOf(pid: number, ancestorPid: number, byPid: Map<number, ProcInfo>): boolean {
  let current = byPid.get(pid);
  const visited = new Set<number>();
  while (current && !visited.has(current.pid)) {
    if (current.ppid === ancestorPid) return true;
    visited.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

function lastMapValue<T>(map: Map<string, T>): T | undefined {
  let value: T | undefined;
  for (const item of map.values()) value = item;
  return value;
}

function timestampMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
