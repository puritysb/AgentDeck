import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from './proc.js';
import { chmodSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, release } from 'os';
import { fileURLToPath } from 'url';
import { debug } from './logger.js';

export interface FoundationModelsHelperStatus {
  available: boolean;
  reason?: string;
  path?: string;
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let helperPathCache: FoundationModelsHelperStatus | null = null;
let helperProcess: ChildProcessWithoutNullStreams | null = null;
let helperStdout = '';
let nextRequestId = 1;
const pending = new Map<number, Pending>();

const HELPER_REQUEST_TIMEOUT_MS = 60_000;

function dataDir(): string {
  return process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
}

function packageRoot(): string {
  // src/foundation-models-helper.ts in dev, dist/foundation-models-helper.js in npm.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function isExecutable(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function supportsFoundationModelsRuntime(): boolean {
  if (process.platform !== 'darwin') return false;
  const darwinMajor = Number(release().split('.')[0] ?? '0');
  // macOS 26 is Darwin 25.x. This is a cheap guard before trying a macOS 26 binary.
  return Number.isFinite(darwinMajor) && darwinMajor >= 25;
}

function sourcePath(): string {
  return join(packageRoot(), 'fm-helper', 'AgentDeckFMHelper.swift');
}

function bundledHelperPath(): string {
  return join(packageRoot(), 'assets', 'fm-helper', 'agentdeck-fm-helper');
}

function cachedHelperPath(): string {
  return join(dataDir(), 'fm-helper', 'agentdeck-fm-helper');
}

function sourceIsNewer(source: string, output: string): boolean {
  try {
    return statSync(source).mtimeMs > statSync(output).mtimeMs;
  } catch {
    return true;
  }
}

function compileHelper(source: string, output: string): FoundationModelsHelperStatus {
  try {
    mkdirSync(dirname(output), { recursive: true });
    const swiftc = execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    execFileSync(swiftc, [
      '-parse-as-library',
      '-target',
      `${arch}-apple-macos26.0`,
      source,
      '-o',
      output,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
    });
    chmodSync(output, 0o755);
    return { available: true, path: output };
  } catch (err) {
    return { available: false, reason: `failed to build Foundation Models helper: ${String(err).slice(0, 160)}` };
  }
}

export function clearFoundationModelsHelperForTests(): void {
  helperPathCache = null;
  stopFoundationModelsHelper();
}

export function resolveFoundationModelsHelper(): FoundationModelsHelperStatus {
  if (helperPathCache) return helperPathCache;
  if (!supportsFoundationModelsRuntime()) {
    helperPathCache = { available: false, reason: 'macOS 26+ required for Foundation Models helper' };
    return helperPathCache;
  }

  const envPath = process.env.AGENTDECK_FM_HELPER;
  if (envPath) {
    helperPathCache = isExecutable(envPath)
      ? { available: true, path: envPath }
      : { available: false, reason: `AGENTDECK_FM_HELPER is not executable: ${envPath}` };
    return helperPathCache;
  }

  const bundled = bundledHelperPath();
  if (isExecutable(bundled)) {
    helperPathCache = { available: true, path: bundled };
    return helperPathCache;
  }

  const source = sourcePath();
  if (!existsSync(source)) {
    helperPathCache = { available: false, reason: 'Foundation Models helper source not packaged' };
    return helperPathCache;
  }

  const cached = cachedHelperPath();
  if (isExecutable(cached) && !sourceIsNewer(source, cached)) {
    helperPathCache = { available: true, path: cached };
    return helperPathCache;
  }

  helperPathCache = compileHelper(source, cached);
  return helperPathCache;
}

function rejectAllPending(reason: string): void {
  for (const [id, item] of pending.entries()) {
    clearTimeout(item.timer);
    item.reject(new Error(reason));
    pending.delete(id);
  }
}

function ensureHelperProcess(): ChildProcessWithoutNullStreams {
  const resolved = resolveFoundationModelsHelper();
  if (!resolved.available || !resolved.path) {
    throw new Error(resolved.reason ?? 'Foundation Models helper unavailable');
  }
  if (helperProcess && !helperProcess.killed) return helperProcess;

  helperStdout = '';
  helperProcess = spawn(resolved.path, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  helperProcess.stdout.setEncoding('utf8');
  helperProcess.stdout.on('data', (chunk: string) => {
    helperStdout += chunk;
    let newline = helperStdout.indexOf('\n');
    while (newline >= 0) {
      const line = helperStdout.slice(0, newline).trim();
      helperStdout = helperStdout.slice(newline + 1);
      if (line) handleHelperLine(line);
      newline = helperStdout.indexOf('\n');
    }
  });
  helperProcess.stderr.setEncoding('utf8');
  helperProcess.stderr.on('data', (chunk: string) => {
    const text = chunk.trim();
    if (text) debug('APME', `Foundation Models helper stderr: ${text.slice(0, 300)}`);
  });
  helperProcess.on('exit', (code, signal) => {
    helperProcess = null;
    rejectAllPending(`Foundation Models helper exited (${code ?? signal ?? 'unknown'})`);
  });
  helperProcess.on('error', (err) => {
    helperProcess = null;
    rejectAllPending(`Foundation Models helper error: ${String(err)}`);
  });
  return helperProcess;
}

function handleHelperLine(line: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    debug('APME', `Foundation Models helper emitted non-JSON line: ${line.slice(0, 160)}`);
    return;
  }
  const id = typeof parsed.id === 'number' ? parsed.id : null;
  if (id == null) return;
  const item = pending.get(id);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(id);
  item.resolve(parsed);
}

function requestHelper(payload: Record<string, unknown>, timeoutMs = HELPER_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const proc = ensureHelperProcess();
  const id = nextRequestId++;
  const message = { id, ...payload };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Foundation Models helper request timed out'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}

export async function probeFoundationModelsHelper(): Promise<FoundationModelsHelperStatus> {
  const resolved = resolveFoundationModelsHelper();
  if (!resolved.available) return resolved;
  try {
    const response = await requestHelper({ type: 'health' }, 8_000);
    if (response.status === 'ready') return { available: true, path: resolved.path };
    return {
      available: false,
      path: resolved.path,
      reason: typeof response.reason === 'string' ? response.reason : 'Foundation Models helper unavailable',
    };
  } catch (err) {
    return { available: false, path: resolved.path, reason: String(err) };
  }
}

export async function callFoundationModelsHelper(prompt: string, instructions?: string): Promise<string> {
  const response = await requestHelper({
    type: 'generate',
    prompt,
    instructions,
    temperature: 0,
  });
  if (typeof response.text === 'string' && response.text.length > 0) return response.text;
  const reason = typeof response.reason === 'string' ? response.reason : 'no reason';
  const code = typeof response.error === 'string' ? response.error : 'unavailable';
  throw new Error(`Foundation Models helper ${code}: ${reason}`);
}

export function stopFoundationModelsHelper(): void {
  if (helperProcess) {
    try { helperProcess.kill('SIGTERM'); } catch { /* ignore */ }
    helperProcess = null;
  }
  rejectAllPending('Foundation Models helper stopped');
}
