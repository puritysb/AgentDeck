import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync, statSync, readFileSync } from 'fs';
import { debug } from './logger.js';
import { transcribeWithHelper, probeFoundationModelsHelper } from './foundation-models-helper.js';
import { REC_CANDIDATES, SOX_CANDIDATES } from '@agentdeck/shared';

function findBinary(candidates: string[], fallback: string): string {
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return fallback;
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
  private recBin: string;
  private soxBin: string;

  constructor() {
    super();
    this.recBin = findBinary(REC_CANDIDATES, 'rec');
    this.soxBin = findBinary(SOX_CANDIDATES, 'sox');
    debug('Voice', `Binaries: rec=${this.recBin}, sox=${this.soxBin} (transcription: Apple Speech via bundled helper)`);
  }

  /** Probe the bundled Swift helper so an unavailable recognizer shows up in
   *  the log at startup rather than on the user's first utterance. There is
   *  nothing to connect to or tear down — the helper is a long-lived process
   *  owned by foundation-models-helper.ts. */
  async probeSpeechHelper(): Promise<void> {
    const status = await probeFoundationModelsHelper();
    if (!status.available) {
      debug('Voice', `Speech helper unavailable: ${status.reason ?? 'unknown'}`);
    }
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
      windowsHide: true,
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

    // Check audio RMS to detect silence — a recognizer handed silence returns
    // invented text rather than an error, so catch it before transcribing.
    const rms = computeRms(this.audioFile);
    debug('Voice', `Audio RMS: ${rms.toFixed(4)}`);
    if (rms < 0.001) {
      this.cleanup();
      throw new Error('No audio detected — check microphone permission');
    }

    // --- Transcription: Apple on-device Speech via the bundled helper ---
    try {
      const text = await this.transcribeViaHelper(this.audioFile);
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

    return await this.transcribeViaHelper(filePath);
  }

  /**
   * Transcribe with Apple's on-device recognizer via the bundled Swift helper
   * (the same binary the APME judge uses for Foundation Models). whisper.cpp
   * was retired here: it required arm64 Homebrew, `brew install whisper-cpp`,
   * a ~1.5 GB model download and a second long-lived server process, which is
   * exactly the install surface docs/voice-setup.md removed from the Apple
   * side. Both daemons now transcribe with the same engine and nothing to
   * install.
   */
  private async transcribeViaHelper(audioFile: string): Promise<string> {
    const text = await transcribeWithHelper(audioFile);
    debug('Voice', `Helper transcription: "${text.slice(0, 80)}"`);
    return text;
  }


  private cleanup(): void {
    if (this.audioFile && existsSync(this.audioFile)) {
      try { unlinkSync(this.audioFile); } catch { /* */ }
    }
    this.audioFile = '';
  }
}
