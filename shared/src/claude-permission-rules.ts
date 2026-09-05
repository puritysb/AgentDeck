/**
 * Claude Code permission prediction — the single source of truth for "would
 * Claude Code actually prompt the user for this tool call?".
 *
 * Both daemons hold an observed session's PreToolUse for a device decision
 * ONLY when this module predicts a genuine prompt. A false hold costs the user
 * twice: the deck shows PERM for a decision Claude never asked for, and the
 * hook response is held for the whole timeout (25 s) before Claude's own
 * allow rule lets the call through. Measured 2026-09-05: two `acceptEdits`
 * worker sessions whose every `curl`/`mkdir` was allowlisted by
 * `Bash(curl *)` / `Bash(mkdir *)` were held on every batch, because the
 * predictor understood only the legacy `Bash(curl:*)` spelling — 67 of the
 * 73 Bash rules in the user's settings were in the space form and matched
 * nothing. The Swift daemon carried the same defect as a hand mirror, which
 * is why the matcher now lives here and is GENERATED into Swift
 * (`pnpm generate-claude-permission-rules`), with behavior pinned by
 * `shared/claude-permission-vectors.json` that both suites replay.
 *
 * Rule semantics follow the Claude Code permissions reference
 * (https://code.claude.com/docs/en/permissions):
 *   - `Bash`, `Bash(*)`        → every Bash call
 *   - `Bash(npm run build)`    → the exact command
 *   - `Bash(npm run *)`        → `*` matches any text INCLUDING spaces; a rule
 *                                whose only wildcard is a trailing ` *` also
 *                                matches the bare command (`ls *` ⇒ `ls`)
 *   - `Bash(ls:*)`             → legacy spelling of `Bash(ls *)`, end-only
 *   - `Bash(git * main)`       → wildcards anywhere
 *   - compound commands split on `&&` `||` `;` `|` `|&` `&` and newlines, and
 *     EVERY subcommand must be covered for Claude to skip the prompt
 *   - a built-in read-only set (`ls`, `cat`, `git status`, …) never prompts in
 *     any mode, and `acceptEdits` additionally auto-approves the filesystem
 *     commands `mkdir touch rm rmdir mv cp sed`
 *   - `timeout`/`nice`/`nohup`/… wrappers and leading `VAR=value` assignments
 *     are stripped before matching
 *
 * Every uncertainty resolves toward "don't hold": a missed hold means the user
 * answers in the terminal exactly as before, while a false hold nags them with
 * a prompt Claude never showed and stalls the agent for the hold timeout.
 */

// ─── Permission modes ───

/** Values Claude Code writes into a hook payload's `permission_mode`. */
export const CLAUDE_PERMISSION_MODES = [
  'default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions',
] as const;
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];

/** Tools that never trigger a permission prompt — holding them can only ever
 *  be a false positive. Kept intentionally tight (unknown tools are excluded
 *  by the prompt-prone check, not this list). */
export const NEVER_PROMPT_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS',
  'TodoWrite', 'TodoRead', 'NotebookRead',
  'Task', 'TaskOutput', 'BashOutput',
]);

/** Tools that DO prompt in default/acceptEdits mode unless allowlisted.
 *  Anything outside this set (including every mcp__* tool, whose per-server
 *  trust state we cannot see) is never held. */
export const PROMPT_PRONE_TOOLS: ReadonlySet<string> = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch',
]);

/** Edit-family tools that Claude auto-approves in `acceptEdits` mode. */
export const EDIT_FAMILY_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

