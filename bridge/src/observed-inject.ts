/**
 * Deliver an option selection INTO an observed session's own UI — the rung of
 * the observed-steering ladder that answers a live prompt without any
 * hold-and-timeout machinery: the prompt is already on screen; the daemon does
 * what the user would do, and if it cannot reach the UI **nothing happens**
 * (the prompt keeps waiting — never an auto-proceed).
 *
 * Two families of host, resolved by the passive observer:
 *
 *   Terminal-hosted (`tty` known) — the session runs in a real terminal, so
 *   the answer is keystrokes into that terminal's own input:
 *     1. tmux — the pane whose `#{pane_tty}` matches gets `send-keys`.
 *     2. cmux — the agent process inherited `CMUX_SURFACE_ID` from the surface
 *        it was started in; `cmux send` / `send-key` type into that surface
 *        (no focus change). Read from the process's own environment, so the
 *        match is exact rather than by tty. Once this rung knows the host is
 *        cmux it never falls through: the AppleScript rungs below would only
 *        raise Automation prompts for an app that does not own the tty.
 *     Before AppleScript, a bounded process snapshot must identify the owning
 *     app in the agent's ancestry. Unknown and unsupported hosts stop here;
 *     neither may probe unrelated apps through Automation.
 *     3. iTerm2 — the session whose `tty` matches gets `write text` (no focus
 *        change; iTerm2 writes straight into the session).
 *     4. Terminal.app — has no write API, so: select the tab owning that tty
 *        (scriptable, no activation) and post keys to Terminal's pid.
 *
 *   App-hosted (`appName` known, no tty) — Claude.app / ChatGPT.app run the
 *   agent inside a native window, so the answer is that window's own control:
 *     5. Press the button whose title matches the chosen option's label
 *        (AXPress — precise; works for native AppKit dialogs).
 *     6. Post keys to the app's pid (focus-free).
 *     7. Raise + keys + restore, only if the app ignores posted events.
 *
 * Every rung is focus-free except the last: measured 2026-07-26, keys posted
 * with `CGEventPostToPid` reached a background Terminal tab while iTerm2
 * stayed frontmost.
 *
 * Two measured dead ends, recorded so they are not retried:
 *   • TIOCSTI — the one kernel path that would cover every emulator at once —
 *     is EPERM on macOS unless the tty is the caller's own controlling
 *     terminal.
 *   • ChatGPT.app exposes no content in its accessibility tree (its window is
 *     three untitled AXButtons plus empty AXGroups, and
 *     `AXManualAccessibility` returns kAXErrorAttributeUnsupported), so the
 *     button rung cannot see its controls — key posting is the working path
 *     for that host.
 *
 * Node-daemon only by design: every rung needs a subprocess
 * (tmux/cmux/osascript), which the App Store Swift daemon must never spawn.
 * See docs/appstore-feature-matrix.md.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import { promisify } from 'util';
import { debug } from './logger.js';

const execFileAsync = promisify(execFile);

export interface InjectTarget {
  /** Controlling terminal short name ("ttys008") for terminal-hosted sessions. */
  tty?: string;
  /** Owning application ("Claude", "ChatGPT") for app-hosted sessions. */
  appName?: string;
  /** Visible label of the chosen option — lets app-hosted rungs press the
   *  matching native button instead of guessing at cursor movement. */
  label?: string;
  /** The agent process itself. The cmux rung reads the surface that process
   *  was started in from its environment, which a tty cannot tell apart. */
  pid?: number;
}

/** Known bundle ids for GUI agent hosts — matched before localized names,
 *  which differ per system language. */
const APP_BUNDLE_IDS: Record<string, string[]> = {
  Claude: ['com.anthropic.claudefordesktop', 'com.anthropic.claude'],
  ChatGPT: ['com.openai.chat'],
  Terminal: ['com.apple.Terminal'],
  iTerm2: ['com.googlecode.iterm2'],
};

