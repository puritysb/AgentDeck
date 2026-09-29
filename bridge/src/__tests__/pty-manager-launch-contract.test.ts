import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// node-pty is an optionalDependency loaded through a dynamic import inside
// spawn(). Mocking it here exercises the real combinator — the shell/args
// decision AND the call that consumes it — rather than a pure helper that a
// later edit to spawn() could bypass without failing anything.
const spawnMock = vi.fn(() => ({
  pid: 4242,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
}));
vi.mock('node-pty', () => ({ spawn: spawnMock }));

import { PtyManager } from '../pty-manager.js';

/**
 * The managed launch contract (#273, "Custom launch arguments"): `-c` is a
 * COMMAND STRING handed to a shell, not an argv array. A daemon-first
 * replacement that execs the agent binary directly reproduces the flags and
 * silently loses everything below — so each property is pinned separately,
 * and the login flag has its own case because it is the one that carries the
 * user's profile (PATH, nvm/rbenv/mise, exported credentials).
 */
describe('PtyManager.spawn launch contract', () => {
  const realPlatform = process.platform;
  const realShell = process.env.SHELL;
  const realComspec = process.env.COMSPEC;

  /**
   * POSIX cases use 'linux', never 'darwin'. `spawn()` calls
   * `repairInstalledNodePtySpawnHelper()` before the mocked dynamic import, and
   * that repair runs for real on a 'darwin' platform value — resolving the
   * installed node-pty and chmod-ing its spawn-helper, which under pnpm's
   * hardlinked store reaches the shared copy. The contract under test is
   * POSIX-vs-win32 (`isWin` is `platform === 'win32'`), so 'linux' exercises
   * the identical branch and keeps the test hermetic.
   */
  function setPlatform(value: string): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  beforeEach(() => {
    spawnMock.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = realShell;
    if (realComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = realComspec;
  });

  /** The shell and argv the mock actually received. */
  function lastInvocation(): { shell: string; args: string[] } {
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [shell, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    return { shell, args };
  }

  it('runs the command through a LOGIN shell on POSIX', async () => {
    setPlatform('linux');
    process.env.SHELL = '/bin/zsh';

    await new PtyManager().spawn('claude');

    const { shell, args } = lastInvocation();
    expect(shell).toBe('/bin/zsh');
    // -l is the whole reason a managed session inherits the user's profile.
    expect(args).toEqual(['-l', '-c', 'claude']);
  });

  it('falls back to /bin/bash when SHELL is unset', async () => {
    setPlatform('linux');
    delete process.env.SHELL;

    await new PtyManager().spawn('codex');

    expect(lastInvocation().shell).toBe('/bin/bash');
  });

  it('uses cmd.exe switches on win32, not POSIX ones', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

    await new PtyManager().spawn('claude --resume X');

    const { shell, args } = lastInvocation();
    expect(shell).toBe('C:\\Windows\\System32\\cmd.exe');
    // /d skips AutoRun, /s keeps the rest literal, /c runs and exits.
    expect(args).toEqual(['/d', '/s', '/c', 'claude --resume X']);
    expect(args).not.toContain('-l');
  });

  it('falls back to cmd.exe when COMSPEC is unset', async () => {
    setPlatform('win32');
    delete process.env.COMSPEC;

    await new PtyManager().spawn('claude');

    expect(lastInvocation().shell).toBe('cmd.exe');
  });

  it('hands the command to the shell verbatim — no escaping, no re-quoting', async () => {
    setPlatform('linux');
    process.env.SHELL = '/bin/zsh';
    // A representative user `-c`: quoting, expansion and an operator. The
    // shell is supposed to interpret all of it; AgentDeck must not pre-chew it.
    const command = 'claude --resume "my session" --arg $HOME/x && echo done';

    await new PtyManager().spawn(command);

    expect(lastInvocation().args[2]).toBe(command);
  });
});
