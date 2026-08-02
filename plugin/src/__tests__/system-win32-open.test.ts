/**
 * Windows open paths — pins the no-shell decisions.
 *
 * URLs must go through rundll32 as a single argv (NOT `cmd /c start`, whose
 * parser turns `&`/`^`/`%` in user-overridable url: targets into an injection
 * vector), and app names must pass the allowlist before they ever reach cmd.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFile = vi.fn<(
  exe: string,
  args: string[],
  opts: Record<string, unknown>,
  cb: (err: Error | null) => void,
) => void>();

vi.mock('child_process', () => ({
  execFile: (
    exe: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: Error | null) => void,
  ) => execFile(exe, args, opts, cb),
  spawn: vi.fn(),
}));

import { win32Backend } from '../system/win32.js';

describe('win32: openUrl via rundll32', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_exe, _args, _opts, cb) => cb(null));
  });

  it('passes the URL as a single argv to rundll32, never through cmd', async () => {
    const url = 'https://x.test/a?b&c^d%e';
    await win32Backend.openUrl(url);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [exe, args] = execFile.mock.calls[0];
    expect(exe.toLowerCase()).toContain('rundll32.exe');
    expect(exe.toLowerCase()).not.toContain('cmd');
    expect(args).toEqual(['url.dll,FileProtocolHandler', url]);
  });

  it('rejects when rundll32 fails so callers can fall back', async () => {
    execFile.mockImplementation((_exe, _args, _opts, cb) => cb(new Error('nope')));
    await expect(win32Backend.openUrl('https://example.com')).rejects.toThrow();
  });
});

describe('win32: openApp via Start Apps lookup', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_exe, _args, _opts, cb) => cb(null));
  });

  it('passes an exact Start-menu name through the environment, not PowerShell source', async () => {
    await win32Backend.openApp('Claude');
    const [exe, args, opts] = execFile.mock.calls[0];
    expect(exe.toLowerCase()).toContain('powershell.exe');
    expect(args.join(' ')).toContain('Get-StartApps');
    expect(args.join(' ')).not.toContain('Claude');
    expect((opts.env as NodeJS.ProcessEnv).AGENTDECK_LAUNCH_TARGET).toBe('Claude');
  });

  it('rejects a missing Start-menu app so the |url: fallback chain can take over', async () => {
    execFile.mockImplementation((_exe, _args, _opts, cb) => cb(new Error('not found')));
    await expect(win32Backend.openApp('Codex')).rejects.toThrow(/Cannot open "Codex"/);
  });
});

describe('win32: openAgentDeckAppOrGitHub', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_exe, _args, _opts, cb) => cb(null));
  });

  it('goes straight to the project page — there is no Windows desktop app', async () => {
    await win32Backend.openAgentDeckAppOrGitHub();
    const [exe, args] = execFile.mock.calls[0];
    expect(exe.toLowerCase()).toContain('rundll32.exe');
    expect(args[1]).toBe('https://puritysb.github.io/AgentDeck/');
  });
});
