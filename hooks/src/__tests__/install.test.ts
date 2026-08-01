import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  HOOK_EVENTS,
  buildHookCommand,
  buildHookCommandWin,
  buildHookEntry,
  applyHooks,
  removeHooks,
  migrateHooks,
  claudeSettingsPaths,
  installHooks,
  uninstallHooks,
  migrateHooksIfNeeded,
  sweepLegacyHooks,
  hasUnboundedHookCurl,
} from '../install.js';

describe('Hook Installer', () => {
  describe('buildHookEntry', () => {
    it('creates matcher-group format with AGENTDECK_PORT env var', () => {
      const entry = buildHookEntry('SessionStart');
      expect(entry.matcher).toBe('');
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe('command');
      // Both POSIX and Windows commands reference AGENTDECK_PORT and the event name.
      // POSIX inlines the full `/hooks/<event>` path; Windows builds it via `/hooks/`+$ev,
      // so assert both substrings without assuming a single concatenated form.
      expect(entry.hooks[0].command).toContain('AGENTDECK_PORT');
      expect(entry.hooks[0].command).toContain('SessionStart');
      expect(entry.hooks[0].command).toContain('/hooks/');
    });

    it('uses `*` matcher for tool events and empty matcher for lifecycle events', () => {
      expect(buildHookEntry('PreToolUse').matcher).toBe('*');
      expect(buildHookEntry('PostToolUse').matcher).toBe('*');
      expect(buildHookEntry('PostToolUseFailure').matcher).toBe('*');
      expect(buildHookEntry('Stop').matcher).toBe('');
      expect(buildHookEntry('SessionStart').matcher).toBe('');
    });
  });

  describe('buildHookCommand (POSIX)', () => {
    it('reads PORT from AGENTDECK_PORT env var first, then daemon.json, then 9120', () => {
      const cmd = buildHookCommand('SessionStart');
      // Priority chain: AGENTDECK_PORT → ~/.agentdeck/daemon.json → App Store sandbox daemon.json → legacy group daemon.json → 9120
      expect(cmd).toContain('PORT="${AGENTDECK_PORT:-}"');
      expect(cmd).toContain('.agentdeck/daemon.json');
      expect(cmd).toContain('Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json');
      expect(cmd).toContain('group.bound.serendipity.agent.deck/daemon.json');
      expect(cmd).toContain('${PORT:-9120}');
      expect(cmd).toContain('-X POST "http://127.0.0.1:$PORT/hooks/SessionStart"');
    });

    it('bounds the fire-and-forget POST so a wedged daemon cannot stall session exit', () => {
      // SessionEnd hooks share one ~1.5s abort budget in Claude Code, and a
      // restarting daemon holds the socket open without replying. Without both
      // timeouts the hook gets killed mid-flight → "Hook cancelled" on exit.
      for (const event of ['SessionStart', 'SessionEnd', 'PostToolUse', 'Notification'] as const) {
        const cmd = buildHookCommand(event);
        expect(cmd).toContain('--connect-timeout 0.2');
        expect(cmd).toContain('--max-time 0.8');
      }
      // The health probe is bounded on connect too, for the same reason.
      expect(buildHookCommand('SessionEnd')).toContain('--connect-timeout 0.2 --max-time 0.3');
    });

    it('emits newline-separated shell so if/then/for/do keywords are not mis-terminated by `;`', () => {
      const cmd = buildHookCommand('SessionStart');
      // Regression guard: `; then;` / `; do;` is a zsh-only oddity that fails under
      // sh/bash — Claude Code runs hooks via /bin/sh so the joined output must
      // use newlines between statements.
      expect(cmd).not.toMatch(/;\s*then\s*;/);
      expect(cmd).not.toMatch(/;\s*do\s*;/);
      expect(cmd).toContain('\n');
    });
  });

  describe('buildHookCommandWin (Windows)', () => {
    it('wraps a PowerShell one-liner that targets the event endpoint', () => {
      const cmd = buildHookCommandWin('SessionStart');
      expect(cmd.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -Command "')).toBe(true);
      expect(cmd).toContain("$ev='SessionStart'");
      expect(cmd).toContain('$env:AGENTDECK_PORT');
      expect(cmd).toContain(".agentdeck\\daemon.json");
      expect(cmd).toContain("/hooks/'+$ev");
      expect(cmd).toContain('Invoke-RestMethod');
      expect(cmd).toContain('$port=9120');
    });

    it('uses single-line PowerShell so cmd.exe can pass it as one -Command argument', () => {
      const cmd = buildHookCommandWin('Stop');
      expect(cmd).not.toContain('\n');
    });

    it('omits the macOS App Store sandbox-container fallback paths', () => {
      const cmd = buildHookCommandWin('SessionStart');
      expect(cmd).not.toContain('Library/Containers/bound.serendipity');
      expect(cmd).not.toContain('group.bound.serendipity');
    });

    it('reads stdin as UTF-8 and posts UTF-8 bytes with charset (#46)', () => {
      const cmd = buildHookCommandWin('SessionStart');
      // Read stdin through a UTF-8 StreamReader — [Console]::In decodes piped
      // stdin with the OEM codepage (e.g. CP949) and garbles non-ASCII payloads.
      expect(cmd).toContain('StreamReader([Console]::OpenStandardInput()');
      expect(cmd).toContain('[System.Text.Encoding]::UTF8');
      expect(cmd).not.toContain('[Console]::In.ReadToEnd()');
      // POST UTF-8 bytes with a charset — Invoke-RestMethod encodes a string body
      // as ISO-8859-1 when the content type carries no charset, mangling non-ASCII.
      expect(cmd).toContain('[System.Text.Encoding]::UTF8.GetBytes');
      expect(cmd).toContain('application/json; charset=utf-8');
      // Still a single -Command line (cmd.exe passes it as one arg) and ASCII-only
      // (the non-ASCII payload arrives at runtime via stdin, never embedded here).
      expect(cmd).not.toContain('\n');
      expect(/^[\x00-\x7F]*$/.test(cmd)).toBe(true);
    });
  });

  describe('applyHooks', () => {
    it('installs hooks to empty settings in matcher-group format', () => {
      const result = applyHooks({});
      expect(result.hooks).toBeDefined();
      expect(Object.keys(result.hooks)).toHaveLength(HOOK_EVENTS.length);

      for (const event of HOOK_EVENTS) {
        expect(result.hooks[event]).toHaveLength(1);
        const group = result.hooks[event][0];
        const expectStar = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event);
        expect(group.matcher).toBe(expectStar ? '*' : '');
        expect(group.hooks).toHaveLength(1);
        expect(group.hooks[0].command).toContain('AGENTDECK_PORT');
        expect(group.hooks[0].command).toContain(event);
      }
    });

    it('preserves non-AgentDeck hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            { matcher: 'custom', hooks: [{ type: 'command', command: 'echo "custom hook"' }] },
          ],
        },
      };
      const result = applyHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(2);
      expect(result.hooks.SessionStart[0].hooks[0].command).toBe('echo "custom hook"');
    });

    it('replaces old flat-format hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              type: 'command',
              command: 'curl -sf -X POST http://localhost:9120/hooks/SessionStart ...',
            },
          ],
        },
      };
      const result = applyHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('replaces old matcher-format hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'curl -sf http://localhost:9120/hooks/SessionStart' }],
            },
          ],
        },
      };
      const result = applyHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('is idempotent — running twice produces same result', () => {
      const first = applyHooks({});
      const second = applyHooks(JSON.parse(JSON.stringify(first)));

      for (const event of HOOK_EVENTS) {
        expect(second.hooks[event]).toHaveLength(1);
      }
    });

    it('preserves existing non-hook settings', () => {
      const settings = { permissions: { allow: true }, other: 'value' };
      const result = applyHooks(settings);
      expect(result.permissions).toEqual({ allow: true });
      expect(result.other).toBe('value');
    });
  });

  describe('removeHooks', () => {
    it('removes all AgentDeck hooks (new format)', () => {
      const installed = applyHooks({});
      const result = removeHooks(installed);
      expect(result.hooks).toBeUndefined();
    });

    it('removes old flat-format AgentDeck hooks', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            { type: 'command', command: 'curl -sf http://localhost:9120/hooks/PreToolUse ...' },
          ],
        },
      };
      const result = removeHooks(settings);
      expect(result.hooks).toBeUndefined();
    });

    it('preserves non-AgentDeck hooks', () => {
      const settings = applyHooks({});
      settings.hooks.SessionStart.unshift({
        matcher: 'custom',
        hooks: [{ type: 'command', command: 'echo "keep me"' }],
      });
      const result = removeHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toBe('echo "keep me"');
    });

    it('handles empty settings gracefully', () => {
      const result = removeHooks({});
      expect(result.hooks).toBeUndefined();
    });
  });

  describe('migrateHooks', () => {
    it('migrates old hardcoded port to env var', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              type: 'command',
              command:
                "curl -sf -X POST http://localhost:9120/hooks/SessionStart -H 'Content-Type: application/json' -d @- 2>/dev/null || true",
            },
          ],
        },
      };
      const { settings: migrated, migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      // Should be migrated to matcher-group format
      expect(migrated.hooks.SessionStart[0].hooks).toBeDefined();
      expect(migrated.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('migrates flat format to matcher-group format', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              type: 'command',
              command: "curl -sf -X POST http://localhost:${AGENTDECK_PORT:-9120}/hooks/PreToolUse ...",
            },
          ],
        },
      };
      const { settings: migrated, migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      expect(migrated.hooks.PreToolUse[0].matcher).toBe('');
      expect(migrated.hooks.PreToolUse[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('skips already-migrated hooks (new format)', () => {
      const settings = applyHooks({});
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(false);
    });

    it('skips non-AgentDeck hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo "unrelated"' }] },
          ],
        },
      };
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(false);
    });

    it('migrates multiple events at once', () => {
      const settings: any = { hooks: {} };
      for (const event of HOOK_EVENTS) {
        settings.hooks[event] = [
          {
            type: 'command',
            command: `curl -sf -X POST http://localhost:9120/hooks/${event} ...`,
          },
        ];
      }
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      for (const event of HOOK_EVENTS) {
        expect(settings.hooks[event][0].hooks).toBeDefined();
        expect(settings.hooks[event][0].hooks[0].command).toContain('AGENTDECK_PORT');
      }
    });

    it('migrates hardcoded port inside matcher-group', () => {
      const settings = {
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{
                type: 'command',
                command: "curl -sf http://localhost:9120/hooks/Stop ...",
              }],
            },
          ],
        },
      };
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      expect(settings.hooks.Stop[0].hooks[0].command).toContain('AGENTDECK_PORT');
      expect(settings.hooks.Stop[0].hooks[0].command).not.toContain('localhost:9120');
    });
  });

  describe('migrateHooksIfNeeded (file-based)', () => {
    it('upgrades old :-9120 fallback hooks to daemon.json-reading format', () => {
      // The new format should contain daemon.json instead of the old :-9120 fallback.
      // Test the POSIX builder directly so the assertion shape is stable regardless of
      // host OS — `applyHooks` picks the platform variant.
      const newCmd = buildHookCommand('SessionStart');
      expect(newCmd).toContain('daemon.json');
      expect(newCmd).not.toContain('${AGENTDECK_PORT:-9120}');
      expect(newCmd).toContain('$PORT');
    });
  });
});

