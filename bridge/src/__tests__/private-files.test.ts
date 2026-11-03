import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWritePrivateFile, readBoundedRegularFile, readBoundedRegularFileAsync } from '../private-files.js';

describe('private atomic file replacement', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'agentdeck-private-file-test-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('bounds whole-file reads and tails on regular files in both read paths', async () => {
    const file = join(directory, 'capture');
    writeFileSync(file, '1234567890');
    expect(readBoundedRegularFile(file, 5)).toBeNull();
    expect(await readBoundedRegularFileAsync(file, 5)).toBeNull();
    expect(readBoundedRegularFile(file, 5, true)?.toString()).toBe('67890');
    expect(readBoundedRegularFile(file, 10)?.toString()).toBe('1234567890');
    expect((await readBoundedRegularFileAsync(file, 10))?.toString()).toBe('1234567890');
    expect(readBoundedRegularFile(directory, 10)).toBeNull();
    expect(await readBoundedRegularFileAsync(directory, 10)).toBeNull();
    expect(readBoundedRegularFile(file, Infinity)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('continues reading intentional local configuration symlinks', async () => {
    const file = join(directory, 'settings.json'), link = join(directory, 'linked-settings.json');
    writeFileSync(file, '{"ok":true}');
    symlinkSync(file, link);
    expect(readBoundedRegularFile(link, 100)?.toString()).toBe('{"ok":true}');
    expect((await readBoundedRegularFileAsync(link, 100))?.toString()).toBe('{"ok":true}');
  });

  it('replaces the file and removes its private temporary entry', () => {
    const target = join(directory, 'timeline.json');
    writeFileSync(target, 'old');
    atomicWritePrivateFile(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(directory)).toEqual(['timeline.json']);
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('leaves an attacker-planted predictable temp symlink untouched', () => {
    const target = join(directory, 'timeline.json'), sentinel = join(directory, 'sentinel');
    writeFileSync(sentinel, 'keep');
    symlinkSync(sentinel, `${target}.tmp`);
    atomicWritePrivateFile(target, 'new');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(existsSync(`${target}.tmp`)).toBe(true);
  });

  it('preserves the target and cleans its temporary entry when rename fails', () => {
    const target = join(directory, 'directory');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'old');
    expect(() => atomicWritePrivateFile(target, 'new')).toThrow();
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('old');
    expect(readdirSync(directory)).toEqual(['directory']);
  });
});
