import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { machoMatchesArch } from '../foundation-models-helper.js';

/**
 * The npm tarball deliberately ships NO helper binary: `prepack` used to bake
 * one on the publisher's machine, which made the same version number mean
 * three different artifacts (arm64 Mac → arm64 binary, Intel Mac → x86_64,
 * CI Linux → nothing at all). The helper now always compiles on demand, so a
 * publish from any machine produces the identical tarball. These tests pin
 * both halves of that contract: the manifest must never re-grow the baked
 * binary, and the resolver must reject a binary built for the other CPU
 * instead of spawning it into EBADARCH with no fallback.
 */
const bridgeRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

function thinMacho(cputype: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(MH_MAGIC_64, 0);
  buf.writeUInt32LE(cputype, 4);
  return buf;
}

function fatMacho(cputypes: number[]): Buffer {
  const buf = Buffer.alloc(8 + cputypes.length * 20);
  buf.writeUInt32BE(FAT_MAGIC, 0);
  buf.writeUInt32BE(cputypes.length, 4);
  cputypes.forEach((type, i) => buf.writeUInt32BE(type, 8 + i * 20));
  return buf;
}

describe('machoMatchesArch', () => {
  it('accepts a thin binary matching the requested arch', () => {
    expect(machoMatchesArch(thinMacho(CPU_ARM64), 'arm64')).toBe(true);
    expect(machoMatchesArch(thinMacho(CPU_X86_64), 'x64')).toBe(true);
  });

  it('rejects a thin binary built for the other CPU', () => {
    expect(machoMatchesArch(thinMacho(CPU_ARM64), 'x64')).toBe(false);
    expect(machoMatchesArch(thinMacho(CPU_X86_64), 'arm64')).toBe(false);
  });

  it('accepts a fat binary that carries a native slice', () => {
    const universal = fatMacho([CPU_X86_64, CPU_ARM64]);
    expect(machoMatchesArch(universal, 'arm64')).toBe(true);
    expect(machoMatchesArch(universal, 'x64')).toBe(true);
  });

  it('rejects a fat binary with no native slice', () => {
    expect(machoMatchesArch(fatMacho([CPU_X86_64]), 'arm64')).toBe(false);
  });

  it('rejects non-Mach-O and truncated input', () => {
    expect(machoMatchesArch(Buffer.from('#!/bin/sh\necho hi\n'), 'arm64')).toBe(false);
    expect(machoMatchesArch(Buffer.alloc(4), 'arm64')).toBe(false);
    expect(machoMatchesArch(Buffer.alloc(0), 'arm64')).toBe(false);
  });

  it('rejects a truncated fat header instead of over-reading', () => {
    const fat = fatMacho([CPU_ARM64]).subarray(0, 10);
    expect(machoMatchesArch(fat, 'arm64')).toBe(false);
  });

  it('rejects unknown architectures outright', () => {
    expect(machoMatchesArch(thinMacho(CPU_ARM64), 'ppc64')).toBe(false);
  });
});

describe('npm tarball determinism', () => {
  const manifest = JSON.parse(readFileSync(join(bridgeRoot, 'package.json'), 'utf8')) as {
    files?: string[];
    scripts?: Record<string, string>;
  };

  it('never ships a baked helper binary', () => {
    expect(manifest.files).not.toContain('assets/fm-helper');
  });

  it('allows only canonical license preparation, never machine-dependent builds, before pack', () => {
    expect(manifest.scripts?.prepack).toBe('node ../scripts/package-license.mjs');
  });

  it('ships the helper source and build script for on-demand compilation', () => {
    expect(manifest.files).toContain('fm-helper');
    expect(manifest.files).toContain('scripts/build-fm-helper.mjs');
  });
});
