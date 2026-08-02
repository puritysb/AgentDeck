/**
 * Unit tests for the systemd user-unit builder (pure, cross-platform).
 *
 * The `systemctl --user` calls in linux-service.ts are integration-only — they
 * require a real Linux host with a user D-Bus session and mutate systemd state —
 * and are exercised manually per docs/daemon.md, not here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  SERVICE_NAME,
  buildUnitFile,
  escapeUnitEnvAssignment,
  escapeExecWord,
  validateDataDirOverride,
  getDataDir,
  getUnitDir,
  getUnitPath,
  installUnit,
} from '../linux-service.js';

// The vitest harness pins AGENTDECK_DATA_DIR to a host tmpdir (vitest.setup.ts),
// which on Windows is a `C:\…` path the systemd validator rightly rejects. Tests
// that don't care about the data dir pass this POSIX fixture instead of
// inheriting the env, so the unit builder stays pure and cross-platform.
const posixDataDir = '/tmp/agentdeck-test-data';

describe('buildUnitFile', () => {
  const node = '/usr/bin/node';
  const cliJs = '/home/alice/.local/share/agentdeck/cli.js';

  it('produces a well-formed unit with the three standard sections', () => {
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: posixDataDir });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Description=AgentDeck monitoring daemon');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('runs the daemon in the foreground so systemd supervises the real process', () => {
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: posixDataDir });
    expect(unit).toContain(`ExecStart="${node}" "${cliJs}" daemon start --foreground`);
    expect(unit).toContain('Type=simple');
  });

  it('mirrors LaunchAgent KeepAlive via Restart=on-failure', () => {
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: posixDataDir });
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5');
  });

  it('waits for the network to be online', () => {
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: posixDataDir });
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('Wants=network-online.target');
  });

  it('defaults the working directory to ~/.agentdeck', () => {
    // The vitest harness pins AGENTDECK_DATA_DIR globally (vitest.setup.ts); clear
    // it here to exercise the bare homedir fallback.
    const saved = process.env.AGENTDECK_DATA_DIR;
    delete process.env.AGENTDECK_DATA_DIR;
    try {
      const unit = buildUnitFile({ node, cliJs });
      expect(unit).toContain(`WorkingDirectory=${join(homedir(), '.agentdeck')}`);
    } finally {
      if (saved === undefined) delete process.env.AGENTDECK_DATA_DIR;
      else process.env.AGENTDECK_DATA_DIR = saved;
    }
  });

  it('derives BOTH WorkingDirectory and Environment from one dataDirOverride', () => {
    // Single override source — a unit must never chdir into one directory while
    // the daemon process resolves another (the split-state failure mode).
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: '/srv/agentdeck-data' });
    expect(unit).toContain('WorkingDirectory=/srv/agentdeck-data');
    expect(unit).toContain('Environment="AGENTDECK_DATA_DIR=/srv/agentdeck-data"');
  });

  it('reflects the AGENTDECK_DATA_DIR override in WorkingDirectory and Environment', () => {
    const saved = process.env.AGENTDECK_DATA_DIR;
    process.env.AGENTDECK_DATA_DIR = '/var/lib/agentdeck';
    try {
      const unit = buildUnitFile({ node, cliJs });
      expect(unit).toContain('WorkingDirectory=/var/lib/agentdeck');
      expect(unit).toContain('Environment="AGENTDECK_DATA_DIR=/var/lib/agentdeck"');
    } finally {
      if (saved === undefined) delete process.env.AGENTDECK_DATA_DIR;
      else process.env.AGENTDECK_DATA_DIR = saved;
    }
  });
});

/**
 * Byte-level golden fixtures — the authoritative assertion on the generated
 * unit. The AGENTDECK_DATA_DIR value is user-controlled and travels through a
 * file format with its own quoting rules, so what matters is the unit's exact
 * bytes and the environment the launched service receives.
 *
 * Provenance: the expected bytes below encode observed systemd behavior, not a
 * reading of the docs — the escaping was verified end-to-end on Debian 13
 * (systemd 257) by installing the generated user unit with a hostile data dir
 * (space, `%i`, `"`, `\`, `$` in the dirname) and asserting the exact raw value
 * back out of /proc/<MainPID>/environ of the running daemon (PR #54).
 */
