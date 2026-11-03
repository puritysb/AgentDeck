/**
 * Optional Python runtime used by the terminal-managed BLE device clients.
 *
 * The npm package owns the Python scripts, while the writable virtual
 * environment lives under ~/.agentdeck so a global npm upgrade cannot erase it.
 * Explicit BLE CLI commands may prepare the environment; daemon startup only
 * inspects it and never performs network installation on its own.
 */

import { spawnSync, type SpawnSyncOptions } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

export interface BleRuntimePaths {
  packageRoot: string;
  dataDir: string;
  runtimeDir: string;
  venvDir: string;
  venvPython: string;
  legacyPython: string;
  requirements: string;
  readyMarker: string;
  scripts: {
    idotmatrixScan: string;
    /** Generated identity mirror imported by scan.py — packaged, never hand-edited. */
    idotmatrixIdentity: string;
    idotmatrixBrightness: string;
    idotmatrixSync: string;
    timeboxScan: string;
    timeboxSync: string;
    sharedSync: string;
  };
}

export interface BleRuntimeOptions {
  packageRoot?: string;
  dataDir?: string;
  platform?: NodeJS.Platform;
  /** Host CPU architecture (`process.arch` shape: 'arm64', 'x64', ...). */
  hostArch?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  run?: BleCommandRunner;
}

export interface BleRuntimeStatus {
  ready: boolean;
  python?: string;
  paths: BleRuntimePaths;
  reason?: string;
}

interface CommandResult {
  status: number | null;
  error?: Error;
}

type BleCommandRunner = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => CommandResult;

function defaultPackageRoot(): string {
  // Source: bridge/src/python-ble-runtime.ts
  // Build:  bridge/dist/python-ble-runtime.js
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function pythonInVenv(venvDir: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

export function resolveBleRuntimePaths(options: BleRuntimeOptions = {}): BleRuntimePaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const dataDir = options.dataDir ?? env.AGENTDECK_DATA_DIR ?? join(homedir(), '.agentdeck');
  const runtimeDir = join(dataDir, 'python-ble');
  const venvDir = join(runtimeDir, 'venv');
  const scriptsRoot = join(packageRoot, 'src');
  const legacyVenvDir = join(packageRoot, '..', '.venv');

  return {
    packageRoot,
    dataDir,
    runtimeDir,
    venvDir,
    venvPython: pythonInVenv(venvDir, platform),
    legacyPython: pythonInVenv(legacyVenvDir, platform),
    requirements: join(packageRoot, 'python', 'requirements-ble.txt'),
    readyMarker: join(runtimeDir, 'ready.json'),
    scripts: {
      idotmatrixScan: join(scriptsRoot, 'idotmatrix', 'scan.py'),
      idotmatrixIdentity: join(scriptsRoot, 'idotmatrix', 'identity_generated.py'),
      idotmatrixBrightness: join(scriptsRoot, 'idotmatrix', 'brightness.py'),
      idotmatrixSync: join(scriptsRoot, 'idotmatrix', 'sync.py'),
      timeboxScan: join(scriptsRoot, 'timebox', 'scan_ble.py'),
      timeboxSync: join(scriptsRoot, 'timebox', 'sync_ble.py'),
      sharedSync: join(scriptsRoot, 'pysync', 'matrix_sync_common.py'),
    },
  };
}

// CPU types from <mach/machine.h>, CPU_ARCH_ABI64-tagged.
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/**
 * Best-effort Mach-O CPU-type probe (thin and fat headers). Returns null when
 * the file is unreadable or not recognizably Mach-O — never a claim.
 */
function machOCpuTypes(path: string): number[] | null {
  let buf: Buffer;
  try {
    buf = readFileSync(path); // follows the venv's bin/python symlink chain
  } catch {
    return null;
  }
  if (buf.length < 8) return null;
  const magicLE = buf.readUInt32LE(0);
  if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) return [buf.readUInt32LE(4)];
  const magicBE = buf.readUInt32BE(0);
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    // Fat headers are big-endian. Java class files share FAT_MAGIC; their
    // version field lands where nfat_arch does and is always > 32, so the
    // bound doubles as the disambiguator.
    const count = buf.readUInt32BE(4);
    if (count === 0 || count > 32) return null;
    const entrySize = magicBE === 0xcafebabf ? 32 : 20;
    const types: number[] = [];
    for (let i = 0; i < count; i++) {
      const off = 8 + i * entrySize;
      if (off + 4 > buf.length) return null;
      types.push(buf.readUInt32BE(off));
    }
    return types;
  }
  return null;
}

