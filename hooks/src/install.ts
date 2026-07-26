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
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -c "import json;d=json.load(open('$F'));print(d.get('httpPort') or d.get('port',''))" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
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
  return preamble.concat([
    `curl -sf -X POST "http://127.0.0.1:$PORT/hooks/${eventName}" -H 'Content-Type: application/json' -d @- 2>/dev/null || true`,
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
 *
 * `-WindowStyle Hidden -NonInteractive` keep the console off screen. Without
 * them every hook flashes a PowerShell window, and since PreToolUse/PostToolUse
 * fire on *every* tool call that reads as constant flickering during a session.
 */
/** Marker identifying the request-response (steering-capable) Windows form. */
export const WIN_RESPONSE_MARKER = '[Console]::Out.Write';

export function buildHookCommandWin(eventName: string): string {
  const preamble = [
    `$ev='${eventName}'`,
    `$port=$env:AGENTDECK_PORT`,
    `if(-not $port){$f=Join-Path $env:USERPROFILE '.agentdeck\\daemon.json'; if(Test-Path $f){try{$d=Get-Content -Raw $f|ConvertFrom-Json; $p=if($d.httpPort){$d.httpPort}else{$d.port}; if($p){try{Invoke-RestMethod -Uri ('http://127.0.0.1:'+$p+'/health') -TimeoutSec 1 -ErrorAction Stop|Out-Null; $port=$p}catch{}}}catch{}}}`,
    `if(-not $port){$port=9120}`,
    // Read stdin as UTF-8: [Console]::In decodes piped stdin with the console OEM
    // codepage (e.g. CP949), garbling non-ASCII payload text.
    `$body=(New-Object System.IO.StreamReader([Console]::OpenStandardInput(),[System.Text.Encoding]::UTF8)).ReadToEnd()`,
    // Post UTF-8 bytes: Invoke-RestMethod encodes a string body as ISO-8859-1 when
    // the content type carries no charset, replacing non-ASCII characters with '?'.
    `$bytes=[System.Text.Encoding]::UTF8.GetBytes([string]$body)`,
  ];

  // PreToolUse and Stop are request-response on POSIX — the daemon answers with a
  // permission decision (device approval / soft-STOP) or a deck-queued turn-end
  // directive, and the hook echoes that body so Claude acts on it. Windows had no
  // such branch and piped every response to Out-Null, so device approval and the
  // directive queue silently did nothing here. Timeouts mirror the POSIX ones.
  //
  // Invoke-WebRequest, not Invoke-RestMethod: the latter deserializes a JSON body
  // into an object, and re-serializing it would not round-trip byte for byte.
  // -UseBasicParsing keeps PowerShell 5.1 off the Internet Explorer engine.
  // [Console]::Out.Write emits no trailing newline, matching `printf '%s'`.
  const responseTimeout = eventName === 'PreToolUse' ? 60 : 10;
  const ps = (eventName === 'PreToolUse' || eventName === 'Stop')
    ? preamble.concat([
      `try{$r=Invoke-WebRequest -Uri ('http://127.0.0.1:'+$port+'/hooks/'+$ev) -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec ${responseTimeout} -UseBasicParsing -ErrorAction Stop; ${WIN_RESPONSE_MARKER}([string]$r.Content)}catch{}`,
    ]).join('; ')
    : preamble.concat([
      `try{Invoke-RestMethod -Uri ('http://127.0.0.1:'+$port+'/hooks/'+$ev) -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 2 -ErrorAction Stop|Out-Null}catch{}`,
    ]).join('; ');

  return `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${ps}"`;
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

/** File-system wrapper: install hooks into ~/.claude/settings.local.json */
export function installHooks(): void {
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: any = {};
  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  }

  applyHooks(settings);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Hooks installed to ${settingsPath}`);
}

/** File-system wrapper: uninstall hooks from ~/.claude/settings.local.json */
export function uninstallHooks(): void {
  const settingsPath = join(homedir(), '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) return;

  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  removeHooks(settings);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('Hooks uninstalled');
}

/** File-system wrapper: migrate old hook formats in ~/.claude/settings.local.json.
 *  Silently catches errors to avoid breaking session startup. */
export function migrateHooksIfNeeded(): void {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.local.json');
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
    // The marker differs per platform: POSIX captures into $RESP, Windows writes
    // the body with [Console]::Out.Write. Testing only for the POSIX one made
    // this fire on every Windows startup (harmless but a pointless rewrite) while
    // never actually detecting a stale Windows hook.
    const hasResponseForm = process.platform === 'win32'
      ? raw.includes(WIN_RESPONSE_MARKER)
      : /RESP=\$\(curl[^\n]*\/hooks\/Stop/.test(raw);
    if (raw.includes('/hooks/Stop') && !hasResponseForm) {
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

    if (migrated) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
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
