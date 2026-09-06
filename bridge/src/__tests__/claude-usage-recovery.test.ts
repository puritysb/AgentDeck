import { describe, expect, it, vi } from 'vitest';
import { ClaudeUsageRecovery, CLAUDE_USAGE_RECOVERY_ARGS } from '../claude-usage-recovery.js';

describe('ClaudeUsageRecovery', () => {
  it('deduplicates concurrent callers and survives restarts without storing credentials', async () => {
    let now = 1000;
    let saved: any = null;
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
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

  it('fails closed if the retry budget cannot be persisted', async () => {
    const run = vi.fn();
    const recovery = new ClaudeUsageRecovery({ now: () => 1000, read: () => null,
      write: () => { throw Error('disk full'); }, run });
    await recovery.recover('token');
    expect(run).not.toHaveBeenCalled();
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
