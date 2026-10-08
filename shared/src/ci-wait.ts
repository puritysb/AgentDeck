import { UI } from './design-tokens.js';
import { CI_GITHUB_GLYPH, CI_GITHUB_GLYPH_SIZE, CI_GITHUB_ALPHA, CI_GITHUB_ALPHA_SIZE } from './ci-github-glyph.generated.js';
/** CI wait intent, never a CI result. SSOT for the staged #433 integration.
 * No I/O, cwd inference, credentials, command text or invented run identity.
 * Unsupported shell syntax fails closed; process evidence can cover it later.
 */
export interface CiWaitIntent {
  kind: 'ci';
  provider: 'github-actions';
  mode: 'watch' | 'poll';
  repo?: string;
  ref?: string;
  pr?: number;
  runId?: number;
}

export const CI_WAIT_MAX_COMMAND_CHARS = 16_384;
/** Data consumed by the native generator; keep CLI grammar and bounds here. */
export const CI_WAIT_RULES = {
  maxCommandChars: CI_WAIT_MAX_COMMAND_CHARS,
  maxIdentityChars: 255,
  maxId: Number.MAX_SAFE_INTEGER,
  whitespace: '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
  forbidden: '\0`$(){}',
  numberPattern: '^[1-9][0-9]*$',
  digitsPattern: '^[0-9]+$',
  repoPattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
  branchPattern: '^[A-Za-z0-9_./-]+$',
  assignmentPattern: '^[A-Za-z_][A-Za-z0-9_]*=',
  urlPattern: '^https://github\\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)/?$',
  runWatch: { values: ['--interval', '-i'], switches: ['--exit-status', '--compact'] },
  prChecks: { values: ['--interval', '-i', '--json', '--jq', '-q', '--template', '-t'], switches: ['--fail-fast', '--required'] },
  runList: { values: ['--branch', '-b', '--json', '--jq', '-q', '--template', '-t', '--limit', '-L',
    '--workflow', '-w', '--status', '-s', '--event', '-e', '--user', '-u', '--commit', '-c', '--created'], switches: ['--all', '-a'] },
} as const;
const patterns = Object.fromEntries(['number', 'digits', 'repo', 'branch', 'assignment', 'url'].map(
  name => [name, new RegExp(CI_WAIT_RULES[`${name}Pattern` as keyof typeof CI_WAIT_RULES] as string)],
));
// `$` may match before a trailing line separator in either regex engine.
// Metadata must match the entire argument; it never carries that separator.
const fullMatch = (pattern: RegExp, value: string) => pattern.exec(value)?.[0] === value;
type Token = { value: string; plain: boolean };

/** Restricted shell lexer. Quoted text stays an argument, comments cannot
 * inject commands, and substitutions/functions are deliberately unsupported.
 * Redirections are preserved as a boundary so log paths cannot become flags.
 */
function segments(command: string): Token[][] | null {
  if (command.length > CI_WAIT_MAX_COMMAND_CHARS || [...CI_WAIT_RULES.forbidden].some(c => command.includes(c)) ||
      /(?:&&|\|\||\|)\s*$/.test(command)) return null;
  const out: Token[][] = [];
  let words: Token[] = [], value = '', started = false, plain = true;
  let quote: string | null = null;
  const word = () => {
    if (started) words.push({ value, plain });
    value = ''; started = false; plain = true;
  };
  const segment = () => { word(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') {
        if (++i === command.length) return null;
        value += command[i];
      } else value += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; plain = false; }
    else if (c === '\\') {
      if (++i === command.length) return null;
      if (command[i] !== '\n') { value += command[i]; started = true; plain = false; }
    } else if (c === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      segment();
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      segment();
      if (command[i + 1] === c || (c === '|' && command[i + 1] === '&')) i++;
    } else if (c === '>' || c === '<') {
      word(); words.push({ value: c, plain: true });
      if (command[i + 1] === c) {
        if (c === '<') return null;
        i++;
      }
    } else if (CI_WAIT_RULES.whitespace.includes(c)) word();
    else { value += c; started = true; }
  }
  if (quote) return null;
  segment();
  return out;
}

