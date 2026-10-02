import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installHermesObserver } from '../hermes-install.js';
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })));

describe('explicit Hermes observer installation', () => {
  it('preserves profile configuration and refreshes only its own directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-install-')); homes.push(home);
    writeFileSync(join(home, 'config.yaml'), 'plugins:\n  enabled: [personal]\n');
    const target = installHermesObserver(home);
    const first = readFileSync(join(target, '__init__.py'), 'utf8');
    expect(installHermesObserver(home)).toBe(target);
    expect(readFileSync(join(target, '__init__.py'), 'utf8')).toBe(first);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('enabled: [personal]');
    expect(readFileSync(join(target, 'plugin.yaml'), 'utf8')).toContain('name: agentdeck-observer');
  });
  it('refuses a directory it does not own', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-install-')); homes.push(home);
    const target = join(home, 'plugins', 'agentdeck-observer'); mkdirSync(target, { recursive: true });
    writeFileSync(join(target, '__init__.py'), 'personal code');
    expect(() => installHermesObserver(home)).toThrow('unowned');
    expect(readFileSync(join(target, '__init__.py'), 'utf8')).toBe('personal code');
  });
  it('runs the Python observer behavior/transport suite', () => {
    const suite = fileURLToPath(new URL('../../hermes-tests', import.meta.url));
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'unittest', 'discover', '-s', suite], { encoding: 'utf8', timeout: 15_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
