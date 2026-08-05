#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'fm-helper', 'AgentDeckFMHelper.swift');
const plist = join(root, 'fm-helper', 'Info.plist');
const defaultOut = join(root, 'assets', 'fm-helper', 'agentdeck-fm-helper');
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const target = `${arch}-apple-macos26.0`;
/** Must match CFBundleIdentifier in fm-helper/Info.plist — see the note there. */
const signingIdentifier = 'bound.serendipity.agentdeck.fm-helper';

// The daemon's source-compiled fallback (foundation-models-helper.ts) runs this
// same script with --out so the plist embedding and the signature can't drift
// between the packaged binary and a locally rebuilt one.
const outFlag = process.argv.indexOf('--out');
const out = outFlag >= 0 ? process.argv[outFlag + 1] : defaultOut;
if (outFlag >= 0 && !out) {
  console.error('[fm-helper] --out requires a path');
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.log('[fm-helper] skipped: darwin only');
  process.exit(0);
}

mkdirSync(dirname(out), { recursive: true });
const swiftc = execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim();
// swiftc is run directly (not via `xcrun swiftc`), so SDKROOT isn't set and the
// stdlib can't be found ("unable to load standard library for target ..."). Pass
// the SDK path explicitly so the build is reproducible from the npm lifecycle.
const sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
const args = ['-parse-as-library', '-sdk', sdk, '-target', target, source, '-o', out];
// A single-file tool has no bundle, so its usage descriptions have to live in an
// __info_plist section: TCC aborts (SIGABRT, not an error return) the moment it
// needs to prompt for the mic or speech recognition without one.
if (existsSync(plist)) {
  args.push('-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist);
} else {
  console.warn(`[fm-helper] WARNING: ${plist} missing — voice capture will crash under TCC`);
}
execFileSync(swiftc, args, { stdio: 'inherit' });
chmodSync(out, 0o755);
// Ad-hoc signing gives TCC a stable identity to hang the grant on. It is not
// about trust: an unsigned binary's grant is keyed on the raw cdhash alone, so
// the prompt cannot name the helper and the user sees a nameless request.
try {
  execFileSync('/usr/bin/codesign', [
    '--force', '--sign', '-', '--identifier', signingIdentifier, out,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (err) {
  console.warn(`[fm-helper] WARNING: ad-hoc codesign failed: ${String(err).slice(0, 160)}`);
}
console.log(`[fm-helper] built ${out}`);
