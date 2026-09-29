/**
 * Windows daemon autostart via a per-user Scheduled Task (logon trigger).
 *
 * The macOS LaunchAgent analog on Windows is a per-user Scheduled Task with a
 * logon trigger — NOT a real Windows Service. A service runs in session 0 with
 * no desktop and restricted device access, which breaks the daemon's USB-HID
 * (D200H), audio (wake-word), mDNS, and Stream Deck app integration. A logon
 * task runs in the interactive user session, needs no admin elevation, and uses
 * only the built-in schtasks.exe (no npm dependency).
 *
 * ## Why the action is a launcher and not the daemon itself
 *
 * Task Scheduler starts an interactive-token action with a console ATTACHED and
 * gives no way to suppress it: node.exe is a console-subsystem binary, so the
 * logon start handed the daemon to the default terminal application and left a
 * window — and a taskbar button — on the desktop for as long as the daemon
 * lived. Measured on a Windows 11 26200 machine 2026-09-14 with Windows
 * Terminal as the default terminal app: a long-lived `node.exe` action produced
 * a visible `WindowsTerminal` window titled with the action's command line, and
 * `<Hidden>true</Hidden>` did NOT suppress it — that setting hides the task in
 * the Task Scheduler UI and nothing else. The two alternatives do not exist
 * here either: `conhost --headless` did not run the action at all, and
 * registering an `S4U` principal fails with "Access is denied" without
 * elevation this installer does not have — and S4U would put the daemon back
 * in a non-interactive session, which is what a Windows Service was rejected
 * for above.
 *
 * So the action is `daemon autostart`: a launcher that spawns the real daemon
 * DETACHED with no console (`detached` + `windowsHide` → DETACHED_PROCESS |
 * CREATE_NO_WINDOW) and exits in a few hundred ms, before the terminal handoff
 * paints anything. Same machine, same method: no visible window at 0.7s or at
 * 5s after `schtasks /Run`, and the detached daemon kept running.
 *
 * The cost is that the task's own `Status` stops describing the daemon — it
 * describes a launcher that is SUPPOSED to be gone. So the launcher passes
 * `AGENTDECK_SUPERVISOR=schtasks` to the daemon, the daemon stamps it into
 * `daemon.json` once it has WON the port, and `supervisorJobRunning` reads that
 * stamp when the status says `Ready` (`startedBySupervisor` /
 * `composeSchtasksRunning` in daemon-supervisor.ts). `RestartOnFailure`
 * likewise now only covers a launcher that cannot spawn; a crashed daemon comes
 * back at the next logon or by hand, the same as a `schtasks /End`ed one always
 * did.
 *
 * The pure XML/args builder is unit-tested (cross-platform); the schtasks
 * /Create|/Run|/Query|/Delete calls are integration-only (real Windows host +
 * side effects) and are exercised manually per docs/daemon.md.
 */
import { writeFileSync, unlinkSync } from 'fs';
import { homedir, tmpdir, userInfo } from 'os';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

export const TASK_NAME = 'AgentDeckDaemon';

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Resolve node.exe + cli.js directly rather than the `agentdeck` npm shim: the
// global bin on Windows is an `agentdeck.cmd` wrapper whose quoting breaks the
// Task Scheduler <Command>/<Arguments> split. process.execPath is the running
// node; cli.js sits next to this module in the dist dir.
export function getDaemonNodeTarget(): { node: string; cliJs: string } {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return { node: process.execPath, cliJs: join(distDir, 'cli.js') };
}

export function getCurrentTaskUser(): string {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME || userInfo().username;
  return domain ? `${domain}\\${user}` : user;
}

export function buildScheduledTaskXml(opts?: { node?: string; cliJs?: string; user?: string; extraArgs?: string[] }): string {
  const { node, cliJs } = { ...getDaemonNodeTarget(), ...opts };
  const user = opts?.user ?? getCurrentTaskUser();
  const workingDir = join(homedir(), '.agentdeck');
  const command = xmlEscape(node);
  // cli.js wrapped in quotes to survive paths with spaces; `daemon autostart`
  // rather than `daemon start --foreground` because an action that IS the
  // daemon keeps a console window on the desktop for the daemon's whole life
  // (see the header). extraArgs carries the network posture (`--local` /
  // `--loopback`): Task Scheduler has no environment element, so argv is the
  // only channel, and the launcher forwards it to the daemon it spawns.
  const extra = (opts?.extraArgs ?? []).map((a) => ` ${a}`).join('');
  const args = xmlEscape(`"${cliJs}" daemon autostart${extra}`);
  const userEsc = xmlEscape(user);
  // schtasks /XML requires UTF-16 with a BOM (see installWindowsTask); declaring
  // UTF-8 triggers "unable to switch the encoding". The bytes are written as
  // UTF-16LE+BOM at install time to match this declaration.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>AgentDeck monitoring daemon (auto-start on logon)</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${userEsc}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${userEsc}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <!-- Hides the task in the Task Scheduler UI, NOT the action's console
         window (measured 2026-09-14). Kept false so the task stays findable. -->
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${args}</Arguments>
      <WorkingDirectory>${xmlEscape(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Register (or overwrite) the AgentDeckDaemon scheduled task.
 * Throws if schtasks /Create fails (e.g. group policy disabling user task creation).
 */
export function installWindowsTask(extraArgs: string[] = []): void {
  const xml = buildScheduledTaskXml({ extraArgs });
  const tmpFile = join(tmpdir(), `agentdeck-task-${process.pid}-${Date.now()}.xml`);
  // Write UTF-16LE with a BOM (U+FEFF) — schtasks /XML rejects UTF-8 here.
  writeFileSync(tmpFile, '﻿' + xml, 'utf16le');
  try {
    // /F overwrites an existing task (idempotent; mirrors macOS unload-before-load).
    execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${tmpFile}" /F`, { stdio: 'pipe', windowsHide: true });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* temp cleanup best-effort */ }
  }
}

/** True if the AgentDeckDaemon scheduled task is registered. */
export function taskExists(): boolean {
  try {
    execSync(`schtasks /Query /TN "${TASK_NAME}"`, { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Start the registered task immediately (so no logout is required). */
export function runWindowsTask(): void {
  execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe', windowsHide: true });
}

/** Stop a running task instance (best-effort; ignores "not running"). */
export function endWindowsTask(): void {
  execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'pipe', windowsHide: true });
}

/** Delete the registered task (/F suppresses the confirm prompt). */
export function deleteWindowsTask(): void {
  execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe', windowsHide: true });
}

