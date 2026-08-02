/**
 * Voice Assistant Manager — orchestrates the wake word → STT → LLM → TTS pipeline.
 *
 * Pipeline:
 * 1. WakeWordListener detects "오픈클로"
 * 2. Record user speech via sox/rec (reusing VoiceManager's approach)
 * 3. VAD: stop recording on silence
 * 4. Transcribe via whisper-server
 * 5. Route to OpenClaw Gateway (or Claude Code) via adapter
 * 6. Receive response text
 * 7. Synthesize + play via macOS say
 *
 * States: idle → listening → processing → speaking → idle
 */

import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, statSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WakeWordListener } from './wake-word.js';
import { TtsEngine } from './tts.js';
import { log, debug } from './logger.js';
import { REC_CANDIDATES } from '@agentdeck/shared';
import type { VoiceAssistantState } from '@agentdeck/shared';

const TAG = 'VoiceAssist';

/** Minimum RMS energy to consider non-silent audio */
const SILENCE_RMS_THRESHOLD = 0.001;

/** Max recording duration (seconds) before auto-stop */
const MAX_RECORDING_SECONDS = 15;

/** Silence duration to trigger recording stop (ms) */
const VAD_SILENCE_MS = 1500;

/** Interval to check audio file for VAD (ms) */
const VAD_CHECK_INTERVAL_MS = 300;

function findBinary(candidates: string[], fallback: string): string {
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return fallback;
}

/** Compute RMS energy of a 16-bit PCM WAV file (skip 44-byte header) */
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

/** Compute RMS of the last N seconds of a WAV file */
function computeTrailingRms(wavFile: string, seconds: number): number {
  const buf = readFileSync(wavFile);
  const headerSize = 44;
  if (buf.length <= headerSize + 2) return 0;

  const bytesPerSample = 2;
  const sampleRate = 16000;
  const trailBytes = Math.min(
    seconds * sampleRate * bytesPerSample,
    buf.length - headerSize,
  );
  const startOffset = buf.length - trailBytes;

  let sumSq = 0;
  const sampleCount = trailBytes / bytesPerSample;
  for (let i = startOffset; i + 1 < buf.length; i += bytesPerSample) {
    const sample = buf.readInt16LE(i) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / sampleCount);
}

export interface VoiceAssistantOptions {
  /** Callback to send a prompt to the active agent */
  sendPrompt: (text: string) => void;
  /** Callback to transcribe a WAV file via whisper-server */
  transcribeFile: (filePath: string) => Promise<string>;
  /** Function that returns true if push-to-talk is recording (mutex) */
  isPttRecording?: () => boolean;
}

export class VoiceAssistantManager extends EventEmitter {
  private state: VoiceAssistantState = 'disabled';
  private wakeWord: WakeWordListener;
  private tts: TtsEngine;
  private opts: VoiceAssistantOptions;
  private recBin: string;

  // Recording state
  private audioProcess: ChildProcess | null = null;
  private audioFile = '';
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpeechTime = 0;

  // Response timeout (activity-aware)
  private responseTimeout: ReturnType<typeof setTimeout> | null = null;

  // Response accumulation
  private pendingResponse = '';

  constructor(opts: VoiceAssistantOptions) {
    super();
    this.opts = opts;
    this.wakeWord = new WakeWordListener();
    this.tts = new TtsEngine();
    this.recBin = findBinary(REC_CANDIDATES, 'rec');

    // Wire wake word detection
    this.wakeWord.on('detected', (info: { deviceId: string; timestamp: number }) => {
      debug(TAG, `Wake word detected from ${info.deviceId}`);
      this.onWakeWordDetected(info);
    });
  }

  /** Start the voice assistant (begins wake word listening) */
  async start(): Promise<boolean> {
    if (this.state !== 'disabled') {
      debug(TAG, `Already in state: ${this.state}`);
      return true;
    }

    // Check availability
    if (!this.wakeWord.isAvailable()) {
      debug(TAG, 'Wake word listener not available');
      return false;
    }

    if (!this.tts.isAvailable()) {
      debug(TAG, 'TTS engine not available (will work without TTS)');
    }

    const started = await this.wakeWord.start();
    if (!started) {
      debug(TAG, 'Failed to start wake word listener');
      return false;
    }

    this.setState('idle');
    debug(TAG, 'Voice assistant started — listening for wake word');
    return true;
  }