export interface InjectResult {
  ok: boolean;
  via?: 'tmux' | 'cmux' | 'iterm2' | 'terminal-app' | 'app-button' | 'app-keys' | 'app-keys-raised';
  reason?: string;
}

/** AppleScript string literal escaping (quotes + backslashes). */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Parse `tmux list-panes -a -F "#{pane_tty}\t#{pane_id}"` output into a
 *  tty-suffix → paneId map ("/dev/ttys012" is matched by "ttys012"). */
export function parseTmuxPanes(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [paneTty, paneId] = line.trim().split('\t');
    if (!paneTty || !paneId) continue;
    map.set(paneTty.replace(/^\/dev\//, ''), paneId);
  }
  return map;
}

/** Gap between an arrow key and the Enter that acts on it. Measured, not
 *  guessed: sending `Down Enter` in one `tmux send-keys` makes the picker
 *  answer with the option the cursor was on BEFORE the arrow — every device
 *  answer silently became option 0. Splitting the calls with this pause
 *  selects the intended option. Same lesson `injectText` already carries for
 *  text-then-CR; the selection path never got it. */
const KEY_PACE_MS = 120;
/** Longer settle before the Enter, which is the irreversible key. */
const SUBMIT_PACE_MS = 300;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function tmuxPaneFor(tty: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync(
    'tmux', ['list-panes', '-a', '-F', '#{pane_tty}\t#{pane_id}'],
    { encoding: 'utf8', timeout: 2_000 },
  );
  return parseTmuxPanes(stdout).get(tty);
}

/** `false` = this rung is not the host, try the next one. `'partial'` = it IS
 *  the host but the sequence broke midway, so the ladder must STOP: the keys
 *  that did land already moved the cursor, and re-sending arrows through
 *  another rung would select an option further down the list. */
type TmuxOutcome = true | false | 'partial';

async function injectViaTmux(tty: string, downs: number, submits = 1): Promise<TmuxOutcome> {
  let paneId: string | undefined;
  try {
    paneId = await tmuxPaneFor(tty);
  } catch {
    return false; // no tmux server — this rung isn't the host
  }
  if (!paneId) return false;
  let sent = 0;
  try {
    // One key per call, paced: the TUI reads a burst as a single input frame
    // and resolves Enter against the pre-arrow cursor.
    for (let i = 0; i < downs; i++) {
      await execFileAsync('tmux', ['send-keys', '-t', paneId, 'Down'], { timeout: 2_000 });
      sent++;
      await pause(KEY_PACE_MS);
    }
    for (let i = 0; i < submits; i++) {
      await pause(SUBMIT_PACE_MS);
      await execFileAsync('tmux', ['send-keys', '-t', paneId, 'Enter'], { timeout: 2_000 });
      sent++;
    }
    return true;
  } catch {
    return sent > 0 ? 'partial' : false;
  }
}

/** The cmux surface an agent runs in, as the agent's own environment has it. */
export interface CmuxSurface {
  surfaceId: string;
  /** The socket of the cmux instance that owns the surface. A tagged or debug
   *  build listens on its own, which the CLI's default would not reach. */
  socketPath?: string;
}

/** cmux surface ids are UUIDs. Anything else is not a cmux surface, and the
 *  value goes on to `--surface`, where it must never read as a flag. */
const CMUX_SURFACE_ID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Read only the environment suffix of `ps -E -ww -o command=`. Apple's ps
 * appends it after the same argv rendered without -E (adv_cmds/ps/print.c,
 * getproclline). Require that complete argv prefix before looking for keys:
 * a prompt argument alone must never identify a cmux surface.
 *
 * `CMUX_WORKSPACE_ID` is deliberately ignored — it records
 * the workspace the surface was in at launch, a surface can be moved since,
 * and cmux resolves a surface UUID on its own (measured on 0.65.1).
 *
 * A value containing a space cannot be told apart from the next entry, so the
 * socket path is used only when it is absolute and exists; otherwise the CLI
 * falls back to its own socket discovery.
 */
export function parseCmuxEnv(
  psOutput: string,
  commandOutput: string,
  pathExists: (path: string) => boolean = existsSync,
): CmuxSurface | undefined {
  // Remove only ps's record terminator; trimming argv whitespace would move
  // the boundary into an argument. No suffix or mismatched snapshots is unknown.
  const command = commandOutput.replace(/\n$/, '');
  const combined = psOutput.replace(/\n$/, '');
  if (!command || command.includes('\n') || !combined.startsWith(`${command} `)) return undefined;
  const environment = combined.slice(command.length + 1);
  const last = (name: string) =>
    [...environment.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S+)`, 'g'))].at(-1)?.[1];
  const surfaceId = last('CMUX_SURFACE_ID');
  if (!surfaceId || !CMUX_SURFACE_ID_RE.test(surfaceId)) return undefined;
  const socket = last('CMUX_SOCKET_PATH');
  const socketPath = socket && isAbsolute(socket) && pathExists(socket) ? socket : undefined;
  return { surfaceId, socketPath };
}

/** The surface the agent process was started in, or undefined when it does
 *  not run under cmux (or is gone, or is not this user's to read). */
export async function readCmuxSurface(pid: number, timeout = 2_000): Promise<CmuxSurface | undefined> {
  if (process.platform !== 'darwin' || !Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    const args = ['-ww', '-o', 'command=', '-p', String(pid)];
    const options = { encoding: 'utf8' as const, timeout };
    const before = await execFileAsync('ps', args, options);
    const combined = await execFileAsync('ps', ['-E', ...args], options);
    const after = await execFileAsync('ps', args, options);
    // A process may rewrite argv or exit between probes. Never use a shorter,
    // outdated argv prefix to reinterpret its newer arguments as environment.
    if (before.stdout !== after.stdout) return undefined;
    return parseCmuxEnv(combined.stdout, before.stdout);
  } catch {
    return undefined;
  }
}

type TerminalHost =
  | { kind: 'iterm2' | 'terminal-app' }
  | { kind: 'unavailable'; reason: string };

/** Read executable names, never argv: a prompt mentioning Terminal.app must
 * not select an Automation target. A single snapshot bounds both latency and
 * the ancestry walk; missing rows, failed reads and cycles remain unknown.
 * The nearest app wins, so an editor launched from iTerm2 still owns its own
 * embedded terminal. No Apple Events are needed to discover the host. */
async function readTerminalHost(pid: number | undefined): Promise<TerminalHost> {
  const unknown = (detail: string): TerminalHost => ({
    kind: 'unavailable', reason: `terminal host unknown (${detail})`,
  });
  if (process.platform !== 'darwin') return unknown('requires macOS');
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return unknown('no valid agent pid');
  try {
    const { stdout } = await execFileAsync(
      'ps', ['-ww', '-axo', 'pid=,ppid=,comm='],
      { encoding: 'utf8', timeout: 2_000 },
    );
    const rows = new Map<number, { ppid: number; executable: string }>();
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), executable: match[3] });
    }
    const seen = new Set<number>();
    for (let depth = 0; depth < 64 && pid > 1; depth++) {
      if (seen.has(pid)) return unknown('cyclic process ancestry');
      seen.add(pid);
      const row = rows.get(pid);
      if (!row) return unknown('incomplete process ancestry');
      if (/\/[^/]+\.app\/Contents\/MacOS\/iTerm2$/.test(row.executable)) {
        return { kind: 'iterm2' };
      }
      if (row.executable.endsWith('/Terminal.app/Contents/MacOS/Terminal')) {
        return { kind: 'terminal-app' };
      }
      const app = /\/([^/]+)\.app\/Contents\//.exec(row.executable)?.[1];
      if (app) return { kind: 'unavailable', reason: `terminal host not supported (${app})` };
      pid = row.ppid;
    }
    return unknown('no supported app ancestor');
  } catch {
    return unknown('process ancestry unreadable');
  }
}

/** `cmux` on PATH first. A LaunchAgent's PATH is frozen at `daemon install`,
 *  so the copy inside the app bundle is the fallback. */
const CMUX_BINS = ['cmux', '/Applications/cmux.app/Contents/Resources/bin/cmux'];

type CmuxRun = { ok: true } | { ok: false; missing?: true; message: string };

/** First line of a cmux error, without its `Error: ` prefix. */
export function cmuxErrorMessage(output: string): string {
  const line = output.split('\n').map((l) => l.trim()).find(Boolean) ?? 'unknown error';
  return line.replace(/^Error:\s*/, '').slice(0, 240);
}

async function runCmux(args: string[], surface: CmuxSurface): Promise<CmuxRun> {
  const env = surface.socketPath ? { ...process.env, CMUX_SOCKET_PATH: surface.socketPath } : process.env;
  for (const bin of CMUX_BINS) {
    try {
      await execFileAsync(bin, args, { encoding: 'utf8', timeout: 3_000, env });
      return { ok: true };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === 'ENOENT') continue;
      return { ok: false, message: cmuxErrorMessage(e.stderr || e.message) };
    }
  }
  return { ok: false, missing: true, message: 'cmux CLI not found' };
}

/**
 * Whether cmux refused the connection itself, as opposed to the command.
 *
 * Under the default Socket Control Mode ("cmux processes only") a process cmux
 * did not start — a LaunchAgent daemon is one — is cut off before any reply,
 * so `send` reports only `Broken pipe (errno 32)`. Measured on cmux 0.65.1.
 */
export function isCmuxSocketRefusal(message: string): boolean {
  return /broken pipe|errno 32|access denied/i.test(message);
}

/** The delivery reason for a failed cmux call. On a socket refusal `ping` is
 *  run on that branch alone, because it is answered with cmux's actual reason
 *  where `send` only saw the pipe close. */
async function cmuxFailureReason(run: Extract<CmuxRun, { ok: false }>, surface: CmuxSurface): Promise<string> {
  if (run.missing) return 'cmux CLI not found';
  if (!isCmuxSocketRefusal(run.message)) return `cmux: ${run.message}`;
  const ping = await runCmux(['ping'], surface);
  const why = ping.ok ? run.message : ping.message;
  return `cmux socket refused (${why}); set Socket Control Mode to Automation mode in cmux Settings`;
}

/**
 * Type a dictated line into the surface and submit it.
 *
 * Never `--force`: cmux refuses while the prompt holds text someone is typing
 * or a question is open, and that refusal is the "nothing happens" this
 * ladder promises. `--paste` because plain `send` turns a literal `\n` in the
 * text into Enter (measured), which would submit a dictated line early. The
 * Enter after it is not refused by the line just pasted (measured).
 */
async function injectTextViaCmux(surface: CmuxSurface, line: string): Promise<InjectResult> {
  const typed = await runCmux(['send', '--paste', '--surface', surface.surfaceId, '--', line], surface);
  if (!typed.ok) return { ok: false, reason: await cmuxFailureReason(typed, surface) };
  await pause(250);
  const submitted = await runCmux(['send-key', '--surface', surface.surfaceId, '--', 'Enter'], surface);
  if (!submitted.ok) {
    return { ok: false, reason: `text typed but not submitted: ${await cmuxFailureReason(submitted, surface)}` };
  }
  return { ok: true, via: 'cmux' };
}

/**
 * Answer the on-screen picker with paced Down×n + Enter.
 *
 * `--force` here and only here: cmux refuses keys while a question or dialog
 * is open (measured), and answering that dialog is what this path is for.
 * A break after some keys landed is reported, never retried elsewhere, for the
 * same reason as `TmuxOutcome`'s 'partial'.
 */
async function injectSelectionViaCmux(
  surface: CmuxSurface,
  downs: number,
  submits: number,
): Promise<InjectResult> {
  const key = (name: string) =>
    runCmux(['send-key', '--force', '--surface', surface.surfaceId, '--', name], surface);
  let sent = 0;
  const fail = async (run: Extract<CmuxRun, { ok: false }>): Promise<InjectResult> => {
    const why = await cmuxFailureReason(run, surface);
    return { ok: false, reason: sent > 0 ? `cmux injection broke partway: ${why}` : why };
  };
  for (let i = 0; i < downs; i++) {
    const r = await key('Down');
    if (!r.ok) return fail(r);
    sent++;
    await pause(KEY_PACE_MS);
  }
  for (let i = 0; i < submits; i++) {
    await pause(SUBMIT_PACE_MS);
    const r = await key('Enter');
    if (!r.ok) return fail(r);
    sent++;
  }
  return { ok: true, via: 'cmux' };
}

/**
 * AppleScript that types part of a selection into the iTerm2 session owning
 * `tty`. Arrows and the Enter that acts on them are emitted by SEPARATE calls
 * with a pause between (see `KEY_PACE_MS`): delivered as one burst the picker
 * resolves Enter against the pre-arrow cursor and answers option 0.
 */
export function buildItermSelectScript(
  tty: string,
  downs: number,
  opts: { enter?: boolean } = { enter: true },
): string {
  // ESC [ B per Down, then a bare `write text ""` for Enter (write text
  // appends CR by default; the arrow writes suppress it with `newline NO`).
  const writes: string[] = [];
  for (let i = 0; i < downs; i++) {
    writes.push('write s text ((character id 27) & "[B") newline NO');
  }
  if (opts.enter !== false) writes.push('write s text ""');
  return [
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if tty of s is "/dev/${tty}" then`,
    ...writes.map((l) => `          ${l}`),
    '          return "ok"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "notfound"',
  ].join('\n');
}

