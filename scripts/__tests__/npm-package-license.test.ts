import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_NPM_PACKAGES, canonicalLicense, preparePackageLicense, verifyTarballLicense } from '../package-license.mjs';

const roots: string[] = [];
const sourceRoot = resolve(__dirname, '../..');
const license = Buffer.from('MIT License\r\nCopyright (c) Fixture — 테스트\r\nNo newline normalization.\n');
// Deterministic USTAR fixtures exercise GNU tar's duplicate-path hardlink form
// even when the tests run on macOS, where bsdtar writes two regular entries.
function licenseArchive(secondType: '0' | '1') {
  function header(type: string, size: number) {
    const bytes = Buffer.alloc(512);
    const field = (value: string, offset: number) => bytes.write(value, offset, 'ascii');
    field('package/LICENSE', 0);
    field('0000644\0', 100);
    field('0000000\0', 108);
    field('0000000\0', 116);
    field(size.toString(8).padStart(11, '0') + '\0', 124);
    field('00000000000\0', 136);
    bytes.fill(0x20, 148, 156);
    field(type, 156);
    if (type === '1') field('package/LICENSE', 157);
    field('ustar\0', 257);
    field('00', 263);
    const checksum = bytes.reduce((sum, byte) => sum + byte, 0);
    field(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    return bytes;
  }
  return gzipSync(Buffer.concat([
    header('0', license.length), license, Buffer.alloc((512 - license.length % 512) % 512),
    header(secondType, 0), Buffer.alloc(1024),
  ]));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-license-test-'));
  roots.push(root);
  writeFileSync(join(root, 'LICENSE'), license);
  for (const name of PUBLIC_NPM_PACKAGES) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'package.json'), JSON.stringify({ name: `@agentdeck/${name}` }));
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('canonical npm package license', () => {
  it('prepares missing copies and repairs corrupted copies for all public packages without changing the source', () => {
    const root = fixture();
    for (const name of PUBLIC_NPM_PACKAGES) {
      const directory = join(root, name);
      preparePackageLicense(directory, root);
      expect(readFileSync(join(directory, 'LICENSE'))).toEqual(license);
      writeFileSync(join(directory, 'LICENSE'), 'obsolete or corrupted generated copy');
      preparePackageLicense(directory, root);
      expect(readFileSync(join(directory, 'LICENSE'))).toEqual(license);
      expect(readdirSync(directory).filter(file => file.endsWith('.tmp'))).toEqual([]);
    }
    expect(readFileSync(join(root, 'LICENSE'))).toEqual(license);
  });

  it('refuses missing or empty canonical content and a mismatched package before modifying the generated copy', () => {
    const root = fixture();
    const directory = join(root, 'shared');
    writeFileSync(join(directory, 'LICENSE'), 'preserved');
    rmSync(join(root, 'LICENSE'));
    expect(() => preparePackageLicense(directory, root)).toThrow();
    writeFileSync(join(root, 'LICENSE'), '');
    expect(() => preparePackageLicense(directory, root)).toThrow(/must not be empty/);
    writeFileSync(join(root, 'LICENSE'), license);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@unrelated/shared' }));
    expect(() => preparePackageLicense(directory, root)).toThrow(/identity/);
    expect(readFileSync(join(directory, 'LICENSE'), 'utf8')).toBe('preserved');
    expect(() => preparePackageLicense(root, root)).toThrow(/source checkout/);
  });

  it('wires every public package to the same prepack source and explicit LICENSE inclusion', () => {
    expect(PUBLIC_NPM_PACKAGES).toEqual(['shared', 'hooks', 'bridge', 'setup']);
    for (const name of PUBLIC_NPM_PACKAGES) {
      const manifest = JSON.parse(readFileSync(join(sourceRoot, name, 'package.json'), 'utf8'));
      expect(manifest.files).toContain('LICENSE');
      expect(manifest.scripts.prepack).toBe('node ../scripts/package-license.mjs');
    }
  });

  it('checks the actual archive bytes and rejects missing, changed or duplicate license entries', () => {
    const root = fixture();
    const packageDir = join(root, 'package');
    mkdirSync(packageDir);
    const archive = join(root, 'fixture.tgz');
    const pack = () => execFileSync('tar', ['-czf', archive, '-C', root, 'package'], { windowsHide: true });
    writeFileSync(join(packageDir, 'README.md'), 'fixture');
    pack();
    expect(() => verifyTarballLicense(archive, canonicalLicense(root))).toThrow();
    writeFileSync(join(packageDir, 'LICENSE'), 'incorrect');
    pack();
    expect(() => verifyTarballLicense(archive, license)).toThrow(/byte-for-byte/);
    writeFileSync(join(packageDir, 'LICENSE'), license);
    pack();
    expect(verifyTarballLicense(archive, license)).toMatch(/^[a-f0-9]{64}$/);
    execFileSync('tar', ['-czf', archive, '-C', root, 'package/LICENSE', 'package/LICENSE'], { windowsHide: true });
    expect(() => verifyTarballLicense(archive, license)).toThrow(/exactly one/);
  });

  it.each(['0', '1'] as const)('rejects a duplicate LICENSE type %s even when extraction returns exactly the canonical bytes', (secondType) => {
    const root = fixture();
    const archive = join(root, 'duplicate-zero-byte.tgz');
    writeFileSync(archive, licenseArchive(secondType));
    expect(execFileSync('tar', ['-xOzf', archive, 'package/LICENSE'])).toEqual(license);
    expect(() => verifyTarballLicense(archive, license)).toThrow(/exactly one/);
  });
});
