#!/usr/bin/env node
/** The root LICENSE is the only source. Package copies are ignored build
 * outputs, refreshed by both npm and pnpm prepack before every archive.
 * Packing/publishing is supported from the release source checkout: the
 * ../scripts prepack reference is intentionally not an installed-package API.
 * npm install does not execute prepack.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_NPM_PACKAGES = ['shared', 'hooks', 'bridge', 'setup'];
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function canonicalLicense(root = sourceRoot) {
  const bytes = readFileSync(join(root, 'LICENSE'));
  assert(bytes.length > 0, 'The root LICENSE must not be empty');
  return bytes;
}

export function preparePackageLicense(packageDir, root = sourceRoot) {
  const directory = resolve(packageDir);
  const name = basename(directory);
  assert(PUBLIC_NPM_PACKAGES.includes(name) && directory === join(resolve(root), name),
    'License preparation requires a public package in the release source checkout');
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, `@agentdeck/${name}`, 'Unexpected public package identity');
  const bytes = canonicalLicense(root);
  const target = join(directory, 'LICENSE');
  // Atomic replacement also replaces a stale symlink instead of following it.
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { package: manifest.name, licenseSha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The POSIX release/candidate gates inspect real archives, not dry-run lists.
 * Repeated LICENSE members concatenate and fail the byte comparison as well. */
export function verifyTarballLicense(tarball, expected = canonicalLicense()) {
  const actual = execFileSync('tar', ['-xOzf', tarball, 'package/LICENSE'], {
    timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(actual.equals(expected), `${basename(tarball)} must contain the root LICENSE byte-for-byte`);
  return createHash('sha256').update(actual).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePackageLicense(process.cwd());
}
