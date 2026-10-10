import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startConfiguredDotHost } from '../dot-host.js';

it('refuses an implicit public Dot bind under loopback-only posture before opening listeners', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-posture-'));
  try {
    for (const bind of [undefined, '0.0.0.0', '::']) {
      writeFileSync(join(directory, 'dot-host.json'), JSON.stringify({ enabled: true, bind }));
      await expect(startConfiguredDotHost(directory, true)).rejects.toThrow('loopback posture');
    }
    writeFileSync(join(directory, 'dot-host.json'), JSON.stringify({ enabled: false }));
    expect(await startConfiguredDotHost(directory, true)).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
