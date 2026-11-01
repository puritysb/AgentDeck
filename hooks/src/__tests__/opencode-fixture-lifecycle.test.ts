import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform === 'win32')('OpenCode device fixture cleanup', () => {
  it.each(['deadline', 'parent-signal'])('terminates its isolated child on %s', async reason => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentdeck-fixture-lifecycle-'));
    const binary = join(cwd, 'fake-opencode');
    writeFileSync(binary, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
    chmodSync(binary, 0o755);
    const owner = spawn(process.execPath, [resolve('apple/DeviceAcceptance/fixtures/opencode-attention.mjs'), 'phone'], {
      cwd, env: { ...process.env, AGENTDECK_ACCEPTANCE_OPENCODE_BINARY: binary,
        AGENTDECK_ACCEPTANCE_TIMEOUT_MS: reason === 'deadline' ? '1000' : '30000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    owner.stdout.on('data', data => { output += data.toString(); });
    owner.stderr.on('data', data => { errors += data.toString(); });
    const exited = new Promise<number | null>(resolveExit => owner.once('exit', resolveExit));
    let metadata: { root: string; pid: number } | undefined;
    try {
      const until = Date.now() + 10_000;
      while (!output.includes('\n') && Date.now() < until && owner.exitCode === null) {
        await new Promise(resolveTick => setTimeout(resolveTick, 20));
      }
      expect(output, errors).toContain('\n');
      metadata = JSON.parse(output.split('\n')[0]);
      expect(metadata!.pid).toBeGreaterThan(1);
      if (reason === 'parent-signal') owner.kill('SIGTERM');
      expect(await exited).toBe(reason === 'deadline' ? 1 : 0);
      expect(() => process.kill(metadata!.pid, 0)).toThrow();
      if (reason === 'deadline') expect(errors).toContain('Acceptance deadline reached');
    } finally {
      owner.kill();
      if (metadata) { try { process.kill(metadata.pid, 'SIGTERM'); } catch { /* already gone */ } }
      rmSync(cwd, { recursive: true, force: true });
      if (metadata) rmSync(metadata.root, { recursive: true, force: true });
    }
  }, 20_000);
});