describe('unit-file escaping (golden bytes)', () => {
  const node = '/usr/bin/node';
  const cliJs = '/opt/agentdeck/cli.js';
  const saved = process.env.AGENTDECK_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = saved;
  });

  it('emits NO Environment= line when the override is not set', () => {
    delete process.env.AGENTDECK_DATA_DIR;
    const unit = buildUnitFile({ node, cliJs });
    expect(unit).not.toContain('Environment=');
  });

  it('passes a plain path with a space through quoted and unescaped', () => {
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: '/srv/agentdeck data' });
    expect(unit).toContain('Environment="AGENTDECK_DATA_DIR=/srv/agentdeck data"\n');
    expect(unit).toContain('WorkingDirectory=/srv/agentdeck data\n');
  });

  it('escapes % as %% (specifier expansion) in Environment and WorkingDirectory', () => {
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: '/srv/deck %i' });
    expect(unit).toContain('Environment="AGENTDECK_DATA_DIR=/srv/deck %%i"\n');
    expect(unit).toContain('WorkingDirectory=/srv/deck %%i\n');
  });

  it('C-escapes backslash and double quote inside the quoted Environment value', () => {
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: '/srv/a\\b"c' });
    expect(unit).toContain('Environment="AGENTDECK_DATA_DIR=/srv/a\\\\b\\"c"\n');
    // WorkingDirectory is verbatim (no word split / unquoting): raw bytes.
    expect(unit).toContain('WorkingDirectory=/srv/a\\b"c\n');
  });

  it('keeps $ SINGLE in Environment= (systemd does not expand $ there)', () => {
    // Guards a future refactor from applying Exec-style $$ doubling here.
    const unit = buildUnitFile({ node, cliJs, dataDirOverride: '/srv/a$b' });
    expect(unit).toContain('Environment="AGENTDECK_DATA_DIR=/srv/a$b"\n');
    expect(unit).toContain('WorkingDirectory=/srv/a$b\n');
  });

  it('doubles $ and % in ExecStart words (expanded there even inside quotes)', () => {
    const unit = buildUnitFile({
      node: '/opt/n v$1/node',
      cliJs: '/opt/deck %i/cli.js',
      dataDirOverride: posixDataDir,
    });
    expect(unit).toContain('ExecStart="/opt/n v$$1/node" "/opt/deck %%i/cli.js" daemon start --foreground');
  });

  it('escapeUnitEnvAssignment / escapeExecWord expose the per-directive rules', () => {
    expect(escapeUnitEnvAssignment('X', 'a b%c"d\\e$f')).toBe('"X=a b%%c\\"d\\\\e$f"');
    expect(escapeExecWord('a b%c"d\\e$f')).toBe('"a b%%c\\"d\\\\e$$f"');
  });

  it.each([
    ['newline', '/srv/a\nb'],
    ['carriage return', '/srv/a\rb'],
    ['NUL', '/srv/a\0b'],
  ])('rejects control characters in the override (%s)', (_name, value) => {
    expect(() => buildUnitFile({ node, cliJs, dataDirOverride: value })).toThrow(/control character/);
  });

  it.each([
    ['relative path', 'srv/agentdeck'],
    ['bare tilde', '~'],
    ['tilde path', '~/agentdeck'],
    ['ignore-missing prefix', '-/srv/agentdeck'],
  ])('rejects non-absolute overrides (%s)', (_name, value) => {
    expect(() => buildUnitFile({ node, cliJs, dataDirOverride: value })).toThrow(/absolute path/);
  });

  it.each([
    ['leading space', ' /srv/agentdeck'],
    ['trailing space', '/srv/agentdeck '],
    ['trailing tab', '/srv/agentdeck\t'],
  ])('rejects edge whitespace the unit parser would trim (%s)', (_name, value) => {
    expect(() => buildUnitFile({ node, cliJs, dataDirOverride: value })).toThrow(/whitespace|control character/);
  });

  it('validateDataDirOverride accepts a hostile-but-legal absolute path', () => {
    expect(() => validateDataDirOverride('/srv/deck %i "a\\$b')).not.toThrow();
  });
});

/**
 * Secondary sanity check: parse the generated Environment= line with systemd's
 * documented semantics (word-split honoring double quotes → strip quotes →
 * C-unescape \\ and \" → collapse %% specifiers) and require the original raw
 * value back. This shares authorship with the escaper, so it proves internal
 * consistency only — correctness is anchored by the golden bytes above and the
 * real-systemd verification recorded there.
 */