/**
 * Should the daemon consider HOLDING a PreToolUse at all, given the session's
 * `permission_mode`? Claude's PreToolUse hook fires for EVERY tool call
 * regardless of mode, so gate only in modes where Claude could still surface
 * its own prompt.
 *
 *  - `bypassPermissions` / `dontAsk` → never prompts                → no
 *  - `auto`   → the classifier decides outside the settings files; the rule
 *               predictor cannot see it, so every unlisted call would
 *               false-hold. The rare genuine prompt still arrives as a
 *               Notification `permission_prompt`                    → no
 *  - `plan`   → tools don't execute (classifier or read-only only)  → no
 *  - `acceptEdits` → edits + filesystem commands auto-approved, other
 *               Bash still prompts                                  → non-edit tools
 *  - `default` / unknown → Claude may prompt                        → yes
 *
 * Unknown/absent mode is treated as `default` to preserve behavior on older
 * Claude versions that don't send the field.
 */
export function shouldGatePreToolUse(permissionMode: string | undefined, tool: string): boolean {
  switch ((permissionMode || 'default').trim()) {
    case 'bypassPermissions':
    case 'dontAsk':
    case 'auto':
    case 'plan':
      return false;
    case 'acceptEdits':
      return !EDIT_FAMILY_TOOLS.has(tool);
    default:
      return true;
  }
}

// ─── Built-in auto-approvals ───

/** Bash programs Claude Code runs without a prompt in every mode (the
 *  documented built-in read-only set plus its obviously read-only kin). Being
 *  generous here is the SAFE direction: an entry that Claude actually prompts
 *  for costs a missed hold, never a false one. */
export const READ_ONLY_BASH_COMMANDS: readonly string[] = [
  'ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'find', 'wc', 'which',
  'diff', 'stat', 'du', 'cd', 'sort', 'uniq', 'tr', 'cut', 'file', 'basename',
  'dirname', 'realpath', 'date', 'whoami', 'uname', 'printenv', 'true', 'false',
  'type', 'tree',
];

/** `git <subcommand>` forms that are read-only regardless of arguments. */
export const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = [
  'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse',
  'rev-list', 'blame', 'describe', 'cat-file', 'name-rev', 'shortlog',
  'merge-base', 'check-ignore', 'count-objects',
];

/** `git <subcommand>` forms that are read-only only when they carry no
 *  arguments or only these flags (`git branch` lists; `git branch x` writes). */
export const READ_ONLY_GIT_LISTING_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  branch: ['--list', '-a', '-r', '-v', '-vv', '--show-current', '--all', '--remotes'],
  tag: ['-l', '--list', '-n'],
  remote: ['-v', '--verbose', 'show', 'get-url'],
  stash: ['list', 'show'],
  worktree: ['list'],
  reflog: ['show'],
  config: ['--get', '--list', '-l', '--get-all', '--global', '--local', '--system'],
};

/** Filesystem commands `acceptEdits` mode auto-approves (in-scope paths). */
export const ACCEPT_EDITS_FS_COMMANDS: readonly string[] = [
  'mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed',
];

/** Process wrappers Claude Code strips before matching. `timeout`, `nice -n`
 *  and `stdbuf` take arguments; the rest run their first argument directly. */
const WRAPPERS_WITH_VALUE: ReadonlySet<string> = new Set(['timeout', 'stdbuf']);
const WRAPPERS_BARE: ReadonlySet<string> = new Set([
  'time', 'nice', 'nohup', 'command', 'builtin', 'noglob', 'xargs',
]);

// ─── Tokenising ───

function tokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter((t) => t.length > 0);
}

/** Strip leading `VAR=value` assignments and process wrappers so `LANG=C
 *  timeout 30 npm test` is matched as `npm test`. Returns the stripped
 *  command text (tokens re-joined by single spaces). */
