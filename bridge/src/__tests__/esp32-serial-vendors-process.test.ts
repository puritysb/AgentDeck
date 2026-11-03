import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { SerialVendorDiscovery } from '../esp32-serial-vendors.js';

// POSIX executable fixture: no USB registry, serial port or live daemon is used.
it.skipIf(process.platform === 'win32')('kills a real stalled child and can recover after close/backoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-ioreg-child-'));
  const calls = join(dir, 'calls');
  const port = '/dev/cu.usbmodem-test';
  const output = `+-o USB <class IOUSBHostDevice>\n  "idVendor" = 6790\n  +-o IOSerialBSDClient\n      "IOCalloutDevice" = "${port}"\n`;
  writeFileSync(join(dir, 'ioreg'), `#!${process.execPath}
const fs = require('node:fs');
const calls = ${JSON.stringify(calls)};
const retry = fs.existsSync(calls);
fs.appendFileSync(calls, process.pid + '\\n');
if (retry) process.stdout.write(${JSON.stringify(output)});
else setTimeout(() => process.exit(1), 6000);
`, { mode: 0o755 });
  vi.stubEnv('PATH', dir + ':' + process.env.PATH);
  const discovery = new SerialVendorDiscovery();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect(await discovery.lookup([port], 'darwin')).toEqual(new Map());
    const pid = Number(readFileSync(calls, 'utf8').trim());
    // SIGKILL delivery is asynchronous. Wait for the real process to disappear.
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await sleep(10); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(await discovery.lookup([port], 'darwin')).toEqual(new Map());
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    // Advance only the retry clock; the OS process and all timers remain real.
    const now = performance.now.bind(performance);
    clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + 60_000);
    let recovered = new Map<string, number>();
    for (let i = 0; i < 100 && recovered.size === 0; i++) {
      recovered = await discovery.lookup([port], 'darwin');
      if (recovered.size === 0) await sleep(10);
    }
    expect(recovered).toEqual(new Map([[port, 0x1a86]]));
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally {
    clock?.mockRestore();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
