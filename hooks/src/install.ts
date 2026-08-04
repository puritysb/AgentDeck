import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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
 *   5. `9120` fallback (legacy, never reached in practice)
 *
 * For (2)-(4) the snippet prefers the daemon's `httpPort` field when
 * present — Swift runs WS and HTTP on separate ports. Each candidate is
 * verified with a short `/health` probe so a stale daemon.json from a
 * crashed daemon doesn't swallow the hook.
 */
export function buildHookCommand(eventName: string): string {
  const preamble = [
    `PORT="\${AGENTDECK_PORT:-}"`,
    `case "$PORT" in ''|*[!0-9]*) PORT="" ;; *) [ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ] 2>/dev/null || PORT="" ;; esac`,
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));p=d.get('httpPort') or d.get('port');print(p if type(p) is int and 1 <= p <= 65535 else '')" "$F" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --connect-timeout 0.2 --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `  done`,
    `fi`,
    `PORT="\${PORT:-9120}"`,
  ];
  // PreToolUse is request-response: the daemon may hold the connection open and
  // return a permission decision (device approval) or a soft-STOP deny. Capture
  // the body and echo it to stdout so Claude can gate the tool; empty output
  // (timeout/error/disabled) = Claude's normal permission flow. `--max-time 60`
  // exceeds the daemon's internal hold timeout (default 25s) so the fallback
  // reaches Claude before curl quits.
  if (eventName === 'PreToolUse') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/PreToolUse" -H 'Content-Type: application/json' --max-time 60 -d @- 2>/dev/null)`,
      `printf '%s' "\${RESP:-}"`,
    ]).join('\n');
  }
  // Stop is also request-response: the daemon answers instantly — either an
  // empty body (turn ends normally) or `{decision:"block", reason}` delivering
  // a deck-queued directive so Claude continues with it. Short --max-time:
  // this runs on EVERY turn end, so a wedged daemon must never stall the TUI.
  if (eventName === 'Stop') {
    return preamble.concat([
      `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/Stop" -H 'Content-Type: application/json' --max-time 10 -d @- 2>/dev/null)`,
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
  // Hook cancelled` on exit.
  return preamble.concat([
    `curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/hooks/${eventName}" -H 'Content-Type: application/json' -d @- >/dev/null 2>&1 || true`,
  ]).join('\n');
}

/**
 * Windows variant of `buildHookCommand`. Claude Code v2.1+ executes hook
 * commands through `cmd.exe` on Windows, so we shell out to PowerShell for
 * the JSON read + HTTP POST. Discovery is narrower than POSIX since the
 * macOS App Store sandbox paths don't exist on Windows:
 *
 *   1. `$env:AGENTDECK_PORT`
 *   2. `%USERPROFILE%\.agentdeck\daemon.json` (verified with `/health` probe)
 *   3. `9120` fallback
 *
 * Single quotes are used inside the PowerShell script so the entire `-Command`
 * argument can stay double-quoted under cmd.exe. Errors are swallowed so a
 * dead daemon never blocks the host session.
 */
export function buildHookCommandWin(eventName: string): string {
  const ps = [
    `$ev='${eventName}'`,
    `[int]$port=0`,
    `[int]$candidate=0`,
    `if(!([int]::TryParse([string]$env:AGENTDECK_PORT,[ref]$candidate)) -or $candidate -lt 1 -or $candidate -gt 65535){$candidate=0}`,
    `$port=$candidate`,
    `if(-not $port){$f=Join-Path $env:USERPROFILE '.agentdeck\\daemon.json'; if(Test-Path $f){try{$d=Get-Content -Raw $f|ConvertFrom-Json; $raw=if($d.httpPort){$d.httpPort}else{$d.port}; $candidate=0; if([int]::TryParse([string]$raw,[ref]$candidate) -and $candidate -ge 1 -and $candidate -le 65535){try{Invoke-RestMethod -Uri ('http://127.0.0.1:'+$candidate+'/health') -TimeoutSec 1 -ErrorAction Stop|Out-Null; $port=$candidate}catch{}}}catch{}}}`,
    `if(-not $port){$port=9120}`,
    // Read stdin as UTF-8: [Console]::In decodes piped stdin with the console OEM
    // codepage (e.g. CP949), garbling non-ASCII payload text.
    `$body=(New-Object System.IO.StreamReader([Console]::OpenStandardInput(),[System.Text.Encoding]::UTF8)).ReadToEnd()`,
    // Post UTF-8 bytes: Invoke-RestMethod encodes a string body as ISO-8859-1 when
    // the content type carries no charset, replacing non-ASCII characters with '?'.
    `$bytes=[System.Text.Encoding]::UTF8.GetBytes([string]$body)`,
    `try{Invoke-RestMethod -Uri ('http://127.0.0.1:'+$port+'/hooks/'+$ev) -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 2 -ErrorAction Stop|Out-Null}catch{}`,
  ].join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`;
}

// Claude Code v2.1+ requires 3-level nesting: event → matcher group → hook handler.
export function buildHookEntry(eventName: string) {
  const command = process.platform === 'win32'
    ? buildHookCommandWin(eventName)
    : buildHookCommand(eventName);
  const handler: any = {
    type: 'command',
    command,
  };
  // Tool-specific hooks need a glob matcher to fire.
  // Empty string "" means "match nothing" for tool events — use "" for non-tool
  // events (SessionStart, Stop, etc.) where matcher is ignored.
  const needsToolMatcher = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(eventName);
  return {
    matcher: needsToolMatcher ? '*' : '',
    hooks: [handler],
  };
}

/** Pure logic: apply AgentDeck hooks to a settings object (no file I/O). */
export function applyHooks(settings: any): any {
  if (!settings.hooks) {
    settings.hooks = {};
  }
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }
    // Remove both old flat format and new matcher format
    settings.hooks[event] = settings.hooks[event].filter((h: any) => {
      if (h.command?.includes('AGENTDECK_PORT') || h.command?.includes('localhost:9120')) {
        return false;
      }
      if (Array.isArray(h.hooks) && h.hooks.some((hh: any) =>
        hh.command?.includes('AGENTDECK_PORT') || hh.command?.includes('localhost:9120')
      )) {
        return false;
      }
      return true;
    });
    settings.hooks[event].push(buildHookEntry(event));
  }
  return settings;
}

/** Pure logic: remove AgentDeck hooks from a settings object (no file I/O). */
export function removeHooks(settings: any): any {
  if (!settings.hooks) return settings;
  for (const event of HOOK_EVENTS) {
    if (settings.hooks[event]) {
      settings.hooks[event] = settings.hooks[event].filter((h: any) => {
        if (h.command?.includes('AGENTDECK_PORT') || h.command?.includes('localhost:9120')) {
          return false;
        }
        if (Array.isArray(h.hooks) && h.hooks.some((hh: any) =>
          hh.command?.includes('AGENTDECK_PORT') || hh.command?.includes('localhost:9120')
        )) {
          return false;
        }
        return true;
      });
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
  if (!raw.includes('AGENTDECK_PORT') && !raw.includes('localhost:9120')) return false;

  const settings = removeHooks(JSON.parse(raw));
  writeSettings(legacy, settings);
  return true;
}

/** File-system wrapper: install hooks into ~/.claude/settings.json */
export function installHooks(home: string = homedir()): void {
  const { dir, settings: settingsPath } = claudeSettingsPaths(home);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (sweepLegacyHooks(home)) {
    console.log('Removed stale hooks from ~/.claude/settings.local.json (never read by Claude Code)');
  }

  const settings = readSettings(settingsPath);
  applyHooks(settings);

  writeSettings(settingsPath, settings);
  console.log(`Hooks installed to ${settingsPath}`);
}

/** File-system wrapper: uninstall hooks from ~/.claude/settings.json (and the legacy file) */
export function uninstallHooks(home: string = homedir()): void {
  const { settings: settingsPath } = claudeSettingsPaths(home);
  sweepLegacyHooks(home);

  if (!existsSync(settingsPath)) return;

  const settings = removeHooks(readSettings(settingsPath));

  writeSettings(settingsPath, settings);
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
  applyHooks(settings);
  const after = JSON.stringify(settings);
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
    if (!raw.includes('AGENTDECK_PORT') && !raw.includes('localhost:9120')) return;

    const settings = JSON.parse(raw);
    let { migrated } = migrateHooks(settings);

    // Migration 4: upgrade hooks using simple :-9120 fallback to daemon.json-reading format.
    // This handles existing users from before daemon.json runtime lookup was added.
    if (raw.includes('AGENTDECK_PORT') && !raw.includes('daemon.json')) {
      applyHooks(settings);
      migrated = true;
    }

    // Migration 5: upgrade fire-and-forget Stop hooks to the request-response
    // form (turn-end directive queue needs the response echoed to Claude).
    if (raw.includes('/hooks/Stop') && !/RESP=\$\(curl[^\n]*\/hooks\/Stop/.test(raw)) {
      applyHooks(settings);
      migrated = true;
    }

    // Migration 6: PostToolUseFailure closes structured AskUserQuestion
    // overlays on ESC/tool failure. Existing installs predate this lifecycle
    // event, so refresh the AgentDeck-owned hook set once when it is absent.
    if (!settings.hooks?.PostToolUseFailure) {
      applyHooks(settings);
      migrated = true;
    }

    // Migration 7: bound curl calls left unbounded by a pre-fix installer.
    // Migrations 1-6 all miss this shape — such hooks already read daemon.json,
    // already echo Stop, already carry PostToolUseFailure; they just hang. This
    // is the self-heal path for a machine where an older App Store build keeps
    // rewriting the same settings.json the CLI installs into.
    if (hasUnboundedHookCurl(settings)) {
      applyHooks(settings);
      migrated = true;
    }

    // Migration 8: install read-only child/team lifecycle telemetry. These
    // hooks only post summaries; they never return steering decisions.
    if (
      !settings.hooks?.SubagentStart || !settings.hooks?.SubagentStop
      || !settings.hooks?.TaskCompleted || !settings.hooks?.TeammateIdle
    ) {
      applyHooks(settings);
      migrated = true;
    }

    // Migration 9: pre-validation hook snippets interpolated untrusted env /
    // daemon.json values directly into a loopback URL. Values containing `@`
    // can make URL parsers treat `127.0.0.1:<value>` as userinfo and send hook
    // payloads to a different host. Rebuild once with strict 1..65535 parsing.
    const hasValidatedPort = process.platform === 'win32'
      ? raw.includes('[int]::TryParse')
      : raw.includes('*[!0-9]*');
    if (!hasValidatedPort) {
      applyHooks(settings);
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
const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule) {
  const action = process.argv[2] || 'install';
  if (action === 'uninstall') {
    uninstallHooks();
    // The OpenCode observer plugin is AgentDeck-owned in its entirety, so
    // uninstall removes the file (unlike ~/.codex/config.toml, where only
    // the fenced block is AgentDeck's and removal has its own dedicated
    // flow to avoid touching user TOML).
    import('./opencode-install.js').then((m) => m.uninstallOpenCodeHooks()).catch(() => {});
  } else {
    installHooks();
  }
}
