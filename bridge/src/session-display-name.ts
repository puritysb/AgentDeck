import { openSync, fstatSync, readSync, closeSync, existsSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { normalizeSessionDisplayName } from '@agentdeck/shared';

/** Bounded file-only Git hint. Worktree .git pointers are supported; detached
 * HEADs and unreadable metadata supply no invented branch. Never invokes Git. */
export function gitBranchDisplayName(cwd: string): string {
  const read = (path: string): string | undefined => {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096) return undefined;
      const buffer = Buffer.alloc(4097);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      return count <= 4096 ? buffer.subarray(0, count).toString('utf8').trim() : undefined;
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  let dir = resolve(cwd);
  for (let depth = 0; depth < 32; depth++) {
    const git = join(dir, '.git');
    const pointer = read(git);
    const gitDir = pointer?.startsWith('gitdir: ') ? resolve(dir, pointer.slice(8)) : git;
    const head = read(join(gitDir, 'HEAD'));
    if (head !== undefined) {
      return head.startsWith('ref: refs/heads/')
        ? normalizeSessionDisplayName(head.slice('ref: refs/heads/'.length)) : '';
    }
    if (existsSync(git)) return ''; // a nearer repository is authoritative even if unreadable
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/** Measured Claude 2.1.316: --name and /rename both write nameSource=user.
 * Unknown source values are never classified as explicit user choices.
 * An explicit empty registry name clears older transcript/branch fallbacks. */
export function claudeDisplayName(
  file: { cwd: string; name?: string; nameSource?: string }, customTitle?: string,
): string {
  if (file.name !== undefined && (!file.name || file.nameSource === 'user')) {
    return normalizeSessionDisplayName(file.name);
  }
  if (customTitle !== undefined) return normalizeSessionDisplayName(customTitle);
  return normalizeSessionDisplayName(file.name) || gitBranchDisplayName(file.cwd);
}
