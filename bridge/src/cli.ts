#!/usr/bin/env node

import { Command } from 'commander';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { BRIDGE_WS_PORT } from './types.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

// ===== LaunchAgent plist =====

const PLIST_LABEL = 'dev.agentdeck.daemon';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function getAgentdeckBin(): string {
  try {
    return execSync('which agentdeck', { encoding: 'utf-8' }).trim();
  } catch {
    const distDir = new URL('.', import.meta.url).pathname;
    return join(distDir, 'cli.js');
  }
}

function buildPlist(): string {
  const bin = getAgentdeckBin();
  const logDir = join(homedir(), '.agentdeck');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`;
}

// ===== Helpers =====

async function stopDaemon(port: number): Promise<void> {
  const { readDaemonInfo, findDaemonPort } = await import('./session-registry.js');
  const info = readDaemonInfo();
  const targetPort = info?.httpPort ?? info?.port ?? findDaemonPort() ?? port;
  try {
    await fetch(`http://127.0.0.1:${targetPort}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
    log('Shutdown signal sent');
  } catch {
    log('Daemon is not running');
  }
}

async function isDaemonPort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const data = await res.json() as Record<string, unknown>;
    return data.mode === 'daemon' || data.agentType === 'daemon';
  } catch {
    return false;
  }
}

function resolveTimeboxSyncPaths(): { python: string; bleScript: string; scanScript: string } {
  const distPath = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(distPath, '..', '..');
  const timeboxDir = join(projectRoot, 'bridge', 'src', 'timebox');
  return {
    python: join(projectRoot, '.venv', 'bin', 'python'),
    bleScript: join(timeboxDir, 'sync_ble.py'),
    scanScript: join(timeboxDir, 'scan_ble.py'),
  };
}

// ===== Program =====

const program = new Command();

program
  .name('agentdeck')
  .description('AgentDeck — Physical Controller for AI Coding Agents')
  .version(packageJson.version);

// ===== Agent session commands =====

program
  .command('claude')
  .description('Start Claude Code session (PTY + bridge)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-c, --command <cmd>', 'Command to spawn', 'claude')
  .option('-d, --debug', 'Enable debug logging')
  .option('--no-update-check', 'Skip version check and auto-update')
  .option('--local', 'Disable all device modules (WS only)')
  // --no-mdns removed: session bridges never advertise mDNS (daemon only)
  .option('--no-adb', 'Disable ADB reverse setup')
  .option('--no-postit', 'Disable terminal tab title updates')
  .option('--wake-word', 'Enable wake word voice assistant ("오픈클로")')
  .action(async (opts) => {
    const { startSession } = await import('./index.js');
    await startSession({
      agentType: 'claude-code',
      port: parseInt(opts.port, 10),
      command: opts.command,
      debug: opts.debug,
      noUpdateCheck: opts.updateCheck === false,
      postit: opts.postit !== false,
      wakeWord: !!opts.wakeWord,
      modules: opts.local ? { mdns: false, adb: false, serial: false, pixoo: false, timebox: false, d200h: false } : {
        mdns: false,   // daemon-only — session bridges never advertise mDNS
        adb: opts.adb !== false ? 'auto' : false,
        serial: false, // daemon-only — session bridges never talk to ESP32
        pixoo: false,  // daemon-only — session bridges never talk to Pixoo
        timebox: false, // daemon-only — session bridges never talk to Timebox
        d200h: false,  // daemon-only — session bridges never talk to D200H
      },
    });
  });

program
  .command('codex')
  .description('Start Codex CLI session (PTY + bridge)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-c, --command <cmd>', 'Command to spawn', 'codex')
  .option('-d, --debug', 'Enable debug logging')
  .option('--local', 'Disable all device modules (WS only)')
  .option('--no-adb', 'Disable ADB reverse setup')
  .option('--no-postit', 'Disable terminal tab title updates')
  .option('--no-codex-hooks', 'Skip ~/.codex/config.toml hook install')
  .action(async (opts) => {
    // Install Codex lifecycle hooks before starting the session so the
    // first prompt's UserPromptSubmit / Stop events reach the daemon.
    // Idempotent: re-running with the same daemon port is a no-op.
    if (opts.codexHooks !== false) {
      try {
        const { installCodexHooksIfNeeded } = await import('@agentdeck/hooks');
        const result = installCodexHooksIfNeeded();
        if (result.installed) {
          log('Codex lifecycle hooks ready in ~/.codex/config.toml');
        } else if (result.reason) {
          log(`Codex hooks skipped: ${result.reason}`);
        }
      } catch (err) {
        log(`Codex hooks unavailable: ${String(err)}`);
        // PTY parser fallback still works without lifecycle hooks.
      }
    } else {
      log('Codex hooks skipped: --no-codex-hooks');
    }
    const { startSession } = await import('./index.js');
    await startSession({
      agentType: 'codex-cli',
      port: parseInt(opts.port, 10),
      command: opts.command,
      debug: opts.debug,
      postit: opts.postit !== false,
      modules: opts.local ? { mdns: false, adb: false, serial: false, pixoo: false, timebox: false, d200h: false } : {
        mdns: false,   // daemon-only
        adb: opts.adb !== false ? 'auto' : false,
        serial: false, // daemon-only
        pixoo: false,  // daemon-only
        timebox: false, // daemon-only
        d200h: false,  // daemon-only
      },
    });
  });

program
  .command('opencode')
  .description('Start OpenCode session (PTY + SSE bridge)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-c, --command <cmd>', 'Command to spawn', 'opencode')
  .option('-d, --debug', 'Enable debug logging')
  .option('--local', 'Disable all device modules (WS only)')
  .option('--no-adb', 'Disable ADB reverse setup')
  .option('--no-postit', 'Disable terminal tab title updates')
  .action(async (opts) => {
    const { startSession } = await import('./index.js');
    await startSession({
      agentType: 'opencode',
      port: parseInt(opts.port, 10),
      command: opts.command,
      debug: opts.debug,
      postit: opts.postit !== false,
      modules: opts.local ? { mdns: false, adb: false, serial: false, pixoo: false, timebox: false, d200h: false } : {
        mdns: false,
        adb: opts.adb !== false ? 'auto' : false,
        serial: false,
        pixoo: false,
        timebox: false,
        d200h: false,
      },
    });
  });

program
  .command('monitor')
  .description('Start hook-only bridge (no PTY — run claude separately)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .option('--local', 'Disable all device modules')
  .action(async (opts) => {
    const { startSession } = await import('./index.js');
    const port = parseInt(opts.port, 10);
    log(`\nMonitor mode: hook server on port ${port}`);
    log(`Run in another terminal: AGENTDECK_PORT=${port} claude\n`);
    await startSession({
      agentType: 'monitor',
      port,
      debug: opts.debug,
      modules: opts.local ? { mdns: false, adb: false, serial: false, pixoo: false, timebox: false, d200h: false } : undefined,
    });
  });

// ===== Daemon commands =====

const daemon = program.command('daemon').description('Manage monitoring daemon');

daemon
  .command('start')
  .description('Start monitoring daemon (WS + mDNS + Gateway proxy)')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .option('-f, --foreground', 'Run in foreground (default: background fork)')
  .option('--wake-word', 'Enable wake word voice assistant ("오픈클로")')
  .action(async (opts) => {
    const { findExistingDaemon, probeDaemonHealth, readDaemonInfo, removeDaemonInfo, removeDaemonSession } = await import('./session-registry.js');
    const daemonInfo = readDaemonInfo();
    if (daemonInfo) {
      const probePort = daemonInfo.httpPort ?? daemonInfo.port;
      const health = await probeDaemonHealth(probePort);
      if (health?.mode === 'daemon') {
        log(`Daemon already running on port ${daemonInfo.port} (PID ${daemonInfo.pid}). Use 'agentdeck daemon stop' first.`);
        process.exit(0);
      }
      log(`Ignoring stale daemon entry on port ${daemonInfo.port} (PID ${daemonInfo.pid}; /health did not respond).`);
      removeDaemonInfo();
    }
    const existing = findExistingDaemon();
    if (existing) {
      const health = await probeDaemonHealth(existing.port);
      if (health?.mode === 'daemon') {
        log(`Daemon already running on port ${existing.port} (PID ${existing.pid}). Use 'agentdeck daemon stop' first.`);
        process.exit(0);
      }
      log(`Ignoring stale daemon session on port ${existing.port} (PID ${existing.pid}; /health did not respond).`);
      removeDaemonSession(existing);
    }

    // Background fork unless --foreground
    if (!opts.foreground) {
      const { openSync } = await import('fs');
      const logDir = join(homedir(), '.agentdeck');
      const scriptPath = fileURLToPath(import.meta.url);
      const args = [scriptPath, 'daemon', 'start', '--foreground'];
      if (opts.port !== String(BRIDGE_WS_PORT)) args.push('-p', opts.port);
      if (opts.debug) args.push('-d');
      if (opts.wakeWord) args.push('--wake-word');

      // Use log files instead of 'ignore' — preserves device access (mic, etc.)
      const out = openSync(join(logDir, 'daemon-stdout.log'), 'w');
      const err = openSync(join(logDir, 'daemon-stderr.log'), 'w');

      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', out, err],
      });
      child.unref();
      log(`Daemon started (PID ${child.pid})`);
      process.exit(0);
    }

    const { startDaemon } = await import('./daemon-server.js');
    await startDaemon({
      port: parseInt(opts.port, 10),
      debug: opts.debug,
      wakeWord: !!opts.wakeWord,
    });
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    await stopDaemon(parseInt(opts.port, 10));
  });

