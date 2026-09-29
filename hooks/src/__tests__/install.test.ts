import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile, execFileSync } from 'child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import {
  HOOK_EVENTS,
  buildHookCommand,
  buildHookCommandWin,
  WINDOWS_HOOK_SCRIPT,
  windowsHookScriptPath,
  ensureWindowsHookScript,
  isAgentDeckHookCommand,
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
  buildKiroHookFile,
  installKiroHooksIfNeeded,
  kiroHookPath,
  uninstallKiroHooks,
} from '../install.js';

/**
 * The substring that identifies an AgentDeck hook command on this platform.
 * POSIX carries the port-discovery shell inline; Windows carries only the path
 * of the script that holds it (see WINDOWS_HOOK_SCRIPT for why it cannot be
 * inlined there).
 */
const HOOK_MARKER = process.platform === 'win32' ? 'agentdeck-hook.ps1' : 'AGENTDECK_PORT';

describe('Hook Installer', () => {
  describe('buildHookEntry', () => {
    it('creates matcher-group format naming the event', () => {
      const entry = buildHookEntry('SessionStart');
      expect(entry.matcher).toBe('');
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe('command');
      expect(entry.hooks[0].command).toContain(HOOK_MARKER);
      expect(entry.hooks[0].command).toContain('SessionStart');
      // POSIX inlines the full `/hooks/<event>` URL; Windows passes the event
      // as -HookEvent and the script builds the URL at runtime.
      if (process.platform === 'win32') {
        expect(entry.hooks[0].command).toContain('-HookEvent SessionStart');
      } else {
        expect(entry.hooks[0].command).toContain('/hooks/');
      }
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

    it('keeps strict port-validation markers in every co-owned hook writer', () => {
      const root = process.cwd();
      const posixWriters = [
        'hooks/src/install.ts',
        'hooks/src/codex-install.ts',
        'setup/src/setup.ts',
        'apple/AgentDeck/Daemon/Core/HookInstaller.swift',
        'apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift',
      ];
      for (const path of posixWriters) {
        const source = readFileSync(join(root, path), 'utf-8');
        expect(source, path).toContain('*[!0-9]*');
        expect(source, path).toContain('1 <= p <= 65535');
      }

      for (const path of ['hooks/src/install.ts', 'hooks/src/codex-install.ts', 'setup/src/setup.ts']) {
        const source = readFileSync(join(root, path), 'utf-8');
        expect(source, path).toContain('[int]::TryParse');
        expect(source, path).toContain('65535');
      }
    });

    it.skipIf(process.platform === 'win32')('rejects non-numeric and out-of-range ports before URL construction', () => {
      for (const malicious of ['9120@evil.example', '-1', '0', '65536', '12.5', ' 9120']) {
        const home = mkdtempSync(join(tmpdir(), "agentdeck-port-o'"));
        const bin = join(home, 'bin');
        const capture = join(home, 'curl.log');
        mkdirSync(join(home, '.agentdeck'), { recursive: true });
        mkdirSync(bin);
        // A malicious string from daemon.json must be rejected too. The home
        // path deliberately contains an apostrophe: passing the filename as a
        // Python argv (instead of interpolating it into source) keeps it safe.
        writeFileSync(join(home, '.agentdeck', 'daemon.json'), JSON.stringify({ httpPort: malicious }));
        const fakeCurl = join(bin, 'curl');
        writeFileSync(fakeCurl, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CAPTURE_FILE"\nexit 0\n');
        chmodSync(fakeCurl, 0o755);

        execFileSync('/bin/sh', ['-c', buildHookCommand('SessionStart')], {
          env: {
            ...process.env,
            HOME: home,
            AGENTDECK_PORT: malicious,
            CAPTURE_FILE: capture,
            PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          },
          input: '{}',
        });

        const urls = readFileSync(capture, 'utf-8');
        expect(urls).toContain('http://127.0.0.1:9120/hooks/SessionStart');
        expect(urls).not.toContain('evil.example');
        rmSync(home, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('accepts a validated daemon.json port', () => {
      const home = mkdtempSync(join(tmpdir(), 'agentdeck-valid-port-'));
      const bin = join(home, 'bin');
      const capture = join(home, 'curl.log');
      mkdirSync(join(home, '.agentdeck'), { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(home, '.agentdeck', 'daemon.json'), JSON.stringify({ httpPort: 9133 }));
      const fakeCurl = join(bin, 'curl');
      writeFileSync(fakeCurl, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CAPTURE_FILE"\nexit 0\n');
      chmodSync(fakeCurl, 0o755);

      execFileSync('/bin/sh', ['-c', buildHookCommand('SessionStart')], {
        env: {
          ...process.env,
          HOME: home,
          AGENTDECK_PORT: '',
          CAPTURE_FILE: capture,
          PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        },
        input: '{}',
      });

      const urls = readFileSync(capture, 'utf-8');
      expect(urls).toContain('http://127.0.0.1:9133/health');
      expect(urls).toContain('http://127.0.0.1:9133/hooks/SessionStart');
      rmSync(home, { recursive: true, force: true });
    });

    it.skipIf(process.platform === 'win32')('bounds a blocked daemon-file read before the hook can stall', () => {
      const cmd = buildHookCommand('SessionStart');
      const python = cmd.match(/python3 -c "([^"]+)"/)?.[1];
      expect(python).toBeTruthy();
      const home = mkdtempSync(join(tmpdir(), 'agentdeck-blocked-read-'));
      const fifo = join(home, 'blocked.json');
      try {
        execFileSync('mkfifo', [fifo]);
        // No writer: open() really blocks. Exercise the emitted Python itself,
        // not a mock timeout or an assertion about the command's spelling.
        const result = execFileSync('python3', ['-c', python!, fifo], {timeout: 2000, encoding: 'utf8'});
        expect(result).toBe('');
      } finally { rmSync(home, {recursive: true, force: true}); }
      for (const file of ['setup/src/setup.ts', 'hooks/src/codex-install.ts',
        'apple/AgentDeck/Daemon/Core/HookInstaller.swift', 'apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift']) {
        expect(readFileSync(join(process.cwd(), file), 'utf8'), file).toContain(python!);
      }
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
    it.skipIf(process.platform !== 'win32')('delivers UTF-8 stdin through Git Bash and Windows PowerShell', async () => {
      const home = mkdtempSync(join(tmpdir(), 'agentdeck hook 한글-'));
      const payload = JSON.stringify({ session_id: 'review', prompt: '안녕하세요 café' });
      let received: { url: string | undefined; body: string } | undefined;
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          received = { url: request.url, body: Buffer.concat(chunks).toString('utf8') };
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{}');
        });
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        ensureWindowsHookScript(home);
        // Select Git's shell explicitly: a Windows host can also have WSL's
        // bash.exe on PATH, which is not the hook execution environment.
        const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
        const started = performance.now();
        const execution = promisify(execFile)(gitBash, ['-c', buildHookCommandWin('Stop', home)], {
          env: { ...process.env, AGENTDECK_PORT: String(port) },
          // This tests encoding, not startup latency. Budget for cold Git Bash
          // and PowerShell on hosted runners; the hook HTTP budget is unchanged.
          timeout: 30_000,
          windowsHide: true,
        });
        execution.child.stdin?.end(payload);
        const result = await execution.catch((error) => {
          throw new Error(`Windows hook execution failed after ${Math.round(performance.now() - started)}ms; `
            + `code=${error.code}, signal=${error.signal}, killed=${error.killed}, `
            + `receivedRequest=${received !== undefined}, stderr=${JSON.stringify(error.stderr)}`, { cause: error });
        });
        expect(result.stderr).toBe('');
        expect(received).toEqual({ url: '/hooks/Stop', body: payload });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(home, { recursive: true, force: true });
      }
    }, 40_000);

    it('invokes the hook script by path and passes the event as a parameter', () => {
      const cmd = buildHookCommandWin('SessionStart');
      expect(cmd.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -File "')).toBe(true);
      expect(cmd).toContain('agentdeck-hook.ps1');
      expect(cmd).toContain('-HookEvent SessionStart');
    });

    it('puts no "$" on the command line, because a POSIX shell parses it first', () => {
      // Claude Code spawns hook commands through Git Bash (sh -c) on Windows.
      // An inlined -Command reached powershell.exe as
      //   ='Stop'; [int]=0; ... [string]:AGENTDECK_PORT,[ref]
      // because sh expanded $ev, $port, $candidate and $env away first, and
      // died with "Missing ')' in method call" on every hook of every turn.
      for (const event of HOOK_EVENTS) {
        expect(buildHookCommandWin(event)).not.toContain('$');
      }
      // The Kiro variant passes prefixed daemon events through the same builder.
      expect(buildHookCommandWin('kiro_tool_start')).not.toContain('$');
    });

    it('stays a single ASCII line', () => {
      const cmd = buildHookCommandWin('Stop');
      expect(cmd).not.toContain('\n');
      expect(/^[\x00-\x7F]*$/.test(cmd)).toBe(true);
    });
  });

  describe('WINDOWS_HOOK_SCRIPT', () => {
    it('keeps the port discovery, validation and UTF-8 handling of the old one-liner', () => {
      expect(WINDOWS_HOOK_SCRIPT).toContain('$env:AGENTDECK_PORT');
      expect(WINDOWS_HOOK_SCRIPT).toContain(".agentdeck\\daemon.json");
      expect(WINDOWS_HOOK_SCRIPT).toContain('$port = 9120');
      // Strict 1..65535 parsing: an unvalidated value containing '@' can make a
      // URL parser read 127.0.0.1:<value> as userinfo and post elsewhere.
      expect(WINDOWS_HOOK_SCRIPT).toContain('[int]::TryParse');
      expect(WINDOWS_HOOK_SCRIPT).toContain('$candidate -gt 65535');
      // Read stdin as UTF-8 — [Console]::In uses the OEM codepage (e.g. CP949).
      expect(WINDOWS_HOOK_SCRIPT).toContain('StreamReader([Console]::OpenStandardInput()');
      expect(WINDOWS_HOOK_SCRIPT).not.toContain('[Console]::In.ReadToEnd()');
      // POST UTF-8 bytes with a charset — a string body without one is encoded
      // as ISO-8859-1 and non-ASCII becomes '?'.
      expect(WINDOWS_HOOK_SCRIPT).toContain('[System.Text.Encoding]::UTF8.GetBytes');
      expect(WINDOWS_HOOK_SCRIPT).toContain('application/json; charset=utf-8');
      // Bounded, and never fails the host session.
      expect(WINDOWS_HOOK_SCRIPT).toContain('-TimeoutSec 2');
      expect(WINDOWS_HOOK_SCRIPT).toContain('exit 0');
    });

    it('omits the macOS App Store sandbox-container fallback paths', () => {
      expect(WINDOWS_HOOK_SCRIPT).not.toContain('Library/Containers/bound.serendipity');
      expect(WINDOWS_HOOK_SCRIPT).not.toContain('group.bound.serendipity');
    });

    it('accepts the underscored daemon events the Kiro hook file uses', () => {
      const pattern = WINDOWS_HOOK_SCRIPT.match(/ValidatePattern\('([^']+)'\)/)?.[1];
      expect(pattern).toBeDefined();
      const re = new RegExp(pattern as string);
      expect(re.test('SessionStart')).toBe(true);
      expect(re.test('kiro_tool_start')).toBe(true);
      // Still refuses anything that could break out of the URL path segment.
      expect(re.test('Stop; rm -rf /')).toBe(false);
      expect(re.test('../health')).toBe(false);
    });

    it('writes the script idempotently and repairs a tampered copy', () => {
      const home = mkdtempSync(join(tmpdir(), 'agentdeck-hook-script-'));
      const path = ensureWindowsHookScript(home);
      expect(path).toBe(windowsHookScriptPath(home));
      expect(readFileSync(path, 'utf-8')).toBe(WINDOWS_HOOK_SCRIPT);

      writeFileSync(path, 'corrupted');
      ensureWindowsHookScript(home);
      expect(readFileSync(path, 'utf-8')).toBe(WINDOWS_HOOK_SCRIPT);
      rmSync(home, { recursive: true, force: true });
    });
  });

  describe('isAgentDeckHookCommand', () => {
    it('recognises the Windows -File form, which carries neither legacy marker', () => {
      // Miss this and every reinstall leaves the previous hook in place and
      // appends a new one, so each event fires as many times as it was installed.
      expect(isAgentDeckHookCommand(buildHookCommandWin('Stop'))).toBe(true);
      expect(isAgentDeckHookCommand(buildHookCommand('Stop'))).toBe(true);
      expect(isAgentDeckHookCommand('echo "my own hook"')).toBe(false);
      expect(isAgentDeckHookCommand(undefined)).toBe(false);
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
        // The Windows form carries the port logic in the script file, not the
        // command line — see WINDOWS_HOOK_SCRIPT.
        expect(group.hooks[0].command).toContain(
          process.platform === 'win32' ? 'agentdeck-hook.ps1' : 'AGENTDECK_PORT',
        );
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
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain(HOOK_MARKER);
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
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain(HOOK_MARKER);
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

    it('self-heals installed hooks that predate strict port validation', () => {
      const home = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-port-migration-'));
      mkdirSync(join(home, '.claude'), { recursive: true });
      const settings = applyHooks({});
      for (const groups of Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)) {
        for (const group of groups) {
          for (const hook of group.hooks) {
            hook.command = hook.command
              .split('\n').filter((line) => !line.includes('*[!0-9]*')).join('\n')
              .replaceAll('[int]::TryParse', '[int]::Parse');
          }
        }
      }
      const settingsPath = join(home, '.claude', 'settings.json');
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

      migrateHooksIfNeeded(home);
      const repaired = readFileSync(settingsPath, 'utf-8');
      const marker = process.platform === 'win32' ? 'agentdeck-hook.ps1' : '*[!0-9]*';
      expect(repaired).toContain(marker);

      migrateHooksIfNeeded(home);
      expect(readFileSync(settingsPath, 'utf-8')).toBe(repaired);
      rmSync(home, { recursive: true, force: true });
    });
  });
});

describe('migration 12 (Windows inline -Command → script file)', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }));
    afterEach(() => Object.defineProperty(process, 'platform', platform));

    it('rewrites hooks whose $variables a POSIX shell would eat', () => {
      const home = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-winfile-'));
      mkdirSync(join(home, '.claude'), { recursive: true });
      const settingsPath = join(home, '.claude', 'settings.json');

      // Exactly what installers before this fix wrote.
      const inline = (event: string) =>
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ev='${event}'; [int]$port=0; `
        + `if(!([int]::TryParse([string]$env:AGENTDECK_PORT,[ref]$port))){$port=9120}; `
        + `try{Invoke-RestMethod -Uri ('http://127.0.0.1:'+$port+'/hooks/'+$ev) -Method Post -TimeoutSec 2}catch{}"`;
      const settings: any = { hooks: {} };
      for (const event of HOOK_EVENTS) {
        settings.hooks[event] = [{ matcher: '', hooks: [{ type: 'command', command: inline(event) }] }];
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

      migrateHooksIfNeeded(home);

      const repaired = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      for (const event of HOOK_EVENTS) {
        // One hook per event — the old entry is replaced, not accumulated.
        const commands = repaired.hooks[event].flatMap((g: any) => g.hooks.map((h: any) => h.command));
        expect(commands).toHaveLength(1);
        expect(commands[0]).not.toContain('$');
        expect(commands[0]).toContain('agentdeck-hook.ps1');
      }
      expect(existsSync(windowsHookScriptPath(home))).toBe(true);

      // Idempotent: a second pass is a no-op.
      const after = readFileSync(settingsPath, 'utf-8');
      migrateHooksIfNeeded(home);
      expect(readFileSync(settingsPath, 'utf-8')).toBe(after);
      rmSync(home, { recursive: true, force: true });
    });

    it('does not duplicate hooks across repeated installs', () => {
      const home = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-reinstall-'));
      mkdirSync(join(home, '.claude'), { recursive: true });
      installHooks(home);
      installHooks(home);
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      for (const event of HOOK_EVENTS) {
        const commands = settings.hooks[event].flatMap((g: any) => g.hooks.map((h: any) => h.command));
        expect(commands).toHaveLength(1);
      }
      rmSync(home, { recursive: true, force: true });
    });

    it('removes the script on uninstall', () => {
      const home = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-uninstall-'));
      mkdirSync(join(home, '.claude'), { recursive: true });
      installHooks(home);
      expect(existsSync(windowsHookScriptPath(home))).toBe(true);
      uninstallHooks(home);
      expect(existsSync(windowsHookScriptPath(home))).toBe(false);
      rmSync(home, { recursive: true, force: true });
    });

    it('repairs the script without rewriting current settings', () => {
      const home = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-winrepair-'));
      try {
        installHooks(home);
        const settingsPath = join(home, '.claude', 'settings.json');
        // Distinct formatting makes even a byte-equivalent semantic rewrite
        // observable without relying on filesystem timestamp resolution.
        const before = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')), null, 4);
        writeFileSync(settingsPath, before);
        for (const missing of [false, true]) {
          if (missing) rmSync(windowsHookScriptPath(home));
          else writeFileSync(windowsHookScriptPath(home), 'broken');
          migrateHooksIfNeeded(home);
          expect(readFileSync(windowsHookScriptPath(home), 'utf8')).toBe(WINDOWS_HOOK_SCRIPT);
          expect(readFileSync(settingsPath, 'utf8')).toBe(before);
        }
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('keeps the bootstrap script byte-identical to the hooks script', () => {
      const literal = /const WINDOWS_HOOK_SCRIPT = (`[\s\S]*?`);/;
      const source = readFileSync(join(process.cwd(), 'hooks/src/install.ts'), 'utf8');
      const bootstrap = readFileSync(join(process.cwd(), 'setup/src/setup.ts'), 'utf8');
      expect(source.match(literal)?.[1]).toBeDefined();
      expect(bootstrap.match(literal)?.[1]).toBe(source.match(literal)?.[1]);
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
      expect(stopCmd).toContain('agentdeck-hook.ps1');
      expect(stopCmd).toContain('-HookEvent Stop');
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
    expect(sessionEnd).toContain(process.platform === 'win32' ? 'agentdeck-hook.ps1' : 'daemon.json');
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

describe('Kiro v3 global hook installer', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentdeck-kiro-hooks-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('skips hosts where Kiro has never created its config root', () => {
    expect(installKiroHooksIfNeeded(home)).toMatchObject({
      installed: false,
      reason: 'Kiro config directory not found',
    });
  });

  it('writes the measured v1 standalone schema with prefixed lifecycle endpoints', () => {
    mkdirSync(join(home, '.kiro'), { recursive: true });
    expect(installKiroHooksIfNeeded(home).installed).toBe(true);
    const written = JSON.parse(readFileSync(kiroHookPath(home), 'utf8'));
    expect(written).toEqual(buildKiroHookFile(home));
    expect(written.hooks.map((hook: { trigger: string }) => hook.trigger)).toEqual([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
    ]);
    const serialized = JSON.stringify(written);
    for (const event of ['kiro_session_start', 'kiro_user_prompt_submit', 'kiro_tool_start', 'kiro_tool_end', 'kiro_stop']) {
      expect(serialized).toContain(event);
    }
    expect(serialized).toContain(HOOK_MARKER);
  });

  it('is idempotent, preserves an occupied path, and only removes its own file', () => {
    mkdirSync(join(home, '.kiro', 'hooks'), { recursive: true });
    installKiroHooksIfNeeded(home);
    expect(installKiroHooksIfNeeded(home).reason).toBe('already current');
    expect(uninstallKiroHooks(home)).toBe(true);

    writeFileSync(kiroHookPath(home), '{"version":"v1","hooks":[]}\n');
    expect(installKiroHooksIfNeeded(home).reason).toContain('occupied');
    expect(uninstallKiroHooks(home)).toBe(false);
    expect(existsSync(kiroHookPath(home))).toBe(true);
  });

  it('provisions and repairs the Windows script without a Claude installation', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      mkdirSync(join(home, '.kiro'));
      expect(installKiroHooksIfNeeded(home).installed).toBe(true);
      const script = windowsHookScriptPath(home);
      expect(readFileSync(script, 'utf8')).toBe(WINDOWS_HOOK_SCRIPT);
      const hooks = JSON.parse(readFileSync(kiroHookPath(home), 'utf8'));
      for (const hook of hooks.hooks) expect(hook.action.command).toContain(script);
      writeFileSync(script, 'broken');
      expect(installKiroHooksIfNeeded(home).reason).toBe('already current');
      expect(readFileSync(script, 'utf8')).toBe(WINDOWS_HOOK_SCRIPT);
      rmSync(script);
      installKiroHooksIfNeeded(home);
      expect(readFileSync(script, 'utf8')).toBe(WINDOWS_HOOK_SCRIPT);
    } finally { Object.defineProperty(process, 'platform', platform); }
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

describe('uninstall wiring', () => {
  it('the uninstall entry point actually calls the Kiro remover', () => {
    // `uninstallKiroHooks` shipped unit-tested and unreachable: nothing called
    // it, so `scripts/uninstall.sh` left `~/.kiro/hooks/agentdeck-lifecycle.json`
    // on disk. Asserting the FUNCTION works cannot catch that — this asserts the
    // call site exists, which is the thing that was missing.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'install.ts'),
      'utf8',
    );
    const branch = src.slice(src.indexOf("if (action === 'uninstall')"));
    expect(branch).toContain('uninstallKiroHooks(');
    expect(branch).toContain('uninstallOpenCodeHooks(');
  });
});
