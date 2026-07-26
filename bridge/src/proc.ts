/**
 * `child_process` with `windowsHide` on by default.
 *
 * On Windows a console-subsystem child spawned from a process with no console
 * of its own gets a brand new console window. The daemon and the CLI shell out
 * constantly — adb probes, git, schtasks, version checks — so without this every
 * one of those flashes a window on screen. `windowsHide: true` sets
 * CREATE_NO_WINDOW and is inert on macOS and Linux.
 *
 * Import from here instead of `child_process` anywhere in the bridge. Callers
 * can still pass `windowsHide: false` explicitly when a visible console is the
 * point (nothing currently wants that).
 */
// Types pass through untouched so `import { spawn, type ChildProcess }` keeps
// working after the import swap.
export type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnOptionsWithoutStdio,
  SpawnSyncOptions,
  SpawnSyncReturns,
  ExecOptions,
  ExecSyncOptions,
  ExecException,
  ExecFileOptions,
  ExecFileSyncOptions,
  StdioOptions,
  IOType,
} from 'child_process';

import {
  execSync as nodeExecSync,
  execFileSync as nodeExecFileSync,
  spawnSync as nodeSpawnSync,
  spawn as nodeSpawn,
  exec as nodeExec,
  execFile as nodeExecFile,
} from 'child_process';

/** Merge `windowsHide: true` into an options object, preserving an explicit false. */
function hidden<T extends object | undefined>(options: T): T {
  return { windowsHide: true, ...(options ?? {}) } as T;
}

/** True when the argument looks like an options bag rather than args/callback. */
function isOptions(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const execSync: typeof nodeExecSync = ((command: any, options?: any) =>
  nodeExecSync(command, hidden(options))) as typeof nodeExecSync;

export const execFileSync: typeof nodeExecFileSync = ((file: any, ...rest: any[]) => {
  // Signature is (file, args?, options?) — the options bag is whichever
  // trailing argument is a plain object.
  if (rest.length === 0) return nodeExecFileSync(file, hidden(undefined) as any);
  if (rest.length === 1) {
    return isOptions(rest[0]) && !Array.isArray(rest[0])
      ? nodeExecFileSync(file, hidden(rest[0]) as any)
      : nodeExecFileSync(file, rest[0], hidden(undefined) as any);
  }
  return nodeExecFileSync(file, rest[0], hidden(rest[1]) as any);
}) as typeof nodeExecFileSync;

export const spawnSync: typeof nodeSpawnSync = ((file: any, ...rest: any[]) => {
  if (rest.length === 0) return nodeSpawnSync(file, hidden(undefined) as any);
  if (rest.length === 1) {
    return isOptions(rest[0]) && !Array.isArray(rest[0])
      ? nodeSpawnSync(file, hidden(rest[0]) as any)
      : nodeSpawnSync(file, rest[0], hidden(undefined) as any);
  }
  return nodeSpawnSync(file, rest[0], hidden(rest[1]) as any);
}) as typeof nodeSpawnSync;

export const spawn: typeof nodeSpawn = ((file: any, ...rest: any[]) => {
  if (rest.length === 0) return nodeSpawn(file, hidden(undefined) as any);
  if (rest.length === 1) {
    return isOptions(rest[0]) && !Array.isArray(rest[0])
      ? nodeSpawn(file, hidden(rest[0]) as any)
      : nodeSpawn(file, rest[0], hidden(undefined) as any);
  }
  return nodeSpawn(file, rest[0], hidden(rest[1]) as any);
}) as typeof nodeSpawn;

export const exec: typeof nodeExec = ((command: any, ...rest: any[]) => {
  // Signature is (command, options?, callback?).
  const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : undefined;
  const options = isOptions(rest[0]) ? rest[0] : undefined;
  return callback
    ? nodeExec(command, hidden(options) as any, callback)
    : nodeExec(command, hidden(options) as any);
}) as typeof nodeExec;

export const execFile: typeof nodeExecFile = ((file: any, ...rest: any[]) => {
  const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : undefined;
  const args = Array.isArray(rest[0]) ? rest.shift() : undefined;
  const options = isOptions(rest[0]) ? rest[0] : undefined;
  const built: any[] = [file];
  if (args) built.push(args);
  built.push(hidden(options));
  if (callback) built.push(callback);
  return (nodeExecFile as any)(...built);
}) as typeof nodeExecFile;