daemon
  .command('restart')
  .description('Stop and restart the daemon')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .action(async (opts) => {
    await stopDaemon(parseInt(opts.port, 10));
    // Wait for port release + session cleanup
    await new Promise(resolve => setTimeout(resolve, 1500));

    const scriptPath = fileURLToPath(import.meta.url);
    const args = [scriptPath, 'daemon', 'start', '--foreground'];
    if (opts.port !== String(BRIDGE_WS_PORT)) args.push('-p', opts.port);
    if (opts.debug) args.push('-d');

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log(`Daemon restarted (PID ${child.pid})`);
    process.exit(0);
  });

daemon
  .command('status')
  .description('Show daemon status')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const { listActive, readDaemonInfo, removeDaemonInfo, removeDaemonSession } = await import('./session-registry.js');
    const info = readDaemonInfo();
    const sessions = listActive();
    const d = sessions.find(s => s.agentType === 'daemon');
    const targetPort = info?.httpPort ?? info?.port ?? d?.port ?? port;
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/health`);
      const data = await res.json() as Record<string, unknown>;
      log(`Daemon status (port ${targetPort}): ${JSON.stringify(data, null, 2)}`);
    } catch {
      if (info) removeDaemonInfo();
      if (d) removeDaemonSession(d);
      log('Daemon is not running');
      process.exit(1);
    }
  });

daemon
  .command('install')
  .description('Install macOS LaunchAgent for auto-start')
  .action(async () => {
    if (process.platform === 'win32') {
      log('agentdeck daemon install/uninstall is not supported on Windows.');
      log("Start the daemon manually with: agentdeck daemon start");
      log('(Add to the Startup folder yourself if you want it to autostart.)');
      process.exit(0);
    }
    if (process.platform !== 'darwin') {
      log('LaunchAgent is macOS-only');
      process.exit(1);
    }
    const plist = buildPlist();
    writeFileSync(PLIST_PATH, plist, 'utf-8');
    log(`Wrote ${PLIST_PATH}`);
    try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch {}
    execSync(`launchctl load "${PLIST_PATH}"`);
    log('LaunchAgent loaded. Daemon will auto-start on login.');
    // Install Codex lifecycle hooks parallel to the LaunchAgent install
    // so the daemon hub gets codex_* events as soon as Codex CLI runs.
    try {
      const { installCodexHooksIfNeeded } = await import('@agentdeck/hooks');
      const result = installCodexHooksIfNeeded();
      if (result.installed) {
        log('Codex lifecycle hooks installed in ~/.codex/config.toml');
      } else if (result.reason) {
        log(`Codex hooks skipped: ${result.reason}`);
      }
    } catch { /* hooks package not built yet — daemon install still succeeds */ }
  });

daemon
  .command('uninstall')
  .description('Remove macOS LaunchAgent')
  .action(() => {
    if (process.platform === 'win32') {
      log('agentdeck daemon install/uninstall is not supported on Windows.');
      process.exit(0);
    }
    if (!existsSync(PLIST_PATH)) {
      log('LaunchAgent not installed');
      return;
    }
    try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch {}
    unlinkSync(PLIST_PATH);
    log('LaunchAgent removed.');
  });

// ===== Session management =====

program
  .command('status')
  .description('Show all sessions and daemon status')
  .action(async () => {
    const { listActive } = await import('./session-registry.js');
    const sessions = listActive();
    if (sessions.length === 0) {
      log('No active sessions.');
      return;
    }
    log(`${sessions.length} active session(s):\n`);
    for (const s of sessions) {
      const type = s.agentType ?? 'unknown';
      const age = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
      log(`  [${type}] :${s.port} — ${s.projectName} (PID ${s.pid}, ${age}s)`);
    }
  });

program
  .command('stop')
  .description('Stop a session or all sessions')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-a, --all', 'Stop all sessions')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (opts.all) {
      const { listActive } = await import('./session-registry.js');
      const sessions = listActive();
      for (const s of sessions) {
        try {
          const url = s.agentType === 'daemon'
            ? `http://127.0.0.1:${s.port}/shutdown`
            : `http://127.0.0.1:${s.port}/hooks/shutdown`;
          await fetch(url, { method: 'POST' });
          log(`Sent stop to :${s.port} (${s.projectName})`);
        } catch {
          log(`Failed to reach :${s.port}`);
        }
      }
    } else {
      try {
        const daemonPort = await isDaemonPort(port);
        const url = daemonPort
          ? `http://127.0.0.1:${port}/shutdown`
          : `http://127.0.0.1:${port}/hooks/shutdown`;
        await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
        });
        log(daemonPort ? 'Daemon shutdown signal sent' : 'Shutdown signal sent');
      } catch {
        log('Session is not running');
      }
    }
  });

// ===== Device commands =====

