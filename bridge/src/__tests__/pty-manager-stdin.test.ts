import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { PtyManager } from '../pty-manager.js';

/** Let the stream deliver queued chunks to its listener. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('PtyManager.attachTerminal', () => {
  it('preserves multi-byte characters split across stdin chunk boundaries', async () => {
    const manager = new PtyManager();
    const written: string[] = [];
    (manager as unknown as { ptyProcess: { write(data: string): void } }).ptyProcess = {
      write: (data: string) => {
        written.push(data);
      },
    };

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    manager.attachTerminal(stdin, stdout);

    // Every character below is 3 bytes in UTF-8, so any chunk boundary that is
    // not a multiple of 3 lands inside a character.
    const text = '日本語のテキストを貼り付ける';
    const bytes = Buffer.from(text, 'utf8');

    // Cut 1 byte into the second character, then 2 bytes into the third.
    stdin.write(bytes.subarray(0, 4));
    await flush();
    stdin.write(bytes.subarray(4, 8));
    await flush();
    stdin.write(bytes.subarray(8));
    await flush();

    const received = written.join('');
    expect(received).not.toContain('�');
    expect(received).toBe(text);
  });

  it('forwards single-byte input unchanged', async () => {
    const manager = new PtyManager();
    const written: string[] = [];
    (manager as unknown as { ptyProcess: { write(data: string): void } }).ptyProcess = {
      write: (data: string) => {
        written.push(data);
      },
    };

    const stdin = new PassThrough();
    manager.attachTerminal(stdin, new PassThrough());

    stdin.write(Buffer.from('ls -la\r', 'utf8'));
    await flush();

    expect(written.join('')).toBe('ls -la\r');
  });
});
