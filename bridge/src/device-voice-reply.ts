/**
 * Spoken replies back to the board that asked the question.
 *
 * The mic half of the voice round trip (device → daemon → session) ends with
 * text arriving in a terminal. This is the other half: when the session that
 * was dictated to finishes its turn, the reply is synthesized on the host and
 * streamed to that board's own amplifier. The host's speakers are the wrong
 * output here by construction — the reason to hold a battery-powered board is
 * that you walked away from the desk.
 *
 * Shape of the exchange (WS only; the serial transport has no binary framing):
 *   daemon → board   {"type":"audio_play_begin","sampleRate":16000,"text":"…"}
 *   daemon → board   binary frames of PCM16LE
 *   daemon → board   {"type":"audio_play_end"}
 *
 * The board cannot buffer a whole reply, so frames are paced at roughly
 * playback speed. Sending as fast as the socket allows would overrun a ring
 * buffer measured in seconds and cost the tail of every long answer.
 */

import { rawSessionId } from '@agentdeck/shared';

// What to read aloud is a two-daemon rule, so it lives in shared/ with the
// Swift mirror pinned to the same parity cases. Re-exported here because every
// existing caller reaches for it through this module.
export {
  MAX_SPOKEN_CHARS, SPOKEN_DIGEST_MAX_CHARS, speakableReply, spokenDigest,
} from '@agentdeck/shared';

export interface ReplySink {
  /** Send a JSON control frame. */
  send(data: string): void;
  /** Send one binary PCM frame. */
  sendBinary(data: Buffer): void;
  /** False once the socket is gone — streaming stops rather than piling up. */
  isOpen(): boolean;
  /** Capability strings the board advertised in device_info. */
  capabilities(): string[];
  /** Short transport label for logs, e.g. `serial:/dev/cu.usbmodem…` or `ws`. */
  describe(): string;
  /**
   * Stable identity of the physical board behind this transport — NOT of the
   * socket. A board is routinely reachable over both USB serial and WiFi, and
   * it drops the WebSocket when serial becomes primary, so the transport a
   * dictation arrived on may be gone by the time the reply exists. The reply
   * follows the board.
   */
  deviceKey(): string;
}

export interface ArmedReply {
  sessionId: string;
  armedAt: number;
}

/** PCM16 mono frame size. 1 KB = 32 ms at 16 kHz — small enough that a dropped
 *  frame is inaudible, large enough that framing overhead stays negligible. */
export const PCM_FRAME_BYTES = 1024;


/**
 * How long an arming survives *without the session making progress*. Measured
 * from the last sign of work, not from the dictation: a question that kicks off
 * half an hour of tool calls still deserves its answer read out, while a session
 * that went quiet has moved on and speaking then is worse than silence.
 */
export const REPLY_ARM_TTL_MS = 10 * 60 * 1000;

/**
 * Extract PCM samples from a canonical RIFF/WAVE file by walking the chunk
 * list. Fixed-offset slicing at byte 44 is wrong for any file carrying a LIST
 * or fact chunk, and would emit metadata as audio.
 */
export function pcmFromWav(wav: Buffer): { pcm: Buffer; sampleRate: number } | null {
  if (wav.length < 44) return null;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let sampleRate = 0;
  let pcm: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= wav.length) {
      sampleRate = wav.readUInt32LE(body + 4);
    } else if (id === 'data') {
      const end = Math.min(body + size, wav.length);
      pcm = wav.subarray(body, end);
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!pcm || pcm.length === 0 || sampleRate === 0) return null;
  return { pcm, sampleRate };
}

/** Split PCM into fixed-size frames; the last one may be short. */
export function pcmFrames(pcm: Buffer, frameBytes = PCM_FRAME_BYTES): Buffer[] {
  const frames: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += frameBytes) {
    frames.push(pcm.subarray(i, Math.min(i + frameBytes, pcm.length)));
  }
  return frames;
}

/**
 * Tracks which board is waiting to hear the answer to which session, and
 * streams the audio when it arrives.
 */
