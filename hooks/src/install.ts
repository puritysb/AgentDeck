export { collectHermesDiagnostic, formatHermesDiagnostic } from './hermes-diagnostics.js';
export { installHermesObserver, parseHermesPortFlag } from './hermes-install.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Re-export the Codex installer surface so callers reach it via the
// canonical `@agentdeck/hooks` entry point alongside the Claude installer.
export {
  installCodexHooksIfNeeded,
  uninstallCodexHooks,
  migrateCodexHooks,
  managedBlockBody as codexManagedBlockBody,
  DEFAULT_CODEX_CONFIG_PATH,
} from './codex-install.js';
export type { InstallOptions as CodexInstallOptions, InstallResult as CodexInstallResult } from './codex-install.js';

// Re-export the OpenCode plugin installer (standalone-session observation
// via opencode_* lifecycle hooks) through the same canonical entry point.
export {
  installOpenCodeHooksIfNeeded,
  uninstallOpenCodeHooks,
  opencodePluginPath,
  opencodePluginSource,
} from './opencode-install.js';
export type { OpenCodeInstallOptions, OpenCodeInstallResult } from './opencode-install.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'Notification',
  // Display-only: Claude Code runs it the moment it is about to show its
  // permission dialog, ~6 s before the `permission_prompt` Notification. The
  // command is the fire-and-forget form and prints nothing, so it never
  // decides the prompt (empty stdout = no decision, the dialog shows).
  'PermissionRequest',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'TaskCompleted',
  'TeammateIdle',
] as const;

/**
 * Shell snippet that resolves the AgentDeck daemon's HTTP port at hook
 * runtime, then POSTs the hook payload to it. Kept in a single helper so
 * the three hook-writer code paths (`@agentdeck/hooks`, `@agentdeck/setup`
 * inlined copy, Swift `HookInstaller`) emit byte-identical shell.
 *
 * Discovery precedence:
 *   1. `$AGENTDECK_PORT` env var (set by `agentdeck claude` session bridge
 *      so the hook targets the *owning* daemon even when several daemons
 *      are running in parallel)
 *   2. `~/.agentdeck/daemon.json`                                  (CLI)
 *   3. App Store sandbox container `daemon.json`                   (Swift)
 *   4. Legacy App Store group container `daemon.json`              (Swift)
 * No implicit default port: without an explicit port or a healthy registry
 * candidate, the hook exits without transmitting its payload.
 *
 * For (2)-(4) the snippet prefers the daemon's `httpPort` field when
 * present — Swift runs WS and HTTP on separate ports. Each candidate is
 * verified with a short `/health` probe so a stale daemon.json from a
 * crashed daemon doesn't swallow the hook.
 */
export function buildHookCommand(eventName: string): string {
  // `X-AgentDeck-Pid: $PPID` — the hook shell's parent is the agent process
  // that spawned it, and the hook payload carries no pid of its own. It is the
  // only consent-free way either daemon can tie a session id to a process:
  // the CLI daemon can also read `~/.claude/sessions/<pid>.json`, but the
  // sandboxed daemon cannot, and the transcript is not held open. The daemon
  // walks up from this pid to the nearest agent process, so a wrapper shell
  // in between does not break it. This is what lets a `claude -p` worker be
  // attributed to the session whose Bash launched it (process ancestry).
  const preamble = [
    `PORT="\${AGENTDECK_PORT:-}"`,
    `case "$PORT" in ''|*[!0-9]*) PORT="" ;; *) [ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ] 2>/dev/null || PORT="" ;; esac`,
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -I -c "import json,sys,signal;signal.signal(signal.SIGALRM,lambda *_:sys.exit(0));signal.setitimer(signal.ITIMER_REAL,0.2);d=json.load(open(sys.argv[1]));p=d.get('httpPort') or d.get('port');print(p if type(p) is int and 1 <= p <= 65535 else '')" "$F" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --connect-timeout 0.2 --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `  done`,
    `fi`,
    `[ -n "$PORT" ] || exit 0`,
  ];
  // PreToolUse is request-response: the daemon may hold the connection open and
  // return a permission decision (device approval) or a soft-STOP deny. Capture
  // the body and echo it to stdout so Claude can gate the tool; empty output
  // (timeout/error/disabled) = Claude's normal permission flow. `--max-time 60`
  // exceeds the daemon's internal hold timeout (default 25s) so the fallback
  // reaches Claude before curl quits.
  if (eventName === 'PreToolUse') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/PreToolUse" -H 'Content-Type: application/json' -H "X-AgentDeck-Pid: $PPID" --max-time 60 -d @- 2>/dev/null)`,
      `printf '%s' "\${RESP:-}"`,
    ]).join('\n');
  }
  // Stop is also request-response: the daemon answers instantly — either an
  // empty body (turn ends normally) or `{decision:"block", reason}` delivering
  // a deck-queued directive so Claude continues with it. Short --max-time:
  // this runs on EVERY turn end, so a wedged daemon must never stall the TUI.
  if (eventName === 'Stop') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/Stop" -H 'Content-Type: application/json' -H "X-AgentDeck-Pid: $PPID" --max-time 10 -d @- 2>/dev/null)`,
      `printf '%s' "\${RESP:-}"`,
    ]).join('\n');
  }
  // Everything else is fire-and-forget telemetry: the daemon answers
  // `{received:true}` and nothing in the reply steers Claude, so the POST must
  // never outlive the host's patience. Short timeouts are mandatory, not an
  // optimization — SessionEnd hooks share a single ~1.5s abort budget
  // (Claude's `getSessionEndHookTimeoutMs()` floor), and a daemon that is
  // restarting holds the socket open without replying. An unbounded curl there
  // gets killed mid-flight and Claude prints `SessionEnd hook [...] failed:
  // Hook cancelled` on exit. `PermissionRequest` belongs here on purpose: it
  // is a display signal, and Claude Code waits for it before drawing the
  // dialog, so it must return at once and print nothing (no decision).
  return preamble.concat([
    `curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/hooks/${eventName}" -H 'Content-Type: application/json' -H "X-AgentDeck-Pid: $PPID" -d @- >/dev/null 2>&1 || true`,
  ]).join('\n');
}

