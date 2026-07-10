/**
 * Linux daemon autostart via a systemd `--user` unit (default.target).
 *
 * The macOS LaunchAgent / Windows Scheduled-Task analog on Linux is a per-user
 * systemd unit installed under ~/.config/systemd/user. It runs in the user's
 * session, needs no root, and `Restart=on-failure` mirrors LaunchAgent KeepAlive
 * / the Windows RestartOnFailure. `--foreground` makes the unit process BE the
 * daemon so systemd supervises the real process.
 *
 * Note: a user unit only auto-starts on graphical/SSH login. For boot-without-
 * login (headless servers), the user must run `loginctl enable-linger $USER`
 * once — we surface that as an informational hint rather than doing it here,
 * since it can require elevated privileges.
 *
 * The pure unit-file builder is unit-tested (cross-platform); the `systemctl`
 * calls are integration-only (real Linux host + side effects).
 */
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

export const SERVICE_NAME = 'agentdeck-daemon';
const UNIT_FILE = `${SERVICE_NAME}.service`;

// Resolve node + cli.js directly rather than the `agentdeck` npm shim: the
// global bin may be a wrapper script, and pointing systemd at the real node
// binary + cli.js keeps ExecStart stable across PATH changes. process.execPath
// is the running node; cli.js sits next to this module in the dist dir.
export function getDaemonNodeTarget(): { node: string; cliJs: string } {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return { node: process.execPath, cliJs: join(distDir, 'cli.js') };
}

/** ~/.config/systemd/user (honors $XDG_CONFIG_HOME). */
export function getUnitDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'systemd', 'user');
}

/** Full path to the installed unit file. */
export function getUnitPath(): string {
  return join(getUnitDir(), UNIT_FILE);
}

export function buildUnitFile(opts?: { node?: string; cliJs?: string }): string {
  const { node, cliJs } = { ...getDaemonNodeTarget(), ...opts };
  const workingDir = join(homedir(), '.agentdeck');
  // cli.js quoted so paths with spaces survive; --foreground so the unit process
  // IS the daemon (lets Restart=on-failure track the real process).
  return `[Unit]
Description=AgentDeck monitoring daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} "${cliJs}" daemon start --foreground
WorkingDirectory=${workingDir}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * True if `systemctl --user` is usable (systemd present + a user D-Bus session).
 * Guards non-systemd distros and headless contexts without a user manager.
 */
export function hasSystemctl(): boolean {
  try {
    // `is-system-running` prints a status word and exits; even a non-zero exit
    // (degraded/starting) means the user manager answered. A missing binary or
    // absent user bus throws.
    execSync('systemctl --user is-system-running', { stdio: 'pipe' });
    return true;
  } catch (e) {
    // Exit codes >0 with output still mean systemctl responded (e.g. "degraded").
    const hasOutput = Boolean((e as { stdout?: Buffer }).stdout?.length);
    return hasOutput;
  }
}

/** True if the unit file is installed on disk. */
export function unitExists(): boolean {
  return existsSync(getUnitPath());
}

/**
 * Write the unit file and enable it. Throws if systemctl fails (e.g. no user
 * D-Bus session).
 */
export function installUnit(): void {
  mkdirSync(getUnitDir(), { recursive: true });
  writeFileSync(getUnitPath(), buildUnitFile(), 'utf-8');
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  execSync(`systemctl --user enable ${UNIT_FILE}`, { stdio: 'pipe' });
}

/** Start the unit now (so no re-login is required). */
export function startUnit(): void {
  execSync(`systemctl --user start ${UNIT_FILE}`, { stdio: 'pipe' });
}

/** Stop the unit (best-effort). */
export function stopUnit(): void {
  execSync(`systemctl --user stop ${UNIT_FILE}`, { stdio: 'pipe' });
}

/** Disable + stop the unit, remove the file, and reload. Idempotent. */
export function disableUnit(): void {
  try { execSync(`systemctl --user disable --now ${UNIT_FILE}`, { stdio: 'pipe' }); } catch { /* not enabled */ }
  try { unlinkSync(getUnitPath()); } catch { /* already gone */ }
  try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch { /* best-effort */ }
}