function number(value: string | undefined): number | undefined {
  if (!value || !fullMatch(patterns.number, value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}
function repo(value: string | undefined): string | undefined {
  return value && value.length <= CI_WAIT_RULES.maxIdentityChars && fullMatch(patterns.repo, value) ? value : undefined;
}
function branch(value: string | undefined): string | undefined {
  return value && value.length <= CI_WAIT_RULES.maxIdentityChars && fullMatch(patterns.branch, value) ? value : undefined;
}

function github(tokens: Token[], polling: boolean): CiWaitIntent | null {
  const redirect = tokens.findIndex(t => t.plain && (t.value === '>' || t.value === '<'));
  const executable = [...(redirect < 0 ? tokens : tokens.slice(0, redirect))];
  while (executable[0]?.plain && patterns.assignment.test(executable[0].value)) executable.shift();
  const argv = executable.map(t => t.value);
  if (argv[0] === 'command') argv.shift();
  if (argv[0]?.split('/').pop() !== 'gh') return null;
  argv.shift();
  let repository: string | undefined;
  const takeRepo = () => {
    if (argv[0] === '-R' || argv[0] === '--repo') {
      argv.shift(); repository = repo(argv.shift()); return true;
    }
    if (argv[0]?.startsWith('--repo=')) {
      repository = repo(argv.shift()!.slice(7)); return true;
    }
    return false;
  };
  while (takeRepo()) { /* global repo option */ }
  const group = argv.shift(), action = argv.shift();
  if (!(group === 'run' && (action === 'watch' || action === 'list')) &&
      !(group === 'pr' && action === 'checks')) return null;
  let watch = action === 'watch';
  let identity: string | undefined, ref: string | undefined;
  const grammar = action === 'watch' ? CI_WAIT_RULES.runWatch : group === 'pr' ? CI_WAIT_RULES.prChecks : CI_WAIT_RULES.runList;
  const valueOptions = new Set<string>(grammar.values);
  const switches = new Set<string>(grammar.switches);
  while (argv.length) {
    if (takeRepo()) continue;
    const arg = argv.shift()!;
    if (arg === '--watch') { if (group !== 'pr') return null; watch = true; continue; }
    const equal = arg.indexOf('=');
    const option = equal < 0 ? arg : arg.slice(0, equal);
    if (valueOptions.has(option)) {
      const value = equal < 0 ? argv.shift() : arg.slice(equal + 1);
      if (!value) return null;
      if (option === '--branch' || option === '-b') ref = branch(value);
    } else if (switches.has(arg)) continue;
    else if (arg.startsWith('-') || identity !== undefined) return null;
    else identity = arg;
  }
  if (!watch && !polling) return null;
  if (group === 'run' && action === 'list' && identity !== undefined) return null;
  // An explicit run id is necessary for `run watch`; interactive selection
  // is not evidence that a particular run is being waited on.
  const runId = group === 'run' && action === 'watch' ? number(identity) : undefined;
  if (group === 'run' && action === 'watch' && runId === undefined) return null;
  let pr: number | undefined;
  if (group === 'pr') {
    const url = identity?.match(patterns.url);
    if (url && url[0] === identity) {
      if (!repo(url[1])) return null;
      if (repository !== undefined && repository !== url[1]) return null;
      repository = url[1]; pr = number(url[2]);
      if (pr === undefined) return null;
    }
    else if (identity !== undefined) {
      pr = number(identity);
      if (pr === undefined) {
        if (patterns.digits.test(identity) || !branch(identity)) return null;
        ref = branch(identity);
      }
    }
  }
  return { kind: 'ci', provider: 'github-actions', mode: watch ? 'watch' : 'poll',
    ...(repository ? { repo: repository } : {}), ...(ref ? { ref } : {}),
    ...(pr ? { pr } : {}), ...(runId ? { runId } : {}) };
}

/** Only an explicitly backgrounded tool intent can open a hook-derived wait.
 * A foreground watch may be discovered separately through process ancestry.
 * Multiple different watches are ambiguous and must not be fused into one run.
 */
export function classifyCiWaitIntent(command: unknown, runInBackground: unknown): CiWaitIntent | null {
  if (runInBackground !== true || typeof command !== 'string') return null;
  const commands = segments(command);
  if (!commands) return null;
  const loops: boolean[] = [];
  const found: CiWaitIntent[] = [];
  for (const original of commands) {
    const tokens = [...original];
    const keyword = () => tokens[0]?.plain ? tokens[0].value : undefined;
    if (keyword() === 'done') { if (loops.pop() !== true || tokens.length !== 1) return null; continue; }
    if (keyword() === 'while' || keyword() === 'until') { loops.push(false); tokens.shift(); }
    if (keyword() === 'do') {
      if (!loops.length || loops[loops.length - 1]) return null;
      loops[loops.length - 1] = true; tokens.shift();
    }
    if (keyword() === '!') tokens.shift();
    const intent = github(tokens, loops.length > 0);
    if (intent) found.push(intent);
  }
  if (loops.length !== 0 || found.length === 0) return null;
  return found.every(i => JSON.stringify(i) === JSON.stringify(found[0])) ? found[0] : null;
}


/** Content-minimized observer evidence. Invalid or extra fields fail closed;
 * no command, environment, result, credential or free-form argument is kept. */
export function normalizedCiWaitIntent(value: unknown): CiWaitIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['kind', 'provider', 'mode', 'repo', 'ref', 'pr', 'runId'].includes(k)) ||
      v.kind !== 'ci' || v.provider !== 'github-actions' || typeof v.mode !== 'string' || !['watch', 'poll'].includes(v.mode)) return null;
  if ((v.repo !== undefined && (typeof v.repo !== 'string' || !repo(v.repo))) ||
      (v.ref !== undefined && (typeof v.ref !== 'string' || !branch(v.ref))) ||
      ['pr', 'runId'].some(k => v[k] !== undefined && (typeof v[k] !== 'number' || !Number.isSafeInteger(v[k]) || Number(v[k]) < 1))) return null;
  return { kind: 'ci', provider: 'github-actions', mode: v.mode as 'watch' | 'poll',
    ...(v.repo !== undefined ? { repo: v.repo as string } : {}), ...(v.ref !== undefined ? { ref: v.ref as string } : {}),
    ...(v.pr !== undefined ? { pr: v.pr as number } : {}), ...(v.runId !== undefined ? { runId: v.runId as number } : {}) };
}

