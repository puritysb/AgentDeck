import { describe, it, expect } from 'vitest';
import {
  HOOK_EVENTS,
  buildHookCommand,
  buildHookCommandWin,
  buildHookEntry,
  applyHooks,
  removeHooks,
  migrateHooks,
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
      expect(cmd).toContain('curl -sf -X POST "http://127.0.0.1:$PORT/hooks/SessionStart"');
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
      expect(cmd.startsWith('powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "')).toBe(true);
      // Hooks fire on every tool call; an unhidden console flickers all session.
      expect(cmd).toContain('-WindowStyle Hidden');
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

  it('migration 5 upgrades fire-and-forget Stop hooks to request-response', () => {
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
    // applyHooks emits the host platform's form, so assert the matching marker:
    // both echo the daemon's turn-end directive back to Claude, POSIX via $RESP
    // and Windows via [Console]::Out.Write.
    // The Windows form builds the URL as '/hooks/'+$ev, so the event name is
    // carried by $ev rather than appearing literally in the path.
    if (process.platform === 'win32') {
      expect(stopCmd).toContain('[Console]::Out.Write');
      expect(stopCmd).toContain("$ev='Stop'");
      expect(stopCmd).toContain("/hooks/'+$ev");
    } else {
      expect(stopCmd).toContain('RESP=$(curl');
      expect(stopCmd).toContain('/hooks/Stop');
    }
  });

  it('gives Windows PreToolUse and Stop a request-response channel', () => {
    // Without this the daemon's permission decision and turn-end directive are
    // piped to Out-Null and device approval silently does nothing on Windows.
    for (const [event, timeout] of [['PreToolUse', 60], ['Stop', 10]] as const) {
      const cmd = buildHookCommandWin(event);
      expect(cmd).toContain('Invoke-WebRequest');
      expect(cmd).toContain('[Console]::Out.Write');
      expect(cmd).toContain(`-TimeoutSec ${timeout}`);
      expect(cmd).not.toContain('|Out-Null}catch{}');
    }
  });

  it('leaves the other Windows events fire-and-forget', () => {
    const cmd = buildHookCommandWin('PostToolUse');
    expect(cmd).toContain('Invoke-RestMethod');
    expect(cmd).toContain('|Out-Null');
    expect(cmd).not.toContain('[Console]::Out.Write');
  });
});
