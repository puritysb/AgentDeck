import { afterEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ execFileSync: vi.fn(() => '2.1.0'), execSync: vi.fn(() => '2.1.0') }));
vi.mock('child_process', () => child);
import { checkDependencies } from '../check-deps.js';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('dependency command arguments', () => {
  it.skipIf(process.platform === 'win32')('passes a configured shell path as an executable, never as shell syntax', () => {
    const shell = '/tmp/a shell; literal $(name)';
    vi.stubEnv('SHELL', shell);
    expect(checkDependencies('claude-code').ok).toBe(true);
    expect(child.execFileSync).toHaveBeenCalledWith(shell, ['-l', '-c', 'claude --version'], expect.objectContaining({ timeout: 5000 }));
    expect(child.execSync).not.toHaveBeenCalled();
  });
});
