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