/**
 * The Windows hook body, shipped as a script file rather than inlined into the
 * hook command.
 *
 * It MUST stay a file. Claude Code runs hook commands through a POSIX shell on
 * Windows (Git Bash, `sh -c`), which expands every `$name` before
 * `powershell.exe` ever parses the line: an inlined `-Command` arrived as
 * `='Stop'; [int]=0; ... [string]:AGENTDECK_PORT,[ref]` and died with
 * `Missing ')' in method call`, on every hook, on every turn. Double-quoting
 * inside the JSON does not help — the shell sees the whole command string. A
 * `-File` invocation keeps `$` off the command line entirely.
 *
 * Port discovery matches the POSIX snippet, minus the macOS App Store sandbox
 * containers which do not exist on Windows:
 *   1. `$env:AGENTDECK_PORT`
 *   2. `%USERPROFILE%\.agentdeck\daemon.json`
 * Registry discovery requires a bounded health probe. Without an explicit
 * valid port or a healthy registry candidate, skip observation.
 *
 * `PreToolUse` and `Stop` are request-response as on POSIX: the daemon's body
 * (device Allow/Deny, soft-STOP deny, queued directive) is written to stdout
 * as raw UTF-8 within the POSIX `--max-time` bounds (60 s / 10 s). The earlier
 * script piped every response to `Out-Null` with a 2 s timeout, so on Windows
 * no device decision, deck STOP or queued directive ever reached Claude.
 * The request bypasses proxy auto-detection and `Expect: 100-continue`.
 *
 * Errors are swallowed and the exit code is always 0 so a dead daemon never
 * blocks or fails the host session.
 */
export const WINDOWS_HOOK_SCRIPT = `# AgentDeck -> Claude Code hook bridge. Generated by @agentdeck/hooks; edits are overwritten.
# Invoked as: powershell -NoProfile -ExecutionPolicy Bypass -File "<this file>" -HookEvent <EventName>
#
# Must be a script file, NOT an inline -Command: Claude Code runs hook commands
# through Git Bash (sh -c) on Windows, which expands \$var references away before
# PowerShell sees them.
param([Parameter(Mandatory = \$true)][ValidatePattern('^[A-Za-z_]+\$')][string]\$HookEvent)

\$ErrorActionPreference = 'SilentlyContinue'

# PreToolUse and Stop are request-response, as in the POSIX hook: the daemon's
# answer (a device Allow/Deny, a soft-STOP deny, a queued deck directive) is
# written to stdout for Claude Code, bounded like the POSIX curl --max-time
# (60 s / 10 s). Every other event is fire-and-forget: bounded like --max-time
# 0.8, nothing printed.
\$timeoutMs = 800
\$respond = \$false
if (\$HookEvent -ceq 'PreToolUse') { \$timeoutMs = 60000; \$respond = \$true }
elseif (\$HookEvent -ceq 'Stop') { \$timeoutMs = 10000; \$respond = \$true }

# A valid explicit port is trusted as on POSIX. Otherwise discover one healthy
# registry candidate; no candidate means no observation request.
\$ports = @()
\$candidate = 0
if ([int]::TryParse([string]\$env:AGENTDECK_PORT, [ref]\$candidate) -and \$candidate -ge 1 -and \$candidate -le 65535) {
  \$ports = @(\$candidate)
} else {
  \$f = Join-Path \$env:USERPROFILE '.agentdeck\\daemon.json'
  if (Test-Path \$f) {
    try {
      \$d = Get-Content -Raw \$f | ConvertFrom-Json
      \$raw = if (\$d.httpPort) { \$d.httpPort } else { \$d.port }
      \$candidate = 0
      if ([int]::TryParse([string]\$raw, [ref]\$candidate) -and \$candidate -ge 1 -and \$candidate -le 65535) {
        \$probe = [System.Net.WebRequest]::Create('http://127.0.0.1:' + \$candidate + '/health')
        \$probe.Proxy = \$null
        \$probe.Timeout = 300; \$probe.ReadWriteTimeout = 300
        \$response = \$probe.GetResponse(); \$response.Close()
        \$ports = @(\$candidate)
      }
    } catch {}
  }
}
if (\$ports.Count -eq 0) { exit 0 }

# Read stdin as UTF-8: [Console]::In decodes piped stdin with the console OEM
# codepage (e.g. CP949), garbling non-ASCII payload text.
\$body = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)).ReadToEnd()
# Post UTF-8 bytes with an explicit charset; the daemon reads them as sent.
\$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]\$body)

# A loopback POST needs no proxy: system proxy auto-detection (WPAD) and the
# Expect: 100-continue wait can each add seconds before the request is sent.
try { [System.Net.WebRequest]::DefaultWebProxy = \$null } catch {}
try { [System.Net.ServicePointManager]::Expect100Continue = \$false } catch {}

foreach (\$port in \$ports) {
  try {
    \$req = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:' + \$port + '/hooks/' + \$HookEvent)
    \$req.Method = 'POST'
    \$req.Proxy = \$null
    \$req.ContentType = 'application/json; charset=utf-8'
    \$req.Timeout = \$timeoutMs
    \$req.ReadWriteTimeout = \$timeoutMs
    \$req.ContentLength = \$bytes.Length
    \$stream = \$req.GetRequestStream()
    \$stream.Write(\$bytes, 0, \$bytes.Length)
    \$stream.Close()
    \$resp = \$req.GetResponse()
    if (\$respond) {
      # Pass the daemon's UTF-8 bytes through unchanged: a console encoding
      # would turn a non-ASCII directive or reason into '?'.
      \$buffer = New-Object System.IO.MemoryStream
      \$resp.GetResponseStream().CopyTo(\$buffer)
      \$out = \$buffer.ToArray()
      if (\$out.Length -gt 0) {
        \$stdout = [Console]::OpenStandardOutput()
        \$stdout.Write(\$out, 0, \$out.Length)
        \$stdout.Flush()
      }
    }
    \$resp.Close()
    break
  } catch {
    # Never retry a payload against another receiver.
    break
  }
}

# Never block or fail the tool call.
exit 0
`;

