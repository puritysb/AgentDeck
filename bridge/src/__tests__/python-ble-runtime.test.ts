import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  ensureBleRuntime,
  getBleRuntimeStatus,
  resolveBleRuntimePaths,
} from '../python-ble-runtime.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-python-ble-'));
  tempDirs.push(dir);
  return dir;
}

function write(path: string, content = '# test\n'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makePackage(root: string): void {
  const paths = resolveBleRuntimePaths({
    packageRoot: root,
    dataDir: join(root, '.data'),
    env: {},
  });
  write(paths.requirements, 'bleak>=2.1,<3\nPillow>=12,<13\nidotmatrix==0.0.9\n');
  for (const script of Object.values(paths.scripts)) write(script);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('optional Python BLE runtime', () => {
  it('resolves packaged scripts from the bridge package and keeps the venv in the data directory', () => {
    const root = join(tempDir(), 'bridge');
    const dataDir = join(tempDir(), 'data');
    // Pin the platform: the venv interpreter location is platform-shaped
    // (bin/python vs Scripts\python.exe), the rest is host-join()ed either way.
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {}, platform: 'linux' });

    expect(paths.scripts.idotmatrixScan).toBe(join(root, 'src', 'idotmatrix', 'scan.py'));
    expect(paths.scripts.timeboxSync).toBe(join(root, 'src', 'timebox', 'sync_ble.py'));
    expect(paths.venvPython).toBe(join(dataDir, 'python-ble', 'venv', 'bin', 'python'));
    expect(paths.legacyPython).toBe(join(root, '..', '.venv', 'bin', 'python'));

    const win = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {}, platform: 'win32' });
    expect(win.venvPython).toBe(join(dataDir, 'python-ble', 'venv', 'Scripts', 'python.exe'));
  });

  it('reports missing npm assets instead of silently disabling BLE', () => {
    const root = join(tempDir(), 'bridge');
    const status = getBleRuntimeStatus({
      packageRoot: root,
      dataDir: join(tempDir(), 'data'),
      env: {},
    });

    expect(status.ready).toBe(false);
    expect(status.reason).toContain('npm package is missing');
    // The reason embeds host-join()ed relative paths — backslashes on Windows.
    expect(status.reason?.replace(/\\/g, '/')).toContain('python/requirements-ble.txt');
  });

  it('creates and marks a persistent environment on first explicit setup', () => {
    const root = join(tempDir(), 'bridge');
    const dataDir = join(tempDir(), 'data');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {} });
    const calls: Array<{ command: string; args: string[] }> = [];

    const runtime = ensureBleRuntime({
      packageRoot: root,
      dataDir,
      env: {},
      run: (command, args) => {
        calls.push({ command, args });
        if (args.includes('venv')) write(paths.venvPython, '#!/usr/bin/env python3\n');
        return { status: 0 };
      },
    });

    expect(runtime.python).toBe(paths.venvPython);
    expect(calls.some(({ args }) => args.includes('venv'))).toBe(true);
    expect(calls.some(({ args }) => args.includes('pip') && args.includes(paths.requirements))).toBe(true);
    expect(existsSync(paths.readyMarker)).toBe(true);
    expect(JSON.parse(readFileSync(paths.readyMarker, 'utf8'))).toHaveProperty('requirementsSha256');
    expect(getBleRuntimeStatus({ packageRoot: root, dataDir, env: {}, run: () => ({ status: 0 }) })).toMatchObject({
      ready: true,
      python: paths.venvPython,
    });
  });

  it('accepts a compatible legacy checkout venv without modifying it', () => {
    const parent = tempDir();
    const root = join(parent, 'bridge');
    const dataDir = join(parent, 'data');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {} });
    write(paths.legacyPython, '#!/usr/bin/env python3\n');
    const calls: string[][] = [];

    const runtime = ensureBleRuntime({
      packageRoot: root,
      dataDir,
      env: {},
      run: (_command, args) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    expect(runtime.python).toBe(paths.legacyPython);
    expect(calls).toHaveLength(1);
    expect(existsSync(paths.readyMarker)).toBe(false);
  });

  it('rejects an incompatible override before any BLE command can use it', () => {
    const root = join(tempDir(), 'bridge');
    makePackage(root);
    const override = join(root, 'external-python');
    write(override);
    const options = {
      packageRoot: root,
      env: { AGENTDECK_BLE_PYTHON: override },
      run: () => ({ status: 1 }),
    };

    expect(getBleRuntimeStatus(options)).toMatchObject({ ready: false });
    expect(() => ensureBleRuntime(options)).toThrow('cryptography >= 50.0.0');
  });

  it('rejects incompatible legacy and managed environments even with a matching marker', () => {
    const root = join(tempDir(), 'bridge');
    const dataDir = join(root, '.data');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {} });
    write(paths.legacyPython);
    let rejectManaged = false;
    const options = {
      packageRoot: root, dataDir, env: {},
      run: (command: string, args: string[]) => {
        if (args.includes('venv')) write(paths.venvPython);
        const incompatible = command === paths.legacyPython ||
          (rejectManaged && command === paths.venvPython && args.includes('-B'));
        return { status: incompatible ? 1 : 0 };
      },
    };

    expect(getBleRuntimeStatus(options)).toMatchObject({ ready: false });
    expect(ensureBleRuntime(options).python).toBe(paths.venvPython);
    expect(getBleRuntimeStatus(options)).toMatchObject({ ready: true });
    rejectManaged = true;
    expect(getBleRuntimeStatus(options)).toMatchObject({ ready: false });
    expect(() => ensureBleRuntime(options)).toThrow('Failed to install optional BLE dependencies');
    expect(existsSync(paths.readyMarker)).toBe(false);
  });

  it('installs changed managed requirements even when imports and a legacy environment still work', () => {
    const root = join(tempDir(), 'bridge'), dataDir = join(tempDir(), 'data');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {}, platform: 'linux' });
    const calls: Array<{command: string; args: string[]}> = [];
    const options = { packageRoot: root, dataDir, env: {}, platform: 'linux' as const,
      run: (command: string, args: string[]) => {
        calls.push({command,args});
        if (args.includes('venv')) write(paths.venvPython);
        return {status: 0};
      } };
    ensureBleRuntime(options);
    calls.length = 0;
    ensureBleRuntime(options);
    expect(calls.some(c => c.args.includes('pip'))).toBe(false);
    write(paths.legacyPython);
    write(paths.requirements, 'bleak>=2.1,<3\nPillow>=13,<14\nidotmatrix==0.0.9\n');
    expect(getBleRuntimeStatus(options).ready).toBe(false);
    calls.length = 0;
    const runtime = ensureBleRuntime(options);
    expect(runtime.python).toBe(paths.venvPython);
    expect(calls.some(c => c.command === paths.venvPython && c.args.includes('pip') && c.args.includes(paths.requirements))).toBe(true);
    expect(calls.some(c => c.command === paths.legacyPython)).toBe(false);
    expect(getBleRuntimeStatus(options)).toMatchObject({ready: true, python: paths.venvPython});
  });

  it('keeps a failed managed upgrade unready instead of blessing imports or falling back to legacy', () => {
    const root = join(tempDir(), 'bridge'), dataDir = join(tempDir(), 'data');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {}, platform: 'linux' });
    let failInstall = false;
    const options = { packageRoot: root, dataDir, env: {}, platform: 'linux' as const,
      run: (_command: string, args: string[]) => {
        if (args.includes('venv')) write(paths.venvPython);
        return {status: failInstall && args.includes('pip') ? 1 : 0};
      } };
    ensureBleRuntime(options);
    write(paths.legacyPython);
    write(paths.requirements, 'bleak>=2.1,<3\nPillow>=13,<14\nidotmatrix==0.0.9\n');
    failInstall = true;
    expect(() => ensureBleRuntime(options)).toThrow('Failed to install optional BLE dependencies');
    expect(getBleRuntimeStatus(options).ready).toBe(false);
    expect(existsSync(paths.readyMarker)).toBe(false);
  });

  it('reinstalls for an old unversioned marker even if it already claims the current requirements digest', () => {
    const root = join(tempDir(), 'bridge'), dataDir = join(tempDir(), 'data');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {}, platform: 'linux' });
    const calls: string[][] = [];
    const options = { packageRoot: root, dataDir, env: {}, platform: 'linux' as const,
      run: (_command: string, args: string[]) => {
        calls.push(args);
        if (args.includes('venv')) write(paths.venvPython);
        return {status: 0};
      } };
    ensureBleRuntime(options);
    const marker = JSON.parse(readFileSync(paths.readyMarker, 'utf8'));
    delete marker.version;
    write(paths.readyMarker, JSON.stringify(marker));
    expect(getBleRuntimeStatus(options).ready).toBe(false);
    calls.length = 0;
    ensureBleRuntime(options);
    expect(calls.some(args => args.includes('pip') && args.includes(paths.requirements))).toBe(true);
    expect(getBleRuntimeStatus(options).ready).toBe(true);
  });
});