program
  .command('devices')
  .description('Show connected devices (WebSocket, ESP32, Pixoo, Timebox, ADB)')
  .option('-p, --port <port>', 'Bridge server port')
  .action(async (opts) => {
    const { readDaemonInfo, findDaemonPort } = await import('./session-registry.js');
    const info = readDaemonInfo();
    const port = opts.port != null
      ? parseInt(opts.port, 10)
      : (info?.httpPort ?? info?.port ?? findDaemonPort() ?? BRIDGE_WS_PORT);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/devices`, {
        signal: AbortSignal.timeout(2000),
      });
      const data = await res.json() as { devices: Array<Record<string, any>> };
      const lines: string[] = ['Connected devices:'];
      let total = 0;

      for (const d of data.devices) {
        if (d.type === 'websocket' && d.count) {
          lines.push(`  WebSocket    ${d.count} client${d.count !== 1 ? 's' : ''}`);
          total += d.count;
        } else if ((d.type === 'esp32' || d.type === 'esp32_serial') && (d.count || d.connections)) {
          // Node daemon: { count, ports }, Swift daemon: { connections: [{ port, connected, deviceInfo }] }
          const count = d.count ?? (d.connections as any[])?.filter((c: any) => c.connected).length ?? 0;
          const ports = d.ports ?? (d.connections as any[])?.map((c: any) => c.port) ?? [];
          if (count > 0) {
            const portInfo = ports.length ? ` (${ports.join(', ')})` : '';
            lines.push(`  ESP32        ${count} serial${portInfo}`);
            total += count;
          }
        } else if (d.type === 'pixoo') {
          // Node daemon: { details: [...] }, Swift daemon: { deviceIps: [...] }
          if (d.details) {
            for (const px of d.details as any[]) {
              if (px.backedOff) {
                const mins = Math.ceil(px.nextProbeMs / 60_000);
                lines.push(`  Pixoo64      ${px.ip} (${px.name}) \u26A0 backed off (next probe ${mins}m)`);
              } else {
                const ago = px.lastPushAgo >= 0 ? `${Math.round(px.lastPushAgo / 1000)}s ago` : 'no push yet';
                lines.push(`  Pixoo64      ${px.ip} (${px.name}) \u2713 ${ago}`);
              }
              total++;
            }
          } else if (d.deviceIps) {
            for (const ip of d.deviceIps as string[]) {
              const err = d.lastPushError ? ` \u26A0 ${d.lastPushError}` : ' \u2713';
              lines.push(`  Pixoo64      ${ip}${err}`);
              total++;
            }
          }
        } else if (d.type === 'timebox') {
          for (const tb of (d.devices ?? []) as any[]) {
            const brightnessInfo = tb.brightness !== undefined ? ` brightness=${tb.brightness}%` : '';
            lines.push(`  Timebox     ${tb.address} (${tb.name || 'Timebox Mini Light'})${brightnessInfo}`);
            total++;
          }
        } else if (d.type === 'adb') {
          const count = d.count ?? (d.devices as any[])?.length ?? 0;
          if (count > 0) {
            lines.push(`  ADB          ${count} USB device${count !== 1 ? 's' : ''}`);
            total += count;
          }
        } else if (d.type === 'd200h' && d.connected) {
          const writeInfo = d.writeOK != null ? ` (writes: ${d.writeOK} ok, ${d.writeFail} fail)` : '';
          lines.push(`  D200H        HID connected${writeInfo}`);
          total++;
        }
      }

      if (total === 0) {
        log('No devices connected.');
      } else {
        lines.push('');
        lines.push(`Total: ${total} device connection${total !== 1 ? 's' : ''}`);
        log(lines.join('\n'));
      }
    } catch {
      const { loadPixooDevices } = await import('./pixoo/pixoo-settings.js');
      const { loadTimeboxDevices } = await import('./timebox/timebox-settings.js');
      const pixoo = loadPixooDevices();
      const timebox = loadTimeboxDevices();
      if (pixoo.length > 0 || timebox.length > 0) {
        log('Bridge is not running.\nConfigured devices:');
        for (const d of pixoo) {
          log(`  Pixoo64     ${d.ip} (${d.name || 'Pixoo64'})`);
        }
        for (const d of timebox) {
          const brightnessInfo = d.brightness !== undefined ? ` brightness=${d.brightness}%` : '';
          log(`  Timebox     ${d.address} (${d.name || 'Timebox Mini Light'})${brightnessInfo}`);
        }
      } else {
        log('Bridge is not running.');
      }
    }
  });

program
  .command('qr')
  .description('Show pairing URL and QR code')
  .option('-p, --port <port>', 'Bridge server port (auto-detects from running sessions)')
  .action(async (opts) => {
    const { getOrCreateToken, getWsUrl } = await import('./auth.js');
    const { listActive } = await import('./session-registry.js');

    let port: number;
    if (opts.port) {
      port = parseInt(opts.port, 10);
    } else {
      const sessions = listActive();
      if (sessions.length > 0) {
        port = sessions[0].port;
        if (sessions.length > 1) {
          log(`Multiple sessions running. Using port ${port} (${sessions[0].projectName}).`);
        }
      } else {
        port = BRIDGE_WS_PORT;
      }
    }

    getOrCreateToken();
    const url = getWsUrl(port);
    log(`\nPairing URL:\n  ${url}\n`);

    try {
      const { default: QRCode } = await import('qrcode');
      const text = await (QRCode as any).toString(url, { type: 'terminal', small: true });
      log(text);
    } catch {
      // qrcode not available
    }
  });

program
  .command('diag')
  .description('Generate diagnostic dump')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-a, --analyze', 'Run AI analysis on the dump')
  .option('-t, --tail <lines>', 'Number of journal entries', '200')
  .action(async (opts) => {
    const { readDaemonInfo, findDaemonPort } = await import('./session-registry.js');
    const info = readDaemonInfo();
    const port = info?.httpPort ?? info?.port ?? findDaemonPort() ?? parseInt(opts.port, 10);
    const tail = parseInt(opts.tail, 10);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/diag?tail=${tail}`);
      if (!res.ok) {
        log(`Diag endpoint error: ${res.status} ${res.statusText}`);
        process.exit(1);
      }
      const dump = await res.json() as import('./diag-analyzer.js').DiagDump;
      const { saveDiagDump, analyzeDump } = await import('./diag-analyzer.js');
      const dumpPath = saveDiagDump(dump);
      log(`Diagnostic dump saved: ${dumpPath}`);

      if (opts.analyze) {
        log('Running AI analysis...');
        const analysis = await analyzeDump(dumpPath);
        if (analysis) {
          log('\n--- AI Analysis ---\n');
          log(analysis);
        } else {
          log('AI analysis failed (is `claude` CLI available?)');
        }
      }
    } catch {
      log('Bridge is not running. Cannot generate live diagnostic dump.');
      process.exit(1);
    }
  });

// ===== Task control =====
//
// User-driven APME task boundary signal. Closes the currently-active task on
// the daemon's APME collector via POST /task/close — same path the macOS
// detail-pane "Mark task complete" button uses. Without this command, the
// only ways to declare task completion are TodoWrite all-completed (Claude /
// Codex / OpenCode) or /clear (also splits the run); OpenClaw users had no
// manual gesture at all before idle_gap landed.

const task = program.command('task').description('Manage APME task boundaries');

async function postTaskClose(opts: { signal: string; outcome?: string; sessionId?: string }): Promise<void> {
  const { readDaemonInfo, findDaemonPort } = await import('./session-registry.js');
  const info = readDaemonInfo();
  const port = info?.httpPort ?? info?.port ?? findDaemonPort();
  if (!port) {
    log('Daemon not running. Start it with `agentdeck daemon start`.');
    process.exit(1);
  }
  const body = JSON.stringify({
    signal: opts.signal,
    ...(opts.outcome ? { outcome: opts.outcome } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/task/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      log(`Failed (${res.status}): ${JSON.stringify(json)}`);
      process.exit(1);
    }
    if ((json as { closed?: boolean }).closed) {
      log(`Task closed (signal=${opts.signal}${opts.outcome ? `, outcome=${opts.outcome}` : ''})`);
    } else {
      log('No active task to close.');
    }
  } catch (err) {
    log(`Request failed: ${String(err)}`);
    process.exit(1);
  }
}

task
  .command('done')
  .description('Mark the active task as complete (manual boundary signal)')
  .option('-o, --outcome <v>', 'Outcome class: success | fail | partial | abandoned', 'success')
  .option('-s, --session <id>', 'Target session id (defaults to active OpenClaw session)')
  .action(async (opts: { outcome?: string; session?: string }) => {
    await postTaskClose({ signal: 'manual', outcome: opts.outcome, sessionId: opts.session });
  });

task
  .command('cancel')
  .description('Mark the active task as abandoned (shorthand for `task done --outcome abandoned`)')
  .option('-s, --session <id>', 'Target session id (defaults to active OpenClaw session)')
  .action(async (opts: { session?: string }) => {
    await postTaskClose({ signal: 'manual', outcome: 'abandoned', sessionId: opts.session });
  });

// ===== iDotMatrix commands =====

const idotmatrix = program.command('idotmatrix').description('Manage iDotMatrix BLE pixel display devices');

idotmatrix
  .command('scan')
  .description('Discover iDotMatrix devices via BLE')
  .action(async () => {
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const { spawn } = await import('child_process');
    
    const distPath = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(distPath, '..', '..');
    const venvPython = join(projectRoot, '.venv', 'bin', 'python');
    const scanScript = join(projectRoot, 'bridge', 'src', 'idotmatrix', 'scan.py');
    
    log('Scanning for BLE devices (5 seconds)...');
    const py = spawn(venvPython, [scanScript]);
    
    let stdoutData = '';
    py.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });
    
    py.on('close', (code) => {
      if (code !== 0) {
        log('Failed to run scan script.');
        process.exit(1);
      }
      try {
        const devices = JSON.parse(stdoutData.trim());
        if (devices.error) {
          log(`Scan error: ${devices.error}`);
          process.exit(1);
        }
        if (!Array.isArray(devices) || devices.length === 0) {
          log('No BLE devices found.');
          return;
        }
        log('\nFound devices:');
        for (const d of devices) {
          const prefix = d.is_idotmatrix ? '★ [iDotMatrix] ' : '  ';
          log(`${prefix}${d.name} (${d.address})`);
        }
      } catch (e) {
        log(`Failed to parse scan output: ${stdoutData}`);
      }
    });
  });

idotmatrix
  .command('add <address>')
  .description('Add an iDotMatrix device address')
  .option('-n, --name <name>', 'Device name', 'iDotMatrix')
  .option('-b, --brightness <value>', 'Brightness 5-100', '100')
  .action(async (address, opts) => {
    const { addIDotMatrixDevice } = await import('./idotmatrix/idotmatrix-settings.js');
    const brightness = parseInt(opts.brightness, 10);
    if (addIDotMatrixDevice({ address, name: opts.name, brightness: isNaN(brightness) ? 100 : brightness })) {
      log(`Added ${opts.name} (${address}) with brightness ${brightness}% to settings.`);
    } else {
      log(`Device ${address} already exists.`);
    }
  });