/** Source hook aliases normalize at the tracker boundary, so native and Node
 * receivers cannot omit an agent family or confuse Interrupt with Stop. */
export const CI_WAIT_HOOK_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'tool_start', PostToolUse: 'tool_end', PostToolUseFailure: 'tool_failure',
  Stop: 'stop', Interrupt: 'interrupt',
  ...Object.fromEntries(['codex', 'opencode', 'hermes'].flatMap(prefix =>
    ['session_start', 'session_end', 'user_prompt_submit', 'tool_start', 'tool_end', 'tool_failure', 'stop', 'interrupt', 'turn_complete']
      .map(event => [`${prefix}_${event}`, event === 'turn_complete' ? 'stop' : event]))),
});

/** Lifecycle bounds are shared with the generated native implementation. */
export const CI_WAIT_LIFECYCLE = { maxSessions: 1024, maxTools: 8, maxSessionChars: 256, maxToolIdChars: 255, maxAgeMs: 24 * 60 * 60 * 1000, resultAgeMs: 30_000 } as const;
import type { CiWaitStatus } from './protocol.js';
export interface CiWaitTool {
  token: number;
  id: string;
  background: boolean;
  status: CiWaitStatus;
}

/** Hook evidence only. Tool exit is NOT a GitHub conclusion: even gh can exit
 * because auth, transport or the user failed. No raw command is retained.
 * A missing invocation id cannot safely match concurrent tools and is ignored.
 */
export class CiWaitTracker {
  private sessions = new Map<string, CiWaitTool[]>();
  private nextToken = 0;

