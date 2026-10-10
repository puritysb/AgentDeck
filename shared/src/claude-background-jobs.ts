/**
 * Claude Code background jobs, as a process table shows them.
 *
 * Claude Code 2.1.29x runs background jobs (its agent view) under its own
 * daemon, and one user conversation can sit behind three kinds of process:
 *
 * - a **spare** (`claude bg-spare --bg-spare …/spare/<id>.claim.sock`): a
 *   pre-warmed pool process. It fires a `SessionStart` (source `startup`) with
 *   its own session id and cwd, yet holds no conversation — before this rule
 *   both daemons minted an idle row and an APME run for it that the reaper
 *   closed half an hour later as `abandoned` (live 2026-10-10);
 * - a **PTY host** (`claude --bg-pty-host <sock> <cols> <rows> -- <job argv>`):
 *   the terminal relay for one job, never a conversation;
 * - the **job** (`…/claude/versions/2.1.296 --session-id <NEW> --fork-session
 *   --resume …/<OLD>.jsonl`), parented by a PTY host. When the user moves a
 *   window's conversation to the background, the job forks it under a new id
 *   and the window process stays alive, parked, emitting no more hooks — so
 *   `<OLD>` is that conversation's previous identity.
 *
 * The Node observer reads the authoritative flags from
 * `~/.claude/sessions/<pid>.json` (`spare`, `parkedJobId`); the sandboxed Swift
 * daemon cannot, so both daemons' hook paths classify from argv with this rule.
 * `pnpm generate-claude-background-jobs` emits the Swift mirror
 * (`ClaudeBackgroundJobRules.generated.swift`) from the constants below; the
 * byte gate is `claude-background-jobs-sync.test.ts`, and behaviour is pinned
 * by `shared/claude-background-job-vectors.json`, replayed by
 * `claude-background-jobs.test.ts` and `ClaudeBackgroundJobRulesTests.swift`.
 */

export type ClaudeBackgroundProcessRole =
  | { role: 'spare' }
  | { role: 'pty-host' }
  /** A background job; `forkedFrom` is the conversation it continues, when
   *  the job was forked from one (`--fork-session --resume <OLD>`). */
  | { role: 'job'; forkedFrom?: string }
  | { role: 'other' };

/** argv flags that name each process kind. */
export const CLAUDE_BG_FLAGS = {
  ptyHost: '--bg-pty-host',
  spare: '--bg-spare',
  forkSession: '--fork-session',
} as const;

/**
 * `--resume <uuid>` or `--resume <path>/<uuid>.jsonl`, capture 1 = the uuid.
 * The path may contain spaces (argv is joined with spaces on both daemons), so
 * the uuid is read as the last thing before `.jsonl`/end-of-token rather than
 * by tokenising. ICU (Swift `NSRegularExpression`) and JS read it alike.
 */
export const CLAUDE_BG_RESUME_PATTERN =
  '(?:^|\\s)--resume(?:=|\\s+)(?:.*?[\\\\/])?'
  + '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
  + '(?:\\.jsonl)?(?=\\s|$)';

/** A flag as a whole argv word: `(?:^|\s)<flag>(?=\s|=|$)`. */
export const CLAUDE_BG_FLAG_PATTERN_PREFIX = '(?:^|\\s)';
export const CLAUDE_BG_FLAG_PATTERN_SUFFIX = '(?=\\s|=|$)';

/** SessionStart `source` values a spare announces itself with (plus absent). */
export const CLAUDE_SPARE_STARTUP_SOURCES: readonly string[] = ['', 'startup'];

const RESUME_RE = new RegExp(CLAUDE_BG_RESUME_PATTERN);

function hasFlag(command: string, flag: string): boolean {
  return new RegExp(`${CLAUDE_BG_FLAG_PATTERN_PREFIX}${flag}${CLAUDE_BG_FLAG_PATTERN_SUFFIX}`).test(command);
}

/**
 * Classify one Claude process from its argv and its parent's argv (both as
 * space-joined command lines). `parentCommand` undefined means the parent is
 * unknown — a fork is then not provably a background job, and stays `other`.
 */
export function claudeBackgroundProcessRole(
  command: string,
  parentCommand?: string,
): ClaudeBackgroundProcessRole {
  if (hasFlag(command, CLAUDE_BG_FLAGS.ptyHost)) return { role: 'pty-host' };
  if (hasFlag(command, CLAUDE_BG_FLAGS.spare)) return { role: 'spare' };
  if (parentCommand !== undefined && hasFlag(parentCommand, CLAUDE_BG_FLAGS.ptyHost)) {
    if (!hasFlag(command, CLAUDE_BG_FLAGS.forkSession)) return { role: 'job' };
    const forkedFrom = RESUME_RE.exec(command)?.[1]?.toLowerCase();
    return forkedFrom ? { role: 'job', forkedFrom } : { role: 'job' };
  }
  return { role: 'other' };
}

/**
 * A Claude `SessionStart` that only announces a spare warming up. Only the
 * `startup` source (or none) qualifies: once a spare is claimed it keeps its
 * argv, and its later `compact`/`clear`/`resume` starts belong to a real
 * conversation. Its first prompt arrives as `UserPromptSubmit`, which both
 * daemons already accept as a session's opening event.
 */
export function isClaudeSpareStartup(source: unknown, role: ClaudeBackgroundProcessRole): boolean {
  if (role.role !== 'spare') return false;
  if (source === undefined || source === null) return true;
  return typeof source === 'string' && CLAUDE_SPARE_STARTUP_SOURCES.includes(source);
}
