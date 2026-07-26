// codex-install.ts — Install AgentDeck observation entries into
// ~/.codex/config.toml so Codex CLI sessions report turn boundaries and
// tool calls to the daemon via lifecycle hooks.
//
// Port of apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift, with
// the macOS-specific consent flow (NSAlert / NSOpenPanel / security-
// scoped bookmarks) stripped — Node CLI runs without sandboxing, so
// invocation is implicit consent. An opt-out env var
// `AGENTDECK_NO_CODEX_HOOKS=1` (or the `--no-codex-hooks` CLI flag) is
// honoured by callers.
//
// The fence sentinels and PORT-resolution shell are byte-identical with
// the Swift installer, so a config installed by either side can be
// migrated / uninstalled by the other without conflict.
//
// MUST stay in sync with apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift
// (managedBlockBody schema + lifecycle hook table layout).

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import {
  applyManagedBlock,
  removeManagedBlock,
  hasTopLevelKeyOutsideFence,
  hasTableOutsideFence,
  quoted,
} from './codex-mini-toml.js';

export const DEFAULT_CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
/** Sidecar script for the Windows notify fallback. Codex execs `notify`
 *  as a bare argv array (no shell) and appends the JSON payload as the
 *  last element; `powershell -File` is the only Windows invocation that
 *  binds trailing argv into `$args` (`-Command` concatenates them into
 *  the command text and `-EncodedCommand` rejects them outright), and
 *  `-File` requires a real script on disk. */
export const DEFAULT_WINDOWS_NOTIFY_SCRIPT_PATH = join(homedir(), '.agentdeck', 'codex-notify.ps1');
const DEFAULT_DAEMON_PORT = 9120;

export interface InstallOptions {
  /** Override the codex config path (tests + non-default homes). */
  configPath?: string;
  /** Daemon HTTP port to bake into the OTel exporter endpoint. If
   *  omitted, the installer reads `~/.agentdeck/daemon.json`. */
  daemonHttpPort?: number;
  /** Override platform for tests. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Override the Windows notify sidecar script path (tests). */
  notifyScriptPath?: string;
}

export interface InstallResult {
  installed: boolean;
  /** Human-readable reason when `installed === false`. */
  reason?: string;
  /** Non-fatal degradation while `installed === true` (e.g. the Windows
   *  notify sidecar could not be written, so notify was omitted). */
  warning?: string;
}

/** Honour `AGENTDECK_NO_CODEX_HOOKS=1` from the environment. Callers
 *  should also accept a `--no-codex-hooks` flag and short-circuit before
 *  calling install. */
function envOptOut(): boolean {
  return process.env.AGENTDECK_NO_CODEX_HOOKS === '1';
}

/** Read `~/.agentdeck/daemon.json` and return the daemon's HTTP port,
 *  preferring `httpPort` over `port`. The Apple build splits HTTP and
 *  WebSocket across different ports; the Node CLI uses a single port,
 *  so this still resolves correctly. Returns null if the file is
 *  missing or malformed. */
function currentDaemonHttpPort(): number | null {
  const path = join(homedir(), '.agentdeck', 'daemon.json');
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof obj.httpPort === 'number' && obj.httpPort > 0) return obj.httpPort;
    if (typeof obj.port === 'number' && obj.port > 0) return obj.port;
  } catch { /* malformed JSON — fall through */ }
  return null;
}

function buildOtelEndpoint(daemonHttpPort?: number): string {
  const port = daemonHttpPort ?? currentDaemonHttpPort() ?? DEFAULT_DAEMON_PORT;
  return `http://127.0.0.1:${port}/otel/v1/traces`;
}

// ─── Body assembly ──────────────────────────────────────────────────────

interface ManagedBlockOptions {
  includeNotify?: boolean;
  includeOtel?: boolean;
  otelEndpoint?: string;
  daemonHttpPort?: number;
  platform?: NodeJS.Platform;
  notifyScriptPath?: string;
}

/** Assemble the body of the AgentDeck-managed fence. Tests call this
 *  directly to assert schema regressions without driving the file
 *  installer. */
