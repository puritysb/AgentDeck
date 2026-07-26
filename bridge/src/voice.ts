import { EventEmitter } from 'events';
import { spawn, execSync, type ChildProcess } from './proc.js';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync, statSync, readFileSync } from 'fs';
import { debug } from './logger.js';
import { ensureWhisperServer, releaseWhisperServer } from './whisper-server-manager.js';
import {
  MODEL_SEARCH_DIRS, MODELS_WITH_METAL, MODELS_WITHOUT_METAL,
  WHISPER_CANDIDATES, REC_CANDIDATES, SOX_CANDIDATES, WHISPER_SERVER_CANDIDATES,
} from '@agentdeck/shared';

// Dynamic timeout: base + multiplier × audio duration
// Metal GPU: fast inference; Rosetta/CPU: ~3-4x slower
const TIMEOUT_BASE_MS = 15_000;
const TIMEOUT_MULTIPLIER_METAL = 1;    // 15s + 1× audio duration
const TIMEOUT_MULTIPLIER_ROSETTA = 4;  // 15s + 4× audio duration

function findBinary(candidates: string[], fallback: string): string {
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return fallback;
}

/** Check if a whisper-cli binary has Metal GPU support (native arm64 + libggml-metal). */
function detectMetal(whisperPath: string): boolean {
  // Skip if whisper-cli doesn't exist (just a fallback name, not installed)
  if (!existsSync(whisperPath)) {
    debug('Voice', `whisper-cli not found, skipping Metal detection`);
    return false;
  }
  try {
    const otoolOut = execSync(`otool -L "${whisperPath}"`, { encoding: 'utf8' });
    const hasMetal = otoolOut.includes('libggml-metal');
    const fileOut = execSync(`file "${whisperPath}"`, { encoding: 'utf8' });
    const isArm64 = fileOut.includes('arm64');
    debug('Voice', `whisper-cli: arm64=${isArm64}, metal=${hasMetal} (${whisperPath})`);
    return hasMetal && isArm64;
  } catch {
    debug('Voice', `Could not detect capabilities: ${whisperPath}`);
    return false;
  }
}

function findWhisperModel(preference: string[]): string {
  for (const model of preference) {
    for (const dir of MODEL_SEARCH_DIRS) {
      const path = join(dir, model);
      if (existsSync(path)) {
        debug('Voice', `Selected whisper model: ${path}`);
        return path;
      }
    }
  }
  debug('Voice', `No whisper model found in: ${MODEL_SEARCH_DIRS.join(', ')}`);
  return join(MODEL_SEARCH_DIRS[0], preference[0]);
}

