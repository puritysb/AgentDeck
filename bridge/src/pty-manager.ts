import { EventEmitter } from 'events';
import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { debug } from './logger.js';

const requireFromHere = createRequire(import.meta.url);

/**
 * node-pty 1.1.0's npm tarball ships the macOS spawn-helper as 0644 even
 * though posix_spawn requires an executable file (upstream #850/#919). Repair
 * the selected helper at the point of use so direct bridge installs and setup
 * installs behave the same and do not depend on package-manager script policy.
 *
 * Returns the repaired path, or null when no repair was needed/applicable.
 */
export function ensureNodePtySpawnHelperExecutable(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform !== 'darwin') return null;

  const candidates = [
    join(packageRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
  ];

  for (const helperPath of candidates) {
    if (!existsSync(helperPath)) continue;
    const stat = lstatSync(helperPath);
    if (!stat.isFile()) continue;
    if ((stat.mode & 0o111) !== 0) return null;
    // Mirror each read bit to its execute bit. The published 0644 becomes
    // 0755 without granting execution to a class that could not read the file.
    const permissions = stat.mode & 0o777;
    chmodSync(helperPath, permissions | ((permissions & 0o444) >> 2));
    return helperPath;
  }
  return null;
}

function repairInstalledNodePtySpawnHelper(): void {
  if (process.platform !== 'darwin') return;

  let packageRoot: string;
  try {
    packageRoot = dirname(dirname(requireFromHere.resolve('node-pty')));
  } catch {
    // The dynamic import below owns the public "not installed" error.
    return;
  }

  try {
    const repaired = ensureNodePtySpawnHelperExecutable(packageRoot);
    if (repaired) debug('PTY', `restored executable permission on ${repaired}`);
  } catch (error) {
    throw new Error(
      `node-pty spawn-helper is not executable and AgentDeck could not repair it under ${packageRoot}.\n` +
      `Fix its permissions with: chmod +x "${join(packageRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')}"\n` +
      `Cause: ${String(error)}`,
    );
  }
}

/** Minimal interface matching node-pty's IPty */
interface IPty {
  pid: number;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

export class PtyManager extends EventEmitter {
  private ptyProcess: IPty | null = null;

  async spawn(command = 'claude', extraEnv?: Record<string, string>): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('PTY process already running');
    }

    // Dynamic import — node-pty is optionalDependency. Repair the stable
    // macOS tarball's missing helper execute bit before node-pty resolves it.
    repairInstalledNodePtySpawnHelper();
    let pty: typeof import('node-pty');
    try {
      pty = await import('node-pty');
    } catch {
      throw new Error(
        'node-pty is not installed. Install it with: npm install node-pty\n' +
        'If you don\'t need PTY (e.g. daemon/monitor mode), this dependency is optional.',
      );
    }

    const isWin = process.platform === 'win32';
    const shell = isWin
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/bash');
    // Windows ConPTY uses cmd-style switches: /d (skip AutoRun), /s (literal),
    // /c (run command then exit). POSIX shells use -l (login) -c (command).
    const args = isWin ? ['/d', '/s', '/c', command] : ['-l', '-c', command];
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;

    debug('PTY', `spawn: shell=${shell} cmd="${command}" cols=${cols} rows=${rows} cwd=${process.cwd()}`);

    const env = { ...(process.env as Record<string, string>), ...extraEnv };

    let proc: IPty;
    try {
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.cwd(),
        env,
        handleFlowControl: true,
      });
    } catch (err: any) {
      if (err?.message?.includes('posix_spawnp')) {
        throw new Error(
          'posix_spawnp failed while launching node-pty. AgentDeck already checked the macOS spawn-helper execute bit.\n' +
          'Reinstall with `npx @agentdeck/setup`, or rebuild a genuinely incompatible native prebuild:\n' +
          '  cd $(npm root -g)/@agentdeck/bridge/node_modules/node-pty && npx node-gyp rebuild\n' +
          `Original error: ${String(err)}`,
        );
      }
      throw err;
    }
    this.ptyProcess = proc;

    debug('PTY', `spawned pid=${proc.pid}`);

    proc.onData((data: string) => {
      this.emit('data', data);
    });

    proc.onExit(({ exitCode, signal }) => {
      debug('PTY', `exit: code=${exitCode} signal=${signal ?? 0}`);
      this.ptyProcess = null;
      this.emit('exit', exitCode, signal ?? 0);
    });
  }

  write(data: string): void {
    if (!this.ptyProcess) {
      debug('PTY', 'write() called but PTY not running — dropped');
      return;
    }
    // Log commands (not individual keystrokes) — heuristic: multi-char or contains newline
    if (data.length > 1 || data === '\n' || data === '\x03' || data === '\x1b[Z') {
      const preview = data.replace(/\n/g, '\\n').replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
      debug('PTY', `write(${data.length}): "${preview.slice(0, 80)}"`);
    }
    this.emit('input', data);
    this.ptyProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ptyProcess) {
      debug('PTY', `resize: ${cols}x${rows}`);
      this.ptyProcess.resize(cols, rows);
    }
  }

  attachTerminal(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void {
    debug('PTY', 'attachTerminal');

    // Decode stdin with a stateful UTF-8 decoder. Raw chunk boundaries land on
    // arbitrary byte offsets, so decoding each chunk on its own — which
    // data.toString() did — destroys any multi-byte character straddling one:
    // its bytes are decoded as separate invalid sequences and become U+FFFD.
    // A pasted CJK line loses roughly one character per chunk boundary.
    stdin.setEncoding('utf8');

    // Proxy PTY output to user's stdout
    this.on('data', (data: string) => {
      stdout.write(data);
    });

    // Proxy user's stdin to PTY
    stdin.on('data', (data: string) => {
      if (this.ptyProcess) {
        this.write(data);
      }
    });

    // Handle terminal resize
    if (process.stdout.isTTY) {
      process.stdout.on('resize', () => {
        this.resize(
          process.stdout.columns || 120,
          process.stdout.rows || 40,
        );
      });
    }
  }

  interrupt(): void {
    if (this.ptyProcess) {
      debug('PTY', 'interrupt (Ctrl+C)');
      this.ptyProcess.write('\x03');
    }
  }

  kill(): void {
    if (this.ptyProcess) {
      debug('PTY', `kill pid=${this.ptyProcess.pid}`);
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
  }

  isAlive(): boolean {
    return this.ptyProcess !== null;
  }

  getPid(): number | null {
    return this.ptyProcess?.pid ?? null;
  }

  getTtyPath(): string | undefined {
    return (this.ptyProcess as any)?._pty as string | undefined;
  }
}