export class DeviceVoiceReplyRouter {
  private armed = new Map<ReplySink, ArmedReply>();
  private streaming = new Set<ReplySink>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((r) => setTimeout(r, ms)),
    /** Current live transport for a board, when its original one has gone. */
    private readonly resolveLive: (deviceKey: string) => ReplySink | null = () => null,
  ) {}

  /**
   * Remember that this board dictated into this session and should hear the
   * reply. Only boards advertising an amplifier are armed — streaming audio at
   * a board that cannot play it wastes the link and, worse, makes the feature
   * look broken on the boards that can.
   */
  arm(sink: ReplySink, sessionId: string): boolean {
    if (!sessionId) return false;
    // Either delivery mechanism counts: `audio_out` boards take the WS push
    // stream, `audio_http_pull` boards fetch the staged reply themselves
    // (the hosted-link boards whose RX path a push stream can crash).
    const caps = sink.capabilities();
    if (!caps.includes('audio_out') && !caps.includes('audio_http_pull')) return false;
    // Store the bare uuid: devices speak the prefixed `observed:<agent>:<uuid>`
    // form while timeline rows are keyed by the uuid alone, so keying on what
    // the device sent means the completion never matches what was armed.
    this.armed.set(sink, { sessionId: rawSessionId(sessionId), armedAt: this.now() });
    return true;
  }

  disarm(sink: ReplySink): void {
    this.armed.delete(sink);
  }

  /**
   * Mark these sessions as still working, so a long turn does not age out
   * mid-flight. Called with whatever the daemon currently considers active.
   */
  refresh(activeSessionIds: readonly string[]): void {
    if (activeSessionIds.length === 0) return;
    const active = new Set(activeSessionIds.map((id) => rawSessionId(id)));
    const now = this.now();
    for (const entry of this.armed.values()) {
      if (active.has(entry.sessionId)) entry.armedAt = now;
    }
  }

  /**
   * Drop armings that have gone stale. Deliberately does NOT evict on a closed
   * transport: a board's link can blink between the dictation and the end of the
   * turn — a serial connection gets recycled, a WebSocket reconnects — and
   * dropping the arming then loses the reply permanently for a device that is
   * about to be reachable again. Liveness is checked where it matters, at the
   * moment of streaming.
   */
  sweep(): void {
    const cutoff = this.now() - REPLY_ARM_TTL_MS;
    for (const [sink, entry] of this.armed) {
      if (entry.armedAt < cutoff) this.armed.delete(sink);
    }
  }

  /** How many armings are outstanding — for diagnostics only. */
  armedCount(): number {
    return this.armed.size;
  }

  /** Transport labels of everything currently armed, for diagnostics. */
  describeArmed(): string {
    return [...this.armed].map(([sink, e]) =>
      `${sink.describe()}->${e.sessionId.slice(0, 12)}`).join(', ') || '(none)';
  }

  /** Boards currently waiting on this session's reply. */
  targetsFor(sessionId: string): ReplySink[] {
    this.sweep();
    const raw = rawSessionId(sessionId);
    const out: ReplySink[] = [];
    for (const [sink, entry] of this.armed) {
      if (entry.sessionId === raw) out.push(sink);
    }
    return out;
  }

  /**
   * Stream one already-synthesized WAV to a board. Consumes the arming, so a
   * single dictation yields a single spoken reply rather than narrating every
   * subsequent turn of that session.
   */
  async stream(armedSink: ReplySink, wav: Buffer, spokenText: string): Promise<boolean> {
    this.armed.delete(armedSink);
    // Follow the board, not the socket: a USB-attached board parks its WiFi and
    // closes the WebSocket the dictation came in on, so by now the same device is
    // very likely reachable over serial instead. And prefer a transport that
    // can PLAY the audio: when the armed sink does not advertise audio_out
    // (arm-time fallback while the board's WS was blinking), upgrade to the
    // board's live audio-capable transport resolved now, at stream time.
    let sink = armedSink.isOpen()
      ? armedSink
      : this.resolveLive(armedSink.deviceKey()) ?? armedSink;
    if (!sink.capabilities().includes('audio_out')) {
      const live = this.resolveLive(armedSink.deviceKey());
      if (live && live.capabilities().includes('audio_out')) sink = live;
    }
    if (this.streaming.has(sink)) return false; // one utterance at a time per board
    const parsed = pcmFromWav(wav);
    if (!parsed || !sink.isOpen()) return false;
    const frames = pcmFrames(parsed.pcm);
    const frameMs = (PCM_FRAME_BYTES / 2) / parsed.sampleRate * 1000;

    this.streaming.add(sink);
    try {
      sink.send(JSON.stringify({
        type: 'audio_play_begin',
        sampleRate: parsed.sampleRate,
        durationMs: Math.round((parsed.pcm.length / 2) / parsed.sampleRate * 1000),
        text: spokenText.slice(0, 160),
      }));
      // Prime the board's ring buffer, then pace. Without the burst the first
      // syllable stutters while the playback task waits on the second frame.
      const burst = Math.min(frames.length, 8);
      for (let i = 0; i < frames.length; i++) {
        if (!sink.isOpen()) return false;
        sink.sendBinary(frames[i]);
        if (i >= burst) await this.sleep(Math.max(1, Math.round(frameMs * 0.9)));
      }
      if (!sink.isOpen()) return false;
      sink.send(JSON.stringify({ type: 'audio_play_end' }));
      return true;
    } finally {
      this.streaming.delete(sink);
    }
  }
}