describe('steering hook channels (request-response)', () => {
  it('PreToolUse and Stop echo the daemon response to stdout; others stay fire-and-forget', () => {
    const pre = buildHookCommand('PreToolUse');
    expect(pre).toContain('RESP=$(curl');
    expect(pre).toContain("printf '%s'");

    const stop = buildHookCommand('Stop');
    expect(stop).toContain('RESP=$(curl');
    expect(stop).toContain("printf '%s'");
    // Runs on EVERY turn end — short timeout so a wedged daemon can't stall the TUI.
    expect(stop).toContain('--max-time 10');

    const notif = buildHookCommand('Notification');
    expect(notif).not.toContain('RESP=');
    expect(notif).toContain('|| true');
  });

  it('migration 5 rewrites legacy Stop hooks to the current platform hook set (request-response on POSIX)', () => {
    const legacyStopCommand = [
      'PORT="${AGENTDECK_PORT:-}"',
      '# daemon.json lookup elided',
      'curl -sf -X POST "http://127.0.0.1:$PORT/hooks/Stop" -H \'Content-Type: application/json\' -d @- 2>/dev/null || true',
    ].join('\n');
    const settings = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: legacyStopCommand }] }],
      },
    };
    const raw = JSON.stringify(settings);
    // Same predicate migrateHooksIfNeeded uses to decide on a rewrite.
    expect(raw.includes('/hooks/Stop') && !/RESP=\$\(curl[^\n]*\/hooks\/Stop/.test(raw)).toBe(true);

    applyHooks(settings);
    const stopCmd = (settings.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((h) => h.hooks).map((h) => h.command).join('\n');
    // The essential property: the legacy fire-and-forget hook was rewritten to
    // the current platform hook set. Only POSIX has a request-response Stop
    // variant; win32 emits its fire-and-forget PowerShell form (which builds the
    // URI as '/hooks/'+$ev, so the literal '/hooks/Stop' never appears in it).
    if (process.platform === 'win32') {
      expect(stopCmd).toContain('Invoke-RestMethod');
      expect(stopCmd).toContain("$ev='Stop'");
    } else {
      expect(stopCmd).toContain('RESP=$(curl');
      expect(stopCmd).toContain('/hooks/Stop');
    }
  });
});

