/**
 * Unit tests for the systemd user-unit builder (pure, cross-platform).
 *
 * The `systemctl --user` calls in linux-service.ts are integration-only — they
 * require a real Linux host with a user D-Bus session and mutate systemd state —
 * and are exercised manually per docs/daemon.md, not here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import {
  SERVICE_NAME,
  buildUnitFile,
  getUnitDir,
  getUnitPath,
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

  it('sets the working directory to the agentdeck data dir', () => {
    const unit = buildUnitFile({ node, cliJs });
    expect(unit).toContain(`WorkingDirectory=${join(homedir(), '.agentdeck')}`);
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
