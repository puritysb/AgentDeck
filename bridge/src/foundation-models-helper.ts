import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
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
// Short-command transcription is sub-second once the model is warm; the
// generous ceiling covers the OS finishing its one-time dictation download.
const TRANSCRIBE_TIMEOUT_MS = 45_000;
// Synthesis blocks until playback finishes, so this bounds an actual spoken reply.
const SPEAK_TIMEOUT_MS = 120_000;

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

function buildScriptPath(): string {
  return join(packageRoot(), 'scripts', 'build-fm-helper.mjs');
}

/**
 * Compile the helper through the packaged build script rather than invoking
 * swiftc here: the script owns the `__info_plist` embedding and the ad-hoc
 * signature, and a second copy of those flags would drift into a binary that
 * TCC kills on the first mic or speech request.
 */
function compileHelper(output: string): FoundationModelsHelperStatus {
  try {
    mkdirSync(dirname(output), { recursive: true });
    const script = buildScriptPath();
    if (!existsSync(script)) {
      return { available: false, reason: `Foundation Models helper build script missing: ${script}` };
    }
    execFileSync(process.execPath, [script, '--out', output], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
    });
    if (!isExecutable(output)) {
      return { available: false, reason: 'Foundation Models helper build produced no binary' };
    }
    chmodSync(output, 0o755);
    return { available: true, path: output };
  } catch (err) {
    return { available: false, reason: `failed to build Foundation Models helper: ${String(err).slice(0, 160)}` };
  }
}

/**
 * True when the binary carries the usage descriptions TCC demands before it will
 * prompt for the microphone or speech recognition. A binary built by an older
 * build script has none, and the failure mode is not a denied request but a
 * SIGABRT the moment voice is used — so a plist-less bundled binary is worth
 * rebuilding from source even though it serves the judge path perfectly well.
 */
function hasVoiceUsageDescriptions(path: string): boolean {
  try {
    return readFileSync(path).includes('NSSpeechRecognitionUsageDescription');
  } catch {
    return false;
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
  const bundledUsable = isExecutable(bundled);
  if (bundledUsable && hasVoiceUsageDescriptions(bundled)) {
    helperPathCache = { available: true, path: bundled };
    return helperPathCache;
  }

  const source = sourcePath();
  if (!existsSync(source)) {
    helperPathCache = bundledUsable
      ? { available: true, path: bundled }
      : { available: false, reason: 'Foundation Models helper source not packaged' };
    return helperPathCache;
  }

  const cached = cachedHelperPath();
  if (isExecutable(cached) && hasVoiceUsageDescriptions(cached) && !sourceIsNewer(source, cached)) {
    helperPathCache = { available: true, path: cached };
    return helperPathCache;
  }

  const compiled = compileHelper(cached);
  // A bundled binary that predates the plist still runs the judge; keep it as
  // the degraded fallback rather than losing the helper entirely when this
  // machine has no Swift toolchain to rebuild with.
  helperPathCache = compiled.available || !bundledUsable
    ? compiled
    : { available: true, path: bundled };
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

/**
 * Transcribe a WAV with Apple's on-device speech recognizer through the same
 * bundled Swift helper the judge uses. This is the CLI daemon's *only* STT
 * path: whisper.cpp was retired because it demanded arm64 Homebrew, a
 * ~1.5 GB model download and a second server process (docs/voice-setup.md).
 * Same engine, same privacy posture (`requiresOnDeviceRecognition`) as the
 * Swift daemon's native path, with nothing for the user to install.
 */
export async function transcribeWithHelper(
  wavPath: string,
  locale?: string,
): Promise<string> {
  const response = await requestHelper(
    { type: 'transcribe', wav: wavPath, ...(locale ? { locale } : {}) },
    TRANSCRIBE_TIMEOUT_MS,
  );
  if (typeof response.error === 'string') {
    throw new Error(`${response.error}: ${String(response.reason ?? '')}`.trim());
  }
  const text = typeof response.text === 'string' ? response.text.trim() : '';
  return text;
}

/** Hard ceiling on one push-to-talk hold; matches the helper's own clamp. */
export const RECORD_MAX_MS = 30_000;

/**
 * Capture the host microphone into a 16 kHz mono PCM16 WAV. Resolves when the
 * capture ends — either `stopHelperRecording()` was called (PTT release) or
 * `maxMs` elapsed. This replaces the sox/iTerm2-grant capture that got the
 * original Stream Deck Voice dial pulled before the Marketplace submission:
 * the mic TCC grant now belongs to the daemon's own bundled helper.
 */
export async function recordWithHelper(
  outPath: string,
  opts: { maxMs?: number } = {},
): Promise<{ wav: string; durationMs: number; stopReason: string }> {
  const maxMs = Math.min(opts.maxMs ?? RECORD_MAX_MS, 120_000);
  let response: Record<string, unknown>;
  try {
    response = await requestHelper({ type: 'record', wav: outPath, maxMs }, maxMs + 15_000);
  } catch (err) {
    // Peer silence is the signal, not the end of it: the helper allows one
    // capture at a time, so a timed-out record leaves its slot armed and every
    // later press answers `busy`. Release it before surfacing the failure.
    await stopHelperRecording({ cancel: true }).catch(() => false);
    throw err;
  }
  if (response.cancelled === true) {
    throw new Error('record_cancelled');
  }
  if (typeof response.error === 'string') {
    throw new Error(`${response.error}: ${String(response.reason ?? '')}`.trim());
  }
  return {
    wav: typeof response.wav === 'string' ? response.wav : outPath,
    durationMs: typeof response.durationMs === 'number' ? response.durationMs : 0,
    stopReason: typeof response.stopReason === 'string' ? response.stopReason : 'stopped',
  };
}

/**
 * End (or abandon) the in-flight `recordWithHelper` capture. Returns false when
 * nothing was recording — a release that raced the max-duration stop.
 */
export async function stopHelperRecording(opts: { cancel?: boolean } = {}): Promise<boolean> {
  const response = await requestHelper(
    { type: opts.cancel ? 'record_cancel' : 'record_stop' },
    10_000,
  );
  return response.stopped === true;
}

/** Speak a reply through the host's audio output (AVSpeechSynthesizer). */
export async function speakWithHelper(
  text: string,
  opts: { locale?: string; voice?: string; rate?: number } = {},
): Promise<void> {
  const response = await requestHelper(
    { type: 'speak', text, ...opts },
    SPEAK_TIMEOUT_MS,
  );
  if (typeof response.error === 'string') {
    throw new Error(`${response.error}: ${String(response.reason ?? '')}`.trim());
  }
}

/**
 * Synthesize to a 16 kHz mono PCM16 WAV instead of the host speakers, for
 * streaming to a board that has its own amplifier. The host is the wrong
 * output when the user carried the device to another room — which is the whole
 * point of a battery-powered pager.
 */
export async function synthesizeWavWithHelper(
  text: string,
  outPath: string,
  opts: { locale?: string; voice?: string; rate?: number } = {},
): Promise<{ wav: string; sampleRate: number; durationMs: number }> {
  const response = await requestHelper(
    { type: 'synthesize', text, wav: outPath, ...opts },
    SPEAK_TIMEOUT_MS,
  );
  if (typeof response.error === 'string') {
    throw new Error(`${response.error}: ${String(response.reason ?? '')}`.trim());
  }
  return {
    wav: typeof response.wav === 'string' ? response.wav : outPath,
    sampleRate: typeof response.sampleRate === 'number' ? response.sampleRate : 16000,
    durationMs: typeof response.durationMs === 'number' ? response.durationMs : 0,
  };
}