/** Where the Windows hook script is installed. */
export function windowsHookScriptPath(home: string = homedir()): string {
  return join(home, '.agentdeck', 'agentdeck-hook.ps1');
}

/**
 * Write the Windows hook script, creating `~/.agentdeck` if needed. Idempotent:
 * rewrites only when the content differs, so a session-start migration does not
 * touch the file on every launch. Returns the path it points hooks at.
 */
export function ensureWindowsHookScript(home: string = homedir()): string {
  const path = windowsHookScriptPath(home);
  mkdirSync(join(home, '.agentdeck'), { recursive: true });
  if (!existsSync(path) || readFileSync(path, 'utf-8') !== WINDOWS_HOOK_SCRIPT) {
    writeFileSync(path, WINDOWS_HOOK_SCRIPT);
  }
  return path;
}

/**
 * Windows variant: invoke `agentdeck-hook.ps1` by path. The command line
 * carries no `$`, so the POSIX shell Claude Code spawns hooks through has
 * nothing to expand. See WINDOWS_HOOK_SCRIPT for why that matters.
 */
export function buildHookCommandWin(eventName: string, home: string = homedir()): string {
  const script = windowsHookScriptPath(home);
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -HookEvent ${eventName}`;
}

// ===== Claude Code status-line relay =====

/**
 * The status line is Claude Code's one documented carrier of the claude.ai
 * subscription windows (`rate_limits.five_hour` / `seven_day`), so AgentDeck
 * installs a status-line command that forwards Claude's status document to the
 * local daemon (`/claude/statusline`) and then runs whatever status line the
 * user already had, unchanged. Byte-identical with `@agentdeck/setup`'s
 * inlined copy and Swift `HookInstaller.buildStatuslineRelayCommand` — change
 * all three together. Rules for what the daemon does with the document:
 * `shared/src/claude-statusline.ts`.
 *
 * Two things this snippet does differently from the hook snippet, on purpose:
 * it never reads `$AGENTDECK_PORT` (a managed session bridge does not serve the
 * route — the account gauge belongs to the daemon), and it is fire-and-forget
 * only, bounded like a telemetry hook: Claude Code cancels a status-line
 * script the moment the next update arrives, so a hung curl costs a missed
 * repaint, never a stalled TUI. The wrapped command receives the same stdin
 * document through `printf '%s' "$I" |`.
 */
export const STATUSLINE_RELAY_MARKER = '/claude/statusline';
const STATUSLINE_RELAY_HEADER = '# AgentDeck status-line relay v1 — forwards Claude Code rate_limits to the local daemon; the status line you had runs below, unchanged.';
const STATUSLINE_WRAP_OPEN = `printf '%s' "$I" | {`;

export function buildStatuslineRelayCommand(original?: string | null): string {
  const lines = [
    STATUSLINE_RELAY_HEADER,
    `I=$(cat)`,
    `PORT=""`,
    `for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `  [ -f "$F" ] || continue`,
    `  P=$(python3 -I -c "import json,sys,signal;signal.signal(signal.SIGALRM,lambda *_:sys.exit(0));signal.setitimer(signal.ITIMER_REAL,0.2);d=json.load(open(sys.argv[1]));p=d.get('httpPort') or d.get('port');print(p if type(p) is int and 1 <= p <= 65535 else '')" "$F" 2>/dev/null)`,
    `  [ -n "$P" ] && curl -sf --connect-timeout 0.2 --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `done`,
    `if [ -n "$PORT" ]; then`,
    `printf '%s' "$I" | curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/claude/statusline" -H 'Content-Type: application/json' -H "X-AgentDeck-Pid: $PPID" -d @- >/dev/null 2>&1 || true`,
    `fi`,
  ];
  const own = original?.trim();
  if (own) lines.push(STATUSLINE_WRAP_OPEN, own, `}`);
  return lines.join('\n');
}

/**
 * The Windows relay body, shipped as a script file for the reason
 * WINDOWS_HOOK_SCRIPT documents: with Git Bash installed, Claude Code runs the
 * command through `sh -c`, which expands `$name` before PowerShell parses it. The
 * user's own status-line command travels as base64 (`-OriginalB64`) for the
 * same reason — nothing on the command line for `sh` to expand or quote — and
 * is run through Git Bash when available, otherwise PowerShell, matching
 * Claude Code's documented Windows shell selection with the same stdin.
 * Mirrored byte-identically in `setup/src/setup.ts`.
 */