idotmatrix
  .command('list')
  .description('List configured iDotMatrix devices')
  .action(async () => {
    const { loadIDotMatrixDevices } = await import('./idotmatrix/idotmatrix-settings.js');
    const devices = loadIDotMatrixDevices();
    if (devices.length === 0) {
      log('No iDotMatrix devices configured. Run `agentdeck idotmatrix scan` or `add`.');
      return;
    }
    log(`${devices.length} device(s) configured:`);
    for (const d of devices) {
      const brightnessInfo = d.brightness !== undefined ? ` (brightness=${d.brightness}%)` : '';
      log(`  ${d.name || 'iDotMatrix'} (${d.address})${brightnessInfo}`);
    }
  });

idotmatrix
  .command('remove <address>')
  .description('Remove an iDotMatrix device')
  .action(async (address) => {
    const { removeIDotMatrixDevice } = await import('./idotmatrix/idotmatrix-settings.js');
    if (removeIDotMatrixDevice(address)) {
      log(`Removed device ${address}.`);
    } else {
      log(`Device ${address} not found.`);
    }
  });

idotmatrix
  .command('brightness <value>')
  .description('Set brightness of the iDotMatrix device (5-100)')
  .option('-a, --address <address>', 'BLE Address (defaults to first configured device)')
  .action(async (valueStr, opts) => {
    const { loadIDotMatrixDevices } = await import('./idotmatrix/idotmatrix-settings.js');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const { spawn } = await import('child_process');
    
    const value = parseInt(valueStr, 10);
    if (isNaN(value) || value < 5 || value > 100) {
      log('Brightness value must be between 5 and 100.');
      process.exit(1);
    }
    
    let targetAddress = opts.address;
    if (!targetAddress) {
      const devices = loadIDotMatrixDevices();
      if (devices.length === 0) {
        log('No device specified and none configured. Use `agentdeck idotmatrix add <address>`.');
        process.exit(1);
      }
      targetAddress = devices[0].address;
    }
    
    const distPath = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(distPath, '..', '..');
    const venvPython = join(projectRoot, '.venv', 'bin', 'python');
    const brightnessScript = join(projectRoot, 'bridge', 'src', 'idotmatrix', 'brightness.py');
    
    log(`Setting brightness of ${targetAddress} to ${value}%...`);
    const py = spawn(venvPython, [brightnessScript, '-a', targetAddress, '-b', String(value)], {
      stdio: 'inherit'
    });
    
    py.on('close', (code) => {
      if (code === 0) {
        log('Brightness updated successfully.');
      } else {
        log(`Failed to update brightness, process exited with code ${code}`);
      }
    });
  });

idotmatrix
  .command('sync [address]')
  .description('Sync AgentDeck dashboard frames to iDotMatrix BLE device')
  .option('-p, --port <port>', 'Bridge server port')
  .option('-b, --brightness <value>', 'Override brightness (5-100)')
  .option('--boost <value>', 'Software brightness boost factor (default: 1.6)')
  .action(async (addressOpt, opts) => {
    const { loadIDotMatrixDevices } = await import('./idotmatrix/idotmatrix-settings.js');
    const { readDaemonInfo, findDaemonPort } = await import('./session-registry.js');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const { spawn } = await import('child_process');
    
    let targetAddress = addressOpt;
    let defaultBrightness = 100;
    const devices = loadIDotMatrixDevices();
    
    if (!targetAddress) {
      if (devices.length === 0) {
        log('No device specified and none configured. Use `agentdeck idotmatrix add <address>`.');
        process.exit(1);
      }
      targetAddress = devices[0].address;
      defaultBrightness = devices[0].brightness ?? 100;
      log(`Using first configured device: ${targetAddress}`);
    } else {
      const matched = devices.find(d => d.address.toLowerCase() === targetAddress.toLowerCase());
      if (matched) {
        defaultBrightness = matched.brightness ?? 100;
      }
    }

    const brightness = opts.brightness ? parseInt(opts.brightness, 10) : defaultBrightness;
    const boost = opts.boost || '1.6';

    const info = readDaemonInfo();
    const port = opts.port != null
      ? parseInt(opts.port, 10)
      : (info?.httpPort ?? info?.port ?? findDaemonPort() ?? BRIDGE_WS_PORT);
      
    const url = `http://127.0.0.1:${port}`;
    
    const distPath = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(distPath, '..', '..');
    const venvPython = join(projectRoot, '.venv', 'bin', 'python');
    const syncScript = join(projectRoot, 'bridge', 'src', 'idotmatrix', 'sync.py');
    
    log(`Starting BLE sync client linking to bridge at ${url} (brightness ${brightness}%, boost ${boost}x)...`);
    
    const py = spawn(venvPython, [syncScript, '-a', targetAddress, '-u', url, '-b', String(brightness), '--boost', String(boost)], {
      stdio: 'inherit'
    });
    
    py.on('close', (code) => {
      log(`Sync process exited with code ${code}`);
    });
  });

// ===== Divoom Timebox Mini Light commands =====

const timebox = program.command('timebox').description('Manage Divoom Timebox Mini devices (Bluetooth LE)');

timebox
  .command('scan')
  .description('Discover BLE TimeBox-mini-light peripherals')
  .action(async () => {
    const paths = resolveTimeboxSyncPaths();
    log('Scanning for BLE devices (5 seconds)...');
    const py = spawn(paths.python, [paths.scanScript]);
    let stdoutData = '';
    py.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });
    py.on('close', (code) => {
      if (code !== 0) {
        log('BLE scan failed (is bleak installed in .venv?).');
        return;
      }
      try {
        const devices = JSON.parse(stdoutData.trim());
        if (devices.error) {
          log(`BLE scan error: ${devices.error}`);
          return;
        }
        if (!Array.isArray(devices) || devices.length === 0) {
          log('No BLE devices found.');
          return;
        }
        log('\nFound BLE devices:');
        for (const d of devices) {
          const prefix = d.is_timebox ? '★ [TimeBox-mini-light] ' : '  ';
          const rssi = typeof d.rssi === 'number' ? ` ${d.rssi}dBm` : '';
          log(`${prefix}${d.name} (${d.address})${rssi}`);
        }
        log('\nAdd the starred BLE device with: agentdeck timebox add <address>');
      } catch {
        log(`Failed to parse BLE scan output: ${stdoutData}`);
      }
    });
  });

timebox
  .command('add <address>')
  .description('Add a Timebox device by its BLE address')
  .option('-n, --name <name>', 'Device name', 'Timebox Mini')
  .option('-b, --brightness <value>', 'Brightness 0-100', '80')
  .action(async (address: string, opts) => {
    const { addTimeboxDevice } = await import('./timebox/timebox-settings.js');
    const parsed = parseInt(opts.brightness, 10);
    const brightness = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 80;
    if (addTimeboxDevice({ address, name: opts.name, brightness })) {
      log(`Added ${opts.name} (BLE ${address}) with brightness ${brightness}% to settings.`);
      log('Restart the daemon to start automatic Timebox sync.');
    } else {
      log(`Device ${address} already exists (or has no valid address).`);
    }
  });

timebox
  .command('list')
  .description('List configured Timebox devices')
  .action(async () => {
    const { loadTimeboxDevices, deviceId } = await import('./timebox/timebox-settings.js');
    const devices = loadTimeboxDevices();
    if (devices.length === 0) {
      log('No Timebox devices configured. Run `agentdeck timebox scan`, then `agentdeck timebox add <address>`.');
      return;
    }
    log(`${devices.length} device(s):`);
    for (const d of devices) {
      const brightnessInfo = d.brightness !== undefined ? ` brightness=${d.brightness}%` : '';
      log(`  [BLE] ${d.name || 'Timebox Mini'} (${deviceId(d)})${brightnessInfo}`);
    }
  });

timebox
  .command('remove <address>')
  .description('Remove a Timebox device by BLE address')
  .action(async (target: string) => {
    const { removeTimeboxDevice } = await import('./timebox/timebox-settings.js');
    if (removeTimeboxDevice(target)) {
      log(`Removed ${target}.`);
    } else {
      log(`Device ${target} not found.`);
    }
  });

/**
 * Spawn the BLE sync writer for a one-shot test or a continuous sync,
 * resolving the target device from CLI args / configured devices.
 */
