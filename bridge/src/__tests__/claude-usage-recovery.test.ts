import { describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { ClaudeUsageRecovery, CLAUDE_USAGE_RECOVERY_ARGS, buildClaudeUsageRecoveryEnv, resolveClaudeCli } from '../claude-usage-recovery.js';

describe('ClaudeUsageRecovery', () => {
  it('resolves a relative executable before recovery changes cwd', () => {
    const path = 'package.json';
    expect(resolveClaudeCli({ AGENTDECK_CLAUDE_CLI: path }, 'linux'))
      .toEqual({ path: resolve(path), shim: false });
  });

  it.each(['.cmd', '.BAT'])('identifies an overridden Windows %s shim', ext => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-cli-shim-'));
    const path = join(dir, `claude${ext}`);
    writeFileSync(path, '');
    expect(resolveClaudeCli({ AGENTDECK_CLAUDE_CLI: path }, 'win32'))
      .toEqual({ path, shim: true });
  });

  it('does not restart the quick tier on repeatedly rotated rejected credentials', async () => {
    let now = 1000;
    let saved: any = null;
    const run = vi.fn().mockResolvedValue('cli-completed' as const);
    const deps = { now: () => now, read: () => saved, write: (r: any) => { saved = r; }, run };
    await new ClaudeUsageRecovery(deps).recover('token-A');
    now += 60_000;
    await new ClaudeUsageRecovery(deps).recover('token-B');
    expect(run).toHaveBeenCalledTimes(2);
    expect(saved.nextAttemptAt - now).toBe(30 * 60_000);
    now += 60_000;
    await new ClaudeUsageRecovery(deps).recover('token-C');
    expect(run).toHaveBeenCalledTimes(2);
    now = saved.nextAttemptAt;
    await new ClaudeUsageRecovery(deps).recover('token-C');
    expect(run).toHaveBeenCalledTimes(3);
    expect(saved.nextAttemptAt - now).toBe(30 * 60_000);
  });

  it('never recovers a different macOS Keychain namespace', () => {
    expect(buildClaudeUsageRecoveryEnv({ CLAUDE_CONFIG_DIR: '/custom/claude' }, 'darwin', '/users/test')).toBeNull();
    expect(buildClaudeUsageRecoveryEnv({}, 'darwin', '/users/test')).not.toBeNull();
  });

  it('resolves a relative credential directory before changing the child cwd', () => {
    const env = buildClaudeUsageRecoveryEnv({ CLAUDE_CONFIG_DIR: './other-claude' }, 'linux');
    expect(env?.CLAUDE_CONFIG_DIR).toBe(resolve('./other-claude'));
  });

  it('removes inherited credential/provider and session overrides without changing the parent', () => {
    const source = { ANTHROPIC_API_KEY: 'api-key', ANTHROPIC_BASE_URL: 'https://other.invalid',
      CLAUDE_CODE_OAUTH_TOKEN: 'override', CLAUDECODE: '1', AGENTDECK_PORT: '9120',
      CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' };
    expect(buildClaudeUsageRecoveryEnv(source, 'linux')).toEqual({ PATH: '/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    expect(source.ANTHROPIC_API_KEY).toBe('api-key');
  });

  it('preserves the configured Claude executable through recovery environment sanitization', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-cli-override-'));
    const cliPath = join(dir, 'claude');
    writeFileSync(cliPath, '#!/bin/sh\n');

    const env = buildClaudeUsageRecoveryEnv({
      AGENTDECK_CLAUDE_CLI: cliPath,
      AGENTDECK_PORT: '9120',
      PATH: '/missing-from-daemon-path',
    }, 'linux');

    expect(env?.AGENTDECK_CLAUDE_CLI).toBe(cliPath);
    expect(env?.AGENTDECK_PORT).toBeUndefined();
    expect(resolveClaudeCli(env!, 'linux')).toEqual({ path: cliPath, shim: false });
  });

  it('deduplicates concurrent callers and survives restarts without storing credentials', async () => {
    let now = 1000;
    let saved: any = null;
    let finish!: () => void;
    const run = vi.fn(() => new Promise<'cli-completed'>(resolve => {
      finish = () => resolve('cli-completed');
    }));
    const deps = { now: () => now, read: () => saved, write: (r: any) => { saved = r; }, run };
    const recovery = new ClaudeUsageRecovery(deps);
    const first = recovery.recover('secret');
    const second = recovery.recover('secret');
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(saved)).not.toContain('secret');
    finish();
    await Promise.all([first, second]);
    await new ClaudeUsageRecovery(deps).recover('secret');
    expect(run).toHaveBeenCalledTimes(1);
    now += 30 * 60_000;
    const third = new ClaudeUsageRecovery(deps).recover('secret');
    finish(); await third;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('backs off six hours after three attempts, including failed child processes', async () => {
    let now = 1000;
    let saved: any = null;
    const run = vi.fn().mockRejectedValue(new Error('offline'));
    const recovery = new ClaudeUsageRecovery({ now: () => now, read: () => saved,
      write: r => { saved = r; }, run });
    for (let i = 0; i < 3; i++) { await recovery.recover('token'); now += 30 * 60_000; }
    await recovery.recover('token');
    expect(run).toHaveBeenCalledTimes(3);
    now = saved.nextAttemptAt;
    await recovery.recover('token');
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('retries an unchanged credential after one minute before using the normal backoff', async () => {
    let now = 1000;
    let saved: any = null;
    const run = vi.fn().mockResolvedValue('cli-completed' as const);
    const recovery = new ClaudeUsageRecovery({ now: () => now, read: () => saved,
      write: r => { saved = r; }, run });

    await recovery.recover('unchanged-token');
    now += 60_000 - 1;
    await recovery.recover('unchanged-token');
    expect(run).toHaveBeenCalledTimes(1);

    now += 1;
    await recovery.recover('unchanged-token');
    expect(run).toHaveBeenCalledTimes(2);

    now += 60_000;
    await recovery.recover('unchanged-token');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('persists a sanitized recovery outcome for detached-daemon diagnostics', async () => {
    let saved: any = null;
    const recovery = new ClaudeUsageRecovery({ now: () => 1000, read: () => saved,
      write: r => { saved = r; }, run: vi.fn().mockResolvedValue('cli-completed' as const) });

    await recovery.recover('secret-token');

    expect(saved).toMatchObject({ attempts: 1, lastAttemptAt: 1000, lastOutcome: 'cli-completed' });
    expect(JSON.stringify(saved)).not.toContain('secret-token');
  });

  it('fails closed if the retry budget cannot be persisted', async () => {
    const run = vi.fn();
    const recovery = new ClaudeUsageRecovery({ now: () => 1000, read: () => null,
      write: () => { throw Error('disk full'); }, run });
    await recovery.recover('token');
    expect(run).not.toHaveBeenCalled();
  });

  // `execFile` searches neither PATHEXT nor a shell, so a bare 'claude' was
  // ENOENT on every Windows install and on any daemon whose baked PATH omits
  // the CLI — a permanent no-op that only ever surfaced as a generic failure.
  it('resolves the CLI off PATH, honours PATHEXT, and reports a shell shim as unusable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-cli-'));
    const winDir = mkdtempSync(join(tmpdir(), 'agentdeck-cli-win-'));
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\n');
    writeFileSync(join(winDir, 'claude.cmd'), '@echo off\n');

    expect(resolveClaudeCli({ PATH: dir }, 'linux')).toEqual({ path: join(dir, 'claude'), shim: false });
    expect(resolveClaudeCli({ PATH: '/nonexistent-agentdeck' }, 'linux')).toBeNull();
    expect(resolveClaudeCli({}, 'linux')).toBeNull();

    // Extension case follows PATHEXT verbatim (Windows is case-insensitive);
    // spelled lowercase here so the fixture also resolves on a case-sensitive
    // CI filesystem.
    const win = resolveClaudeCli({ PATH: winDir, PATHEXT: '.EXE;.cmd' }, 'win32');
    expect(win).toEqual({ path: join(winDir, 'claude.cmd'), shim: true });
    expect(resolveClaudeCli({ PATH: winDir, PATHEXT: '.EXE' }, 'win32')).toBeNull();

    // An explicit override wins, and a missing override is not silently
    // replaced by a PATH hit — the operator named a specific binary.
    expect(resolveClaudeCli({ AGENTDECK_CLAUDE_CLI: join(dir, 'claude'), PATH: dir }, 'linux'))
      .toEqual({ path: join(dir, 'claude'), shim: false });
    expect(resolveClaudeCli({ AGENTDECK_CLAUDE_CLI: join(dir, 'absent'), PATH: dir }, 'linux')).toBeNull();
  });

  // The cooldown record used to resolve under `homedir()/.agentdeck` while
  // every other file in that directory honours AGENTDECK_DATA_DIR — so two
  // daemons on different data dirs silently shared one retry budget, each
  // spending the other's quota. usage-api.ts's cache resolves the same way and
  // the two move together (#286).
  it('resolves the cooldown record and the usage cache under AGENTDECK_DATA_DIR', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ad-datadir-'));
    const original = process.env.AGENTDECK_DATA_DIR;
    process.env.AGENTDECK_DATA_DIR = dataDir;
    try {
      vi.resetModules();
      const recovery = await import('../claude-usage-recovery.js');
      const usage = await import('../usage-api.js');
      expect(recovery.CLAUDE_USAGE_RECOVERY_FILE).toBe(join(dataDir, 'claude-usage-recovery.json'));
      expect(usage.USAGE_CACHE_FILE).toBe(join(dataDir, 'usage-cache.json'));
    } finally {
      if (original === undefined) delete process.env.AGENTDECK_DATA_DIR;
      else process.env.AGENTDECK_DATA_DIR = original;
      vi.resetModules();
    }
  });

  it('disables tools and customizations while keeping OAuth available', () => {
    const args = CLAUDE_USAGE_RECOVERY_ARGS;
    expect(args).toContain('--safe-mode');
    expect(args).not.toContain('--bare');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
  });
});