export const WINDOWS_STATUSLINE_SCRIPT = `# AgentDeck -> Claude Code status-line relay. Generated by @agentdeck/hooks; edits are overwritten.
# Invoked as: powershell -NoProfile -ExecutionPolicy Bypass -File "<this file>" [-OriginalB64 <base64 of your own status-line command>]
#
# Must be a script file, NOT an inline -Command, for the reason agentdeck-hook.ps1
# documents: when installed, Git Bash (sh -c) expands \$var references before
# PowerShell sees them. Your own command travels as
# base64 for the same reason.
param([ValidatePattern('^[A-Za-z0-9+/=]*\$')][string]\$OriginalB64 = '')

\$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding(\$false) } catch {}

# Read stdin as UTF-8: [Console]::In decodes piped stdin with the console OEM
# codepage (e.g. CP949), garbling non-ASCII payload text.
\$body = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)).ReadToEnd()

\$port = 0
\$f = Join-Path \$env:USERPROFILE '.agentdeck\\daemon.json'
if (Test-Path \$f) {
  try {
    \$d = Get-Content -Raw \$f | ConvertFrom-Json
    \$raw = if (\$d.httpPort) { \$d.httpPort } else { \$d.port }
    \$candidate = 0
    if ([int]::TryParse([string]\$raw, [ref]\$candidate) -and \$candidate -ge 1 -and \$candidate -le 65535) {
      try {
        \$probe = [System.Net.WebRequest]::Create('http://127.0.0.1:' + \$candidate + '/health')
        \$probe.Proxy = \$null
        \$probe.Timeout = 300; \$probe.ReadWriteTimeout = 300
        \$response = \$probe.GetResponse(); \$response.Close()
        \$port = \$candidate
      } catch {}
    }
  } catch {}
}
# Post UTF-8 bytes; the daemon keeps only rate_limits (shared/src/claude-statusline.ts).
\$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]\$body)
if (\$port -gt 0) {
  try {
    Invoke-RestMethod -Uri ('http://127.0.0.1:' + \$port + '/claude/statusline') -Method Post -Body \$bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 2 -ErrorAction Stop | Out-Null
  } catch {}
}

# Your own status line, when one was wrapped: the same document on its stdin,
# its output is what Claude Code shows. Match Claude Code's Windows shell choice:
# Git Bash when available, otherwise the PowerShell running this relay.
if (\$OriginalB64) {
  \$script = \$null
  try {
    \$original = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\$OriginalB64))
    \$sh = \$env:CLAUDE_CODE_GIT_BASH_PATH
    if (-not \$sh -or -not (Test-Path \$sh)) { \$sh = (Get-Command bash -ErrorAction SilentlyContinue).Source }
    \$psi = New-Object System.Diagnostics.ProcessStartInfo
    if (\$sh) {
      \$script = [System.IO.Path]::GetTempFileName()
      [System.IO.File]::WriteAllText(\$script, \$original, (New-Object System.Text.UTF8Encoding(\$false)))
      \$psi.FileName = \$sh
      \$psi.Arguments = '"' + \$script.Replace('\\', '/') + '"'
    } else {
      \$psi.FileName = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
      # PowerShell captures its stdin reader before running a command that uses
      # the input variable. Parse the user's command after selecting UTF-8 and
      # feed that pipeline explicitly; leave raw stdin untouched otherwise.
      \$command = @'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding(\$false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding(\$false)
\$OutputEncoding = [Console]::OutputEncoding
\$userCommand = [ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__AGENTDECK_ORIGINAL__')))
\$usesInput = \$userCommand.Ast.Find({
  param(\$node)
  \$node -is [System.Management.Automation.Language.VariableExpressionAst] -and
    \$node.VariablePath.IsVariable -and
    \$node.VariablePath.UserPath -match '^(?:variable:)?(?:(?:global|local|script|private):)?input\$'
}, \$false)
if (\$usesInput) {
  & { while ((\$line = [Console]::In.ReadLine()) -ne \$null) { \$line } } | & \$userCommand
} else {
  & \$userCommand
}
'@
      \$command = \$command.Replace('__AGENTDECK_ORIGINAL__', \$OriginalB64)
      \$psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes(\$command))
    }
    \$psi.UseShellExecute = \$false
    \$psi.CreateNoWindow = \$true
    \$psi.RedirectStandardInput = \$true
    \$psi.RedirectStandardOutput = \$true
    \$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    \$p = [System.Diagnostics.Process]::Start(\$psi)
    \$stdin = New-Object System.IO.StreamWriter(\$p.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding(\$false)))
    \$stdin.Write(\$body)
    \$stdin.Close()
    \$out = \$p.StandardOutput.ReadToEnd()
    \$p.WaitForExit()
    [Console]::Out.Write(\$out)
  } catch {} finally {
    if (\$script) { Remove-Item \$script -Force }
  }
}

# Never block or fail the status line.
exit 0
`;

/** Where the Windows relay script is installed. */
export function windowsStatuslineScriptPath(home: string = homedir()): string {
  return join(home, '.agentdeck', 'agentdeck-statusline.ps1');
}

/** Write the Windows relay script, creating `~/.agentdeck` if needed. Idempotent. */
export function ensureWindowsStatuslineScript(home: string = homedir()): string {
  const path = windowsStatuslineScriptPath(home);
  mkdirSync(join(home, '.agentdeck'), { recursive: true });
  if (!existsSync(path) || readFileSync(path, 'utf-8') !== WINDOWS_STATUSLINE_SCRIPT) {
    writeFileSync(path, WINDOWS_STATUSLINE_SCRIPT);
  }
  return path;
}

/**
 * Windows variant: invoke `agentdeck-statusline.ps1` by path, the user's own
 * command riding as base64. The command line carries no `$` and no quote the
 * POSIX shell Claude Code spawns it through could misread.
 */
export function buildStatuslineRelayCommandWin(original?: string | null, home: string = homedir()): string {
  const base = `powershell -NoProfile -ExecutionPolicy Bypass -File "${windowsStatuslineScriptPath(home)}"`;
  const own = original?.trim();
  return own ? `${base} -OriginalB64 ${Buffer.from(own, 'utf-8').toString('base64')}` : base;
}

const WINDOWS_STATUSLINE_MARKER = 'agentdeck-statusline.ps1';

export function isAgentDeckStatuslineCommand(command: unknown): boolean {
  return typeof command === 'string'
    && (command.includes(STATUSLINE_RELAY_MARKER) || command.includes(WINDOWS_STATUSLINE_MARKER));
}

/**
 * The user's own command inside an AgentDeck relay: their text verbatim, `''`
 * when the relay was installed alone, `null` when the command is not ours.
 */
export function unwrapStatuslineCommand(command: unknown): string | null {
  if (!isAgentDeckStatuslineCommand(command)) return null;
  const text = command as string;
  if (text.includes(WINDOWS_STATUSLINE_MARKER)) {
    const encoded = /-OriginalB64 ([A-Za-z0-9+/=]+)/.exec(text);
    return encoded ? Buffer.from(encoded[1], 'base64').toString('utf-8') : '';
  }
  const open = `\n${STATUSLINE_WRAP_OPEN}\n`;
  const at = text.indexOf(open);
  if (at < 0) return '';
  const body = text.slice(at + open.length);
  return body.endsWith('\n}') ? body.slice(0, -2) : body;
}