  note(sessionId: string, event: string, json: Record<string, unknown>, now: number): boolean {
    event = Object.hasOwn(CI_WAIT_HOOK_EVENTS, event) ? CI_WAIT_HOOK_EVENTS[event] : event;
    if (!sessionId || sessionId.length > CI_WAIT_LIFECYCLE.maxSessionChars || !Number.isSafeInteger(now) || now < 0) return false;
    const before = JSON.stringify(this.snapshot(sessionId, now));
    if (['session_start', 'session_end', 'user_prompt_submit', 'interrupt'].includes(event)) {
      this.sessions.delete(sessionId);
    } else if (event === 'stop') {
      const waits = (this.sessions.get(sessionId) ?? []).filter(w => w.background);
      if (waits.length) this.sessions.set(sessionId, waits); else this.sessions.delete(sessionId);
    } else {
      const id = json.tool_use_id ?? json.tool_call_id ?? json.call_id;
      if (typeof id !== 'string' || !id || id.length > CI_WAIT_LIFECYCLE.maxToolIdChars) return false;
      const input = json.tool_input as Record<string, unknown> | undefined;
      let waits = this.sessions.get(sessionId) ?? [];
      if (event === 'tool_start') {
        const tool = json.tool_name;
        const normalized = tool === 'terminal' ? normalizedCiWaitIntent(json.ci_wait_intent) : null;
        if (!normalized && (!input || typeof input !== 'object' ||
            !['Bash', 'bash', 'shell', 'shell_command', 'exec_command'].includes(String(tool)))) return false;
        const background = normalized ? json.ci_wait_background === true : input?.run_in_background === true;
        const intent = normalized ?? classifyCiWaitIntent(input?.command ?? input?.cmd, true);
        // Foreground one-shot reads and polling loops are not watch evidence.
        if (!intent || (!background && intent.mode !== 'watch')) return false;
        if (!waits.some(w => w.id === id)) {
          if (waits.length >= CI_WAIT_LIFECYCLE.maxTools ||
              (!this.sessions.has(sessionId) && this.sessions.size >= CI_WAIT_LIFECYCLE.maxSessions)) return false;
          const { mode: _mode, ...identity } = intent;
          waits = [...waits, { token: ++this.nextToken, id, background, status: { ...identity, phase: 'unknown',
            agentWaiting: true, evidence: 'tool_input', openedAt: Math.trunc(now) } }];
        }
      } else if (event === 'tool_end' || event === 'tool_failure') {
        waits = waits.filter(w => w.id !== id || (w.background && event !== 'tool_failure' && json.is_error !== true));

      }
      if (waits.length) this.sessions.set(sessionId, waits); else this.sessions.delete(sessionId);
    }
    return before !== JSON.stringify(this.snapshot(sessionId, now));
  }

  snapshot(sessionId: string, now: number): CiWaitStatus | null {
    const waits = (this.sessions.get(sessionId) ?? []).filter(w => now - w.status.openedAt < CI_WAIT_LIFECYCLE.maxAgeMs);
    if (!waits.length) { this.sessions.delete(sessionId); return null; }
    this.sessions.set(sessionId, waits);
    return { ...waits[0].status };
  }
  entries(now: number): [string, CiWaitStatus][] {
    return [...this.sessions.keys()].flatMap(id => { const value = this.snapshot(id, now); return value ? [[id, value] as [string, CiWaitStatus]] : []; });
  }
  /** Bind an asynchronous result to this exact wait; a later visit cannot be
   * completed by a response from the earlier visit. */
  waitsFor(sessionId: string, now: number): ReadonlyArray<{ token: number; background: boolean; status: CiWaitStatus }> {
    this.snapshot(sessionId, now);
    return (this.sessions.get(sessionId) ?? []).map(w => ({ token: w.token, background: w.background, status: { ...w.status } }));
  }
  isForeground(sessionId: string): boolean { return this.sessions.get(sessionId)?.[0]?.background === false; }
  tokenFor(sessionId: string): number | undefined { return this.sessions.get(sessionId)?.[0]?.token; }
  applyPhase(sessionId: string, token: number | undefined, phase: CiWaitStatus['phase']): boolean {
    const first = this.sessions.get(sessionId)?.[0];
    if (!first || first.token !== token || first.status.phase === phase) return false;
    first.status = { ...first.status, phase, evidence: phase === 'unknown' ? 'tool_input' : 'github',
      agentWaiting: phase !== 'passed' && phase !== 'failed' };
    return true;
  }
  applyEvidence(sessionId: string, token: number | undefined, evidence: Pick<CiWaitStatus, 'phase' | 'checks' | 'runUrl'>): boolean {
    const first = this.sessions.get(sessionId)?.[0];
    if (!first || first.token !== token) return false;
    const before = JSON.stringify(first.status);
    this.applyPhase(sessionId, token, evidence.phase);
    first.status = { ...first.status, checks: evidence.checks, runUrl: evidence.runUrl };
    return before !== JSON.stringify(first.status);
  }
  closeHead(sessionId: string, openedAt: number): boolean {
    const waits = this.sessions.get(sessionId);
    if (!waits?.length || waits[0].status.openedAt !== openedAt) return false;
    waits.shift();
    if (!waits.length) this.sessions.delete(sessionId);
    return true;
  }
  forget(sessionId: string): void { this.sessions.delete(sessionId); }
}