describe('bridge npm BLE assets', () => {
  it('publishes every Python client and the dependency manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { files: string[] };

    expect(manifest.files).toEqual(expect.arrayContaining([
      'python',
      'src/idotmatrix/*.py',
      'src/timebox/*.py',
      'src/pysync/*.py',
    ]));
  });
});

describe('Rosetta interpreter guard (darwin/arm64)', () => {
  const machOThin = (cputype: number): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(cputype, 4);
    return buf;
  };
  const machOFat = (cputypes: number[]): Buffer => {
    const buf = Buffer.alloc(8 + cputypes.length * 20);
    buf.writeUInt32BE(0xcafebabe, 0);
    buf.writeUInt32BE(cputypes.length, 4);
    cputypes.forEach((t, i) => buf.writeUInt32BE(t, 8 + i * 20));
    return buf;
  };
  const X86_64 = 0x01000007;
  const ARM64 = 0x0100000c;

  it('refuses an x86_64-only legacy venv on an arm64 Mac with a rebuild hint', () => {
    const root = join(tempDir(), 'bridge');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir: join(root, '.data'), env: {} });
    write(paths.legacyPython);
    writeFileSync(paths.legacyPython, machOThin(X86_64));

    const status = getBleRuntimeStatus({
      packageRoot: root,
      dataDir: join(root, '.data'),
      env: {},
      platform: 'darwin',
      hostArch: 'arm64',
    });
    expect(status.ready).toBe(false);
    expect(status.reason).toContain('Rosetta');
    expect(status.reason).toContain('agentdeck ble setup');
  });

  it('accepts a universal binary carrying an arm64 slice, and anything on non-arm64 hosts', () => {
    const root = join(tempDir(), 'bridge');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir: join(root, '.data'), env: {} });
    write(paths.legacyPython);
    writeFileSync(paths.legacyPython, machOFat([ARM64, X86_64]));

    const base = { packageRoot: root, dataDir: join(root, '.data'), env: {}, run: () => ({ status: 0 }) };
    expect(getBleRuntimeStatus({ ...base, platform: 'darwin', hostArch: 'arm64' }).ready).toBe(true);

    // The same x86_64-only binary is fine where Rosetta is not in play.
    writeFileSync(paths.legacyPython, machOThin(X86_64));
    expect(getBleRuntimeStatus({ ...base, platform: 'darwin', hostArch: 'x64' }).ready).toBe(true);
    expect(getBleRuntimeStatus({ ...base, platform: 'linux', hostArch: 'arm64' }).ready).toBe(true);
  });

  it('makes no claim about an unrecognized binary (scripts, ELF, truncated files)', () => {
    const root = join(tempDir(), 'bridge');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir: join(root, '.data'), env: {} });
    write(paths.legacyPython, '#!/bin/sh\nexec python3 "$@"\n');

    const status = getBleRuntimeStatus({
      packageRoot: root,
      dataDir: join(root, '.data'),
      env: {},
      run: () => ({ status: 0 }),
      platform: 'darwin',
      hostArch: 'arm64',
    });
    expect(status.ready).toBe(true);
  });

  it('rebuilds a Rosetta venv with the native Homebrew interpreter probed first', () => {
    const root = join(tempDir(), 'bridge');
    const dataDir = join(root, '.data');
    makePackage(root);
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {} });
    write(paths.legacyPython);
    writeFileSync(paths.legacyPython, machOThin(X86_64));

    const calls: Array<{ command: string; args: string[] }> = [];
    const runtime = ensureBleRuntime({
      packageRoot: root,
      dataDir,
      env: {},
      platform: 'darwin',
      hostArch: 'arm64',
      run: (command, args) => {
        calls.push({ command, args });
        if (args.includes('venv')) write(paths.venvPython);
        return { status: 0 };
      },
    });

    // The Rosetta legacy venv was never dependency-probed or returned.
    expect(runtime.python).toBe(paths.venvPython);
    expect(calls.some((c) => c.command === paths.legacyPython)).toBe(false);
    // Interpreter probing starts at the native Homebrew path.
    expect(calls[0].command).toBe('/opt/homebrew/bin/python3');
  });
});