async function runTimeboxSync(targetOpt: string | undefined, opts: { bridgePort?: string; brightness?: string }, once: boolean): Promise<void> {
  const { loadTimeboxDevices, deviceId } = await import('./timebox/timebox-settings.js');
  const { readDaemonInfo, findDaemonPort } = await import('./session-registry.js');

  const devices = loadTimeboxDevices();
  let device = targetOpt
    ? devices.find((d) => deviceId(d).toLowerCase() === targetOpt.toLowerCase())
    : devices[0];

  // Allow an ad-hoc BLE address that isn't in settings.
  if (!device && targetOpt) {
    device = { address: targetOpt };
  }
  if (!device) {
    log('No device specified and none configured. Use `agentdeck timebox scan` and `agentdeck timebox add <address>`.');
    process.exit(1);
  }

  const id = deviceId(device);
  if (!targetOpt) log(`Using first configured device: ${id} (BLE)`);

  const defaultBrightness = device.brightness ?? 80;
  const parsedBrightness = opts.brightness ? parseInt(opts.brightness, 10) : defaultBrightness;
  const brightness = Number.isFinite(parsedBrightness) ? Math.max(0, Math.min(100, parsedBrightness)) : defaultBrightness;

  const info = readDaemonInfo();
  const bridgePort = opts.bridgePort != null
    ? parseInt(opts.bridgePort, 10)
    : (info?.httpPort ?? info?.port ?? findDaemonPort() ?? BRIDGE_WS_PORT);
  const url = `http://127.0.0.1:${bridgePort}`;
  const paths = resolveTimeboxSyncPaths();

  const args = [paths.bleScript, '--address', id, '--url', url, '--brightness', String(brightness), ...(once ? ['--once'] : [])];

  log(`${once ? 'Sending one Timebox frame' : 'Starting Timebox sync'} via BLE ${id} from ${url} (brightness ${brightness}%)...`);
  const py = spawn(paths.python, args, { stdio: 'inherit' });
  py.on('close', (code) => {
    if (once) {
      if (code === 0) {
        log('Timebox test frame sent.');
      } else {
        log(`Timebox test exited with code ${code}`);
        process.exit(code ?? 1);
      }
    } else {
      log(`Timebox sync process exited with code ${code}`);
    }
  });
}

timebox
  .command('test [target]')
  .description('Send one AgentDeck frame to a Timebox Mini (BLE)')
  .option('-p, --bridge-port <port>', 'Bridge server port')
  .option('-b, --brightness <value>', 'Override brightness 0-100')
  .action((targetOpt: string | undefined, opts) => runTimeboxSync(targetOpt, opts, true));

timebox
  .command('sync [target]')
  .description('Sync AgentDeck dashboard frames to a Timebox Mini (BLE)')
  .option('-p, --bridge-port <port>', 'Bridge server port')
  .option('-b, --brightness <value>', 'Override brightness 0-100')
  .action((targetOpt: string | undefined, opts) => runTimeboxSync(targetOpt, opts, false));

// ===== Pixoo commands =====

const pixoo = program.command('pixoo').description('Manage Pixoo64 LED matrix devices');

pixoo
  .command('scan')
  .description('Discover Pixoo devices on LAN')
  .action(async () => {
    const { discoverDevices, getDeviceConfig } = await import('./pixoo/pixoo-client.js');
    const { loadPixooDevices, savePixooDevices } = await import('./pixoo/pixoo-settings.js');

    log('Scanning for Pixoo devices...');
    const found = await discoverDevices();
    if (found.length === 0) {
      log('No devices found.');
      return;
    }

    const verified: Array<{ name: string; ip: string; ok: boolean }> = [];
    for (const d of found) {
      const config = await getDeviceConfig(d.ip);
      verified.push({ ...d, ok: config !== null });
    }

    log(`\nFound ${verified.length} device(s):`);
    for (const d of verified) {
      log(`  ${d.name} (${d.ip}) ${d.ok ? '\u2713 reachable' : '\u2717 unreachable'}`);
    }

    const reachable = verified.filter(d => d.ok);
    if (reachable.length === 0) {
      log('\nNo reachable devices to save.');
      return;
    }

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>(resolve => {
      rl.question(`\nSave ${reachable.length} device(s)? (Y/n) `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'n') {
      log('Cancelled.');
      return;
    }

    const existing = loadPixooDevices();
    const existingIps = new Set(existing.map(d => d.ip));
    const newDevices = reachable
      .filter(d => !existingIps.has(d.ip))
      .map(d => ({ ip: d.ip, name: d.name }));

    if (newDevices.length === 0) {
      log('All discovered devices already in settings.');
      return;
    }

    savePixooDevices([...existing, ...newDevices]);
    log(`Added ${newDevices.length} device(s) to ~/.agentdeck/settings.json`);
  });

pixoo
  .command('add <ip>')
  .description('Manually add a Pixoo device')
  .option('-n, --name <name>', 'Device name', 'Pixoo64')
  .option('-b, --brightness <value>', 'Brightness 0-100')
  .action(async (ip: string, opts) => {
    const { getDeviceConfig } = await import('./pixoo/pixoo-client.js');
    const { addDevice } = await import('./pixoo/pixoo-settings.js');

    log(`Testing connection to ${ip}...`);
    const config = await getDeviceConfig(ip);
    log(config ? 'Device reachable \u2713' : `Cannot reach ${ip}. Adding anyway.`);

    const device: { ip: string; name?: string; brightness?: number } = { ip, name: opts.name };
    if (opts.brightness) device.brightness = Math.max(0, Math.min(100, parseInt(opts.brightness, 10)));

    if (addDevice(device)) {
      log(`Added ${device.name} (${ip}) to settings.`);
    } else {
      log(`Device ${ip} already exists.`);
    }
  });

pixoo
  .command('list')
  .description('List configured Pixoo devices')
  .action(async () => {
    const { loadPixooDevices } = await import('./pixoo/pixoo-settings.js');
    const devices = loadPixooDevices();
    if (devices.length === 0) {
      log('No Pixoo devices configured. Run `agentdeck pixoo scan`.');
      return;
    }
    log(`${devices.length} device(s):`);
    for (const d of devices) {
      const parts = [d.name || 'Pixoo', `(${d.ip})`];
      if (d.brightness !== undefined) parts.push(`brightness=${d.brightness}`);
      log(`  ${parts.join(' ')}`);
    }
  });

pixoo
  .command('remove <ip>')
  .description('Remove a Pixoo device')
  .action(async (ip: string) => {
    const { removeDevice } = await import('./pixoo/pixoo-settings.js');
    if (removeDevice(ip)) {
      log(`Removed ${ip}.`);
    } else {
      log(`Device ${ip} not found.`);
    }
  });

pixoo
  .command('test [ip]')
  .description('Send a test frame to a Pixoo device')
  .action(async (ip?: string) => {
    const { loadPixooDevices } = await import('./pixoo/pixoo-settings.js');
    const { pushFrame, setBrightness } = await import('./pixoo/pixoo-client.js');

    let targetIp = ip;
    if (!targetIp) {
      const devices = loadPixooDevices();
      if (devices.length === 0) {
        log('No device specified and none configured.');
        return;
      }
      targetIp = devices[0].ip;
      log(`Using first configured device: ${targetIp}`);
    }

    const buf = new Uint8Array(64 * 64 * 3);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 3;
        const hue = ((x + y) * 4) % 256;
        const region = Math.floor(hue / 43);
        const remainder = (hue - region * 43) * 6;
        const q = 255 - remainder;
        const t = remainder;
        if (region === 0) { buf[i] = 255; buf[i+1] = t; buf[i+2] = 0; }
        else if (region === 1) { buf[i] = q; buf[i+1] = 255; buf[i+2] = 0; }
        else if (region === 2) { buf[i] = 0; buf[i+1] = 255; buf[i+2] = t; }
        else if (region === 3) { buf[i] = 0; buf[i+1] = q; buf[i+2] = 255; }
        else if (region === 4) { buf[i] = t; buf[i+1] = 0; buf[i+2] = 255; }
        else { buf[i] = 255; buf[i+1] = 0; buf[i+2] = q; }
      }
    }

    await setBrightness(targetIp, 60);
    const ok = await pushFrame(targetIp, buf);
    log(ok ? `Test frame sent to ${targetIp} \u2713` : `Failed to send to ${targetIp}`);
  });

// ===== WiFi Setup =====

