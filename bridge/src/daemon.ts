#!/usr/bin/env node

/**
 * Legacy daemon entry point.
 * New CLI: `agentdeck daemon start|stop|status|install|uninstall`
 *
 * Kept for backward compatibility with existing LaunchAgent plists
 * that reference this file directly.
 */

import { Command } from 'commander';
import { BRIDGE_WS_PORT } from './types.js';
import { startDaemon } from './daemon-server.js';
import { readDaemonInfo, findExistingDaemon, findDaemonPort, probeDaemonHealth } from './session-registry.js';

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

const program = new Command();

program
  .name('agentdeck')
  .description('AgentDeck daemon (legacy entry point — use `agentdeck daemon` instead)')
  .version('0.2.3');

program
  .command('start', { isDefault: true })
  .description('Start monitoring daemon')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .action(async (opts) => {
    const daemonInfo = readDaemonInfo();
    if (daemonInfo) {
      const probePort = daemonInfo.httpPort ?? daemonInfo.port;
      const health = await probeDaemonHealth(probePort);
      if (health?.mode === 'daemon') {
        log(`Daemon already running on port ${daemonInfo.port} (PID ${daemonInfo.pid}).`);
        process.exit(0);
      }
      log(`Ignoring stale daemon entry on port ${daemonInfo.port} (PID ${daemonInfo.pid}; /health did not respond).`);
    }
    const existing = findExistingDaemon();
    if (existing) {
      const health = await probeDaemonHealth(existing.port);
      if (health?.mode === 'daemon') {
        log(`Daemon already running on port ${existing.port} (PID ${existing.pid}).`);
        process.exit(0);
      }
      log(`Ignoring stale daemon session on port ${existing.port} (PID ${existing.pid}; /health did not respond).`);
    }
    await startDaemon({ port: parseInt(opts.port, 10), debug: opts.debug });
  });

program
  .command('stop')
  .description('Stop the daemon')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const info = readDaemonInfo();
    const targetPort = info?.httpPort ?? info?.port ?? findDaemonPort() ?? port;
    try {
      await fetch(`http://127.0.0.1:${targetPort}/shutdown`, { method: 'POST' });
      log('Shutdown signal sent');
    } catch {
      log('Daemon is not running');
    }
  });

program.parse();