export function managedBlockBody(opts: ManagedBlockOptions = {}): string {
  const includeNotify = opts.includeNotify ?? true;
  const includeOtel = opts.includeOtel ?? true;
  const platform = opts.platform ?? process.platform;

  const lines: string[] = [
    '# Codex lifecycle hooks. Command hooks receive JSON on stdin;',
    '# each snippet forwards that stdin body unchanged to AgentDeck.',
    '[features]',
    'hooks = true',
  ];

  lines.push('');
  lines.push(...buildLifecycleHookTables(platform));

  if (includeNotify) {
    lines.push('');
    lines.push('# Optional turn-complete notification fallback.');
    if (platform === 'win32') {
      lines.push('# Codex appends the JSON payload as the last argv entry;');
      lines.push('# powershell -File binds it into $args. (-Command cannot:');
      lines.push('# it concatenates trailing argv into the command text.)');
    } else {
      lines.push('# Codex appends the JSON payload as the last argv entry,');
      lines.push('# so the 4th array element acts as $0 and payload lands at $1.');
    }
    lines.push(buildNotifyAssignment('codex_turn_complete', platform, opts.notifyScriptPath));
  }

  if (includeOtel) {
    lines.push('');
    lines.push('# OTel trace exporter — best-effort live progress signal.');
    lines.push('# Schema: [otel.trace_exporter.otlp-http].');
    lines.push('[otel.trace_exporter.otlp-http]');
    lines.push(`endpoint = ${quoted(opts.otelEndpoint ?? buildOtelEndpoint(opts.daemonHttpPort))}`);
    lines.push('protocol = "json"');
  }
  return lines.join('\n');
}

/** `notify = ["sh", "-c", "<snippet>", "agentdeck-notify"]`. Two design
 *  choices stacked here:
 *    1. `"sh"` uses PATH lookup so no absolute shell path lands in the
 *       installer config.
 *    2. The trailing `"agentdeck-notify"` is a dummy `$0`. Codex invokes
 *       `notify` by appending the JSON payload as the last argv entry.
 *       Without our 4th element, `sh -c "<snippet>" <json>` would assign
 *       `<json>` to `$0` and leave `$1` empty. With the dummy in place,
 *       `<json>` lands at `$1` as the snippet expects. */
function buildNotifyAssignment(event: string, platform: NodeJS.Platform, notifyScriptPath?: string): string {
  if (platform === 'win32') {
    const scriptPath = notifyScriptPath ?? DEFAULT_WINDOWS_NOTIFY_SCRIPT_PATH;
    // -WindowStyle Hidden: without it every notify flashes a console window.
    return `notify = ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ${quoted(scriptPath)}]`;
  }
  return `notify = ["sh", "-c", ${quoted(buildNotifySnippet(event))}, "agentdeck-notify"]`;
}

/** Codex notify snippet. PORT-resolution lines are byte-identical with
 *  `hooks/src/install.ts:buildHookCommand` so the two integrations share
 *  one canonical port-discovery contract. Only the trailing curl line
 *  differs: Claude hooks pipe stdin (`-d @-`); Codex notify hands the
 *  JSON payload as `$1` (`--data-raw "$1"`). */
function buildNotifySnippet(event: string): string {
  return [
    `PORT="\${AGENTDECK_PORT:-}"`,
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -c "import json;d=json.load(open('$F'));print(d.get('httpPort') or d.get('port',''))" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `  done`,
    `fi`,
    `PORT="\${PORT:-9120}"`,
    `curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/hooks/${event}" -H 'Content-Type: application/json' --data-raw "$1" 2>/dev/null || true`,
  ].join('\n');
}

interface LifecycleHook {
  codexEvent: string;
  agentDeckEvent: string;
  matcher: string | null;
}

const LIFECYCLE_HOOKS: LifecycleHook[] = [
  { codexEvent: 'SessionStart',     agentDeckEvent: 'codex_session_start',      matcher: 'startup|resume|clear' },
  { codexEvent: 'UserPromptSubmit', agentDeckEvent: 'codex_user_prompt_submit', matcher: null },
  { codexEvent: 'PreToolUse',       agentDeckEvent: 'codex_tool_start',         matcher: '*' },
  { codexEvent: 'PostToolUse',      agentDeckEvent: 'codex_tool_end',           matcher: '*' },
  { codexEvent: 'Stop',             agentDeckEvent: 'codex_stop',               matcher: null },
];

