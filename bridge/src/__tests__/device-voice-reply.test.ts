import { describe, it, expect } from 'vitest';
import {
  DeviceVoiceReplyRouter, speakableReply, pcmFromWav, pcmFrames,
  PCM_FRAME_BYTES, MAX_SPOKEN_CHARS, REPLY_ARM_TTL_MS, type ReplySink,
} from '../device-voice-reply.js';

function wav(pcmBytes: number, sampleRate = 16000, extraChunk = false): Buffer {
  const pcm = Buffer.alloc(pcmBytes, 7);
  const extra = extraChunk ? Buffer.concat([
    Buffer.from('LIST', 'ascii'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(8); return b; })(),
    Buffer.alloc(8, 0x41),
  ]) : Buffer.alloc(0);
  const head = Buffer.alloc(36);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(28 + extra.length + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0, 'ascii');
  dataHdr.writeUInt32LE(pcm.length, 4);
  return Buffer.concat([head, extra, dataHdr, pcm]);
}

function fakeSink(caps: string[] = ['audio_out']) {
  const json: string[] = [];
  const binary: Buffer[] = [];
  let open = true;
  const sink: ReplySink & { json: string[]; binary: Buffer[]; close(): void } = {
    json, binary,
    close() { open = false; },
    send: (d) => { json.push(d); },
    sendBinary: (d) => { binary.push(Buffer.from(d)); },
    isOpen: () => open,
    capabilities: () => caps,
    describe: () => 'fake',
    deviceKey: () => 't_embed',
  };
  return sink;
}

