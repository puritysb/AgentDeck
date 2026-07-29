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

/**
 * The daemon's data directory — the same resolver the daemon itself uses
 * (`AGENTDECK_DATA_DIR` override, else `~/.agentdeck`). Kept byte-identical to
 * the inline resolution in session-registry.ts / apme/store.ts so the unit's
 * WorkingDirectory always matches where the daemon actually reads/writes.
 */
export function getDataDir(): string {
  return process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
}

// ── Unit-file escaping ────────────────────────────────────────────────
//
// The data-dir override is user-controlled and travels through a file format
// with its own quoting rules, so every generated value is escaped for the
// exact directive it lands in. The rules differ per directive:
//   - Environment=  word-splits with double-quote grouping; `\` and `"` need
//     C-style escaping inside quotes; `%` specifiers expand (→ `%%`); `$` is
//     NOT expanded and stays literal.
//   - ExecStart=    word-splits like Environment=, but ADDITIONALLY expands
//     `$VAR`/`${VAR}` even inside double quotes → a literal `$` must be `$$`.
//   - WorkingDirectory=  takes the rest of the line verbatim (no word split,
//     no unquoting — quotes would become literal path bytes); `%` specifiers
//     still expand (`%h` is the documented home-dir idiom) → only `%%`.
// Expected bytes are pinned in linux-service.test.ts and were verified against
// real systemd (Debian 13) via this PR's user-unit install test.

/** Throw if a value cannot be represented on a single unit-file line. */
function assertUnitLineSafe(value: string, what: string): void {
  const ctrl = /[\x00-\x1f\x7f]/.exec(value);
  if (ctrl) {
    throw new Error(
      `${what} contains a control character (code ${ctrl[0].charCodeAt(0)}) — ` +
      'it cannot be written safely into a systemd unit file',
    );
  }
}

/**
 * Validate the AGENTDECK_DATA_DIR override for use in a systemd unit. Because
 * `WorkingDirectory=` is verbatim, values that are relative, `~`, leading-`-`
 * (systemd's ignore-missing prefix), or edge-whitespace-padded (trimmed by the
 * unit parser, hence unrepresentable) would silently mean something else —
 * reject them with an actionable error instead.
 */
export function validateDataDirOverride(value: string): void {
  assertUnitLineSafe(value, 'AGENTDECK_DATA_DIR');
  if (value !== value.trim()) {
    throw new Error(
      'AGENTDECK_DATA_DIR has leading/trailing whitespace — the systemd unit parser trims it, ' +
      'so the path cannot be represented in the unit. Use a path without edge whitespace.',
    );
  }
  if (!value.startsWith('/')) {
    throw new Error(
      `AGENTDECK_DATA_DIR must be an absolute path to be usable in a systemd unit (got '${value}') — ` +
      "'~', relative paths, and '-'-prefixed values mean something else to systemd.",
    );
  }
}

/** Escape for the inside of a double-quoted unit-file string. */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** `%` → `%%` — systemd expands % specifiers in Environment/Exec/path settings. */
function escapeSpecifiers(value: string): string {
  return value.replace(/%/g, '%%');
}

/** Render one quoted `Environment=` assignment ($ stays literal there). */
export function escapeUnitEnvAssignment(name: string, value: string): string {
  assertUnitLineSafe(value, name);
  return `"${name}=${escapeSpecifiers(escapeQuoted(value))}"`;
}

/** Quote one ExecStart word ($ must be doubled — expanded even inside quotes). */
export function escapeExecWord(word: string): string {
  assertUnitLineSafe(word, 'ExecStart path');
  return `"${escapeSpecifiers(escapeQuoted(word)).replace(/\$/g, '$$$$')}"`;
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

export function buildUnitFile(opts?: { node?: string; cliJs?: string; dataDirOverride?: string }): string {
  const { node, cliJs } = { ...getDaemonNodeTarget(), ...opts };
  // Single override source: BOTH WorkingDirectory= and the Environment= line
  // derive from the same value, so the unit can never chdir into one directory
  // while the daemon process resolves another (the split-state failure mode).
  const override = opts?.dataDirOverride ?? process.env.AGENTDECK_DATA_DIR ?? '';
  if (override) validateDataDirOverride(override);
  const workingDir = override || join(homedir(), '.agentdeck');
  // A systemd user manager does not inherit the install shell's environment
  // after login/boot, so an explicitly selected AGENTDECK_DATA_DIR must be
  // persisted into the unit — otherwise the daemon falls back to ~/.agentdeck
  // while systemd merely chdirs into the override. Emitted only when set.
  const envLine = override
    ? `Environment=${escapeUnitEnvAssignment('AGENTDECK_DATA_DIR', override)}\n`
    : '';
  // Both ExecStart words quoted so paths with spaces survive; --foreground so
  // the unit process IS the daemon (lets Restart=on-failure track it).
  return `[Unit]
Description=AgentDeck monitoring daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${escapeExecWord(node)} ${escapeExecWord(cliJs)} daemon start --foreground
WorkingDirectory=${escapeSpecifiers(workingDir)}
${envLine}Restart=on-failure
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
  // Build (and thereby validate any AGENTDECK_DATA_DIR override) BEFORE any
  // side effect, so a rejected install leaves no stray directory behind.
  const unit = buildUnitFile();
  // Ensure the unit's WorkingDirectory exists — on a fresh install ~/.agentdeck
  // (or the AGENTDECK_DATA_DIR override) may not exist yet, and systemd fails at
  // the CHDIR step before Node starts if it's missing.
  mkdirSync(getDataDir(), { recursive: true });
  mkdirSync(getUnitDir(), { recursive: true });
  writeFileSync(getUnitPath(), unit, 'utf-8');
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
