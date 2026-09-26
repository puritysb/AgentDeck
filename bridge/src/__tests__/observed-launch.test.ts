import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { launchObservedCommand } from '../observed-launch.js';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
afterEach(() => vi.resetAllMocks());
describe('observed terminal launch', () => {
  it.each([
    ['darwin', { SHELL: '/bin/zsh' }, '/bin/zsh', ['-l', '-c']],
    ['linux', {}, '/bin/bash', ['-l', '-c']],
    ['win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }, 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c']],
    ['win32', {}, 'cmd.exe', ['/d', '/s', '/c']],
  ] as const)('preserves shell grammar on %s', (platform, env, shell, args) => {
    spawn.mockReturnValue({ status: 17 } as ReturnType<typeof spawnSync>);
    const cmd = 'claude --resume "a b" && echo "$HOME"';
    expect(launchObservedCommand(cmd, env, platform)).toBe(17);
    expect(spawn).toHaveBeenCalledWith(shell, [...args, platform === 'win32' ? `"${cmd}"` : cmd], { env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: platform === 'win32' });
  });
  it('does not silently misroute hooks from a managed terminal', () => {
    expect(() => launchObservedCommand('claude', { AGENTDECK_PORT: '9122' })).toThrow('ordinary terminal');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('preserves signal exit status and removes signal listeners', () => {
    const count = process.listenerCount('SIGINT');
    spawn.mockReturnValue({ status: null, signal: 'SIGINT' } as ReturnType<typeof spawnSync>);
    expect(launchObservedCommand('claude', {})).toBe(130);
    expect(process.listenerCount('SIGINT')).toBe(count);
  });
  it('reports a missing shell and cleans up on failure', () => {
    const count = process.listenerCount('SIGINT');
    spawn.mockReturnValue({ error: new Error('ENOENT') } as ReturnType<typeof spawnSync>);
    expect(() => launchObservedCommand('claude', {})).toThrow('ENOENT');
    expect(process.listenerCount('SIGINT')).toBe(count);
  });
});