function buildLifecycleHookTables(platform: NodeJS.Platform): string[] {
  const lines: string[] = [];
  for (let idx = 0; idx < LIFECYCLE_HOOKS.length; idx++) {
    const hook = LIFECYCLE_HOOKS[idx];
    if (idx > 0) lines.push('');
    lines.push(`[[hooks.${hook.codexEvent}]]`);
    if (hook.matcher !== null) {
      lines.push(`matcher = ${quoted(hook.matcher)}`);
    }
    lines.push(`[[hooks.${hook.codexEvent}.hooks]]`);
    lines.push(`type = "command"`);
    lines.push(`command = ${quoted(buildLifecycleHookCommand(hook.agentDeckEvent, platform))}`);
    lines.push(`timeout = 5`);
  }
  return lines;
}

/** Official Codex lifecycle hooks pass their JSON payload on stdin.
 *  Keep stdout quiet so Stop / UserPromptSubmit hooks do not accidentally
 *  feed the daemon's acknowledgement back into Codex as hook output. */
function buildLifecycleHookCommand(event: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return buildWindowsLifecycleHookCommand(event);
  }
  return `sh -c ${shellSingleQuoted(buildStdinPostSnippet(event))}`;
}

function buildStdinPostSnippet(event: string): string {
  return [
    `PORT="\${AGENTDECK_PORT:-}"`,
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -c "import json;d=json.load(open('$F'));print(d.get('httpPort') or d.get('port',''))" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `  done`,
    `fi`,
    `PORT="\${PORT:-9120}"`,
    `curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/hooks/${event}" -H 'Content-Type: application/json' -d @- >/dev/null 2>&1 || true`,
  ].join('\n');
}

function shellSingleQuoted(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

function buildWindowsLifecycleHookCommand(event: string): string {
  // -WindowStyle Hidden: lifecycle hooks fire many times per session, so an
  // unhidden console reads as constant flickering.
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${windowsEncodedCommand(buildWindowsStdinPostSnippet(event))}`;
}

function buildWindowsStdinPostSnippet(event: string): string {
  // Read raw stdin as UTF-8: [Console]::In decodes with the console's OEM
  // codepage (e.g. CP949) and would garble non-ASCII payload text.
  return buildWindowsPostSnippet(
    event,
    '(New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)).ReadToEnd()'
  );
}

/** Body of the Windows notify sidecar script (`-File` execution binds
 *  Codex's appended payload argv into `$args`; take the last element to
 *  mirror POSIX `$1`). ASCII-only so PowerShell 5.1's BOM-less ANSI
 *  fallback reads it identically to UTF-8. Exported for tests. */
export function windowsNotifyScriptContent(event = 'codex_turn_complete'): string {
  return buildWindowsPostSnippet(event, `$(if ($args.Count -gt 0) { [string]$args[$args.Count - 1] } else { '' })`) + '\n';
}

function buildWindowsPostSnippet(event: string, bodyExpression: string): string {
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$port = $env:AGENTDECK_PORT`,
    `if ([string]::IsNullOrWhiteSpace($port)) {`,
    `  $daemonFile = Join-Path $env:USERPROFILE '.agentdeck\\daemon.json'`,
    `  if (Test-Path -LiteralPath $daemonFile) {`,
    `    try {`,
    `      $daemon = Get-Content -LiteralPath $daemonFile -Raw | ConvertFrom-Json`,
    `      $candidate = if ($daemon.httpPort) { $daemon.httpPort } else { $daemon.port }`,
    `      if ($candidate) {`,
    `        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ('http://127.0.0.1:' + $candidate + '/health') | Out-Null; $port = [string]$candidate } catch {}`,
    `      }`,
    `    } catch {}`,
    `  }`,
    `}`,
    `if ([string]::IsNullOrWhiteSpace($port)) { $port = '9120' }`,
    `$body = ${bodyExpression}`,
    // Post UTF-8 bytes: Invoke-RestMethod encodes string bodies as
    // ISO-8859-1 when the content type carries no charset, replacing
    // non-ASCII payload characters with '?'.
    `$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$body)`,
    `try { Invoke-RestMethod -Method Post -TimeoutSec 1 -Uri ('http://127.0.0.1:' + $port + '/hooks/${event}') -ContentType 'application/json; charset=utf-8' -Body $bytes | Out-Null } catch {}`,
    `exit 0`,
  ].join('\n');
}

function windowsEncodedCommand(s: string): string {
  return Buffer.from(s, 'utf16le').toString('base64');
}

// ─── File I/O ───────────────────────────────────────────────────────────

