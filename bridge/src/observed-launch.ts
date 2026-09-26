import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';

/** Run in the caller's terminal. No PTY, bridge, output parser or device owner. */
export function launchObservedCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  if (env.AGENTDECK_PORT) {
    throw new Error('Run from an ordinary terminal, outside a managed AgentDeck session (AGENTDECK_PORT is set).');
  }
  const shell = platform === 'win32' ? (env.COMSPEC || 'cmd.exe') : (env.SHELL || '/bin/bash');
  const args = platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-l', '-c', command];
  // Keep the same shell grammar as managed -c, including login profiles. Inherit
  // the terminal and foreground process group: the terminal delivers Ctrl-C to
  // the child directly. Do not forward it a second time. Sync wait deliberately
  // keeps this launcher out of the agent's stdin/stdout and hook lifecycle.
  const ignoreTerminalInterrupt = () => {};
  process.on('SIGINT', ignoreTerminalInterrupt);
  process.on('SIGQUIT', ignoreTerminalInterrupt);
  try {
    const result = spawnSync(shell, args, { env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: platform === 'win32' });
    if (result.error) throw result.error;
    return result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 1) : 1);
  } finally {
    process.off('SIGINT', ignoreTerminalInterrupt);
    process.off('SIGQUIT', ignoreTerminalInterrupt);
  }
}