program
  .command('wifi-setup')
  .description('Configure WiFi for ESP32 independent operation (USB-free)')
  .option('--ssid <ssid>', 'WiFi network name (auto-detected from macOS if omitted)')
  .option('--password <password>', 'WiFi password (auto-fetched from Keychain if omitted)')
  .action(async (opts) => {
    const { detectCurrentSSID, getKeychainPassword, saveWifiConfig } = await import('./wifi-config.js');

    let ssid = opts.ssid as string | undefined;
    let password = opts.password as string | undefined;

    if (!ssid) {
      const detected = detectCurrentSSID();
      if (detected) {
        log(`Detected WiFi: ${detected}`);
        ssid = detected;
      } else {
        log('Could not detect WiFi network. Use --ssid <name>');
        process.exit(1);
      }
    }

    if (!password) {
      log(`Looking up Keychain password for "${ssid}"...`);
      const keychainPw = getKeychainPassword(ssid);
      if (keychainPw) {
        log('Found password in Keychain \u2713');
        password = keychainPw;
      } else {
        log('Password not found in Keychain. Use --password <pw>');
        process.exit(1);
      }
    }

    saveWifiConfig({ ssid, password, autoProvision: true });
    log(`WiFi config saved: SSID="${ssid}" \u2192 ~/.agentdeck/wifi-config.json`);
    log('Daemon will auto-provision ESP32 devices on next restart.');
  });

// ===== TUI Dashboard =====

program
  .command('dashboard')
  .alias('dash')
  .description('TUI monitoring dashboard with terrarium animation')
  .option('-p, --port <port>', 'Bridge port (auto-discover if omitted)')
  .option('-s, --session <id>', 'Specific session ID')
  .action(async (opts) => {
    const { startDashboard } = await import('./tui/dashboard.js');
    await startDashboard(opts);
  });

// ===== Backward compat: `agentdeck start` → `agentdeck daemon start` =====

program
  .command('start', { hidden: true })
  .description('(legacy) Start daemon in foreground — use `agentdeck daemon start`')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .action(async (opts) => {
    // Legacy: runs foreground (LaunchAgent plist compatibility)
    const { findExistingDaemon } = await import('./session-registry.js');
    const existing = findExistingDaemon();
    if (existing) {
      log(`Daemon already running on port ${existing.port} (PID ${existing.pid}).`);
      process.exit(0);
    }
    const { startDaemon } = await import('./daemon-server.js');
    await startDaemon({
      port: parseInt(opts.port, 10),
      debug: opts.debug,
    });
  });

// ===== Default command (no args) =====

// If no command specified, show status or help
program.action(async () => {
  const { listActive } = await import('./session-registry.js');
  const sessions = listActive();

  if (sessions.length === 0) {
    program.help();
    return;
  }

  log('AgentDeck — Active sessions:\n');
  for (const s of sessions) {
    const type = s.agentType ?? 'unknown';
    const age = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
    log(`  [${type}] :${s.port} — ${s.projectName} (PID ${s.pid}, ${age}s)`);
  }
  log('\nRun `agentdeck --help` for all commands.');
});

// ===== APME commands =====

const apme = program.command('apme').description('Agent Performance Monitoring & Evaluation');

apme
  .command('runs')
  .description('List recent evaluated runs')
  .option('-n, --limit <n>', 'Number of runs', '20')
  .option('-a, --agent <type>', 'Filter by agent type (claude-code, openclaw, ...)')
  .option('-m, --model <id>', 'Filter by model id')
  .action(async (opts) => {
    const { initApme } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available (better-sqlite3 missing)'); process.exit(1); }

    const runs = apme.store.listRuns({
      limit: parseInt(opts.limit, 10) || 20,
      agentType: opts.agent,
      modelId: opts.model,
    });
    if (runs.length === 0) { log('No runs found.'); return; }

    log(`\n  ${'ID'.padEnd(10)} ${'Category'.padEnd(14)} ${'Agent'.padEnd(14)} ${'Model'.padEnd(20)} ${'Project'.padEnd(14)} ${'Cost'.padEnd(8)} ${'Score'.padEnd(7)} Dur`);
    log(`  ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(14)} ${'─'.repeat(20)} ${'─'.repeat(14)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(5)}`);
    for (const r of runs) {
      const evals = apme.store.listEvalsForRun(r.id);
      const overall = evals.find(e => e.layer === 'llm_judge' && e.metric === 'overall');
      const det = evals.filter(e => e.layer === 'deterministic');
      const score = overall
        ? `${(overall.score * 100).toFixed(0)}%`
        : det.length > 0
          ? `${det.filter(e => e.score === 1).length}/${det.length}`
          : '—';
      const dur = r.endedAt && r.startedAt
        ? `${Math.round((r.endedAt - r.startedAt) / 1000)}s`
        : '—';
      const cost = r.costUsd != null ? `$${r.costUsd.toFixed(3)}` : '—';
      const cat = r.taskCategory ?? '—';
      log(`  ${r.id.slice(0, 10)} ${cat.padEnd(14)} ${(r.agentType ?? '—').padEnd(14)} ${(r.modelId ?? '—').slice(0, 20).padEnd(20)} ${(r.projectName ?? '—').slice(0, 14).padEnd(14)} ${cost.padEnd(8)} ${score.padEnd(7)} ${dur}`);
    }
    log(`\n  ${runs.length} run(s) shown.`);
  });