function readText(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/** Write the notify sidecar only when its content changed, so repeated
 *  installs stay idempotent (no mtime churn). Returns false when the
 *  script cannot be guaranteed on disk. */
function writeScriptIfChanged(content: string, path: string): boolean {
  try {
    if (existsSync(path) && readFileSync(path, 'utf-8') === content) return true;
  } catch { /* unreadable — fall through to rewrite */ }
  return writeTextAtomic(content, path);
}

function writeTextAtomic(text: string, path: string): boolean {
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.agentdeck.tmp`;
    writeFileSync(tmp, text, 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

// ─── Public install / uninstall / migrate ──────────────────────────────

/** Install AgentDeck's Codex observation entries into `~/.codex/config.toml`
 *  unless the user opted out, the user has authored a conflicting top-level
 *  `[features]` / `[hooks]` table outside the fence, or the file write
 *  failed. Idempotent: re-running with the same daemon port produces a
 *  byte-identical file, so safe to call from setup, `agentdeck codex`,
 *  and `agentdeck daemon install`. */
export function installCodexHooksIfNeeded(opts: InstallOptions = {}): InstallResult {
  if (envOptOut()) return { installed: false, reason: 'AGENTDECK_NO_CODEX_HOOKS=1' };

  const path = opts.configPath ?? DEFAULT_CODEX_CONFIG_PATH;
  const original = readText(path);

  // Refuse to clobber user-authored lifecycle hook config. This line-mode
  // editor cannot safely merge existing `[features]` or `[hooks]` tables
  // without a real TOML parser, and duplicate tables would make Codex
  // reject config.toml.
  if (hasTableOutsideFence(original, 'features')) {
    return { installed: false, reason: 'user-authored [features] present' };
  }
  if (hasTableOutsideFence(original, 'hooks')) {
    return { installed: false, reason: 'user-authored [hooks] present' };
  }

  const platform = opts.platform ?? process.platform;
  let includeNotify = !hasTopLevelKeyOutsideFence(original, 'notify');
  // OTel exporter stays POSIX-only for now — deliberately omitted on
  // win32 (unverified there); lifecycle hooks + notify carry the signal.
  const includeOtel = platform !== 'win32' && !hasTableOutsideFence(original, 'otel');

  let warning: string | undefined;
  const notifyScriptPath = opts.notifyScriptPath ?? DEFAULT_WINDOWS_NOTIFY_SCRIPT_PATH;
  if (includeNotify && platform === 'win32') {
    // The Stop lifecycle hook already reports turn-complete, so a failed
    // sidecar write downgrades to lifecycle-only rather than aborting.
    if (!writeScriptIfChanged(windowsNotifyScriptContent(), notifyScriptPath)) {
      includeNotify = false;
      warning = `notify sidecar write failed (${notifyScriptPath}) — notify fallback omitted`;
    }
  }

  const otelEndpoint = includeOtel ? buildOtelEndpoint(opts.daemonHttpPort) : undefined;
  const body = managedBlockBody({
    includeNotify,
    includeOtel,
    otelEndpoint,
    daemonHttpPort: opts.daemonHttpPort,
    platform,
    notifyScriptPath,
  });
  const updated = applyManagedBlock(original, body);

  if (updated === original) {
    return { installed: true, warning };
  }

  if (writeTextAtomic(updated, path)) {
    return { installed: true, warning };
  }
  return { installed: false, reason: `write failed: ${path}` };
}

/** Strip the AgentDeck-managed fence. Idempotent — no-op when the fence
 *  is absent. Does not delete the config file even if it becomes empty
 *  (Codex may rely on its existence). */
export function uninstallCodexHooks(opts: { configPath?: string; notifyScriptPath?: string } = {}): void {
  try {
    unlinkSync(opts.notifyScriptPath ?? DEFAULT_WINDOWS_NOTIFY_SCRIPT_PATH);
  } catch { /* absent on POSIX installs — nothing to remove */ }
  const path = opts.configPath ?? DEFAULT_CODEX_CONFIG_PATH;
  if (!existsSync(path)) return;
  const original = readText(path);
  const stripped = removeManagedBlock(original);
  if (stripped !== original) writeTextAtomic(stripped, path);
}

/** Re-apply the managed block when the daemon port (or any other resolved
 *  field) might have changed. Equivalent to install but renamed for the
 *  daemon-restart code path so the intent is clearer at the call site. */
export function migrateCodexHooks(opts: InstallOptions = {}): InstallResult {
  return installCodexHooksIfNeeded(opts);
}