describe('install target (~/.claude/settings.json)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const read = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));
  const legacyHookFile = (extra: Record<string, unknown> = {}) => ({
    ...extra,
    hooks: {
      SessionEnd: [
        {
          matcher: '',
          hooks: [{
            type: 'command',
            // Pre-move shape: unwatched file, unbounded POST.
            command: 'PORT="${AGENTDECK_PORT:-9120}"\ncurl -sf -X POST "http://127.0.0.1:$PORT/hooks/SessionEnd" -d @- || true',
          }],
        },
      ],
    },
  });

  it('installs into the watched settings.json, never settings.local.json', () => {
    const { settings, legacy } = claudeSettingsPaths(home);
    installHooks(home);

    expect(existsSync(legacy)).toBe(false);
    const written = read(settings);
    for (const event of HOOK_EVENTS) {
      expect(written.hooks[event]).toHaveLength(1);
    }
  });

  it('strips AgentDeck hooks out of the legacy file while keeping the user keys', () => {
    const { legacy } = claudeSettingsPaths(home);
    writeFileSync(legacy, JSON.stringify(legacyHookFile({ permissions: { allow: ['Bash(ls *)'] } })));

    expect(sweepLegacyHooks(home)).toBe(true);

    const after = read(legacy);
    expect(after.permissions).toEqual({ allow: ['Bash(ls *)'] });
    expect(after.hooks).toBeUndefined();
    // Nothing left to sweep on a second pass.
    expect(sweepLegacyHooks(home)).toBe(false);
  });

  it('relocates pre-move installs from the legacy file into settings.json', () => {
    const { settings, legacy } = claudeSettingsPaths(home);
    writeFileSync(legacy, JSON.stringify(legacyHookFile()));

    migrateHooksIfNeeded(home);

    expect(read(legacy).hooks).toBeUndefined();
    const relocated = read(settings);
    for (const event of HOOK_EVENTS) {
      expect(relocated.hooks[event]).toHaveLength(1);
    }
    // Relocation rebuilds from the current builder, so the bounded form lands
    // even though the legacy entry was unbounded.
    const sessionEnd = relocated.hooks.SessionEnd[0].hooks[0].command;
    expect(sessionEnd).toContain('daemon.json');
    if (process.platform !== 'win32') {
      expect(sessionEnd).toContain('--max-time 0.8');
    }
  });

  it('leaves a settings.json without AgentDeck hooks untouched', () => {
    const { settings } = claudeSettingsPaths(home);
    const user = { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    writeFileSync(settings, JSON.stringify(user, null, 2));
    const before = readFileSync(settings, 'utf-8');

    migrateHooksIfNeeded(home);

    expect(readFileSync(settings, 'utf-8')).toBe(before);
  });

  it('uninstalls from both the current and the legacy file', () => {
    const { settings, legacy } = claudeSettingsPaths(home);
    writeFileSync(legacy, JSON.stringify(legacyHookFile()));
    installHooks(home);
    expect(read(settings).hooks.SessionEnd).toHaveLength(1);

    uninstallHooks(home);

    expect(read(settings).hooks).toBeUndefined();
    expect(read(legacy).hooks).toBeUndefined();
  });
});