function statuslineRelayCommandFor(original: string, platform: NodeJS.Platform, home: string): string {
  return platform === 'win32' ? buildStatuslineRelayCommandWin(original, home) : buildStatuslineRelayCommand(original);
}

/**
 * `auto` wraps a status line the user already has and installs nothing
 * otherwise; `on` installs the relay even with no status line — which makes
 * Claude Code hide its footer hints (`esc to interrupt`, `? for shortcuts`,
 * voice), so it is never the default; `off` removes an installed relay
 * (restoring the user's own status line) and never installs one.
 */
export type StatuslinePolicy = 'auto' | 'on' | 'off';

export function statuslinePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): StatuslinePolicy {
  const v = (env.AGENTDECK_STATUSLINE ?? '').trim().toLowerCase();
  if (v === '1' || v === 'on' || v === 'true') return 'on';
  if (v === '0' || v === 'off' || v === 'false') return 'off';
  return 'auto';
}

export interface StatuslineApplyResult {
  installed: boolean;
  /** True when a user command runs inside the relay. */
  wrapped: boolean;
  reason?: string;
}

/** Pure logic: install or refresh the relay in a settings object (no file I/O). */
export function applyStatuslineRelay(
  settings: any,
  policy: StatuslinePolicy = 'auto',
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): StatuslineApplyResult {
  if (policy === 'off') {
    const removed = removeStatuslineRelay(settings);
    return {
      installed: false,
      wrapped: false,
      reason: removed ? 'removed — your own status line is restored' : 'disabled (--no-statusline / AGENTDECK_STATUSLINE=0)',
    };
  }
  const current = settings.statusLine;
  if (current != null && (typeof current !== 'object' || Array.isArray(current))) {
    return { installed: false, wrapped: false, reason: 'statusLine is not an object; left untouched' };
  }
  const command = current?.command;
  const ours = isAgentDeckStatuslineCommand(command);
  if (current && !ours && typeof command !== 'string') {
    return { installed: false, wrapped: false, reason: 'statusLine carries no command; left untouched' };
  }
  const original = ours ? unwrapStatuslineCommand(command) ?? '' : (typeof command === 'string' ? command : '');
  if (!original.trim() && !ours && policy !== 'on') {
    return {
      installed: false,
      wrapped: false,
      reason: 'no status line configured — opt in with --statusline (a configured status line hides Claude Code\'s footer hints)',
    };
  }
  settings.statusLine = { ...(current ?? {}), type: 'command', command: statuslineRelayCommandFor(original, platform, home) };
  return { installed: true, wrapped: original.trim().length > 0 };
}

/** Pure logic: take the relay out again, restoring the user's own command verbatim. */
export function removeStatuslineRelay(settings: any): boolean {
  const current = settings?.statusLine;
  if (!current || typeof current !== 'object') return false;
  const original = unwrapStatuslineCommand(current.command);
  if (original == null) return false;
  if (original) settings.statusLine = { ...current, command: original };
  else delete settings.statusLine;
  return true;
}

/** Pure logic: keep an installed relay on the current snippet. Never installs one. */
export function refreshStatuslineRelay(
  settings: any,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): boolean {
  const current = settings?.statusLine;
  const original = current && typeof current === 'object' ? unwrapStatuslineCommand(current.command) : null;
  if (original == null) return false;
  const rebuilt = statuslineRelayCommandFor(original, platform, home);
  if (rebuilt === current.command) return false;
  settings.statusLine = { ...current, type: 'command', command: rebuilt };
  return true;
}

export const KIRO_HOOK_EVENTS = [
  ['SessionStart', 'kiro_session_start'],
  ['UserPromptSubmit', 'kiro_user_prompt_submit'],
  ['PreToolUse', 'kiro_tool_start'],
  ['PostToolUse', 'kiro_tool_end'],
  ['Stop', 'kiro_stop'],
] as const;

export interface KiroHookInstallResult {
  installed: boolean;
  path: string;
  reason?: string;
}

export function kiroHookPath(home: string = homedir()): string {
  return join(home, '.kiro', 'hooks', 'agentdeck-lifecycle.json');
}

/** Kiro v3 hooks are telemetry-only: never echo daemon steering into Kiro. */
export function buildKiroHookFile(home: string = homedir()): Record<string, unknown> {
  return {
    version: 'v1',
    hooks: KIRO_HOOK_EVENTS.map(([trigger, daemonEvent]) => ({
      name: `AgentDeck ${trigger}`,
      trigger,
      action: {
        type: 'command',
        // A prefixed event bypasses Claude's request-response branches in
        // buildHookCommand and reaches the agent-neutral observed pipeline.
        command: process.platform === 'win32'
          ? buildHookCommandWin(daemonEvent, home)
          : buildHookCommand(daemonEvent),
      },
      timeout: 2,
    })),
  };
}