describe('speakableReply', () => {
  it('replaces fenced code with a spoken marker instead of reciting it', () => {
    const out = speakableReply('Fixed it.\n\n```ts\nconst x = 1;\n```\n\nRun the tests.');
    expect(out).toContain('Fixed it.');
    expect(out).toContain('(code)');
    expect(out).not.toContain('const x');
  });

  it('strips markdown scaffolding and URLs that read as noise', () => {
    const out = speakableReply('## Result\n- **done**: see [docs](https://x.dev/a/b)\n');
    expect(out).toBe('Result\ndone: see docs');
  });

  it('returns empty when nothing speakable survives', () => {
    expect(speakableReply('```\ndiff --git a b\n```')).toBe('(code)');
    expect(speakableReply('')).toBe('');
    expect(speakableReply('   \n  ')).toBe('');
  });

  it('cuts at a sentence boundary when the cap lands mid-sentence', () => {
    const body = 'First sentence here. ' + 'x'.repeat(40) + '. Tail after cap.';
    const out = speakableReply(body, 30);
    expect(out.endsWith('.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it('hard-caps when no sentence boundary is near the cap', () => {
    const out = speakableReply('y'.repeat(MAX_SPOKEN_CHARS + 500));
    expect(out.length).toBe(MAX_SPOKEN_CHARS);
  });
});

describe('pcmFromWav', () => {
  it('walks chunks rather than assuming the data starts at byte 44', () => {
    const parsed = pcmFromWav(wav(320, 16000, true));
    expect(parsed).not.toBeNull();
    expect(parsed!.sampleRate).toBe(16000);
    expect(parsed!.pcm.length).toBe(320);
    // Metadata must not leak into the audio.
    expect(parsed!.pcm.every((b) => b === 7)).toBe(true);
  });

  it('rejects non-RIFF and truncated input', () => {
    expect(pcmFromWav(Buffer.alloc(10))).toBeNull();
    expect(pcmFromWav(Buffer.alloc(64, 0))).toBeNull();
  });

  it('clamps a data chunk that claims more bytes than the file holds', () => {
    const w = wav(64);
    w.writeUInt32LE(9999, w.length - 64 - 4);
    const parsed = pcmFromWav(w);
    expect(parsed!.pcm.length).toBe(64);
  });
});

describe('pcmFrames', () => {
  it('splits into fixed frames with a short tail', () => {
    const frames = pcmFrames(Buffer.alloc(PCM_FRAME_BYTES * 2 + 100));
    expect(frames.length).toBe(3);
    expect(frames[0].length).toBe(PCM_FRAME_BYTES);
    expect(frames[2].length).toBe(100);
  });
});

describe('DeviceVoiceReplyRouter', () => {
  const noSleep = async () => {};

  it('only arms boards that advertise an amplifier', () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const withSpeaker = fakeSink(['audio', 'audio_out']);
    const without = fakeSink(['audio']);
    expect(r.arm(withSpeaker, 'observed:codex:a')).toBe(true);
    expect(r.arm(without, 'observed:codex:a')).toBe(false);
    expect(r.targetsFor('observed:codex:a')).toEqual([withSpeaker]);
  });

  it('does not arm without a session id', () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    expect(r.arm(fakeSink(), '')).toBe(false);
  });

  it('matches only the session that was dictated to', () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'session-a');
    expect(r.targetsFor('session-b')).toEqual([]);
    expect(r.targetsFor('session-a')).toEqual([sink]);
  });

  it('expires an arming once the window closes, so a stale answer stays silent', () => {
    let now = 1000;
    const r = new DeviceVoiceReplyRouter(() => now, noSleep);
    r.arm(fakeSink(), 'session-a');
    now += REPLY_ARM_TTL_MS - 1;
    expect(r.targetsFor('session-a').length).toBe(1);
    now += 2;
    expect(r.targetsFor('session-a').length).toBe(0);
  });

  it('keeps an arming across a transport blip, and refuses to stream while down', async () => {
    // A serial link gets recycled and a WebSocket reconnects; losing the reply
    // because the link blinked mid-turn would be worse than a late reply.
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'session-a');
    sink.close();
    expect(r.targetsFor('session-a')).toEqual([sink]);
    expect(await r.stream(sink, wav(64), 'hi')).toBe(false);
    expect(sink.json).toEqual([]);
  });

  it('streams begin, paced PCM frames, then end', async () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'session-a');
    const ok = await r.stream(sink, wav(PCM_FRAME_BYTES * 3), 'hello there');
    expect(ok).toBe(true);
    expect(sink.binary.length).toBe(3);
    const begin = JSON.parse(sink.json[0]);
    expect(begin.type).toBe('audio_play_begin');
    expect(begin.sampleRate).toBe(16000);
    expect(begin.text).toBe('hello there');
    expect(JSON.parse(sink.json[1]).type).toBe('audio_play_end');
  });

  it('consumes the arming so one dictation yields one spoken reply', async () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'session-a');
    await r.stream(sink, wav(64), 'hi');
    expect(r.targetsFor('session-a')).toEqual([]);
  });

  it('stops mid-stream when the board disconnects and sends no end frame', async () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    sink.close();
    const ok = await r.stream(sink, wav(PCM_FRAME_BYTES * 2), 'hi');
    expect(ok).toBe(false);
    expect(sink.json).toEqual([]);
  });

  it('refuses a WAV it cannot parse rather than streaming garbage', async () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    expect(await r.stream(sink, Buffer.alloc(20), 'hi')).toBe(false);
    expect(sink.binary).toEqual([]);
  });

  it('disarm removes a target without streaming', () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'session-a');
    r.disarm(sink);
    expect(r.targetsFor('session-a')).toEqual([]);
  });
});

describe('session-id keying across the two forms', () => {
  const noSleep = async () => {};

  // The bug this guards: devices send `observed:<agent>:<uuid>` while timeline
  // rows carry the bare uuid, so arming under one and looking up under the other
  // silently matched nothing and the reply was synthesized for no one.
  it('matches a bare-uuid completion against a prefixed arming', () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'observed:claude:1222c7e8-f613-4940-8cb2-9056b46fe1cc');
    expect(r.targetsFor('1222c7e8-f613-4940-8cb2-9056b46fe1cc')).toEqual([sink]);
  });

  it('matches in the other direction too', () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'abc-123');
    expect(r.targetsFor('observed:codex:abc-123')).toEqual([sink]);
  });

  it.each(['claude', 'codex', 'codex-app', 'opencode', 'antigravity'])(
    'normalizes the %s prefix', (agent) => {
      const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
      const sink = fakeSink();
      r.arm(sink, `observed:${agent}:u-1`);
      expect(r.targetsFor('u-1')).toEqual([sink]);
    });

  it('still keeps different sessions apart', () => {
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'observed:claude:aaa');
    expect(r.targetsFor('observed:claude:bbb')).toEqual([]);
    expect(r.targetsFor('bbb')).toEqual([]);
  });
});