apme
  .command('run <id>')
  .description('Show details for a specific run')
  .action(async (id: string) => {
    const { initApme, evaluateOutcome } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    // Support partial id match
    let run = apme.store.getRun(id);
    if (!run) {
      const all = apme.store.listRuns({ limit: 500 });
      const match = all.find(r => r.id.startsWith(id));
      if (match) run = match;
    }
    if (!run) { log(`Run ${id} not found.`); process.exit(1); }

    const durSec = run.endedAt && run.startedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : 0;
    const durStr = durSec >= 60 ? `${Math.floor(durSec / 60)}m ${durSec % 60}s` : `${durSec}s`;
    const tokIn = run.inputTokens ?? 0;
    const tokOut = run.outputTokens ?? 0;
    const costStr = run.costUsd != null ? `$${run.costUsd.toFixed(3)}` : '—';
    const catStr = run.taskCategory ?? 'unknown';

    log(`\n  Run: ${run.id.slice(0, 10)} (${run.agentType} / ${run.modelId ?? '—'} / ${run.projectName ?? '—'})`);
    if (run.taskPrompt) log(`  Task: "${run.taskPrompt.slice(0, 300)}"`);
    log(`  Duration: ${durStr} │ Tokens: ${tokIn.toLocaleString()} in / ${tokOut.toLocaleString()} out │ Cost: ${costStr}`);
    log(`  Category: ${catStr}`);

    // ── Outcome ──
    let outcomeData = run.outcome ? { outcome: run.outcome, confidence: run.outcomeConfidence ?? '—' } : null;
    if (!outcomeData && run.endedAt) {
      // Compute now if not yet evaluated
      const result = evaluateOutcome(apme.store, run.id);
      if (result) {
        outcomeData = { outcome: result.outcome.outcome, confidence: result.outcome.confidence };
        run = apme.store.getRun(run.id) ?? run; // refresh
      }
    }
    if (outcomeData) {
      log(`\n  ── Outcome ${'─'.repeat(40)} confidence: ${String(outcomeData.confidence).toUpperCase()}`);
      log(`    ${outcomeData.outcome}`);
    }

    // ── LLM Judge ──
    const evals = apme.store.listEvalsForRun(run.id);
    const judgeEvals = evals.filter(e => e.layer === 'llm_judge');
    if (judgeEvals.length > 0) {
      const overall = judgeEvals.find(e => e.metric === 'overall');
      log(`\n  ── Task Completion (LLM Judge) ${'─'.repeat(24)} score: ${overall ? (overall.score * 100).toFixed(0) + '%' : '—'}`);
      for (const e of judgeEvals.filter(e => e.metric !== 'overall')) {
        log(`    ${e.metric.padEnd(20)} ${(e.score * 100).toFixed(0)}%`);
      }
      if (overall?.raw) {
        try {
          const raw = JSON.parse(overall.raw) as { reasoning?: string; done?: string[]; missed?: string[] };
          if (raw.done?.length) {
            for (const item of raw.done) log(`    ✓ ${item}`);
          }
          if (raw.missed?.length) {
            for (const item of raw.missed) log(`    ✗ ${item}`);
          }
          if (raw.reasoning) log(`    Reasoning: "${raw.reasoning.slice(0, 300)}"`);
        } catch { /* ignore */ }
      }
    }

    // ── Deterministic ──
    const detEvals = evals.filter(e => e.layer === 'deterministic');
    if (detEvals.length > 0) {
      log(`\n  ── Deterministic ${'─'.repeat(36)}`);
      for (const e of detEvals) {
        const icon = e.score === 1 ? '✓' : '✗';
        let cmdInfo = '';
        if (e.raw) {
          try {
            const r = JSON.parse(e.raw) as { command?: string; exitCode?: number; durationMs?: number };
            cmdInfo = ` (${r.command ?? '—'}, exit=${r.exitCode ?? '—'}, ${r.durationMs ? Math.round(r.durationMs / 1000) + 's' : '—'})`;
          } catch { /* ignore */ }
        }
        log(`    ${icon} ${e.metric}${cmdInfo}`);
      }
    }

    // ── Efficiency ──
    if (run.efficiencyJson) {
      try {
        const eff = JSON.parse(run.efficiencyJson) as Record<string, number | null>;
        log(`\n  ── Efficiency ${'─'.repeat(40)}`);
        if (eff.diffLines != null) log(`    ${eff.diffLines} lines changed`);
        if (eff.tokensPerChange != null) log(`    ${eff.tokensPerChange} tokens/changed line`);
        if (eff.costPerChange != null) log(`    $${eff.costPerChange.toFixed(4)}/changed line`);
        if (eff.toolEfficiency != null) log(`    ${eff.toolEfficiency} lines/tool call`);
        if (eff.timeToCompleteSec != null) log(`    ${eff.timeToCompleteSec}s total`);
      } catch { /* ignore */ }
    }

    // ── Composite Score ──
    if (run.compositeScore != null) {
      log(`\n  ── Composite Score ${'─'.repeat(34)} ${(run.compositeScore * 100).toFixed(0)}%`);
      // Show weight breakdown
      const oc = outcomeData ? `outcome(${outcomeData.outcome})` : 'outcome(—)';
      const jd = judgeEvals.find(e => e.metric === 'overall');
      const jdStr = jd ? `judge(${(jd.score * 100).toFixed(0)}%)` : 'judge(—)';
      const vibe = apme.store.latestVibeForRun(run.id);
      const vibeStr = vibe ? `vibe(${vibe.verdict})` : 'vibe(—)';
      log(`    ${oc} × 0.4 + ${jdStr} × 0.3 + efficiency × 0.2 + ${vibeStr} × 0.1`);
    }

    // ── Turns ──
    const turns = apme.store.listTurns(run.id);
    if (turns.length > 0) {
      log(`\n  ── Turns (${turns.length}) ${'─'.repeat(38)}`);
      for (const t of turns) {
        const idx = t.turn_index as number;
        const prompt = t.prompt as string | null;
        const tc = t.tool_calls as number ?? 0;
        const fm = t.files_modified as number ?? 0;
        const fc = t.files_created as number ?? 0;
        const dur = t.ended_at && t.started_at
          ? `${Math.round(((t.ended_at as number) - (t.started_at as number)) / 1000)}s`
          : 'open';
        const gitChanged = t.git_before && t.git_after && t.git_before !== t.git_after ? ' +commit' : '';
        const turnEvals = apme.store.listEvalsForTurn(t.id as string);
        const turnOverall = turnEvals.find(e => e.metric === 'overall');
        const scoreStr = turnOverall ? ` score=${(turnOverall.score * 100).toFixed(0)}%` : '';

        const resp = t.response as string | null;
        log(`    [${idx}] ${prompt ? '"' + prompt.slice(0, 80) + (prompt.length > 80 ? '...' : '') + '"' : '(no prompt)'}`);
        if (resp) log(`        → ${resp.slice(0, 200)}${resp.length > 200 ? '...' : ''}`);
        log(`        ${tc} tools, ${fm} edits, ${fc} creates, ${dur}${gitChanged}${scoreStr}`);

        // Show judge reasoning if available for this turn
        if (turnOverall?.raw) {
          try {
            const raw = JSON.parse(turnOverall.raw) as { reasoning?: string; done?: string[]; missed?: string[] };
            if (raw.done?.length) for (const item of raw.done) log(`        ✓ ${item}`);
            if (raw.missed?.length) for (const item of raw.missed) log(`        ✗ ${item}`);
          } catch { /* ignore */ }
        }
      }
    }

    // ── Steps summary ──
    const steps = apme.store.listSteps(run.id);
    if (steps.length > 0) {
      log(`\n  ── Steps (${steps.length}) ${'─'.repeat(38)}`);
      for (const s of steps.slice(-10)) {
        const tool = s.toolName ? ` [${s.toolName}]` : '';
        log(`    ${new Date(s.ts).toISOString().slice(11, 19)} ${s.kind}${tool}`);
      }
      if (steps.length > 10) log(`    ... ${steps.length - 10} more`);
    }

    const vibe = apme.store.latestVibeForRun(run.id);
    if (vibe) log(`\n  Vibe: ${vibe.verdict}${vibe.note ? ` — ${vibe.note}` : ''}`);
  });

apme
  .command('scorecard')
  .description('Model performance scorecard')
  .action(async () => {
    const { initApme } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    const cards = apme.store.scorecard();
    if (cards.length === 0) { log('No scorecard data yet.'); return; }

    log(`\n  ${'Model'.padEnd(26)} ${'Agent'.padEnd(14)} ${'Runs'.padEnd(6)} ${'Score'.padEnd(8)} ${'Tests'.padEnd(8)} ${'Cost'.padEnd(10)} $/Quality`);
    log(`  ${'─'.repeat(26)} ${'─'.repeat(14)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(9)}`);
    for (const c of cards) {
      const score = c.avgOverall != null ? `${(c.avgOverall * 100).toFixed(0)}%` : '—';
      const tests = c.avgTestsPass != null ? `${(c.avgTestsPass * 100).toFixed(0)}%` : '—';
      const cost = c.totalCost != null ? `$${c.totalCost.toFixed(2)}` : '—';
      const cpq = c.costPerQuality != null ? `$${c.costPerQuality.toFixed(2)}` : '—';
      log(`  ${c.modelId.slice(0, 26).padEnd(26)} ${c.agentType.padEnd(14)} ${String(c.runs).padEnd(6)} ${score.padEnd(8)} ${tests.padEnd(8)} ${cost.padEnd(10)} ${cpq}`);
    }
  });

apme
  .command('judge')
  .description('Run evaluation on unevaluated runs')
  .option('--all', 'Judge all unevaluated runs (default: up to 10)')
  .action(async (opts) => {
    const { initApme } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    const limit = opts.all ? 100 : 10;
    const pending = apme.store.listUnevaluatedRuns(limit);
    if (pending.length === 0) { log('All runs already evaluated.'); return; }

    log(`Evaluating ${pending.length} run(s)...`);
    let completed = 0;
    apme.runner.onResult((r) => {
      completed++;
      const tag = [r.layer1Ran && 'L1', r.layer2Ran && 'L2'].filter(Boolean).join('+') || 'skip';
      log(`  [${completed}/${pending.length}] ${r.runId.slice(0, 10)} → ${tag}${r.overall != null ? ` overall=${(r.overall * 100).toFixed(0)}%` : ''}`);
    });

    for (const run of pending) {
      apme.runner.enqueue({ runId: run.id, projectPath: run.projectPath ?? undefined });
    }
    await apme.runner.drain();
    log(`Done. ${completed} run(s) evaluated.`);
  });

apme
  .command('tune')
  .description('Manually trigger rubric auto-tuning')
  .action(async () => {
    const { initApme } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    log('Running rubric tuner...');
    const outcome = await apme.tuner.tune();
    if (outcome.accepted) {
      log(`Accepted rubric v${outcome.newVersion} (correlation ${outcome.baselineCorrelation?.toFixed(2) ?? '?'} → ${outcome.proposedCorrelation?.toFixed(2) ?? '?'})`);
    } else {
      log(`Rejected: ${outcome.reason}`);
    }
  });

apme
  .command('vibe <runId> <verdict>')
  .description('Submit vibe feedback (approve|reject|neutral)')
  .option('-n, --note <text>', 'Optional note')
  .action(async (runId: string, verdict: string, opts) => {
    const { initApme } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    if (!['approve', 'reject', 'neutral'].includes(verdict)) {
      log('Verdict must be approve, reject, or neutral.'); process.exit(1);
    }
    // Support partial id
    let run = apme.store.getRun(runId);
    if (!run) {
      const all = apme.store.listRuns({ limit: 500 });
      const match = all.find(r => r.id.startsWith(runId));
      if (match) run = match;
    }
    if (!run) { log(`Run ${runId} not found.`); process.exit(1); }

    apme.store.insertVibe({
      runId: run.id,
      verdict: verdict as 'approve' | 'reject' | 'neutral',
      note: opts.note ?? null,
      ts: Date.now(),
    });
    log(`Vibe ${verdict} recorded for run ${run.id.slice(0, 10)}.`);
  });