/**
 * Non-null when `python` is an x86_64-only interpreter on an arm64 Mac — a
 * Rosetta leftover (e.g. a venv created by an Intel-Homebrew python that
 * survived a machine migration). It imports everything fine under Rosetta, so
 * a dependency probe cannot catch it; only the binary itself says. Such an
 * environment must be rebuilt, not used: every BLE client it runs is a
 * translated process, and its native wheels are the wrong architecture for
 * any native interpreter that replaces it.
 */
function rosettaInterpreterReason(
  python: string,
  platform: NodeJS.Platform,
  hostArch: string,
): string | null {
  if (platform !== 'darwin' || hostArch !== 'arm64') return null;
  const types = machOCpuTypes(python);
  if (!types || types.includes(CPU_TYPE_ARM64)) return null;
  if (!types.includes(CPU_TYPE_X86_64)) return null; // unknown arch — no claim
  return `${python} is an x86_64 (Rosetta) Python on this arm64 Mac`;
}

function packagedAssetsMissing(paths: BleRuntimePaths): string[] {
  return [paths.requirements, ...Object.values(paths.scripts)].filter((path) => !existsSync(path));
}

function requirementsDigest(paths: BleRuntimePaths): string {
  return createHash('sha256').update(readFileSync(paths.requirements)).digest('hex');
}

// Unversioned markers could be renewed from imports alone, without installing
// the declared versions. They must be repaired even when their digest matches.
const BLE_READY_MARKER_VERSION = 1;

function readyMarkerMatches(paths: BleRuntimePaths): boolean {
  if (!existsSync(paths.readyMarker)) return false;
  try {
    const marker = JSON.parse(readFileSync(paths.readyMarker, 'utf8')) as { version?: number; requirementsSha256?: string };
    return marker.version === BLE_READY_MARKER_VERSION && marker.requirementsSha256 === requirementsDigest(paths);
  } catch {
    return false;
  }
}

/**
 * Read-only daemon probe. It deliberately does not run Python or install
 * packages, so daemon startup remains deterministic and offline-safe.
 */
export function getBleRuntimeStatus(options: BleRuntimeOptions = {}): BleRuntimeStatus {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const hostArch = options.hostArch ?? process.arch;
  const paths = resolveBleRuntimePaths(options);
  const missing = packagedAssetsMissing(paths);
  if (missing.length > 0) {
    return {
      ready: false,
      paths,
      reason: `npm package is missing ${missing.map((path) => path.slice(paths.packageRoot.length + 1)).join(', ')}`,
    };
  }

  const override = env.AGENTDECK_BLE_PYTHON;
  if (override) {
    return existsSync(override)
      ? { ready: true, python: override, paths }
      : { ready: false, paths, reason: `AGENTDECK_BLE_PYTHON does not exist: ${override}` };
  }

  if (existsSync(paths.venvPython) && readyMarkerMatches(paths)) {
    const rosetta = rosettaInterpreterReason(paths.venvPython, platform, hostArch);
    if (!rosetta) return { ready: true, python: paths.venvPython, paths };
    return { ready: false, paths, reason: `${rosetta}; run \`agentdeck ble setup\` to rebuild it` };
  }

  // Preserve source-checkout and pre-1.0.4 manual environments. An explicit BLE
  // command will import-probe this interpreter before using it.
  if (!existsSync(paths.venvPython) && existsSync(paths.legacyPython)) {
    const rosetta = rosettaInterpreterReason(paths.legacyPython, platform, hostArch);
    if (!rosetta) return { ready: true, python: paths.legacyPython, paths };
    return { ready: false, paths, reason: `${rosetta}; run \`agentdeck ble setup\` to rebuild it` };
  }

  return {
    ready: false,
    paths,
    reason: 'optional BLE runtime is not prepared',
  };
}

function defaultRun(command: string, args: string[], options?: SpawnSyncOptions): CommandResult {
  const result = spawnSync(command, args, { ...options, windowsHide: true });
  return {
    status: result.status,
    error: result.error,
  };
}

function commandSucceeded(
  run: BleCommandRunner,
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): boolean {
  const result = run(command, args, { ...options, stdio: options.stdio ?? 'ignore' });
  return !result.error && result.status === 0;
}

function dependencyProbe(run: BleCommandRunner, python: string): boolean {
  return commandSucceeded(run, python, [
    '-c',
    'import bleak; import PIL; import idotmatrix',
  ]);
}