export function stripCommandWrappers(segment: string): string {
  let toks = tokens(segment);
  let changed = true;
  while (changed && toks.length > 0) {
    changed = false;
    const head = toks[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      toks = toks.slice(1);
      changed = true;
      continue;
    }
    if (WRAPPERS_WITH_VALUE.has(head)) {
      // `timeout [flags] <duration> cmd…` / `stdbuf -oL cmd…`
      let i = 1;
      while (i < toks.length && toks[i].startsWith('-')) i++;
      if (head === 'timeout') i++; // the duration
      toks = toks.slice(Math.min(i, toks.length));
      changed = true;
      continue;
    }
    if (WRAPPERS_BARE.has(head)) {
      let i = 1;
      // `nice -n 10 cmd` carries a value; other bare wrappers may take flags.
      while (i < toks.length && toks[i].startsWith('-')) {
        i++;
        if (head === 'nice' && toks[i - 1] === '-n') i++;
      }
      if (head === 'xargs' && i > 1) break; // `xargs -n1 …` is matched as xargs itself
      toks = toks.slice(Math.min(i, toks.length));
      changed = true;
    }
  }
  return toks.join(' ');
}

/**
 * Split a compound command on shell operators, quote-aware. Returns `null`
 * when the split is not trustworthy — a heredoc, command substitution, an
 * unbalanced quote, or an operator with nothing after it — in which case
 * Claude Code itself does not split either.
 */
export function splitCompoundCommand(command: string): string[] | null {
  if (command.includes('<<') || command.includes('$(') || command.includes('`')) return null;
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '|&') {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (quote) return null;
  segments.push(current);
  const trimmed = segments.map((s) => s.trim());
  // An operator with nothing after it (`npm test &&`) is unparseable.
  if (trimmed.length > 1 && trimmed[trimmed.length - 1] === '') return null;
  return trimmed.filter((s) => s.length > 0);
}

// ─── Rule matching ───

/**
 * Does one Bash rule spec match one command text? Implements the documented
 * wildcard rules: `*` matches any text including spaces; a trailing ` *` that
 * is the rule's only wildcard also matches the bare command; the legacy `:*`
 * suffix is an alias for ` *`; no wildcard means exact match.
 */
export function bashRuleMatches(spec: string, command: string): boolean {
  const cmd = command.trim();
  if (spec === '*') return true;
  let pattern = spec;
  if (pattern.endsWith(':*')) pattern = `${pattern.slice(0, -2)} *`;
  const stars = pattern.split('*').length - 1;
  if (stars === 0) return cmd === pattern;
  if (stars === 1 && pattern.endsWith(' *') && cmd === pattern.slice(0, -2)) return true;
  return globMatch(pattern, cmd);
}

/** `*`-only glob over code points. Iterative two-pointer form so a rule with
 *  several wildcards cannot go exponential on a long command. */
