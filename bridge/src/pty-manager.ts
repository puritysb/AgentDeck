import { EventEmitter } from 'events';
import { debug } from './logger.js';

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

    // Dynamic import — node-pty is optionalDependency
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
      : (process.env.SHELL || '/bin/zsh');
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
          'posix_spawnp failed — the prebuilt node-pty binary is incompatible with your Node.js version.\n' +
          'Fix: rebuild node-pty from source:\n' +
          '  cd $(npm root -g)/@agentdeck/bridge/node_modules/node-pty && npx node-gyp rebuild\n' +
          'Or reinstall: npx @agentdeck/setup',
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

    // Proxy PTY output to user's stdout
    this.on('data', (data: string) => {
      stdout.write(data);
    });

    // Proxy user's stdin to PTY
    stdin.on('data', (data: Buffer) => {
      if (this.ptyProcess) {
        this.ptyProcess.write(data.toString());
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