function systemPython(
  run: BleCommandRunner,
  platform: NodeJS.Platform,
  hostArch: string,
): { command: string; prefix: string[] } | null {
  const candidates = platform === 'win32'
    ? [
        { command: 'py', prefix: ['-3'] },
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] },
      ]
    : [
        // On an arm64 Mac a bare `python3` can resolve to a leftover Intel
        // Homebrew install (/usr/local precedes /opt/homebrew in the default
        // /etc/paths order for daemon-spawned shells), building the whole BLE
        // venv on Rosetta. Probe the native Homebrew interpreter first; it is
        // simply skipped where it does not exist.
        ...(platform === 'darwin' && hostArch === 'arm64'
          ? [{ command: '/opt/homebrew/bin/python3', prefix: [] }]
          : []),
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] },
      ];

  for (const candidate of candidates) {
    if (commandSucceeded(run, candidate.command, [
      ...candidate.prefix,
      '-c',
      'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)',
    ])) {
      return candidate;
    }
  }
  return null;
}

/**
 * Ensure the optional BLE dependencies exist. This is called only from an
 * explicit BLE command (`ble setup`, scan, brightness, test, or sync).
 */
export function ensureBleRuntime(options: BleRuntimeOptions = {}): BleRuntimeStatus & { ready: true; python: string } {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const hostArch = options.hostArch ?? process.arch;
  const paths = resolveBleRuntimePaths(options);
  const log = options.log ?? (() => {});
  const run = options.run ?? defaultRun;
  const missing = packagedAssetsMissing(paths);

  if (missing.length > 0) {
    throw new Error(
      `The installed @agentdeck/bridge package is missing BLE assets: ${missing.join(', ')}. ` +
      'Reinstall @agentdeck/setup, then try again.',
    );
  }

  const override = env.AGENTDECK_BLE_PYTHON;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`AGENTDECK_BLE_PYTHON does not exist: ${override}`);
    }
    if (!dependencyProbe(run, override)) {
      throw new Error(
        `AGENTDECK_BLE_PYTHON cannot import bleak, Pillow, and idotmatrix: ${override}. ` +
        `Install the dependencies from ${paths.requirements}.`,
      );
    }
    return { ready: true, python: override, paths };
  }

  // The Rosetta check precedes the dependency probe: a translated interpreter
  // imports everything just fine, so probing it would accept exactly the
  // environment we need to rebuild.
  const venvRosetta = existsSync(paths.venvPython)
    ? rosettaInterpreterReason(paths.venvPython, platform, hostArch)
    : null;
  if (existsSync(paths.venvPython) && !venvRosetta && readyMarkerMatches(paths) && dependencyProbe(run, paths.venvPython)) {
    return { ready: true, python: paths.venvPython, paths };
  }

  const legacyRosetta = existsSync(paths.legacyPython)
    ? rosettaInterpreterReason(paths.legacyPython, platform, hostArch)
    : null;
  if (legacyRosetta) log(`Ignoring legacy BLE venv: ${legacyRosetta}.`);
  if (!existsSync(paths.venvPython) && existsSync(paths.legacyPython) && !legacyRosetta && dependencyProbe(run, paths.legacyPython)) {
    return { ready: true, python: paths.legacyPython, paths };
  }

  const python = systemPython(run, platform, hostArch);
  if (!python) {
    throw new Error('Python 3.10 or newer is required for optional BLE device support.');
  }

  if (venvRosetta) {
    // `python -m venv` over an existing venv relinks the interpreter but keeps
    // site-packages — native wheels compiled for the wrong architecture. Start
    // clean instead.
    log(`Rebuilding BLE venv: ${venvRosetta}.`);
    rmSync(paths.venvDir, { recursive: true, force: true });
  }

  mkdirSync(paths.runtimeDir, { recursive: true });
  // Imports do not prove the installed versions satisfy a changed manifest.
  // Revoke old readiness before repair; a failed install must stay unready.
  rmSync(paths.readyMarker, { force: true });
  log(`Preparing optional BLE support in ${paths.runtimeDir}...`);
  const create = run(python.command, [
    ...python.prefix,
    '-m',
    'venv',
    paths.venvDir,
  ], { stdio: 'inherit' });
  if (create.error || create.status !== 0 || !existsSync(paths.venvPython)) {
    throw new Error(`Failed to create the BLE Python environment at ${paths.venvDir}.`);
  }

  const install = run(paths.venvPython, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--requirement',
    paths.requirements,
  ], { stdio: 'inherit' });
  if (install.error || install.status !== 0 || !dependencyProbe(run, paths.venvPython)) {
    throw new Error(
      `Failed to install optional BLE dependencies. Retry with \`agentdeck ble setup\` ` +
      `or inspect ${paths.requirements}.`,
    );
  }

  writeFileSync(paths.readyMarker, JSON.stringify({
    version: BLE_READY_MARKER_VERSION,
    requirementsSha256: requirementsDigest(paths),
    preparedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  log('Optional BLE support is ready.');
  return { ready: true, python: paths.venvPython, paths };
}