describe('Environment= round-trip (systemd parse semantics)', () => {
  function parseEnvironmentLine(unit: string): string {
    const m = /^Environment="AGENTDECK_DATA_DIR=(.*)"$/m.exec(unit);
    if (!m) throw new Error('no quoted Environment=AGENTDECK_DATA_DIR line found');
    // Inside double quotes systemd C-unescapes \" and \\; afterwards specifier
    // expansion turns %% into %. $ is not expanded in Environment=.
    return m[1]
      .replace(/\\(["\\])/g, '$1')
      .replace(/%%/g, '%');
  }

  it.each([
    ['space', '/srv/agentdeck data'],
    ['percent specifier', '/srv/deck %i'],
    ['double quote', '/srv/a"b'],
    ['backslash', '/srv/a\\b'],
    ['dollar', '/srv/a$b'],
    ['everything at once', '/srv/deck %i "a\\$b'],
  ])('round-trips the raw value (%s)', (_name, value) => {
    const unit = buildUnitFile({ node: '/usr/bin/node', cliJs: '/opt/cli.js', dataDirOverride: value });
    expect(parseEnvironmentLine(unit)).toBe(value);
  });
});

describe('getDataDir', () => {
  const saved = process.env.AGENTDECK_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = saved;
  });

  it('defaults to ~/.agentdeck', () => {
    delete process.env.AGENTDECK_DATA_DIR;
    expect(getDataDir()).toBe(join(homedir(), '.agentdeck'));
  });

  it('honors AGENTDECK_DATA_DIR', () => {
    process.env.AGENTDECK_DATA_DIR = '/var/lib/agentdeck';
    expect(getDataDir()).toBe('/var/lib/agentdeck');
  });
});

describe('installUnit (fresh data dir)', () => {
  const savedData = process.env.AGENTDECK_DATA_DIR;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  let scratch: string;

  afterEach(() => {
    if (savedData === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = savedData;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  // win32: needs a data dir that is both fs-creatable and '/'-absolute for the
  // systemd validator — no such path exists on Windows; ubuntu CI covers it.
  it.skipIf(process.platform === 'win32')('creates a not-yet-existing data directory before touching systemd', () => {
    scratch = mkdtempSync(join(tmpdir(), 'agentdeck-linux-svc-'));
    const dataDir = join(scratch, 'data', 'agentdeck'); // nested + absent
    process.env.AGENTDECK_DATA_DIR = dataDir;
    process.env.XDG_CONFIG_HOME = join(scratch, 'cfg');
    expect(existsSync(dataDir)).toBe(false);

    // installUnit shells out to `systemctl --user` after writing the file, which
    // fails in CI (no user D-Bus). The mkdir of the data dir happens first, so we
    // assert the directory exists regardless of whether systemctl succeeds.
    try { installUnit(); } catch { /* systemctl unavailable in CI — expected */ }

    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(getUnitPath())).toBe(true);
    // The written unit must persist the override into the service's environment,
    // not just its working directory.
    const unit = readFileSync(getUnitPath(), 'utf-8');
    expect(unit).toContain(`Environment="AGENTDECK_DATA_DIR=${dataDir}"`);
    expect(unit).toContain(`WorkingDirectory=${dataDir}`);
  });

  it('rejects an invalid override BEFORE creating any directory', () => {
    scratch = mkdtempSync(join(tmpdir(), 'agentdeck-linux-svc-'));
    process.env.AGENTDECK_DATA_DIR = 'relative/not-allowed';
    process.env.XDG_CONFIG_HOME = join(scratch, 'cfg');

    expect(() => installUnit()).toThrow(/absolute path/);
    // Validation runs before side effects — no stray dir, no unit file.
    expect(existsSync(join(process.cwd(), 'relative'))).toBe(false);
    expect(existsSync(getUnitPath())).toBe(false);
  });
});

describe('getUnitPath / getUnitDir', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it('defaults to ~/.config/systemd/user', () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(getUnitDir()).toBe(join(homedir(), '.config', 'systemd', 'user'));
    expect(getUnitPath()).toBe(join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`));
  });

  it('honors $XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '/custom/cfg';
    expect(getUnitDir()).toBe(join('/custom/cfg', 'systemd', 'user'));
    expect(getUnitPath()).toBe(join('/custom/cfg', 'systemd', 'user', `${SERVICE_NAME}.service`));
  });
});
