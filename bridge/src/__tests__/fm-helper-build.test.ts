import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * The voice helper is a single Mach-O file with no app bundle, so the usage
 * descriptions TCC requires before it will *prompt* have to be linked into an
 * `__info_plist` section. Getting this wrong does not degrade gracefully: TCC
 * aborts the helper (SIGABRT) the moment it touches the mic or the recognizer,
 * which reads on the deck as "the VOICE key does nothing" and in the daemon log
 * as a request timeout. These assertions guard the three pieces that have to
 * agree — the plist keys, the linker flags, and the signing identity the grant
 * is pinned to.
 */
const bridgeRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const plistPath = join(bridgeRoot, 'fm-helper', 'Info.plist');
const sourcePath = join(bridgeRoot, 'fm-helper', 'AgentDeckFMHelper.swift');
const scriptPath = join(bridgeRoot, 'scripts', 'build-fm-helper.mjs');
const binaryPath = join(bridgeRoot, 'assets', 'fm-helper', 'agentdeck-fm-helper');

const REQUIRED_KEYS = [
  'NSMicrophoneUsageDescription',
  'NSSpeechRecognitionUsageDescription',
];

function plistValue(plist: string, key: string): string | null {
  const match = plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
  );
  return match ? match[1] : null;
}

/**
 * Comments in this build script *explain* the linker flags and the signing
 * identifier, so a plain `toContain` matches the prose after the code that
 * matters is gone. Strip comments before asserting — the first cut of this test
 * stayed green with `__info_plist` renamed in the actual argument list.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** `codesign -dv` reports on stderr even when it succeeds. */
function codesignReport(path: string): string {
  const result = spawnSync('/usr/bin/codesign', ['-dv', path], { encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function toolchainAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe('fm-helper build invariants', () => {
  const plist = readFileSync(plistPath, 'utf8');
  const script = codeOnly(readFileSync(scriptPath, 'utf8'));

  it.each(REQUIRED_KEYS)('declares a non-empty %s', (key) => {
    const value = plistValue(plist, key);
    expect(value, `${key} missing from fm-helper/Info.plist`).toBeTruthy();
    expect((value ?? '').length).toBeGreaterThan(20);
  });

  it('embeds the plist into the __TEXT segment at link time', () => {
    expect(script).toContain('-sectcreate');
    expect(script).toContain('__info_plist');
    expect(script).toMatch(/join\(root, 'fm-helper', 'Info\.plist'\)/);
  });

  it('ad-hoc signs with the identifier the plist declares', () => {
    // TCC keys an ad-hoc grant on the signing identifier; a mismatch between
    // these two reads as a different app and re-prompts forever.
    const bundleId = plistValue(plist, 'CFBundleIdentifier');
    expect(bundleId).toBeTruthy();
    expect(script).toContain('codesign');
    expect(script).toContain(`'${bundleId}'`);
  });

  it('exposes instruction-less eval sessions and the native output limit', () => {
    const source = codeOnly(readFileSync(sourcePath, 'utf8'));
    expect(source).toContain('let instructionsMode: String?');
    expect(source).toContain('request.instructionsMode == "none"');
    expect(source).toContain('let maximumResponseTokens: Int?');
    expect(source).toContain('maximumResponseTokens: maximumResponseTokens');
    expect(source).toContain('"generationProtocol": 2');
    expect(source).toContain('case .exceededContextWindowSize:');
    expect(source).toContain('return "unsupportedLanguageOrLocale"');
  });

  // #542: TCC charges a privacy request to the RESPONSIBLE process, which a
  // plain spawn inherits — so without this the grant belonged to whatever
  // launched the daemon (`node` under the LaunchAgent, the terminal in a
  // foreground run), never to the helper whose usage strings it carries.
  it('disclaims TCC responsibility by re-executing in place before serving', () => {
    const source = codeOnly(readFileSync(sourcePath, 'utf8'));
    const main = source.indexOf('static func main() async {');
    const disclaim = source.indexOf('ResponsibilityDisclaim.reexecIfNeeded()', main);
    const stdin = source.indexOf('FileHandle.standardInput.bytes.lines', main);
    expect(main).toBeGreaterThan(-1);
    expect(disclaim).toBeGreaterThan(main);
    expect(stdin).toBeGreaterThan(disclaim);
    // SETEXEC keeps the pid and the daemon's pipes; a spawned child would
    // outlive the daemon's SIGTERM to its parent while holding them.
    expect(source).toContain('POSIX_SPAWN_SETEXEC');
    expect(source).toContain('"responsibility_spawnattrs_setdisclaim"');
  });

  // Only meaningful where a dev build has run (`pnpm --filter @agentdeck/bridge
  // build:fm-helper`); the binary is not tracked or packaged — the npm install
  // compiles on demand — so its absence is not a failure.
  it.skipIf(!existsSync(binaryPath))('ships a binary carrying the usage strings', () => {
    const bytes = readFileSync(binaryPath);
    for (const key of REQUIRED_KEYS) {
      expect(bytes.includes(key), `${key} not embedded in the built helper`).toBe(true);
    }
  });

  // The assertions above read intent off the script; this one reads the outcome
  // off a real build, which is what TCC actually inspects.
  it.skipIf(!toolchainAvailable())('produces a signed binary macOS can prompt for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-helper-build-'));
    const out = join(dir, 'agentdeck-fm-helper');
    try {
      execFileSync(process.execPath, [scriptPath, '--out', out], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 180_000,
      });
      const bytes = readFileSync(out);
      for (const key of REQUIRED_KEYS) {
        expect(bytes.includes(key), `${key} not linked into the built helper`).toBe(true);
      }
      const signature = codesignReport(out);
      expect(signature).toContain(`Identifier=${plistValue(plist, 'CFBundleIdentifier')}`);
      expect(signature).toMatch(/Info\.plist entries=[1-9]/);

      // The disclaim re-exec must land in the SAME process (the daemon tracks
      // and kills that pid) and must not loop: the helper still answers on the
      // pipes it was spawned with, and its environment carries the marker.
      const probe = spawnSync('/bin/sh', ['-c',
        `(printf '{"id":7,"type":"health"}\\n'; sleep 2) | "${out}" & pid=$!; sleep 1; ps -E -p $pid -o command=; wait $pid`,
      ], { encoding: 'utf8', timeout: 20_000 });
      expect(probe.stdout).toContain('"id":7');
      expect(probe.stdout).toContain('AGENTDECK_FM_HELPER_DISCLAIMED=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 200_000);
});
