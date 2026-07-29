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
    const paths = resolveBleRuntimePaths({ packageRoot: root, dataDir, env: {} });

    expect(paths.scripts.idotmatrixScan).toBe(join(root, 'src', 'idotmatrix', 'scan.py'));
    expect(paths.scripts.timeboxSync).toBe(join(root, 'src', 'timebox', 'sync_ble.py'));
    expect(paths.venvPython).toBe(join(dataDir, 'python-ble', 'venv', 'bin', 'python'));
    expect(paths.legacyPython).toBe(join(root, '..', '.venv', 'bin', 'python'));
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
    expect(status.reason).toContain('python/requirements-ble.txt');
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
    expect(getBleRuntimeStatus({ packageRoot: root, dataDir, env: {} })).toMatchObject({
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
