import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildHookCommand, buildStatuslineRelayCommand, applyHooks, migrateHooksIfNeeded } from '../install.js';
import { managedBlockBody, buildCodexApprovalHoldCommand } from '../codex-install.js';

const body = managedBlockBody({ platform: 'linux', includeOtel: false });
const lifecycle = JSON.parse(body.split('\n').find(line => line.startsWith('command = '))!.slice(10));
const notify = JSON.parse(body.split('\n').find(line => line.startsWith('notify = '))!.slice(9));

describe('Custom integration handler preservation', () => {
  it('keeps other handlers and group metadata when refreshing on any platform', () => {
    const owned = applyHooks({}).hooks.SessionStart[0].hooks[0];
    const custom = { type: 'command', command: 'printf custom-handler', timeout: 7 };
    const settings = { hooks: { SessionStart: [{ matcher: 'custom', timeout: 9, hooks: [owned, custom] }] } };
    const fixed = applyHooks(settings);
    expect(fixed.hooks.SessionStart[0]).toEqual({ matcher: 'custom', timeout: 9, hooks: [custom] });
    expect(fixed.hooks.SessionStart).toHaveLength(2);
    expect(applyHooks(structuredClone(fixed))).toEqual(fixed);
  });
});

describe.skipIf(process.platform === 'win32')('Generated integration command refresh', () => {
  it('upgrades existing owned hooks and relay once, preserving user commands', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentdeck-python-migrate-'));
    try {
      mkdirSync(join(home, '.claude'));
      const user = { matcher: '', hooks: [{ type: 'command', command: 'printf user-hook' }] };
      const settings: any = applyHooks({ hooks: { SessionStart: [user] } }, home);
      const sharedUser = { type: 'command', command: 'printf shared-user-hook', timeout: 7 };
      settings.hooks.SessionStart.push({ matcher: 'custom', timeout: 9, hooks: [
        { type: 'command', command: buildHookCommand('SessionStart') }, sharedUser,
      ] });
      settings.statusLine = { type: 'command', command: buildStatuslineRelayCommand('printf user-status') };
      const path = join(home, '.claude/settings.json');
      writeFileSync(path, JSON.stringify(settings).replaceAll('python3 -I -c', 'python3 -c'));
      migrateHooksIfNeeded(home);
      const fixed = readFileSync(path, 'utf8');
      expect(fixed).toContain('python3 -I -c');
      expect(fixed).not.toContain('python3 -c');
      expect(JSON.parse(fixed).hooks.SessionStart).toContainEqual(user);
      expect(JSON.parse(fixed).hooks.SessionStart).toContainEqual({ matcher: 'custom', timeout: 9, hooks: [sharedUser] });
      expect(JSON.parse(fixed).statusLine.command).toContain('printf user-status');
      migrateHooksIfNeeded(home);
      expect(readFileSync(path, 'utf8')).toBe(fixed);
      // An older app can overwrite the co-owned file after the first repair.
      // Also repair an isolated-Python snippet that still has the old fallback.
      const overwritten = fixed.replaceAll('[ -n \\"$PORT\\" ] || exit 0', 'PORT=\\"${PORT:-9120}\\"');
      expect(overwritten).not.toBe(fixed);
      writeFileSync(path, overwritten);
      migrateHooksIfNeeded(home);
      expect(readFileSync(path, 'utf8')).toBe(fixed);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('refreshes an existing relay without adding absent hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentdeck-relay-only-'));
    try {
      mkdirSync(join(home, '.claude'));
      const path = join(home, '.claude/settings.json');
      writeFileSync(path, JSON.stringify({ statusLine: { type: 'command',
        command: buildStatuslineRelayCommand('printf user-status').replaceAll('python3 -I -c', 'python3 -c') } }));
      migrateHooksIfNeeded(home);
      const fixed = JSON.parse(readFileSync(path, 'utf8'));
      expect(fixed.hooks).toBeUndefined();
      expect(fixed.statusLine.command).toContain('python3 -I -c');
      expect(fixed.statusLine.command).toContain('printf user-status');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  for (const [name, argv] of [
    ['Claude lifecycle', ['-c', buildHookCommand('SessionStart')]],
    ['Claude status line', ['-c', buildStatuslineRelayCommand('cat')]],
    ['Codex lifecycle', ['-c', lifecycle]],
    ['Codex notify', notify.slice(1).concat('{"prompt":"private-fixture"}')],
    ['Codex approval hold', ['-c', buildCodexApprovalHoldCommand('linux')]],
  ] as [string, string[]][]) {
    for (const registry of ['missing', 'malformed', 'unhealthy']) {
      it(`${name} sends no payload when the daemon registry is ${registry}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'agentdeck-no-receiver-'));
        try {
          const home = join(root, 'home');
          const bin = join(root, 'bin');
          mkdirSync(join(home, '.agentdeck'), { recursive: true });
          mkdirSync(bin);
          if (registry !== 'missing') writeFileSync(join(home, '.agentdeck/daemon.json'),
            registry === 'malformed' ? '{broken' : '{"httpPort":9133}');
          const capture = join(root, 'curl.log');
          const curl = join(bin, 'curl');
          // No sockets: record any attempted request and reject health checks.
          writeFileSync(curl, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CAPTURE_FILE"\nexit 1\n');
          chmodSync(curl, 0o755);
          const input = '{"prompt":"private-fixture"}';
          const inputPath = join(root, 'stdin.json');
          writeFileSync(inputPath, input);
          // An intentional early exit need not consume stdin. A regular file
          // keeps that success from racing Node's pipe writer with EPIPE.
          const stdin = openSync(inputPath, 'r');
          let stdout: string;
          try {
            stdout = execFileSync('/bin/sh', argv, { cwd: root, stdio: [stdin, 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000,
              env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CAPTURE_FILE: capture } });
          } finally { closeSync(stdin); }
          const requests = existsSync(capture) ? readFileSync(capture, 'utf8') : '';
          expect(requests).not.toContain('-X POST');
          expect(requests).not.toContain(':9120/');
          expect(stdout).toBe(name === 'Claude status line' ? input : '');
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }
  }

  it('keeps every co-owned resolver isolated', () => {
    for (const file of ['hooks/src/install.ts', 'hooks/src/codex-install.ts', 'setup/src/setup.ts',
      'apple/AgentDeck/Daemon/Core/HookInstaller.swift', 'apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const resolvers = source.split('\n').filter(line => line.includes('P=$(python3'));
      expect(resolvers.length, file).toBeGreaterThan(0);
      for (const line of resolvers) expect(line, file).toContain('python3 -I -c');
    }
  });
});
