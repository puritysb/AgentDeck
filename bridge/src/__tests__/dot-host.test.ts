import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readDotConfiguration, startConfiguredDotHost } from '../dot-host.js';

it('refuses an implicit public Dot bind under loopback-only posture before opening listeners', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-posture-'));
  try {
    for (const bind of [undefined, '0.0.0.0', '::']) {
      writeFileSync(join(directory, 'dot-host.json'), JSON.stringify({ enabled: true, port: 3391, controlPort: 3392, bind }));
      await expect(startConfiguredDotHost(directory, true)).rejects.toThrow('loopback posture');
    }
    writeFileSync(join(directory, 'dot-host.json'), JSON.stringify({ enabled: false }));
    expect(await startConfiguredDotHost(directory, true)).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('refuses port strings that could redirect operator credentials in a URL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-config-'));
  try {
    for (const controlPort of ['3392@outside.invalid', -1, 65536, null]) {
      writeFileSync(join(directory, 'dot-host.json'), JSON.stringify({ enabled: true, mode: 'local', port: 3391, controlPort }));
      expect(() => readDotConfiguration(directory)).toThrow('Invalid Dot port');
    }
    writeFileSync(join(directory, 'dot-host.json'), JSON.stringify({ enabled: true, mode: 'local', port: 3391, controlPort: 3392 }));
    expect(readDotConfiguration(directory)?.controlPort).toBe(3392);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