export function globMatch(pattern: string, text: string): boolean {
  const p = Array.from(pattern);
  const t = Array.from(text);
  let pi = 0;
  let ti = 0;
  let starPi = -1;
  let starTi = -1;
  while (ti < t.length) {
    if (pi < p.length && p[pi] === '*') {
      starPi = pi;
      starTi = ti;
      pi++;
    } else if (pi < p.length && p[pi] === t[ti]) {
      pi++;
      ti++;
    } else if (starPi >= 0) {
      pi = starPi + 1;
      starTi++;
      ti = starTi;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

export interface ParsedPermissionRule {
  tool: string;
  spec?: string;
}

/** `Tool` or `Tool(spec)` → parts; anything else → null. */
export function parsePermissionRule(rule: string): ParsedPermissionRule | null {
  const m = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return null;
  return { tool: m[1], spec: m[2] };
}

/** Rules merged from every settings file Claude reads for a cwd. `null`
 *  ("unknown") when any existing file failed to parse — the daemon can no
 *  longer trust its picture of the allowlist and must hold nothing. */
export interface MergedPermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

/** Loose match (allow/deny direction): a tool-name match with ANY spec counts
 *  for tools whose spec grammar we do not replicate (paths, domains); Bash
 *  specs are compared precisely against the (wrapper-stripped) segment. */
export function ruleMatchesLoose(rule: ParsedPermissionRule, tool: string, segment: string | undefined): boolean {
  if (rule.tool !== tool) return false;
  if (rule.spec === undefined) return true;
  if (tool === 'Bash') {
    if (segment === undefined) return true; // malformed input — assume covered
    return bashRuleMatches(rule.spec, segment) || bashRuleMatches(rule.spec, stripCommandWrappers(segment));
  }
  return true;
}

/** Strict match (ask direction): only patterns we can evaluate exactly, since
 *  an ask match CAUSES a hold. */
export function ruleMatchesStrict(rule: ParsedPermissionRule, tool: string, segment: string | undefined): boolean {
  if (rule.tool !== tool) return false;
  if (rule.spec === undefined) return true;
  if (tool === 'Bash' && segment !== undefined) return bashRuleMatches(rule.spec, segment);
  return false;
}

// ─── Built-in read-only / acceptEdits detection ───

function hasUnquotedGlob(segment: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '*' || ch === '?' || ch === '[') return true;
  }
  return false;
}

function hasWriteRedirect(segment: string): boolean {
  // `2>/dev/null`, `>/dev/null`, `&>/dev/null` are not writes anywhere.
  const stripped = segment.replace(/(?:\d|&)?>>?\s*\/dev\/null/g, '');
  return stripped.includes('>');
}

/** Programs whose unquoted glob could expand into a write/exec flag. */
const GLOB_SENSITIVE: ReadonlySet<string> = new Set(['find', 'sort', 'sed', 'git']);

/**
 * Is this one (already split) segment in Claude Code's built-in read-only set,
 * so it runs without a prompt in every mode?
 */
export function isBuiltinReadOnlyCommand(segment: string): boolean {
  const stripped = stripCommandWrappers(segment);
  const toks = tokens(stripped);
  if (toks.length === 0) return false;
  if (hasWriteRedirect(stripped)) return false;
  const program = toks[0];
  if (program === 'git') {
    const sub = toks[1];
    if (!sub) return false;
    if (hasUnquotedGlob(stripped)) return false;
    if (READ_ONLY_GIT_SUBCOMMANDS.includes(sub)) return true;
    const listingFlags = READ_ONLY_GIT_LISTING_SUBCOMMANDS[sub];
    if (!listingFlags) return false;
    return toks.slice(2).every((t) => listingFlags.includes(t));
  }
  if (!READ_ONLY_BASH_COMMANDS.includes(program)) return false;
  if (GLOB_SENSITIVE.has(program) && hasUnquotedGlob(stripped)) return false;
  return true;
}

/** Is this segment one of the filesystem commands `acceptEdits` auto-approves? */
export function isAcceptEditsFsCommand(segment: string): boolean {
  const toks = tokens(stripCommandWrappers(segment));
  return toks.length > 0 && ACCEPT_EDITS_FS_COMMANDS.includes(toks[0]);
}

// ─── Verdicts ───

export type PermissionRuleVerdict = 'allow' | 'deny' | 'ask' | 'none' | 'unknown';

/**
 * Predict Claude's permission-RULE verdict for one tool call (rules only; the
 * mode and built-in sets are applied by `predictPreToolUseHold`).
 *   'deny'    → a deny rule may match: Claude auto-denies — don't hold
 *   'allow'   → allow rules cover every subcommand — don't hold
 *   'ask'     → an ask rule definitely matches — hold-eligible
 *   'none'    → no rule decides — default behavior for the tool applies
 *   'unknown' → settings unreadable — don't hold
 */
export function evaluatePermissionRules(
  tool: string,
  command: string | undefined,
  rules: MergedPermissionRules | null,
  opts: { permissionMode?: string } = {},
): PermissionRuleVerdict {
  if (rules === null) return 'unknown';
  const parsedDeny = rules.deny.map(parsePermissionRule);
  const parsedAllow = rules.allow.map(parsePermissionRule);
  const parsedAsk = rules.ask.map(parsePermissionRule);

  for (const r of parsedDeny) {
    if (r && ruleMatchesLoose(r, tool, command)) return 'deny';
  }

  if (tool !== 'Bash' || command === undefined) {
    for (const r of parsedAllow) if (r && ruleMatchesLoose(r, tool, command)) return 'allow';
    for (const r of parsedAsk) if (r && ruleMatchesStrict(r, tool, command)) return 'ask';
    return 'none';
  }

  const segments = splitCompoundCommand(command) ?? [command];
  const acceptEdits = (opts.permissionMode || '').trim() === 'acceptEdits';
  let anyAsk = false;
  let allCovered = segments.length > 0;
  for (const segment of segments) {
    if (parsedDeny.some((r) => r && ruleMatchesLoose(r, tool, segment))) return 'deny';
    if (parsedAsk.some((r) => r && ruleMatchesStrict(r, tool, segment))) {
      anyAsk = true;
      allCovered = false;
      continue;
    }
    const covered = parsedAllow.some((r) => r && ruleMatchesLoose(r, tool, segment))
      || isBuiltinReadOnlyCommand(segment)
      || (acceptEdits && isAcceptEditsFsCommand(segment));
    if (!covered) allCovered = false;
  }
  if (allCovered) return 'allow';
  if (anyAsk) return 'ask';
  return 'none';
}

export interface PreToolUseHoldInput {
  tool: string;
  toolInput?: Record<string, unknown> | undefined;
  permissionMode?: string | undefined;
  /** Merged rules, or `null` when unreadable. */
  rules: MergedPermissionRules | null;
}

export interface PreToolUseHoldPrediction {
  hold: boolean;
  reason: string;
}

/**
 * The stateless half of the device-approval gate: given the tool, its input,
 * the session's mode and the merged rules, would Claude Code genuinely prompt?
 * The daemons layer session state on top (connected clients, one held gate
 * per session, learned auto-approvals).
 */
export function predictPreToolUseHold(input: PreToolUseHoldInput): PreToolUseHoldPrediction {
  const tool = input.tool;
  if (!tool) return { hold: false, reason: 'no tool name' };
  if (tool.startsWith('mcp__')) return { hold: false, reason: 'mcp tool (trust state unknown)' };
  if (NEVER_PROMPT_TOOLS.has(tool)) return { hold: false, reason: 'never-prompt tool' };
  if (!PROMPT_PRONE_TOOLS.has(tool)) return { hold: false, reason: 'not prompt-prone' };
  if (!shouldGatePreToolUse(input.permissionMode, tool)) {
    return { hold: false, reason: `permission_mode=${input.permissionMode || 'default'} auto-approves` };
  }
  const command = typeof input.toolInput?.command === 'string' ? input.toolInput.command : undefined;
  const verdict = evaluatePermissionRules(tool, command, input.rules, { permissionMode: input.permissionMode });
  if (verdict === 'unknown') return { hold: false, reason: 'settings unreadable' };
  if (verdict === 'deny') return { hold: false, reason: 'deny rule may match' };
  if (verdict === 'allow') return { hold: false, reason: 'allow rule or built-in auto-approval covers the call' };
  return { hold: true, reason: verdict === 'ask' ? 'ask rule matches' : 'prompt-prone, no rule match' };
}

// ─── Learner ───

/** Bash signature = first two command tokens (the granularity of Claude's own
 *  "always allow `git push`"-style session approvals); other tools = tool name. */
export function gateSignature(tool: string, toolInput: Record<string, unknown> | undefined): string {
  if (tool === 'Bash' && typeof toolInput?.command === 'string') {
    const head = toolInput.command.trim().split(/\s+/).slice(0, 2).join(' ');
    return `Bash|${head}`;
  }
  return tool;
}

/**
 * How long after an undecided gate release a PostToolUse still teaches the
 * daemon "Claude auto-approved this signature". A `permission_prompt`
 * Notification in between clears the pending release, so the window bounds
 * only how long a slow TOOL may take — it was 8 s, and a `curl` fetching a
 * web page routinely exceeds that, so the same `curl -sL` signature was held
 * on every batch of one session (measured 2026-09-05).
 */
export const GATE_LEARN_WINDOW_MS = 15 * 60_000;