apme
  .command('export')
  .description('Export runs (default) or tasks as JSONL/CSV — dataset for offline analysis or meta-eval')
  .option('-n, --limit <n>', 'Maximum rows', '100')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .option('-b, --by <unit>', 'Row unit: run | task', 'run')
  .option('-f, --format <fmt>', 'Format: jsonl | csv', 'jsonl')
  .option('--closed-only', 'Tasks only: skip in-progress tasks (no ended_at)', false)
  .action(async (opts) => {
    const { initApme } = await import('./apme/index.js');
    const { writeFileSync: wfs } = await import('fs');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    const limit = parseInt(opts.limit, 10) || 100;
    const by: 'task' | 'run' = opts.by === 'task' ? 'task' : 'run';
    const format: 'csv' | 'jsonl' = opts.format === 'csv' ? 'csv' : 'jsonl';

    let rows: Array<Record<string, unknown>>;
    if (by === 'task') {
      // Task-unit dataset: one row per task (group of turns between
      // boundary signals). This is the dataset format that supports
      // meaningful agent evaluation per the user requirement —
      // "의미 있는 단위의 세션을 데이터셋으로 저장".
      const tasks = apme.store.listAllTasks({ limit, closedOnly: !!opts.closedOnly });
      rows = tasks.map((t) => {
        const turns = apme.store.listTurnsForTask(t.id);
        const evals = apme.store.listEvalsForTask(t.id);
        const run = apme.store.getRun(t.runId);
        const vibe = apme.store.latestVibeForRun(t.runId);

        const axes: Record<string, number> = {};
        for (const e of evals) {
          if (e.layer === 'task_judge') axes[e.metric] = e.score;
        }
        const overallEval = evals.find((e) => e.layer === 'task_judge' && e.metric === 'overall');
        let reasoning: string | null = null;
        let done: string[] | null = null;
        let missed: string[] | null = null;
        if (overallEval?.raw) {
          try {
            const parsed = JSON.parse(overallEval.raw) as { reasoning?: string; done?: string[]; missed?: string[] };
            reasoning = parsed.reasoning ?? null;
            done = parsed.done ?? null;
            missed = parsed.missed ?? null;
          } catch { /* ignore parse failure */ }
        }

        const toolCalls = turns.reduce((n, tu) => n + ((tu.tool_calls as number | undefined) ?? 0), 0);
        const filesModified = turns.reduce((n, tu) => n + ((tu.files_modified as number | undefined) ?? 0), 0);
        const filesCreated = turns.reduce((n, tu) => n + ((tu.files_created as number | undefined) ?? 0), 0);
        const firstPrompt = (turns[0]?.prompt as string | undefined) ?? null;
        const lastResponse = (turns[turns.length - 1]?.response as string | undefined) ?? null;

        return {
          taskId: t.id,
          runId: t.runId,
          taskIndex: t.taskIndex,
          agentType: run?.agentType ?? null,
          modelId: run?.modelId ?? null,
          projectName: run?.projectName ?? null,
          taskCategory: t.taskCategory ?? run?.taskCategory ?? null,
          boundarySignal: t.boundarySignal,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          durationSec: t.endedAt ? Math.round((t.endedAt - t.startedAt) / 1000) : null,
          turnCount: turns.length,
          firstTurnIndex: t.firstTurnIndex,
          lastTurnIndex: t.lastTurnIndex,
          toolCalls,
          filesModified,
          filesCreated,
          firstPrompt: firstPrompt ? firstPrompt.slice(0, 500) : null,
          lastResponse: lastResponse ? lastResponse.slice(0, 500) : null,
          summary: t.summary ?? null,
          composite: t.compositeScore ?? null,
          outcome: t.outcome ?? null,
          axes,
          overall: axes.overall ?? null,
          reasoning,
          done,
          missed,
          vibeVerdict: vibe?.verdict ?? null,
          vibeNote: vibe?.note ?? null,
        };
      });
    } else {
      const runRows = apme.store.listRuns({ limit });
      rows = runRows.map((r) => {
        const evals = apme.store.listEvalsForRun(r.id);
        const vibe = apme.store.latestVibeForRun(r.id);
        return { ...r, evals, vibe };
      });
    }

    const output = format === 'csv' ? rowsToCsv(rows) : rowsToJsonl(rows);
    if (opts.output) {
      wfs(opts.output, output, 'utf-8');
      log(`Exported ${rows.length} ${by}(s) to ${opts.output} (${format})`);
    } else {
      process.stdout.write(output);
    }
  });

function rowsToJsonl(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headerSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k);
  const headers = Array.from(headerSet);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines: string[] = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ];
  return lines.join('\n') + '\n';
}

apme
  .command('rubric')
  .description('Show current judge rubric')
  .action(async () => {
    const { initApme } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    const rubric = apme.store.getCurrentRubric('general');
    if (!rubric) { log('No rubric seeded.'); return; }

    log(`\n  Rubric v${rubric.version} (purpose: ${rubric.purpose})`);
    log(`  Created: ${new Date(rubric.createdAt).toISOString()}`);
    if (rubric.parentVer) log(`  Parent: v${rubric.parentVer}`);
    if (rubric.notes) log(`  Notes: ${rubric.notes}`);
    log(`\n  Weights: ${rubric.weights}`);
    log(`\n  Prompt:\n${rubric.prompt.split('\n').map(l => '    ' + l).join('\n')}`);
  });

apme
  .command('tag <runId> <category>')
  .description('Override task category for a run (user label)')
  .action(async (runId: string, category: string) => {
    const { initApme, TASK_CATEGORIES } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    // Support partial id
    let run = apme.store.getRun(runId);
    if (!run) {
      const all = apme.store.listRuns({ limit: 500 });
      const match = all.find(r => r.id.startsWith(runId));
      if (match) run = match;
    }
    if (!run) { log(`Run ${runId} not found.`); process.exit(1); }

    if (!TASK_CATEGORIES.includes(category as any) && category !== 'unknown') {
      log(`Known categories: ${TASK_CATEGORIES.join(', ')}`);
      log(`You can also use any custom string.`);
    }
    apme.store.updateRun(run.id, {
      taskCategory: category,
      taskCategorySource: 'user',
    });
    log(`Tagged run ${run.id.slice(0, 10)} as "${category}" (source: user).`);
  });

apme
  .command('reclassify')
  .description('Re-classify all runs using the current rule-based classifier')
  .option('--force', 'Overwrite user-tagged runs too')
  .action(async (opts) => {
    const { initApme, classifyRun } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    const runs = apme.store.listRuns({ limit: 5000 });
    let updated = 0;
    let skipped = 0;
    for (const r of runs) {
      if (!opts.force && r.taskCategorySource === 'user') {
        skipped++;
        continue;
      }
      const { signals, category } = classifyRun(apme.store, r.id);
      apme.store.updateRun(r.id, {
        taskSignals: JSON.stringify(signals),
        taskCategory: category,
        taskCategorySource: 'auto',
      });
      updated++;
    }
    log(`Reclassified ${updated} run(s).${skipped > 0 ? ` Skipped ${skipped} user-tagged (use --force to overwrite).` : ''}`);
  });

apme
  .command('categories')
  .description('Show task category scorecard (model × category performance)')
  .action(async () => {
    const { initApme } = await import('./apme/index.js');
    const apme = await initApme();
    if (!apme) { log('APME not available'); process.exit(1); }

    const cards = apme.store.categoryScorecard();
    if (cards.length === 0) { log('No category data yet.'); return; }

    log(`\n  ${'Category'.padEnd(16)} ${'Model'.padEnd(22)} ${'Runs'.padEnd(6)} ${'Score'.padEnd(8)} ${'Tests'.padEnd(8)} Cost`);
    log(`  ${'─'.repeat(16)} ${'─'.repeat(22)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
    for (const c of cards) {
      const score = c.avgOverall != null ? `${(c.avgOverall * 100).toFixed(0)}%` : '—';
      const tests = c.avgTestsPass != null ? `${(c.avgTestsPass * 100).toFixed(0)}%` : '—';
      const cost = c.totalCost != null ? `$${c.totalCost.toFixed(2)}` : '—';
      log(`  ${c.taskCategory.padEnd(16)} ${c.modelId.slice(0, 22).padEnd(22)} ${String(c.runs).padEnd(6)} ${score.padEnd(8)} ${tests.padEnd(8)} ${cost}`);
    }
  });

program.parse();