describe('migration 7 — unbounded curl self-heal', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-m7-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * What an App Store build from before the timeout fix writes: current in
   * every other respect (daemon.json discovery, request-response Stop,
   * PostToolUseFailure present) — so migrations 1-6 all pass it by.
   */
  const preFixSettings = () => {
    const preamble = [
      'PORT="${AGENTDECK_PORT:-}"',
      'if [ -z "$PORT" ]; then',
      '  for F in "$HOME/.agentdeck/daemon.json"; do',
      '    [ -f "$F" ] || continue',
      '    P=$(python3 -c "..." 2>/dev/null)',
      '    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }',
      '  done',
      'fi',
      'PORT="${PORT:-9120}"',
    ];
    const command = (event: string) => {
      if (event === 'PreToolUse' || event === 'Stop') {
        const cap = event === 'PreToolUse' ? 60 : 10;
        return preamble.concat([
          `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/${event}" -H 'Content-Type: application/json' --max-time ${cap} -d @- 2>/dev/null)`,
          `printf '%s' "\${RESP:-}"`,
        ]).join('\n');
      }
      return preamble.concat([
        `curl -sf -X POST "http://127.0.0.1:$PORT/hooks/${event}" -H 'Content-Type: application/json' -d @- >/dev/null 2>&1 || true`,
      ]).join('\n');
    };
    const hooks: Record<string, unknown> = {};
    for (const event of HOOK_EVENTS) {
      hooks[event] = [{
        matcher: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event) ? '*' : '',
        hooks: [{ type: 'command', command: command(event) }],
      }];
    }
    return { hooks };
  };

  it('flags a pre-fix hook set that every earlier migration passes by', () => {
    const settings = preFixSettings();
    // Migrations 4-6 look at exactly these three signals and find nothing wrong.
    const raw = JSON.stringify(settings);
    expect(raw.includes('daemon.json')).toBe(true);
    expect(/RESP=\$\(curl[^\n]*\/hooks\/Stop/.test(raw)).toBe(true);
    expect(settings.hooks.PostToolUseFailure).toBeDefined();

    expect(hasUnboundedHookCurl(settings)).toBe(true);
    expect(hasUnboundedHookCurl(applyHooks(settings))).toBe(false);
  });

  it('rebuilds unbounded hooks on migrate and then leaves the file alone', () => {
    const { settings: settingsPath } = claudeSettingsPaths(home);
    writeFileSync(settingsPath, JSON.stringify(preFixSettings(), null, 2) + '\n');

    migrateHooksIfNeeded(home);

    const repaired = readFileSync(settingsPath, 'utf-8');
    if (process.platform !== 'win32') {
      // 12 events minus the two request-response ones.
      expect(repaired.split('--max-time 0.8').length - 1).toBe(10);
      expect(repaired).toContain('--connect-timeout 0.2 --max-time 0.3');
      expect(repaired).toContain('--max-time 60');
      expect(repaired).toContain('--max-time 10');
    }
    expect(hasUnboundedHookCurl(JSON.parse(repaired))).toBe(false);

    // Idempotent: a second pass must not rewrite an already-bounded file.
    migrateHooksIfNeeded(home);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(repaired);
  });

  it('does not flag the request-response hooks for lacking a short timeout', () => {
    const current = applyHooks({});
    expect(hasUnboundedHookCurl(current)).toBe(false);
    // A user's own unrelated hook is not ours to judge.
    expect(hasUnboundedHookCurl({
      hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'curl -X POST http://example.test/ping' }] }] },
    })).toBe(false);
  });
});
