/**
 * Unit tests for the systemd user-unit builder (pure, cross-platform).
 *
 * The `systemctl --user` calls in linux-service.ts are integration-only — they
 * require a real Linux host with a user D-Bus session and mutate systemd state —
 * and are exercised manually per docs/daemon.md, not here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  SERVICE_NAME,
  buildUnitFile,
  getDataDir,
  getUnitDir,
  getUnitPath,
  installUnit,
} from '../linux-service.js';

describe('buildUnitFile', () => {
  const node = '/usr/bin/node';
  const cliJs = '/home/alice/.local/share/agentdeck/cli.js';

  it('produces a well-formed unit with the three standard sections', () => {
    const unit = buildUnitFile({ node, cliJs });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Description=AgentDeck monitoring daemon');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('runs the daemon in the foreground so systemd supervises the real process', () => {
    const unit = buildUnitFile({ node, cliJs });
    expect(unit).toContain(`ExecStart=${node} "${cliJs}" daemon start --foreground`);
    expect(unit).toContain('Type=simple');
  });

  it('mirrors LaunchAgent KeepAlive via Restart=on-failure', () => {
    const unit = buildUnitFile({ node, cliJs });
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5');
  });

  it('waits for the network to be online', () => {
    const unit = buildUnitFile({ node, cliJs });
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

  it('honors an explicit workingDir override', () => {
    const unit = buildUnitFile({ node, cliJs, workingDir: '/srv/agentdeck-data' });
    expect(unit).toContain('WorkingDirectory=/srv/agentdeck-data');
  });

  it('reflects the AGENTDECK_DATA_DIR override in WorkingDirectory', () => {
    const saved = process.env.AGENTDECK_DATA_DIR;
    process.env.AGENTDECK_DATA_DIR = '/var/lib/agentdeck';
    try {
      const unit = buildUnitFile({ node, cliJs });
      expect(unit).toContain('WorkingDirectory=/var/lib/agentdeck');
    } finally {
      if (saved === undefined) delete process.env.AGENTDECK_DATA_DIR;
      else process.env.AGENTDECK_DATA_DIR = saved;
    }
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

  it('creates a not-yet-existing data directory before touching systemd', () => {
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
