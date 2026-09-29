/**
 * Every child process this package spawns must be unable to open a console
 * window — because the daemon has no console to lend it.
 *
 * The Windows autostart daemon is started DETACHED by its Scheduled Task
 * launcher (windows-service.ts explains why it has to be), so it runs with no
 * console at all. A console-subsystem child of a console-less parent gets a
 * BRAND NEW console, and a new console comes with a window on the desktop
 * unless the spawn passes `windowsHide` (CREATE_NO_WINDOW). Reported from a
 * real desktop 2026-09-14: an empty `C:\Windows\system32\taskkill.exe` window
 * appearing every five minutes, from the Codex rate-limit probe's cleanup kill.
 *
 * The bug was latent for as long as the task's action was the daemon itself:
 * the daemon then HAD a console (the one whose window this change removes),
 * children inherited it, and nothing new was ever drawn. So this gate is the
 * price of that fix, and it belongs in CI rather than on a user's desktop.
 *
 * A call passes if any of three things is true:
 *  - it passes `windowsHide` (the fix),
 *  - it runs a binary that cannot exist on Windows, so the spawn fails with
 *    ENOENT and draws nothing (`launchctl`, `osascript`, `sysctl`, …),
 *  - it carries an inline `windows-hide-exempt:` comment stating why — for the
 *    cases a regex cannot see, such as a command in a variable or a branch that
 *    only ever runs on POSIX.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, relative } from 'path';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Binaries with no Windows counterpart: a spawn of these cannot draw a window. */
const POSIX_ONLY = new Set([
  'afplay', 'airport', 'chmod', 'codesign', 'defaults', 'ioreg', 'killall', 'launchctl',
  'lsof', 'networksetup', 'open', 'osascript', 'pgrep', 'plutil', 'pmset', 'ps', 'say',
  'screencapture', 'security', 'sqlite3', 'stty', 'sysctl', 'systemctl', 'tmux', 'tty',
  'uptime', 'vm_stat', 'which', 'xcodebuild',
]);

const CHILD_PROCESS_FNS = new Set([
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync',
]);

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsFiles(path, out);
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * The LOCAL names this file calls `child_process` through — nothing else counts.
 *
 * Two files define their own `spawnSync` helper (the Timebox and iDotMatrix BLE
 * managers), and a gate that matched on the bare name would report those
 * forever while missing an aliased import. Only `type`-only specifiers are
 * skipped; a value import of `ChildProcess` is harmless either way.
 */
export function childProcessLocalNames(source: string): Set<string> {
  const names = new Set<string>();
  const importRe = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;
  for (const match of source.matchAll(importRe)) {
    for (const raw of match[1].split(',')) {
      const spec = raw.trim();
      if (!spec || spec.startsWith('type ')) continue;
      const [imported, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (CHILD_PROCESS_FNS.has(imported)) names.add(alias || imported);
    }
  }
  return names;
}

/**
 * Blank every comment, preserving length and newlines so offsets and line
 * numbers still line up.
 *
 * Needed because prose mentions these functions: the very first run of this
 * gate reported `spawn()` from a sentence explaining that "spawn() fails with
 * EBADARCH". String literals are walked (not blanked) so a `//` inside a URL
 * cannot swallow the rest of a line of real code.
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** The text of one call, from its opening paren to the matching close. */
export function callText(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

/** The basename of a literal command, when the first argument is one. */
export function literalCommand(args: string): string | undefined {
  const literal = /^\(\s*(['"`])([^'"`$]*)/.exec(args);
  if (!literal) return undefined;
  const command = literal[2].trim();
  // A template whose first character is an interpolation captures nothing —
  // that is "no literal command", not "a command called empty string".
  if (!command) return undefined;
  // `execSync` takes a whole command line; `execFile`/`spawn` take a path.
  const [word] = command.split(/\s+/);
  const base = word.split(/[/\\]/).pop() ?? word;
  return base.replace(/\.exe$/i, '');
}

interface Violation { file: string; line: number; call: string }

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const file of tsFiles(SRC_ROOT)) {
    const source = readFileSync(file, 'utf-8');
    // Call sites are found in the comment-blanked copy (prose mentions these
    // names) and read back out of the original, where the options object is.
    const code = blankComments(source);
    const locals = childProcessLocalNames(source);
    if (locals.size === 0) continue;
    for (const name of locals) {
      // Not a property access (`this.spawn(`), not a declaration.
      const callRe = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g');
      for (const match of code.matchAll(callRe)) {
        const openParen = match.index + match[0].length - 1;
        const before = source.slice(0, match.index);
        if (/\b(function|const|let|var)\s+$/.test(before)) continue;
        const args = callText(source, openParen);
        if (args.includes('windowsHide')) continue;
        const command = literalCommand(args);
        if (command && POSIX_ONLY.has(command)) continue;
        // The exemption marker must sit within the four lines above the call,
        // where a reader of the call will see it.
        const lineNo = before.split('\n').length;
        const context = before.split('\n').slice(-5).join('\n');
        if (context.includes('windows-hide-exempt:')) continue;
        violations.push({
          file: relative(SRC_ROOT, file).replace(/\\/g, '/'),
          line: lineNo,
          call: `${name}(${(command ?? args.slice(1, 40)).trim()}`,
        });
      }
    }
  }
  return violations;
}

describe('no child process may open a console window', () => {
  it('every child_process call hides its window, names a POSIX-only binary, or says why not', () => {
    // The message is the whole point of the gate: a new spawn added without
    // `windowsHide` has to arrive with the reason it is safe.
    expect(scan().map((v) => `${v.file}:${v.line} — ${v.call}`)).toEqual([]);
  });
});

describe('the gate reads what it claims to read', () => {
  it('counts only child_process imports, aliases included', () => {
    expect(childProcessLocalNames("import { spawn, type ChildProcess } from 'child_process';"))
      .toEqual(new Set(['spawn']));
    expect(childProcessLocalNames("import { execFile as run } from 'node:child_process';"))
      .toEqual(new Set(['run']));
    // A locally defined helper that merely shares the name is not this import.
    expect(childProcessLocalNames("import { type ChildProcess } from 'child_process';\nfunction spawnSync() {}"))
      .toEqual(new Set());
  });

  it('never reads a function name out of prose', () => {
    // The first run of this gate reported a `spawn()` that lives inside a
    // sentence explaining that spawn() fails with EBADARCH.
    expect(blankComments("/* spawn() fails */\nspawn('a');")).toBe("                   \nspawn('a');");
    // A `//` inside a string must not blank the real code after it.
    expect(blankComments("execSync('curl http://x', {})")).toBe("execSync('curl http://x', {})");
  });

  it('extracts a call across newlines and nested parens', () => {
    const src = "x(spawn('a', [String(1)], {\n  windowsHide: true,\n}))";
    expect(callText(src, src.indexOf('(', src.indexOf('spawn'))))
      .toBe("('a', [String(1)], {\n  windowsHide: true,\n})");
  });

  it('reads the binary out of a literal first argument', () => {
    expect(literalCommand("('taskkill', ['/f'])")).toBe('taskkill');
    expect(literalCommand("('adb -s X reverse --list', {")).toBe('adb');
    expect(literalCommand("('/usr/bin/sqlite3', [db])")).toBe('sqlite3');
    expect(literalCommand('(`${loginShell} -l -c`)')).toBeUndefined();
    expect(literalCommand('(plan.command, args, {')).toBeUndefined();
  });
});
