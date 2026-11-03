import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** Bound allocation and reads on the opened regular file, not a prior path stat.
 * Local configuration may intentionally be symlinked by a dotfile manager. */
export function readBoundedRegularFile(path: string, maxBytes: number, tail = false): Buffer | null {
  let fd: number | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || (!tail && info.size > maxBytes)) return null;
    const length = Math.min(info.size, maxBytes);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    const start = tail ? info.size - length : 0;
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, start + offset);
      if (count === 0) return null;
      offset += count;
    }
    return bytes;
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* unreadable */ } } }
}

export async function readBoundedRegularFileAsync(path: string, maxBytes: number): Promise<Buffer | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > maxBytes) return null;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    return bytes;
  } catch { return null; }
  finally { if (file) await file.close().catch(() => {}); }
}

/** Same-directory atomic replacement without following a predictable temp symlink. */
export function atomicWritePrivateFile(target: string, data: string | Uint8Array): void {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(fd, data);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original error */ } }
    if (created) { try { unlinkSync(temporary); } catch { /* rename already consumed it */ } }
  }
}