  /** Stop the voice assistant completely */
  stop(): void {
    this.wakeWord.stop();
    this.tts.cleanup();
    this.cancelRecording();
    this.setState('disabled');
    debug(TAG, 'Voice assistant stopped');
  }

  getState(): VoiceAssistantState {
    return this.state;
  }

  /**
   * Reset the response timeout. Call this on state changes / tool activity
   * while voice assistant is in 'processing' state so long-running LLM
   * tasks don't prematurely time out.
   */
  resetResponseTimeout(): void {
    if (this.responseTimeout) clearTimeout(this.responseTimeout);
    if (this.state !== 'processing') return;
    this.responseTimeout = setTimeout(() => {
      this.responseTimeout = null;
      if (this.state === 'processing') {
        debug(TAG, 'Response timeout (60s), returning to idle');
        this.setState('idle');
        this.wakeWord.resume();
      }
    }, 60_000);
  }

  /** Feed LLM response text for TTS playback */
  async handleResponse(text: string): Promise<void> {
    log(`handleResponse called (state=${this.state}, text=${text.length} chars): "${text.slice(0, 80)}..."`);
    if (this.state !== 'processing') {
      debug(TAG, `Ignoring response in state ${this.state}`);
      return;
    }

    // Clear response timeout
    if (this.responseTimeout) { clearTimeout(this.responseTimeout); this.responseTimeout = null; }

    this.pendingResponse = text;
    this.setState('speaking');

    // Broadcast response text
    this.emit('state_change', {
      state: 'speaking' as VoiceAssistantState,
      responseText: text,
    });

    try {
      if (this.tts.isAvailable()) {
        await this.tts.speakStreaming(text);
      } else {
        debug(TAG, 'TTS not available, skipping playback');
      }
    } catch (err) {
      debug(TAG, `TTS playback error: ${err}`);
    }

    // Return to listening
    this.pendingResponse = '';
    this.setState('idle');
    this.wakeWord.resume();
  }

  // ===== Private =====

  private setState(state: VoiceAssistantState): void {
    if (this.state === state) return;
    const prev = this.state;
    this.state = state;
    log(`${prev} → ${state}`);
    debug(TAG, `State: ${prev} → ${state}`);
    this.emit('state_change', { state });
  }

  private onWakeWordDetected(info: { deviceId: string; timestamp: number }): void {
    // Mutex: skip if push-to-talk is active
    if (this.opts.isPttRecording?.()) {
      debug(TAG, 'Skipping wake word — push-to-talk active');
      return;
    }

    // Only respond from idle state
    if (this.state !== 'idle') {
      debug(TAG, `Ignoring wake word in state ${this.state}`);
      return;
    }

    log('Wake word detected!');
    this.emit('wake_word_detected', info);

    // Pause wake word detection to avoid self-triggering
    this.wakeWord.pause();

    // CoreAudio device release delay — PvRecorder.stop() releases the audio
    // device asynchronously. Starting rec immediately can cause device contention
    // resulting in corrupted/empty audio capture.
    setTimeout(() => this.startRecording(), 300);
  }