/** Install the global Kiro v3 hook without changing how users launch Kiro. */
export function installKiroHooksIfNeeded(home: string = homedir()): KiroHookInstallResult {
  const kiroRoot = join(home, '.kiro');
  const path = kiroHookPath(home);
  if (!existsSync(kiroRoot)) {
    return { installed: false, path, reason: 'Kiro config directory not found' };
  }
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (!existing.includes('/hooks/kiro_') && !existing.includes('AgentDeck ')) {
      return { installed: false, path, reason: 'hook path is occupied by a non-AgentDeck file' };
    }
  }
  mkdirSync(join(kiroRoot, 'hooks'), { recursive: true });
  // Kiro may be installed without Claude. Repair the shared script even when
  // the JSON below is already current.
  if (process.platform === 'win32') ensureWindowsHookScript(home);
  const content = `${JSON.stringify(buildKiroHookFile(home), null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === content) {
    return { installed: true, path, reason: 'already current' };
  }
  writeFileSync(path, content);
  return { installed: true, path };
}

export function uninstallKiroHooks(home: string = homedir()): boolean {
  const path = kiroHookPath(home);
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, 'utf8');
  if (!existing.includes('/hooks/kiro_') && !existing.includes('AgentDeck ')) return false;
  unlinkSync(path);
  return true;
}

/**
 * Does this command belong to AgentDeck? Every writer/remover funnels through
 * here so a new hook shape cannot be added on one side and missed on the other
 * — the `-File` Windows form carries neither `AGENTDECK_PORT` nor
 * `localhost:9120`, so the older two-marker test left it behind on reinstall
 * and the settings file accumulated one live hook per install.
 */
export function isAgentDeckHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return command.includes('AGENTDECK_PORT')
    || command.includes('localhost:9120')
    || command.includes('agentdeck-hook.ps1');
}

/** The same test for a settings entry in either the flat or matcher-group shape. */
function isAgentDeckHookEntry(entry: any): boolean {
  if (isAgentDeckHookCommand(entry?.command)) return true;
  return Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => isAgentDeckHookCommand(h?.command));
}

// Claude Code v2.1+ requires 3-level nesting: event → matcher group → hook handler.
export function buildHookEntry(eventName: string, home: string = homedir()) {
  const command = process.platform === 'win32'
    ? buildHookCommandWin(eventName, home)
    : buildHookCommand(eventName);
  const handler: any = {
    type: 'command',
    command,
  };
  // Tool-specific hooks need a glob matcher to fire.
  // Empty string "" means "match nothing" for tool events — use "" for non-tool
  // events (SessionStart, Stop, etc.) where matcher is ignored.
  const needsToolMatcher = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(eventName);
  return {
    matcher: needsToolMatcher ? '*' : '',
    hooks: [handler],
  };
}

/**
 * Pure logic: apply AgentDeck hooks to a settings object (no file I/O).
 *
 * On Windows the hook body lives in a script file, so callers that persist the
 * result must also call `ensureWindowsHookScript()` — every file-system wrapper
 * in this module does.
 */
export function applyHooks(settings: any, home: string = homedir()): any {
  if (!settings.hooks) {
    settings.hooks = {};
  }
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }
    // Refresh only our handlers; a matcher group can also hold user commands.
    settings.hooks[event] = settings.hooks[event].flatMap((h: any) => {
      if (!isAgentDeckHookEntry(h)) return [h];
      if (!Array.isArray(h.hooks)) return [];
      const kept = h.hooks.filter((handler: any) => !isAgentDeckHookEntry(handler));
      return kept.length ? [{ ...h, hooks: kept }] : [];
    });
    settings.hooks[event].push(buildHookEntry(event, home));
  }
  return settings;
}

/** Pure logic: remove AgentDeck hooks from a settings object (no file I/O). */
export function removeHooks(settings: any): any {
  if (!settings.hooks) return settings;
  for (const event of HOOK_EVENTS) {
    if (settings.hooks[event]) {
      settings.hooks[event] = settings.hooks[event].filter((h: any) => !isAgentDeckHookEntry(h));
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return settings;
}

/**
 * Pure logic: does any AgentDeck hook still carry an unbounded `curl`?
 *
 * Two shapes qualify, both written by installers that predate the timeout fix
 * — including an older App Store app, which owns the very same
 * `~/.claude/settings.json` a current CLI writes:
 *   - a fire-and-forget POST with no `--max-time` (hangs on a daemon that
 *     holds the socket without replying, blowing Claude's ~1.5s SessionEnd
 *     abort budget → `SessionEnd hook [...] failed: Hook cancelled`)
 *   - a `/health` probe with no `--connect-timeout` (burns the same budget
 *     before the POST even starts)
 *
 * `PreToolUse`/`Stop` are exempt: they are request-response by design and
 * carry their own long `--max-time`. The Windows PowerShell form is bounded
 * by `-TimeoutSec` and has no `curl` to match.
 */
export function hasUnboundedHookCurl(settings: any): boolean {
  const lines = (cmd: string) => cmd.split('\n');
  for (const event of HOOK_EVENTS) {
    for (const group of settings?.hooks?.[event] ?? []) {
      const handlers = [group, ...(Array.isArray(group?.hooks) ? group.hooks : [])];
      for (const handler of handlers) {
        const cmd: unknown = handler?.command;
        if (typeof cmd !== 'string' || !cmd.includes('/hooks/')) continue;

        const probe = lines(cmd).find((l) => l.includes('curl') && l.includes('/health'));
        if (probe && !probe.includes('--connect-timeout')) return true;

        if (event === 'PreToolUse' || event === 'Stop') continue;
        const post = lines(cmd).find(
          (l) => l.includes('curl') && l.includes('-X POST') && l.includes('/hooks/'),
        );
        if (post && !post.includes('--max-time')) return true;
      }
    }
  }
  return false;
}

/** Pure logic: migrate old hook formats to v2.1 matcher-group format. */
export function migrateHooks(settings: any): { settings: any; migrated: boolean } {
  let migrated = false;
  if (!settings.hooks) return { settings, migrated };

  for (const event of Object.keys(settings.hooks)) {
    const hooks = settings.hooks[event];
    if (!Array.isArray(hooks)) continue;
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];

      // Migration 1: hardcoded port → env var (flat format)
      if (hook.command?.includes('localhost:9120') && !hook.command?.includes('AGENTDECK_PORT')) {
        hook.command = hook.command.replace(
          /localhost:9120/g,
          'localhost:${AGENTDECK_PORT:-9120}',
        );
        migrated = true;
      }

      // Migration 2: flat format → matcher-group format
      if (hook.type === 'command' && hook.command?.includes('AGENTDECK_PORT') && !hook.hooks) {
        const handler: Record<string, unknown> = { type: hook.type, command: hook.command };
        hooks[i] = { matcher: '', hooks: [handler] };
        migrated = true;
      }

      // Migration 3: hardcoded port inside matcher-group
      if (Array.isArray(hook.hooks)) {
        for (const inner of hook.hooks) {
          if (inner.command?.includes('localhost:9120') && !inner.command?.includes('AGENTDECK_PORT')) {
            inner.command = inner.command.replace(
              /localhost:9120/g,
              'localhost:${AGENTDECK_PORT:-9120}',
            );
            migrated = true;
          }
        }
      }
    }
  }
  return { settings, migrated };
}

/**
 * Where the hooks go, and where they used to go.
 *
 * Claude Code only reads hooks from files it watches: `~/.claude/settings.json`
 * (user-global), `<project>/.claude/settings.json`, and
 * `<project>/.claude/settings.local.json`. The *local* path is resolved against
 * the git root / cwd — so `~/.claude/settings.local.json`, which every node
 * installer used to target, is loaded only when the home directory happens to
 * be the project root. CLI-only installs therefore wrote hooks into a file
 * Claude never read; they fired only for users who ALSO ran the macOS app,
 * whose `HookInstaller` moved to the watched `settings.json` first.
 *
 * The legacy path is still swept on every install/migrate so the dead entries
 * don't linger as orphans next to the live ones.
 */
export function claudeSettingsPaths(home: string = homedir()) {
  const dir = join(home, '.claude');
  return {
    dir,
    settings: join(dir, 'settings.json'),
    legacy: join(dir, 'settings.local.json'),
  };
}

function readSettings(path: string): any {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeSettings(path: string, settings: any): void {
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Strip AgentDeck hooks out of the unwatched `~/.claude/settings.local.json`.
 * Returns true when the file actually carried them (i.e. this install predates
 * the settings.json move). Never deletes the file — users may keep unrelated
 * keys there.
 */
export function sweepLegacyHooks(home: string = homedir()): boolean {
  const { legacy } = claudeSettingsPaths(home);
  if (!existsSync(legacy)) return false;

  const raw = readFileSync(legacy, 'utf-8');
  if (!raw.includes('AGENTDECK_PORT') && !raw.includes('localhost:9120')
    && !raw.includes('agentdeck-hook.ps1')) return false;

  const settings = removeHooks(JSON.parse(raw));
  writeSettings(legacy, settings);
  return true;
}

export interface InstallHooksOptions {
  /** Claude status-line relay policy; `AGENTDECK_STATUSLINE=1|0` is the default. See `StatuslinePolicy`. */
  statusline?: StatuslinePolicy;
}

/** File-system wrapper: install hooks into ~/.claude/settings.json */
export function installHooks(home: string = homedir(), opts: InstallHooksOptions = {}): void {
  const { dir, settings: settingsPath } = claudeSettingsPaths(home);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (sweepLegacyHooks(home)) {
    console.log('Removed stale hooks from ~/.claude/settings.local.json (never read by Claude Code)');
  }

  if (process.platform === 'win32') {
    console.log(`Hook script written to ${ensureWindowsHookScript(home)}`);
  }

  const settings = readSettings(settingsPath);
  applyHooks(settings, home);
  const statusline = applyStatuslineRelay(settings, opts.statusline ?? statuslinePolicyFromEnv(), process.platform, home);
  if (process.platform === 'win32' && isAgentDeckStatuslineCommand(settings.statusLine?.command)) {
    ensureWindowsStatuslineScript(home);
  }

  writeSettings(settingsPath, settings);
  console.log(`Hooks installed to ${settingsPath}`);
  console.log(statusline.installed
    ? `Claude status-line relay ${statusline.wrapped ? 'wrapped around your status line' : 'installed (relay only)'}`
    : `Claude status-line relay not installed: ${statusline.reason}`);
}

/** File-system wrapper: uninstall hooks from ~/.claude/settings.json (and the legacy file) */
export function uninstallHooks(home: string = homedir()): void {
  const { settings: settingsPath } = claudeSettingsPaths(home);
  sweepLegacyHooks(home);

  if (!existsSync(settingsPath)) return;

  const settings = removeHooks(readSettings(settingsPath));
  if (removeStatuslineRelay(settings)) console.log('Claude status-line relay removed (your own status line restored)');

  writeSettings(settingsPath, settings);
  // The scripts are AgentDeck-owned in their entirety, like the OpenCode plugin.
  for (const script of [windowsHookScriptPath(home), windowsStatuslineScriptPath(home)]) {
    if (existsSync(script)) unlinkSync(script);
  }
  console.log('Hooks uninstalled');
}

/**
 * Relocate hooks left behind in the unwatched `~/.claude/settings.local.json`
 * into the watched `~/.claude/settings.json`. Returns true when it wrote
 * anything, in which case the settings.json hooks come straight from the
 * current builder and need no further migration.
 */
function relocateLegacyHooks(home: string = homedir()): boolean {
  const { settings: settingsPath } = claudeSettingsPaths(home);
  if (!sweepLegacyHooks(home)) return false;

  const settings = readSettings(settingsPath);
  const before = JSON.stringify(settings);
  applyHooks(settings, home);
  const after = JSON.stringify(settings);
  if (process.platform === 'win32') ensureWindowsHookScript(home);
  if (before !== after) {
    writeSettings(settingsPath, settings);
  }
  return true;
}

/** File-system wrapper: migrate old hook formats in ~/.claude/settings.json.
 *  Silently catches errors to avoid breaking session startup. */
export function migrateHooksIfNeeded(home: string = homedir()): void {
  try {
    const { settings: settingsPath } = claudeSettingsPaths(home);
    if (relocateLegacyHooks(home)) return;
    if (!existsSync(settingsPath)) return;

    const raw = readFileSync(settingsPath, 'utf-8');
    if (!raw.includes('AGENTDECK_PORT') && !raw.includes('localhost:9120')
      && !raw.includes('agentdeck-hook.ps1')) {
      // A relay may remain after hooks were removed independently. Refresh
      // that owned slot without silently reinstalling a hook set.
      if (raw.includes(STATUSLINE_RELAY_MARKER)) {
        const relayOnly = JSON.parse(raw);
        if (refreshStatuslineRelay(relayOnly, process.platform, home)) writeSettings(settingsPath, relayOnly);
      }
      return;
    }

    const settings = JSON.parse(raw);
    // Windows settings now contain a file path, not the inline validation
    // markers used by the POSIX migrations below. Converge the command set
    // by value and repair its script independently; current settings must
    // not be rewritten every time a session starts.
    if (process.platform === 'win32') {
      ensureWindowsHookScript(home);
      const before = JSON.stringify(settings);
      applyHooks(settings, home);
      // An installed relay keeps its script current too (never installed here).
      refreshStatuslineRelay(settings, 'win32', home);
      if (isAgentDeckStatuslineCommand(settings.statusLine?.command)) ensureWindowsStatuslineScript(home);
      if (JSON.stringify(settings) !== before) writeSettings(settingsPath, settings);
      return;
    }
    let { migrated } = migrateHooks(settings);

    // Migration 4: upgrade hooks using simple :-9120 fallback to daemon.json-reading format.
    // This handles existing users from before daemon.json runtime lookup was added.
    if (raw.includes('AGENTDECK_PORT') && !raw.includes('daemon.json')) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 5: upgrade fire-and-forget Stop hooks to the request-response
    // form (turn-end directive queue needs the response echoed to Claude).
    if (raw.includes('/hooks/Stop') && !/RESP=\$\(curl[^\n]*\/hooks\/Stop/.test(raw)) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 6: PostToolUseFailure closes structured AskUserQuestion
    // overlays on ESC/tool failure. Existing installs predate this lifecycle
    // event, so refresh the AgentDeck-owned hook set once when it is absent.
    if (!settings.hooks?.PostToolUseFailure) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 7: bound curl calls left unbounded by a pre-fix installer.
    // Migrations 1-6 all miss this shape — such hooks already read daemon.json,
    // already echo Stop, already carry PostToolUseFailure; they just hang. This
    // is the self-heal path for a machine where an older App Store build keeps
    // rewriting the same settings.json the CLI installs into.
    if (hasUnboundedHookCurl(settings)) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 8: install read-only child/team lifecycle telemetry. These
    // hooks only post summaries; they never return steering decisions.
    if (
      !settings.hooks?.SubagentStart || !settings.hooks?.SubagentStop
      || !settings.hooks?.TaskCompleted || !settings.hooks?.TeammateIdle
    ) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 9: pre-validation hook snippets interpolated untrusted env /
    // daemon.json values directly into a loopback URL. Values containing `@`
    // can make URL parsers treat `127.0.0.1:<value>` as userinfo and send hook
    // payloads to a different host. Rebuild once with strict 1..65535 parsing.
    const hasValidatedPort = raw.includes('*[!0-9]*');
    if (!hasValidatedPort) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 10: hooks predating the pid header cannot tell the daemon
    // which process posted them, so spawned-worker ancestry never resolves.
    if (!raw.includes('X-AgentDeck-Pid')) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 11: protected container reads can await an OS decision forever.
    // The Python timer bounds lookup before the existing healthy-port fallback.
    if (!raw.includes('signal.setitimer')) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 12: an installed Claude status-line relay is kept on the
    // current snippet. Never installed here — a status line is a visible
    // change to Claude Code's footer, so only `installHooks` adds one, under
    // its policy.
    if (refreshStatuslineRelay(settings, process.platform, home)) migrated = true;

    // Migration 13: the display-only `PermissionRequest` hook. Existing
    // installs predate it, so they keep showing a permission prompt only when
    // the Notification arrives ~6 s after the dialog. Checked by ownership,
    // not presence: a user's own PermissionRequest hook must not hide ours.
    const permissionRequestGroups = settings.hooks?.PermissionRequest;
    if (!Array.isArray(permissionRequestGroups) || !permissionRequestGroups.some(isAgentDeckHookEntry)) {
      applyHooks(settings, home);
      migrated = true;
    }

    // Migration 14: isolate Python imports and refuse an undiscovered receiver.
    // Refresh owned hooks even if an older installer overwrites a fixed snippet.
    const unsafeResolver = Object.values(settings.hooks ?? {}).some((groups: any) =>
      Array.isArray(groups) && groups.some((group: any) =>
        isAgentDeckHookEntry(group) && [group, ...(Array.isArray(group.hooks) ? group.hooks : [])].some((handler: any) =>
          typeof handler.command === 'string' && (handler.command.includes('python3 -c "import json,sys,signal;')
            || handler.command.includes('PORT="${PORT:-9120}"')),
        ),
      ),
    );
    if (unsafeResolver) {
      applyHooks(settings, home);
      migrated = true;
    }

    if (migrated) {
      writeSettings(settingsPath, settings);
    }
  } catch {
    // Silently ignore — migration is best-effort, never block session startup
  }
}

// CLI execution
// Use pathToFileURL so the comparison is correct on Windows too — process.argv[1]
// is a native path (E:\dev\...\install.js), but import.meta.url is a file:// URL
// (file:///E:/dev/.../install.js). Manually building `file://${argv[1]}` only
// matches on POSIX, which is why the installer used to be a silent no-op on
// Windows.
import { pathToFileURL } from 'url';
import { uninstallCodexHooks } from './codex-install.js';
const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule) {
  const action = process.argv[2] || 'install';
  if (action === 'uninstall') {
    uninstallHooks();
    // Only the fenced block of ~/.codex/config.toml is AgentDeck's. The
    // lossless editor removes the generated entries and keeps anything Codex
    // or the user added there; a file it cannot edit safely is kept and
    // reported. stdout, because scripts/uninstall.sh discards stderr.
    try {
      uninstallCodexHooks();
    } catch (e) {
      console.log(`Codex hooks kept: ${(e as Error).message}`);
    }
    // The OpenCode observer plugin is AgentDeck-owned in its entirety, so
    // uninstall removes the file.
    import('./opencode-install.js').then((m) => m.uninstallOpenCodeHooks()).catch(() => {});
    // `~/.kiro/hooks/agentdeck-lifecycle.json` is AgentDeck-owned in its
    // entirety like the OpenCode plugin, so uninstall removes the file.
    // `uninstallKiroHooks` existed and was unit-tested from the day it landed
    // but no caller ever reached it, so `scripts/uninstall.sh` left the file
    // behind — a test proves a function works, never that anything runs it.
    uninstallKiroHooks();
  } else {
    installHooks();
  }
}
