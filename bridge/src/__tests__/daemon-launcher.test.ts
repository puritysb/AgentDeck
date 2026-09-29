import { spawn } from 'child_process';
import { once } from 'events';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { waitForDaemonSpawn } from '../daemon-launcher.js';

describe('detached daemon launcher', () => {
  it('rejects an asynchronous OS spawn failure instead of reporting success', async () => {
    const child = spawn(process.execPath, ['-e', ''], {
      cwd: join(tmpdir(), randomUUID()), detached: true, stdio: 'ignore', windowsHide: true,
    });
    await expect(waitForDaemonSpawn(child)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for successful creation before releasing the child', async () => {
    const child = spawn(process.execPath, ['-e', ''], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    const exited = once(child, 'exit');
    await waitForDaemonSpawn(child);
    expect(child.pid).toBeGreaterThan(0);
    expect(await exited).toEqual([0, null]);
  });
});
