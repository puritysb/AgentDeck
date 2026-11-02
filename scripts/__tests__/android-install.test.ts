import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-android-install-'));
  roots.push(root);
  for (const dir of ['bin', 'scripts', 'android/app']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/build-android-release.sh'), join(root, 'scripts/build-android-release.sh'));
  writeFileSync(join(root, 'android/app/build.gradle.kts'), 'versionName = "0.0.0-fixture"');
  writeFileSync(join(root, 'android/signing.properties'), '# synthetic fixture; no signing material');
  const data = join(root, 'retained-app-data');
  writeFileSync(data, 'existing settings');
  const executable = (path: string, body: string) => { writeFileSync(path, body); chmodSync(path, 0o755); };
  executable(join(root, 'bin/java'), `#!/bin/sh
printf 'openjdk version "17.0.0"\\n' >&2
`);
  executable(join(root, 'android/gradlew'), '#!/bin/sh\nmkdir -p app/build/outputs/apk/sideload\nprintf fixture > app/build/outputs/apk/sideload/app-sideload.apk\n');
  executable(join(root, 'bin/adb'), `#!/bin/sh
if [ "$1" = devices ]; then
  printf 'List of devices attached\\nfixture-device\\tdevice\\n'
  exit 0
fi
[ "$1" = -s ] || exit 94
shift 2
printf '%s\\n' "$*" >> "$ADB_CALLS"
case "$1" in
  install) printf '%s\\n' "$ADB_OUTPUT"; exit "$ADB_STATUS" ;;
  uninstall) rm -f "$RETAINED_DATA"; exit 0 ;;
  *) exit 95 ;;
esac
`);
  return { root, data, run: (status: number, output: string) => {
    const result = spawnSync('bash', ['scripts/build-android-release.sh', '--install'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
        ADB_CALLS: join(root, 'adb-calls'), ADB_STATUS: String(status), ADB_OUTPUT: output, RETAINED_DATA: data },
    });
    const calls = existsSync(join(root, 'adb-calls')) ? readFileSync(join(root, 'adb-calls'), 'utf8').trim().split('\n') : [];
    return { ...result, output: result.stdout + result.stderr, calls };
  } };
}

describe.skipIf(process.platform === 'win32')('Android release script safe update', () => {
  it.each([
    ['version downgrade', 1, 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'],
    ['storage exhaustion', 1, 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]'],
    ['signing mismatch', 1, 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]'],
    ['transport failure', 255, 'adb: device disconnected'],
    ['misleading output', 7, 'Success\ntransport failed after acknowledgement'],
  ] as const)('preserves the installed app and data after %s', (_name, status, message) => {
    const f = fixture();
    const result = f.run(status, message);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatch(/^install -r /);
    expect(readFileSync(f.data, 'utf8')).toBe('existing settings');
    expect(result.output).toContain(message);
    expect(result.output).not.toContain('Done — installed');
  });

  it('completes an in-place update without deleting existing data', () => {
    const f = fixture();
    const result = f.run(0, 'Success');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatch(/^install -r /);
    expect(readFileSync(f.data, 'utf8')).toBe('existing settings');
    expect(result.output).toContain('Done — installed on 1 device(s).');
  });
});
