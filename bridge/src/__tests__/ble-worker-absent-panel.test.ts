import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Python BLE sync clients (Timebox `sync_ble.py`, iDotMatrix `sync.py`) must
 * keep retrying a switched-off panel while the daemon answers, and still leave
 * once it stops. The suite stubs Pillow, bleak and the iDotMatrix library, so it
 * runs on a plain Python 3.
 *
 * It takes about 4.5 s of real time (each "keeps retrying" case waits out several
 * bridge-gone windows), so the test carries its own timeout above the spawn's:
 * vitest fails a synchronous test that overruns the 10 s default even though the
 * child was allowed 30 s.
 */
describe('BLE sync clients with an absent panel', () => {
  it('runs the Python absent-panel suite', () => {
    const suite = fileURLToPath(new URL('../../ble-worker-tests', import.meta.url));
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'unittest', 'discover', '-s', suite], { encoding: 'utf8', timeout: 30_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 35_000);
});
