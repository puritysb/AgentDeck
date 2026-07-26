import { describe, expect, it } from 'vitest';
import { execFileSync, execSync, spawnSync } from '../proc.js';

/**
 * The wrapper must set windowsHide without disturbing the call signatures — a
 * dropped args array or a swallowed options bag would break shell-outs on every
 * platform, not just Windows.
 */
describe('proc wrappers preserve child_process behaviour', () => {
  const node = process.execPath;

  it('execFileSync still passes the args array', () => {
    const out = execFileSync(node, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf-8' });
    expect(out).toBe('ok');
  });

  it('execFileSync honours the options bag', () => {
    const out = execFileSync(node, ['-e', 'process.stdout.write(process.env.PROBE ?? "")'], {
      encoding: 'utf-8',
      env: { ...process.env, PROBE: 'from-env' },
    });
    expect(out).toBe('from-env');
  });

  it('execSync returns stdout', () => {
    const out = execSync(`"${node}" -e "process.stdout.write('hi')"`, { encoding: 'utf-8' });
    expect(out).toBe('hi');
  });

  it('spawnSync reports status and stdout', () => {
    const res = spawnSync(node, ['-e', 'process.stdout.write("x"); process.exit(3)'], { encoding: 'utf-8' });
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('x');
  });

  it('a caller can still opt out of hiding', () => {
    // Nothing in the bridge does, but the override must survive the merge or the
    // wrapper would be impossible to escape.
    const out = execFileSync(node, ['-e', 'process.stdout.write("visible")'], {
      encoding: 'utf-8',
      windowsHide: false,
    });
    expect(out).toBe('visible');
  });
});
