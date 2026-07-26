/**
 * TTS Engine — macOS `say` with Neural Korean voice.
 *
 * Uses macOS built-in Neural TTS (Yuna / Sandy / etc.) — pre-installed,
 * fast (~1s for a sentence), high quality Korean, no GPU competition.
 *
 * Supports sentence-level streaming: splits text into sentences,
 * speaks each sequentially for lower perceived latency.
 */

import { spawn, execSync, type ChildProcess } from './proc.js';
import { platform } from 'os';
import { debug } from './logger.js';

const TAG = 'TTS';

/** Preferred Korean voices in quality order */
const PREFERRED_KO_VOICES = ['Yuna', 'Sandy', 'Shelley', 'Reed', 'Flo', 'Eddy'];

function findMacOsKoreanVoice(): string | null {
  if (platform() !== 'darwin') return null;
  try {
    const voices = execSync('say -v "?"', { encoding: 'utf-8' });
    const koVoices = voices.split('\n').filter(l => l.includes('ko_KR'));
    if (koVoices.length === 0) return null;

    for (const name of PREFERRED_KO_VOICES) {
      if (koVoices.some(v => v.startsWith(name + ' ') || v.includes(`(${name})`))) {
        return name;
      }
    }
    const match = koVoices[0].match(/^(\S+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export class TtsEngine {
  private voice: string | null;
  private currentPlayback: ChildProcess | null = null;

  constructor() {
    this.voice = findMacOsKoreanVoice();
    if (this.voice) {
      debug(TAG, `macOS say voice: ${this.voice}`);
    } else {
      debug(TAG, 'No Korean TTS voice available');
    }
  }

  isAvailable(): boolean {
    return this.voice !== null;
  }

  /** Speak text directly (no temp file) */
  async speak(text: string): Promise<void> {
    if (!this.voice) throw new Error('No TTS voice available');
    return new Promise((resolve, reject) => {
      debug(TAG, `say -v ${this.voice}: "${text.slice(0, 60)}"`);
      const proc = spawn('say', ['-v', this.voice!, text], { stdio: 'ignore' });
      this.currentPlayback = proc;

      proc.on('error', (err) => {
        this.currentPlayback = null;
        reject(new Error(`say error: ${err.message}`));
      });

      proc.on('close', (code) => {
        this.currentPlayback = null;
        if (code !== 0) reject(new Error(`say exited with code ${code}`));
        else resolve();
      });
    });
  }

  /**
   * Streaming speak: split text into sentences, speak sequentially.
   * Each sentence starts as soon as the previous one finishes.
   */
  async speakStreaming(text: string): Promise<void> {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return;

    for (const sentence of sentences) {
      await this.speak(sentence);
    }
  }

  stopPlayback(): void {
    if (this.currentPlayback) {
      this.currentPlayback.kill('SIGTERM');
      this.currentPlayback = null;
    }
  }

  cleanup(): void {
    this.stopPlayback();
  }
}

/** Split text into sentences for streaming TTS */
function splitSentences(text: string): string[] {
  const raw = text.split(/(?<=[.!?。？！])\s+/);
  return raw.map(s => s.trim()).filter(s => s.length > 0);
}