  private startRecording(): void {
    this.setState('listening');
    this.audioFile = join(tmpdir(), `agentdeck-va-${Date.now()}.wav`);
    this.lastSpeechTime = Date.now();

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
      if (line && !line.startsWith('In:') && !line.startsWith('Out:')) {
        debug(TAG, `rec: ${line}`);
      }
    });

    this.audioProcess.on('error', (err) => {
      debug(TAG, `rec spawn error: ${err.message}`);
      this.cancelRecording();
      this.setState('idle');
      this.wakeWord.resume();
    });

    this.audioProcess.on('exit', () => {
      this.audioProcess = null;
    });

    // VAD: check trailing RMS periodically
    this.vadTimer = setInterval(() => {
      this.checkVad();
    }, VAD_CHECK_INTERVAL_MS);

    // Max recording timeout
    this.maxRecordingTimer = setTimeout(() => {
      debug(TAG, 'Max recording duration reached');
      this.finishRecording();
    }, MAX_RECORDING_SECONDS * 1000);

    debug(TAG, `Recording started → ${this.audioFile}`);
  }

  private checkVad(): void {
    if (!this.audioFile || !existsSync(this.audioFile)) return;

    try {
      const stat = statSync(this.audioFile);
      // Need at least 1 second of audio before VAD
      if (stat.size < 16000 * 2 + 44) return;

      const trailingRms = computeTrailingRms(this.audioFile, 1.0);
      if (trailingRms > SILENCE_RMS_THRESHOLD) {
        this.lastSpeechTime = Date.now();
      } else if (Date.now() - this.lastSpeechTime > VAD_SILENCE_MS) {
        debug(TAG, `VAD silence detected (${VAD_SILENCE_MS}ms)`);
        this.finishRecording();
      }
    } catch {
      // File might be busy, skip this check
    }
  }

  private async finishRecording(): Promise<void> {
    this.clearTimers();

    if (!this.audioProcess) {
      this.setState('idle');
      this.wakeWord.resume();
      return;
    }

    // Stop recording
    const proc = this.audioProcess;
    proc.kill('SIGINT');
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.on('exit', finish);
      setTimeout(finish, 3000);
    });

    // Verify audio file
    if (!existsSync(this.audioFile)) {
      debug(TAG, 'Recording file not created');
      this.setState('idle');
      this.wakeWord.resume();
      return;
    }

    const size = statSync(this.audioFile).size;
    if (size < 100) {
      debug(TAG, 'Recording too short');
      this.cleanupAudio();
      this.setState('idle');
      this.wakeWord.resume();
      return;
    }

    // Check RMS
    const rms = computeRms(this.audioFile);
    debug(TAG, `Audio RMS: ${rms.toFixed(4)}, size: ${size} bytes`);
    if (rms < SILENCE_RMS_THRESHOLD) {
      debug(TAG, 'No speech detected (silence)');
      this.cleanupAudio();
      this.setState('idle');
      this.wakeWord.resume();
      return;
    }

    // Transcribe
    this.setState('processing');
    try {
      let text = await this.opts.transcribeFile(this.audioFile);
      log(`Transcription result: "${text}" (${text?.length ?? 0} chars)`);

      // Retry once on empty transcription — device contention may have
      // corrupted the first ~200ms of audio. Re-record a short clip.
      if ((!text || text.length < 2) && rms > SILENCE_RMS_THRESHOLD * 3) {
        log('Empty transcription with strong RMS — retrying recording');
        this.cleanupAudio();
        await this.retryRecording();
        if (this.audioFile && existsSync(this.audioFile)) {
          text = await this.opts.transcribeFile(this.audioFile);
          log(`Retry transcription: "${text}" (${text?.length ?? 0} chars)`);
        }
      }

      this.cleanupAudio();

      if (!text || text.length < 2) {
        log('Empty transcription, returning to idle');
        this.setState('idle');
        this.wakeWord.resume();
        return;
      }

      // Broadcast transcribed text
      this.emit('state_change', {
        state: 'processing' as VoiceAssistantState,
        text,
      });

      // Send to agent
      log(`Sending prompt to agent: "${text}"`);
      this.opts.sendPrompt(text);

      // Activity-aware timeout: 60s initial, reset on each activity
      this.resetResponseTimeout();

    } catch (err) {
      log(`Transcription error: ${err}`);
      this.cleanupAudio();
      this.setState('idle');
      this.wakeWord.resume();
    }
  }

  /** Re-record a short clip for retry (device should be fully available now) */
  private async retryRecording(): Promise<void> {
    this.audioFile = join(tmpdir(), `agentdeck-va-retry-${Date.now()}.wav`);
    const retryDuration = 5; // seconds

    return new Promise<void>((resolve) => {
      const proc = spawn(this.recBin, [
        '-r', '16000', '-c', '1', '-b', '16',
        this.audioFile,
        'trim', '0', String(retryDuration),
      ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });

      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      // Safety timeout
      setTimeout(() => { proc.kill('SIGINT'); }, (retryDuration + 1) * 1000);
    });
  }

  private cancelRecording(): void {
    this.clearTimers();
    if (this.audioProcess) {
      this.audioProcess.kill('SIGKILL');
      this.audioProcess = null;
    }
    this.cleanupAudio();
  }

  private clearTimers(): void {
    if (this.vadTimer) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    if (this.maxRecordingTimer) {
      clearTimeout(this.maxRecordingTimer);
      this.maxRecordingTimer = null;
    }
  }

  private cleanupAudio(): void {
    if (this.audioFile && existsSync(this.audioFile)) {
      try { unlinkSync(this.audioFile); } catch { /* ok */ }
    }
    this.audioFile = '';
  }
}