function findFallbackModel(currentModel: string): string | null {
  const all = [...MODELS_WITH_METAL];
  const currentName = currentModel.split('/').pop() ?? '';
  const idx = all.indexOf(currentName);
  // Find a smaller model than current
  for (let i = idx + 1; i < all.length; i++) {
    for (const dir of MODEL_SEARCH_DIRS) {
      const path = join(dir, all[i]);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** Compute RMS energy of a 16-bit PCM WAV file (skip 44-byte header). */
function computeRms(wavFile: string): number {
  const buf = readFileSync(wavFile);
  const headerSize = 44;
  if (buf.length <= headerSize + 2) return 0;
  const samples = (buf.length - headerSize) / 2;
  let sumSq = 0;
  for (let i = headerSize; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

export class VoiceManager extends EventEmitter {
  private recording = false;
  private audioProcess: ChildProcess | null = null;
  private audioFile = '';
  private whisperBin: string;
  private whisperModel: string;
  private recBin: string;
  private soxBin: string;
  private hasMetal: boolean;
  private whisperServerBin: string;
  private serverPort: number | null = null;
  private useServer = false;

  constructor() {
    super();
    this.whisperBin = findBinary(WHISPER_CANDIDATES, 'whisper-cli');
    this.recBin = findBinary(REC_CANDIDATES, 'rec');
    this.soxBin = findBinary(SOX_CANDIDATES, 'sox');
    this.whisperServerBin = findBinary(WHISPER_SERVER_CANDIDATES, 'whisper-server');
    this.hasMetal = detectMetal(this.whisperBin);
    const preference = this.hasMetal ? MODELS_WITH_METAL : MODELS_WITHOUT_METAL;
    this.whisperModel = findWhisperModel(preference);
    if (!this.hasMetal) {
      debug('Voice', 'WARNING: whisper-cli has no Metal GPU support (x86/Rosetta). Using smaller model for speed. Install arm64 Homebrew for best quality.');
    }
    debug('Voice', `Binaries: whisper=${this.whisperBin}, rec=${this.recBin}, sox=${this.soxBin}, server=${this.whisperServerBin}`);
  }

  async connectToServer(): Promise<void> {
    const port = await ensureWhisperServer(this.whisperServerBin, this.whisperModel);
    if (port) {
      this.serverPort = port;
      this.useServer = true;
    }
  }

  disconnectFromServer(): void {
    this.useServer = false;
    this.serverPort = null;
    releaseWhisperServer();
  }

  startRecording(): void {
    if (this.recording) return;

    this.audioFile = join(tmpdir(), `agentdeck-voice-${Date.now()}.wav`);
    this.recording = true;

    // rec (sox) — record raw WAV. We request 16kHz mono 16-bit.
    // macOS coreaudio may record at native rate (24/48kHz); resample step normalizes.
    // No sox effects during recording — they can interfere with real-time capture.
    this.audioProcess = spawn(this.recBin, [
      '-r', '16000',
      '-c', '1',
      '-b', '16',
      this.audioFile,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    this.audioProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      // Only log non-progress lines
      if (line && !line.startsWith('In:') && !line.startsWith('Out:')) {
        debug('Voice', `rec: ${line}`);
      }
    });

    this.audioProcess.on('error', (err) => {
      debug('Voice', `rec spawn error: ${err.message}`);
      this.recording = false;
      this.audioProcess = null;
      this.emit('error', new Error(`Failed to start recording: ${err.message}`));
    });

    this.audioProcess.on('exit', (code) => {
      debug('Voice', `rec exited with code ${code}`);
      this.audioProcess = null;
    });

    this.emit('recording_start');
    debug('Voice', `Recording started → ${this.audioFile}`);
  }

  async stopRecording(): Promise<string> {
    if (!this.recording || !this.audioProcess) {
      throw new Error('Not currently recording');
    }

    const proc = this.audioProcess;
    this.recording = false;
    this.emit('recording_stop');

    proc.kill('SIGINT');
    debug('Voice', 'Sent SIGINT to rec');

    // Wait for exit (up to 3s)
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.on('exit', finish);
      setTimeout(finish, 3000);
    });

    // Verify file
    if (!existsSync(this.audioFile)) {
      const path = this.audioFile;
      this.cleanup();
      throw new Error(`Recording file not created: ${path}`);
    }
    const sz = statSync(this.audioFile).size;
    debug('Voice', `Recording file: ${sz} bytes`);
    if (sz < 100) {
      this.cleanup();
      throw new Error('Recording too short or empty');
    }

    // Check audio RMS to detect silence (whisper hallucinates on silent audio)
    const rms = computeRms(this.audioFile);
    debug('Voice', `Audio RMS: ${rms.toFixed(4)}`);
    if (rms < 0.001) {
      this.cleanup();
      throw new Error('No audio detected — check microphone permission');
    }

    // --- Transcription: prefer whisper-server, fallback to whisper-cli ---
    try {
      let text: string;

      if (this.useServer && this.serverPort) {
        // Server mode: skip resample, whisper-server handles format conversion (--convert)
        debug('Voice', 'Server mode: skipping sox resample');
        try {
          text = await this.transcribeViaServer(this.audioFile);
        } catch (serverErr) {
          debug('Voice', `Server transcription failed, falling back to whisper-cli: ${serverErr}`);
          this.useServer = false;
          text = await this.transcribeWithCli(this.audioFile);
        }
      } else {
        text = await this.transcribeWithCli(this.audioFile);
      }

      debug('Voice', `Transcription result: "${text.slice(0, 80)}"`);
      this.emit('transcription', text);
      this.cleanup();
      return text;
    } catch (err) {
      this.cleanup();
      const error = err instanceof Error ? err : new Error(String(err));
      debug('Voice', `Transcription error: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }

  cancel(): void {
    if (this.audioProcess) {
      this.audioProcess.kill('SIGKILL');
      this.audioProcess = null;
    }
    this.recording = false;
    this.cleanup();
    this.emit('recording_stop');
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** Transcribe a WAV file (used by /voice/transcribe endpoint) */
  async transcribeFile(filePath: string): Promise<string> {
    // Check audio RMS to detect silence
    const rms = computeRms(filePath);
    debug('Voice', `transcribeFile RMS: ${rms.toFixed(4)}`);
    if (rms < 0.001) {
      throw new Error('No audio detected — silent recording');
    }

    if (this.useServer && this.serverPort) {
      try {
        return await this.transcribeViaServer(filePath);
      } catch (serverErr) {
        debug('Voice', `Server transcription failed, falling back to whisper-cli: ${serverErr}`);
        this.useServer = false;
        return await this.transcribeWithCli(filePath);
      }
    }
    return await this.transcribeWithCli(filePath);
  }

  private async transcribeViaServer(audioFile: string): Promise<string> {
    const fileData = readFileSync(audioFile);
    const boundary = `----whisper${Date.now()}`;
    const filename = audioFile.split('/').pop() || 'audio.wav';

    // Build multipart form-data manually (no external deps)
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const url = `http://127.0.0.1:${this.serverPort}/inference`;
    debug('Voice', `POST ${url} (${fileData.length} bytes audio)`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`whisper-server returned ${res.status}: ${await res.text()}`);
    }

    const json = await res.json() as { text?: string };
    const text = (json.text ?? '').trim();
    debug('Voice', `whisper-server response: "${text.slice(0, 80)}"`);
    return text;
  }

  private async transcribeWithCli(audioFile: string): Promise<string> {
    // Resample to 16kHz/16-bit mono WAV (macOS coreaudio may record at 48kHz/32-bit)
    const resampledFile = audioFile.replace('.wav', '_16k.wav');
    debug('Voice', `Resampling ${audioFile} → ${resampledFile}`);
    try {
      await this.resample(audioFile, resampledFile);
    } catch (err) {
      debug('Voice', `Resample failed, using original: ${err}`);
    }
    const whisperInput = existsSync(resampledFile) ? resampledFile : audioFile;
    debug('Voice', `Whisper input: ${whisperInput}`);

    // Calculate dynamic timeout based on audio duration and Metal support
    const audioDurationSec = (statSync(whisperInput).size - 44) / 32000;  // 16kHz × 16-bit
    const multiplier = this.hasMetal ? TIMEOUT_MULTIPLIER_METAL : TIMEOUT_MULTIPLIER_ROSETTA;
    const timeoutMs = TIMEOUT_BASE_MS + Math.ceil(audioDurationSec * 1000 * multiplier);
    debug('Voice', `Starting whisper-cli transcription (${audioDurationSec.toFixed(1)}s audio, timeout ${(timeoutMs / 1000).toFixed(0)}s, metal=${this.hasMetal})...`);

    try {
      let text: string;
      try {
        text = await this.transcribe(whisperInput, this.whisperModel, timeoutMs);
      } catch (err) {
        const isTimeout = err instanceof Error && err.message.includes('timed out');
        const fallback = isTimeout ? findFallbackModel(this.whisperModel) : null;
        if (fallback) {
          debug('Voice', `Timeout with current model, retrying with fallback: ${fallback}`);
          this.whisperModel = fallback;  // persist for future calls
          text = await this.transcribe(whisperInput, fallback, timeoutMs);
        } else {
          throw err;
        }
      }
      if (existsSync(resampledFile)) try { unlinkSync(resampledFile); } catch { /* */ }
      return text;
    } catch (err) {
      if (existsSync(resampledFile)) try { unlinkSync(resampledFile); } catch { /* */ }
      throw err;
    }
  }

  private resample(inputFile: string, outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Resample to 16kHz/16-bit mono + gentle highpass (80Hz removes rumble, preserves voice)
      // + normalize volume for consistent whisper input
      const sox = spawn(this.soxBin, [
        inputFile,
        '-r', '16000',
        '-c', '1',
        '-b', '16',
        outputFile,
        'highpass', '80',
        'norm',
      ]);

      let stderr = '';
      sox.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      sox.on('error', (err) => reject(new Error(`sox spawn error: ${err.message}`)));
      sox.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`sox exited with code ${code}: ${stderr.slice(-200)}`));
        } else {
          debug('Voice', `Resampled OK (${statSync(outputFile).size} bytes)`);
          resolve();
        }
      });
    });
  }

  private transcribe(audioFile: string, modelPath: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-m', modelPath,
        '-l', 'auto',              // auto-detect language (supports Korean, English, etc.)
        '-f', audioFile,
        '--no-timestamps',
        '-np',                     // suppress whisper's own progress output
        '--prompt', 'coding, programming, Claude, terminal, git, function, component, API',
      ];
      debug('Voice', `${this.whisperBin} ${args.join(' ')}`);

      const whisper = spawn(this.whisperBin, args);

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Timeout guard (dynamic based on audio length + Metal support)
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          debug('Voice', `whisper-cli timed out after ${(timeoutMs / 1000).toFixed(0)}s, killing`);
          whisper.kill('SIGKILL');
          reject(new Error(`whisper-cli timed out after ${(timeoutMs / 1000).toFixed(0)}s`));
        }
      }, timeoutMs);

      whisper.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      whisper.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      whisper.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          debug('Voice', `whisper-cli spawn error: ${err.message}`);
          reject(new Error(`Failed to run whisper-cli: ${err.message}`));
        }
      });

      whisper.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        debug('Voice', `whisper-cli exited with code ${code}`);
        if (stderr.length > 0) {
          debug('Voice', `whisper stderr (last 200): ${stderr.slice(-200)}`);
        }

        if (code !== 0) {
          reject(new Error(`whisper-cli exited with code ${code}: ${stderr.slice(-300)}`));
          return;
        }

        const text = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) =>
            line.length > 0 &&
            !line.startsWith('[') &&          // skip timestamp lines
            line !== '(blank audio)' &&       // skip blank audio markers
            !line.startsWith('(') &&          // skip other whisper annotations
            !/^\[BLANK_AUDIO\]$/i.test(line)  // skip blank audio tags
          )
          .join(' ')
          .trim();

        debug('Voice', `whisper stdout raw (${stdout.length} chars): "${stdout.slice(0, 100)}"`);
        resolve(text);
      });
    });
  }

  private cleanup(): void {
    if (this.audioFile && existsSync(this.audioFile)) {
      try { unlinkSync(this.audioFile); } catch { /* */ }
    }
    this.audioFile = '';
  }
}