/** A CI wait does not become PERM or WORKING. Permission prompts keep priority. */
export function ciWaitLabel(wait: CiWaitStatus | null | undefined): string | null {
  if (!wait) return null;
  return `CI ${wait.phase === 'unknown' ? 'wait' : wait.phase}${wait.pr ? ` #${wait.pr}` : ''}`;
}

/** Stable compact phase IDs: zero clears; unknown is never success. */
export const CI_WAIT_CUE = {
  cycleMs: 6000, showAfterMs: 3000,
  glyphSize: CI_GITHUB_GLYPH_SIZE, helperColor: UI.hudText,
  standardGlyphSize: CI_GITHUB_ALPHA_SIZE,
  colors: { unknown: UI.idle, queued: UI.cyan, running: UI.cyan, passed: UI.ok, failed: UI.error },
} as const;
export const CI_WAIT_VISUAL = {
  none: 0, unknown: 1, queued: 2, running: 3, passed: 4, failed: 5,
  // Official GitHub Invertocat sampled from the canonical SVG, never an agent.
  github: CI_GITHUB_GLYPH,
  githubAlpha: CI_GITHUB_ALPHA,
} as const;
export function ciWaitPhaseId(wait: CiWaitStatus | null | undefined): number {
  if (!wait) return CI_WAIT_VISUAL.none;
  // Terminal verdicts are passive evidence. A pending helper needs an explicit
  // waiting signal; missing/false is not evidence that an agent is waiting.
  if (wait.phase !== 'passed' && wait.phase !== 'failed' && wait.agentWaiting !== true) return CI_WAIT_VISUAL.none;
  const value = CI_WAIT_VISUAL[wait.phase];
  return typeof value === 'number' ? value : CI_WAIT_VISUAL.unknown;
}
export function ciWaitDetail(wait: CiWaitStatus | null | undefined): string | null {
  const label = ciWaitLabel(wait);
  if (!wait || !label) return null;
  return label + (wait.checks ? ` · ${wait.checks.passed}/${wait.checks.total}` : '');
}

/** Union, clipped to the real turn. Concurrent waits never double-charge and
 * a background wait never subtracts time when the agent can continue working. */
export function ciWaitDuration(spans: ReadonlyArray<{ start: number; end: number }>, start: number, end: number): number {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return 0;
  const ranges = spans.filter(s => Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) && s.end >= s.start)
    .map(s => ({ start: Math.max(start, s.start), end: Math.min(end, s.end) }))
    .filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
  let total = 0, through = start;
  for (const span of ranges) { total += Math.max(0, span.end - Math.max(through, span.start)); through = Math.max(through, span.end); }
  return total;
}

export function ciWaitForegroundMs(events: ReadonlyArray<import('./sample.js').TrajectoryEvent>, turnIndex: number, start: number, end: number): number {
  const open = new Map<string, number>(), spans: { start: number; end: number }[] = [];
  for (const event of events) {
    if (event.kind !== 'relation' || event.relation !== 'waiting_on' || event.evidence !== 'ci_wait_foreground' || event.turnIndex !== turnIndex || !event.relationId) continue;
    if (event.phase === 'open') { if (!open.has(event.relationId)) open.set(event.relationId, event.ts); }
    else { const began = open.get(event.relationId); if (began !== undefined) { spans.push({ start: began, end: event.ts }); open.delete(event.relationId); } }
  }
  for (const began of open.values()) spans.push({ start: began, end });
  return ciWaitDuration(spans, start, end);
}