describe('long-running turns', () => {
  const noSleep = async () => {};

  // A dictated question can start half an hour of tool calls. The answer is
  // still wanted, so the TTL measures silence, not elapsed time.
  it('keeps an arming alive while the session is still working', () => {
    let now = 1000;
    const r = new DeviceVoiceReplyRouter(() => now, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'observed:claude:long-1');
    for (let i = 0; i < 6; i++) {
      now += REPLY_ARM_TTL_MS - 1000;
      r.refresh(['observed:claude:long-1']);
    }
    now += 1000;
    expect(r.targetsFor('long-1')).toEqual([sink]);
  });

  it('still expires a session that went quiet', () => {
    let now = 1000;
    const r = new DeviceVoiceReplyRouter(() => now, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'long-2');
    r.refresh(['some-other-session']);
    now += REPLY_ARM_TTL_MS + 1;
    expect(r.targetsFor('long-2')).toEqual([]);
  });

  it('refresh accepts either id form and ignores an empty list', () => {
    let now = 1000;
    const r = new DeviceVoiceReplyRouter(() => now, noSleep);
    const sink = fakeSink();
    r.arm(sink, 'long-3');
    now += REPLY_ARM_TTL_MS - 10;
    r.refresh([]);                        // no-op, must not throw
    r.refresh(['observed:codex:long-3']); // prefixed form refreshes bare key
    now += REPLY_ARM_TTL_MS - 10;
    expect(r.targetsFor('long-3')).toEqual([sink]);
  });
});

describe('following the board across transports', () => {
  const noSleep = async () => {};

  // The real failure: a USB-attached board dictates over WiFi, then parks its
  // radio and closes that socket. The reply must still arrive, over serial.
  it('streams to the board\'s current transport when the armed one is gone', async () => {
    const dead = fakeSink();
    const live = fakeSink();
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep,
      (key) => (key === 't_embed' ? live : null));
    r.arm(dead, 'observed:codex:s1');
    dead.close();
    const ok = await r.stream(dead, wav(PCM_FRAME_BYTES), 'hi');
    expect(ok).toBe(true);
    expect(live.binary.length).toBe(1);
    expect(dead.binary).toEqual([]);
    expect(JSON.parse(live.json[0]).type).toBe('audio_play_begin');
  });

  it('gives up when the board is not reachable at all', async () => {
    const dead = fakeSink();
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep, () => null);
    r.arm(dead, 's1');
    dead.close();
    expect(await r.stream(dead, wav(PCM_FRAME_BYTES), 'hi')).toBe(false);
  });

  it('prefers the armed transport while it is still open', async () => {
    const armed = fakeSink();
    const other = fakeSink();
    const r = new DeviceVoiceReplyRouter(() => 1000, noSleep, () => other);
    r.arm(armed, 's1');
    await r.stream(armed, wav(PCM_FRAME_BYTES), 'hi');
    expect(armed.binary.length).toBe(1);
    expect(other.binary).toEqual([]);
  });
});

 describe('HTTP reply target after synthesis', () => {
  it('moves a pull notification to the live connection after reconnect', () => {
    const old = fakeSink(['audio_http_pull']);
    const live = fakeSink(['audio_http_pull']);
    const router = new DeviceVoiceReplyRouter(Date.now, async () => {}, () => live);
    router.arm(old, 'personal-run');
    old.close();
    expect(router.resolveTarget(router.targetsFor('personal-run')[0])).toBe(live);
  });
  it('upgrades a metadata-only connection to a pull-capable transport', () => {
    const serial = fakeSink([]);
    const live = fakeSink(['audio_http_pull']);
    const router = new DeviceVoiceReplyRouter(Date.now, async () => {}, () => live);
    expect(router.resolveTarget(serial)).toBe(live);
  });
 });
