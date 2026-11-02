import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(stale: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-apple-upload-')));
  roots.push(root);
  for (const dir of ['scripts', 'apple/scripts', 'dist']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/build-apple-release.sh'), join(root, 'scripts/build-apple-release.sh'));
  writeFileSync(join(root, 'apple/project.yml'), 'MARKETING_VERSION: "0.0.0"\n');
  writeFileSync(join(root, 'apple/scripts/verify-appstore-archive.sh'), 'exit 0\n');
  if (stale) {
    mkdirSync(join(root, 'dist/export_macos'), { recursive: true });
    writeFileSync(join(root, 'dist/export_macos/stale.pkg'), 'old macOS build');
    writeFileSync(join(root, 'dist/agentdeck-ios-v0.0.0.ipa'), 'old iOS build');
  }
  // Bash functions override even the system PATH prepended by the real script.
  // No compiler, signing, package inspection, or uploader executable is invoked.
  const envFile = join(root, 'mock-build.bash');
  writeFileSync(envFile, `
xcodebuild() {
  local export_path='' archive_path=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -exportPath) export_path="$2"; shift ;;
      -archivePath) archive_path="$2"; shift ;;
    esac
    shift
  done
  if [ -n "$export_path" ]; then
    mkdir -p "$export_path"
    case "$archive_path" in
      *_iOS.xcarchive) printf fresh-ios > "$export_path/AgentDeck.ipa" ;;
      *_macOS.xcarchive) printf fresh-macos > "$export_path/AgentDeck.pkg" ;;
      *) return 90 ;;
    esac
  fi
}
unzip() { mkdir -p "$4/Payload/AgentDeck.app"; }
pkgutil() { mkdir -p "$3/AgentDeck.app"; }
xcrun() { printf '%s\\n' "$*" >> "$UPLOAD_CALLS"; }
`);
  return { root, run: (target: string) => {
    const result = spawnSync('bash', ['scripts/build-apple-release.sh', target], {
      cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, BASH_ENV: envFile, ASC_API_KEY_ID: 'fixture-key', ASC_ISSUER_ID: 'fixture-issuer', UPLOAD_CALLS: join(root, 'uploads') },
    });
    const calls = existsSync(join(root, 'uploads')) ? readFileSync(join(root, 'uploads'), 'utf8').trim().split('\n') : [];
    return { ...result, calls };
  } };
}

describe.skipIf(process.platform === 'win32')('Apple release upload selection', () => {
  it.each([false, true])('uploads only the freshly verified iOS artifact (stale outputs: %s)', stale => {
    const f = fixture(stale); const result = f.run('--ios');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.calls).toEqual([`altool --upload-app -f ${f.root}/dist/agentdeck-ios-v0.0.0.ipa -t ios --apiKey fixture-key --apiIssuer fixture-issuer`]);
    if (stale) expect(readFileSync(join(f.root, 'dist/export_macos/stale.pkg'), 'utf8')).toBe('old macOS build');
  });
  it.each([false, true])('uploads only the freshly verified macOS artifact (stale outputs: %s)', stale => {
    const f = fixture(stale); const result = f.run('--macos');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.calls).toEqual([`altool --upload-app -f ${f.root}/dist/export_macos/AgentDeck.pkg -t macos --apiKey fixture-key --apiIssuer fixture-issuer`]);
    if (stale) expect(readFileSync(join(f.root, 'dist/agentdeck-ios-v0.0.0.ipa'), 'utf8')).toBe('old iOS build');
  });
  it('uploads both current verified artifacts for --all', () => {
    const f = fixture(true); const result = f.run('--all');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toContain(`${f.root}/dist/agentdeck-ios-v0.0.0.ipa -t ios`);
    expect(result.calls[1]).toContain(`${f.root}/dist/export_macos/AgentDeck.pkg -t macos`);
    expect(result.calls.join('\n')).not.toContain('stale.pkg');
  });
});
