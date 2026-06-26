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

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
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
const DEFAULT_DAEMON_PORT = 9120;

export interface InstallOptions {
  /** Override the codex config path (tests + non-default homes). */
  configPath?: string;
  /** Daemon HTTP port to bake into the OTel exporter endpoint. If
   *  omitted, the installer reads `~/.agentdeck/daemon.json`. */
  daemonHttpPort?: number;
}

export interface InstallResult {
  installed: boolean;
  /** Human-readable reason when `installed === false`. */
  reason?: string;
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
}

/** Assemble the body of the AgentDeck-managed fence. Tests call this
 *  directly to assert schema regressions without driving the file
 *  installer. */
export function managedBlockBody(opts: ManagedBlockOptions = {}): string {
  const includeNotify = opts.includeNotify ?? true;
  const includeOtel = opts.includeOtel ?? true;

  const lines: string[] = [
    '# Codex lifecycle hooks. Command hooks receive JSON on stdin;',
    '# each snippet forwards that stdin body unchanged to AgentDeck.',
    '[features]',
    'hooks = true',
  ];

  lines.push('');
  lines.push(...buildLifecycleHookTables());

  if (includeNotify) {
    lines.push('');
    lines.push('# Optional turn-complete notification fallback.');
    lines.push('# Codex appends the JSON payload as the last argv entry,');
    lines.push('# so the 4th array element acts as $0 and payload lands at $1.');
    lines.push(buildNotifyAssignment('codex_turn_complete'));
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
function buildNotifyAssignment(event: string): string {
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

function buildLifecycleHookTables(): string[] {
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
    lines.push(`command = ${quoted(buildLifecycleHookCommand(hook.agentDeckEvent))}`);
    lines.push(`timeout = 5`);
  }
  return lines;
}

/** Official Codex lifecycle hooks pass their JSON payload on stdin.
 *  Keep stdout quiet so Stop / UserPromptSubmit hooks do not accidentally
 *  feed the daemon's acknowledgement back into Codex as hook output. */
function buildLifecycleHookCommand(event: string): string {
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

// ─── File I/O ───────────────────────────────────────────────────────────

function readText(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
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

  const includeNotify = !hasTopLevelKeyOutsideFence(original, 'notify');
  const includeOtel = !hasTableOutsideFence(original, 'otel');

  const otelEndpoint = includeOtel ? buildOtelEndpoint(opts.daemonHttpPort) : undefined;
  const body = managedBlockBody({
    includeNotify,
    includeOtel,
    otelEndpoint,
    daemonHttpPort: opts.daemonHttpPort,
  });
  const updated = applyManagedBlock(original, body);

  if (updated === original) {
    return { installed: true };
  }

  if (writeTextAtomic(updated, path)) {
    return { installed: true };
  }
  return { installed: false, reason: `write failed: ${path}` };
}

/** Strip the AgentDeck-managed fence. Idempotent — no-op when the fence
 *  is absent. Does not delete the config file even if it becomes empty
 *  (Codex may rely on its existence). */
export function uninstallCodexHooks(opts: { configPath?: string } = {}): void {
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
