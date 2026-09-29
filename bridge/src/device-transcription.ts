import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { transcribeWithHelper } from './foundation-models-helper.js';

export interface VoiceTranscriptionSettings {
  locale?: string;
  transcriber?: 'apple' | 'whisper-cpp';
  whisperCli?: string;
  whisperModel?: string;
  /** Explicit opt-in to an operator-managed, loopback-only warm model server. */
  whisperServerUrl?: string;
  /** Optional local speech-presence gate. Both paths are required together. */
  whisperVadCli?: string;
  whisperVadModel?: string;
}
const run = promisify(execFile);

/** Parse the VAD tool's result, never treating a failed/changed probe as silence. */
export function vadHasSpeech(output: string): boolean {
  const match = output.match(/^Detected (\d+) speech segments:$/m);
  if (!match) throw new Error('invalid_vad_response');
  const count = Number(match[1]);
  const segments = [...output.matchAll(/^Speech segment (\d+): start = ([\d.]+), end = ([\d.]+)$/gm)];
  if (!Number.isSafeInteger(count) || count !== segments.length || segments.some((s, i) =>
    Number(s[1]) !== i || !Number.isFinite(Number(s[2])) || !Number.isFinite(Number(s[3]))
      || Number(s[3]) <= Number(s[2]))) throw new Error('invalid_vad_response');
  return count > 0;
}

/** Explicit local backend selection: no network ASR or implicit model download. */
export async function transcribeDeviceAudio(wav: string, settings?: VoiceTranscriptionSettings): Promise<string> {
  if (!settings?.transcriber || settings.transcriber === 'apple') {
    return transcribeWithHelper(wav, settings?.locale);
  }
  if (settings.transcriber !== 'whisper-cpp') throw new Error('unknown_voice_transcriber');
  if (!settings.whisperCli || !isAbsolute(settings.whisperCli)
    || !settings.whisperModel || !isAbsolute(settings.whisperModel)) {
    throw new Error('whisper_paths_required');
  }
  const language = settings.locale?.split(/[-_]/)[0].toLowerCase() || 'auto';
  if (!/^(?:[a-z]{2,3}|auto)$/.test(language)) throw new Error('invalid_voice_locale');
  if (settings.whisperVadCli || settings.whisperVadModel) {
    if (!settings.whisperVadCli || !isAbsolute(settings.whisperVadCli)
      || !settings.whisperVadModel || !isAbsolute(settings.whisperVadModel)) {
      throw new Error('vad_paths_required');
    }
    // Presence only: recognizers still receive the full original WAV. Do not
    // trim consonants or feed a VAD-spliced waveform to the decoder.
    const { stdout } = await run(settings.whisperVadCli, [
      '-vm', settings.whisperVadModel, '-f', wav, '-np',
    ], { timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8',
      // VAD uses CPU by default. Avoid unrelated Metal library compilation on
      // every probe (which can stall behind a resident GPU model on macOS).
      env: process.platform === 'darwin' ? { ...process.env, GGML_METAL_DEVICES: '' } : process.env,
    });
    if (!vadHasSpeech(stdout)) throw new Error('No speech detected');
  }
  if (settings.whisperServerUrl) {
    const endpoint = new URL(settings.whisperServerUrl);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/inference') throw new Error('invalid_whisper_server_url');
    try {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(await readFile(wav))], { type: 'audio/wav' }), 'capture.wav');
      form.set('language', language);
      form.set('response_format', 'json');
      // No redirects: captured speech must never leave the configured loopback.
      // Bound a dead/stalled warm worker before falling back to the existing CLI.
      const response = await fetch(endpoint, {
        method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error('whisper_server_failed');
      const result = await response.json() as { text?: unknown };
      if (typeof result.text !== 'string') throw new Error('invalid_whisper_server_response');
      const text = result.text.trim();
      if (!text) throw new Error('No speech detected');
      return text;
    } catch (error) {
      if (error instanceof Error && error.message === 'No speech detected') throw error;
      // A warm worker is an optimization, never a requirement for dictation.
    }
  }
  const { stdout } = await run(settings.whisperCli, [
    '-m', settings.whisperModel, '-f', wav, '-l', language, '-nt', '-np',
  ], { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' });
  const text = stdout.trim();
  if (!text) throw new Error('No speech detected');
  return text;
}