/**
 * AppleScript for Terminal.app: select the tab whose `tty` matches, WITHOUT
 * activating the app. Keys are then posted straight to Terminal's pid
 * (`buildPostKeysScript`), so answering a prompt never steals the user's
 * focus — measured 2026-07-26: iTerm2 stayed frontmost while the Terminal
 * tab received ESC[B + CR.
 */
export function buildTerminalAppSelectTabScript(tty: string): string {
  return [
    'set found to false',
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if tty of t is "/dev/${tty}" then`,
    '        set selected of t to true',
    '        set index of w to 1',
    '        set found to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if found then exit repeat',
    '  end repeat',
    'end tell',
    'if found then',
    '  return "ok"',
    'else',
    '  return "notfound"',
    'end if',
  ].join('\n');
}

/**
 * JXA that posts Down×n + Return directly to a running app's process with
 * `CGEventPostToPid` — the event reaches that app's key window without
 * raising it, so the user's foreground work is untouched.
 *
 * The app is matched by bundle id first and localized name second: on a
 * Korean system `Terminal` is "터미널", so name matching alone silently
 * missed it.
 *
 * Requires Accessibility permission for whatever process runs the daemon
 * (the terminal that launched it, or the LaunchAgent itself).
 */
export function buildPostKeysScript(
  match: { bundleIds?: string[]; names?: string[] },
  downs: number,
  submits = 1,
): string {
  const bundles = JSON.stringify(match.bundleIds ?? []);
  const names = JSON.stringify(match.names ?? []);
  return [
    "ObjC.import('ApplicationServices'); ObjC.import('AppKit');",
    `const wantBundles = ${bundles}; const wantNames = ${names};`,
    'function findPid() {',
    '  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;',
    '  for (let i = 0; i < apps.count; i++) {',
    '    const a = apps.objectAtIndex(i);',
    '    const b = ObjC.unwrap(a.bundleIdentifier);',
    '    if (b && wantBundles.indexOf(b) >= 0) return a.processIdentifier;',
    '  }',
    '  for (let i = 0; i < apps.count; i++) {',
    '    const a = apps.objectAtIndex(i);',
    '    const n = ObjC.unwrap(a.localizedName);',
    '    if (n && wantNames.indexOf(n) >= 0) return a.processIdentifier;',
    '  }',
    '  return -1;',
    '}',
    'const pid = findPid();',
    'if (pid < 0) { "notfound" } else {',
    '  function key(code) {',
    '    const d = $.CGEventCreateKeyboardEvent($(), code, true);',
    '    const u = $.CGEventCreateKeyboardEvent($(), code, false);',
    '    $.CGEventPostToPid(pid, d); $.CGEventPostToPid(pid, u);',
    '    delay(0.12);',
    '  }',
    // A background app drops the first posted events until its input queue is
    // warm: measured with 0.05s pacing and no lead-in, two Downs vanished and
    // only the Return landed (which would silently pick the WRONG option).
    '  delay(0.30);',
    `  for (let i = 0; i < ${downs}; i++) key(125);`,
    // A grouped AskUserQuestion answers its last question into a "Submit
    // answers" confirmation rather than closing, so it needs a second Return.
    `  delay(0.30); for (let i = 0; i < ${submits}; i++) { key(36); delay(0.30); }`,
    '  "ok"',
    '}',
  ].join('\n');
}

/**
 * AppleScript for an app-hosted session: press the button whose title matches
 * the option label inside the app's front window. Matching is
 * case-insensitive and prefix-tolerant (native buttons often shorten a long
 * option label). AXPress needs no focus change, so this is the preferred
 * app-hosted rung.
 */
export function buildAppButtonPressScript(appName: string, label: string): string {
  const app = escapeAppleScript(appName);
  // AppleScript text comparison ignores case by default — no lowercasing dance.
  const want = escapeAppleScript(label.trim());
  // `entire contents` yields a flat element list; AppleScript cannot filter it
  // with `every button of …`, so iterate and test the accessibility role.
  return [
    `tell application "System Events" to tell process "${app}"`,
    '  if not (exists window 1) then return "nowindow"',
    '  set target to missing value',
    '  repeat with e in (entire contents of window 1)',
    '    try',
    '      if role of e is "AXButton" or role of e is "AXRadioButton" then',
    '        set bt to name of e',
    '        if bt is not missing value and bt is not "" then',
    `          if bt is "${want}" or bt starts with "${want}" or "${want}" starts with bt then`,
    '            set target to e',
    '            exit repeat',
    '          end if',
    '        end if',
    '      end if',
    '    end try',
    '  end repeat',
    '  if target is missing value then return "nobutton"',
    '  click target',
    '  return "ok"',
    'end tell',
  ].join('\n');
}

/**
 * Last-resort key path: raise the app, post Down×n + Return through System
 * Events, restore the previous frontmost app. Only used when the focus-free
 * `CGEventPostToPid` route reports the app is not running or the app ignores
 * posted events.
 */
export function buildAppKeysScript(appName: string, downs: number, submits = 1): string {
  const app = escapeAppleScript(appName);
  const keyLines: string[] = [];
  for (let i = 0; i < downs; i++) { keyLines.push('key code 125'); keyLines.push('delay 0.12'); }
  keyLines.push('delay 0.30');
  // Grouped questions end on a "Submit answers" confirmation, not on close.
  for (let i = 0; i < submits; i++) { keyLines.push('key code 36'); keyLines.push('delay 0.30'); }
  return [
    'set prevApp to ""',
    'try',
    '  tell application "System Events" to set prevApp to name of first process whose frontmost is true',
    'end try',
    `tell application "${app}" to activate`,
    'delay 0.15',
    'tell application "System Events"',
    ...keyLines.map((l) => `  ${l}`),
    'end tell',
    'delay 0.05',
    `if prevApp is not "" and prevApp is not "${app}" then`,
    '  try',
    '    tell application prevApp to activate',
    '  end try',
    'end if',
    'return "ok"',
  ].join('\n');
}

async function runJxa(script: string, timeoutMs = 8_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script],
      { encoding: 'utf8', timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    debug('inject', `jxa failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

async function runOsa(script: string, timeoutMs = 8_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script],
      { encoding: 'utf8', timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    debug('inject', `osascript failed: ${String(err).slice(0, 200)}`);
    return null;
  }
}

/**
 * Answer the session's on-screen prompt by driving its host UI.
 * `index` is the zero-based option position (Claude's pickers start with the
 * cursor on the first option, so index == the number of Down presses).
 *
 * `confirmSubmit` covers the extra step a GROUPED AskUserQuestion adds: after
 * the last question is answered its picker does not close but shows a "Review
 * your answers → Submit answers / Cancel" confirmation, already sitting on
 * Submit. Without a second Enter the agent waits forever on a form the user
 * cannot see. Single-question calls have no such step, so this stays off for
 * them — an extra Enter there would land in the prompt box.
 */
export async function injectObservedSelection(
  target: InjectTarget,
  index: number,
  opts: { confirmSubmit?: boolean } = {},
): Promise<InjectResult> {
  if (index < 0 || index > 16) return { ok: false, reason: 'index out of range' };
  const { tty, appName, label } = target;
  if (!tty && !appName) return { ok: false, reason: 'no tty or app host for session' };
  const submits = opts.confirmSubmit ? 2 : 1;

  if (tty) {
    const viaTmux = await injectViaTmux(tty, index, submits);
    if (viaTmux === true) return { ok: true, via: 'tmux' };
    // Some keys landed before it broke: the cursor has already moved, so
    // falling through would send a second set of arrows on top of them.
    if (viaTmux === 'partial') {
      return { ok: false, reason: `tmux injection broke partway for ${tty}` };
    }
    const cmux = target.pid ? await readCmuxSurface(target.pid) : undefined;
    if (cmux) return injectSelectionViaCmux(cmux, index, submits);
    const host = await readTerminalHost(target.pid);
    if (host.kind === 'unavailable') return { ok: false, reason: host.reason };
    if (host.kind === 'iterm2' && await runOsa(buildItermSelectScript(tty, index, { enter: false }), 5_000) === 'ok') {
      for (let i = 0; i < submits; i++) {
        await pause(SUBMIT_PACE_MS);
        await runOsa(buildItermSelectScript(tty, 0), 5_000);
      }
      return { ok: true, via: 'iterm2' };
    }
    // Terminal.app: select the owning tab (no activation), then post keys to
    // its pid — focus-free.
    if (host.kind === 'terminal-app' && await runOsa(buildTerminalAppSelectTabScript(tty), 5_000) === 'ok') {
      const posted = await runJxa(
        buildPostKeysScript({ bundleIds: ['com.apple.Terminal'], names: ['Terminal', '터미널'] }, index, submits),
      );
      if (posted === 'ok') return { ok: true, via: 'terminal-app' };
      debug('inject', `Terminal.app tab selected but key post failed: ${posted ?? 'error'}`);
    }
    return { ok: false, reason: `no reachable terminal for ${tty}` };
  }

  // App-hosted. Try the labelled control first (works for native AppKit
  // dialogs); then focus-free key posting; raise+restore only as last resort.
  if (label) {
    const r = await runOsa(buildAppButtonPressScript(appName!, label));
    if (r === 'ok') return { ok: true, via: 'app-button' };
    debug('inject', `app-button press on ${appName}: ${r ?? 'error'}`);
  }
  const posted = await runJxa(
    buildPostKeysScript({ bundleIds: APP_BUNDLE_IDS[appName!] ?? [], names: [appName!] }, index, submits),
  );
  if (posted === 'ok') return { ok: true, via: 'app-keys' };
  if (await runOsa(buildAppKeysScript(appName!, index, submits)) === 'ok') {
    return { ok: true, via: 'app-keys-raised' };
  }
  return { ok: false, reason: `no reachable UI in ${appName}` };
}

/**
 * Type a whole line of text into the session's terminal and submit it — the
 * delivery path for a dictated prompt. Same host ladder as
 * `injectObservedSelection`, but writing text instead of arrow keys.
 *
 * Only terminal hosts are supported: typing free text into a GUI app's focused
 * field is far riskier (no way to know what has focus), and a spoken prompt
 * that lands in the wrong place is worse than one that is refused.
 */
export async function injectObservedText(
  target: InjectTarget,
  text: string,
): Promise<InjectResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty text' };
  // Newlines would submit early and split the prompt across turns.
  const line = trimmed.replace(/[\r\n]+/g, ' ');
  const { tty } = target;
  if (!tty) return { ok: false, reason: 'no tty for session (text injection is terminal-only)' };

  // tmux: -l sends the payload literally, then a separate Enter submits it.
  try {
    const { stdout } = await execFileAsync(
      'tmux', ['list-panes', '-a', '-F', '#{pane_tty}\t#{pane_id}'],
      { encoding: 'utf8', timeout: 2_000 },
    );
    const paneId = parseTmuxPanes(stdout).get(tty);
    if (paneId) {
      await execFileAsync('tmux', ['send-keys', '-t', paneId, '-l', line], { timeout: 2_000 });
      // Same beat as above: process spawn alone happens to provide ~50 ms, which
      // is not a guarantee worth relying on for the keystroke that commits.
      await new Promise((r) => setTimeout(r, 250));
      await execFileAsync('tmux', ['send-keys', '-t', paneId, 'Enter'], { timeout: 2_000 });
      return { ok: true, via: 'tmux' };
    }
  } catch { /* no tmux server — fall through */ }

  const cmux = target.pid ? await readCmuxSurface(target.pid) : undefined;
  if (cmux) return injectTextViaCmux(cmux, line);
  const host = await readTerminalHost(target.pid);
  if (host.kind === 'unavailable') return { ok: false, reason: host.reason };

  // iTerm2: type the line, pause, then submit with an explicit carriage return.
  //
  // `write text "..."` alone would do both — measured in raw mode it delivers
  // the text followed by 0x0d, which is the right byte (0x0a would land as a
  // newline *inside* the prompt instead of submitting it; the tty's ICRNL
  // translation hides that difference from any canonical-mode probe, so test
  // this with `stty raw` or the reading is meaningless). It is split anyway
  // because a TUI that treats one burst as a paste can absorb a trailing return
  // as content, and the same missing beat cost us the option keys earlier.
  const iterm = [
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if tty of s is "/dev/${tty}" then`,
    `          write s text "${escapeAppleScript(line)}" newline NO`,
    '          delay 0.25',
    '          write s text (ASCII character 13) newline NO',
    '          return "ok"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "notfound"',
  ].join('\n');
  if (host.kind === 'iterm2' && await runOsa(iterm, 5_000) === 'ok') return { ok: true, via: 'iterm2' };

  // Terminal.app: `do script … in <tab>` types into that tab and returns.
  const term = [
    'set done to false',
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if tty of t is "/dev/${tty}" then`,
    `        do script "${escapeAppleScript(line)}" in t`,
    '        set done to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if done then exit repeat',
    '  end repeat',
    'end tell',
    'if done then',
    '  return "ok"',
    'else',
    '  return "notfound"',
    'end if',
  ].join('\n');
  if (host.kind === 'terminal-app' && await runOsa(term, 5_000) === 'ok') return { ok: true, via: 'terminal-app' };

  return { ok: false, reason: `no reachable terminal for ${tty}` };
}
