/**
 * Device-sourced photos: a board captures a JPEG (T-Display-S3-Pro rear
 * camera) and the daemon turns it into a prompt for the session the board was
 * pointing at — "show-and-tell" for coding agents: snap a whiteboard, an app
 * screen, an error dialog, and the agent gets a file path it can read.
 *
 * Wire shape (per WS connection), mirroring device-voice:
 *   {"type":"photo_begin","format":"jpeg","width":…,"height":…,"sessionId":…}
 *   <binary frames: raw JPEG bytes>
 *   {"type":"photo_end","bytes":…,"cancel":false}
 * Serial transport wraps the same bytes base64 in `photo_chunk` lines.
 *
 * Binary frames carry no envelope, so they are attributed to whichever socket
 * has an open capture — hence the per-connection state here. A connection may
 * hold an open voice utterance OR an open photo, never both; the daemon's
 * onBinary router offers the frame to each collector in turn.
 *
 * Unlike a voice WAV (deleted after transcription), the JPEG must outlive this
 * module: the prompt references the path and the agent reads it seconds or
 * minutes later. Photos land under <dataDir>/photos with a small retention
 * sweep instead of a cleanup callback.
 */

import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { debug } from './logger.js';

/** Refuse to buffer more than one plausible photo. VGA-class JPEGs are tens of
 *  KB; a 5 MP OV5640 shield tops out around 1–2 MB. */
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
/** A capture whose photo_end never arrives (board reboot, WiFi drop). */
const CAPTURE_TTL_MS = 60_000;
/** Keep this many photos; older ones are pruned on each save. */
const RETAIN_COUNT = 40;

export interface PhotoCapture {
  sessionId: string;
  board: string;
  format: string;
  width: number;
  height: number;
  chunks: Buffer[];
  bytes: number;
  startedAt: number;
  truncated: boolean;
}

export interface PhotoCaptureResult {
  sessionId: string;
  board: string;
  path: string;
  bytes: number;
  width: number;
  height: number;
  truncated: boolean;
}

export function defaultPhotoDir(): string {
  return join(process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck'), 'photos');
}

/** Drop the oldest files beyond the retention count. Best-effort. */
export function prunePhotoDir(dir: string, retain = RETAIN_COUNT): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .map((f) => {
        const p = join(dir, f);
        try { return { p, mtime: statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { p: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(retain)) {
      try { rmSync(f.p, { force: true }); } catch { /* best effort */ }
    }
  } catch { /* dir missing — nothing to prune */ }
}

/**
 * Per-connection photo assembly. One instance per daemon; connections are
 * keyed by whatever opaque handle the server uses for a socket (WS object or
 * serial port string), exactly like DeviceVoiceCollector.
 */
export class DevicePhotoCollector {
  private open = new Map<unknown, PhotoCapture>();

  constructor(private photoDir: string = defaultPhotoDir()) {}

  begin(conn: unknown, msg: Record<string, unknown>): void {
    this.open.set(conn, {
      sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : '',
      board: typeof msg.board === 'string' ? msg.board : 'esp32',
      format: typeof msg.format === 'string' && msg.format ? msg.format : 'jpeg',
      width: typeof msg.width === 'number' ? msg.width : 0,
      height: typeof msg.height === 'number' ? msg.height : 0,
      chunks: [],
      bytes: 0,
      startedAt: Date.now(),
      truncated: false,
    });
    debug('photo', `capture begin (${String(msg.width ?? '?')}x${String(msg.height ?? '?')}, `
      + `session ${String(msg.sessionId ?? '').slice(0, 20)})`);
  }

  /** True while this connection has an open capture. */
  isOpen(conn: unknown): boolean {
    return this.open.has(conn);
  }

  /** Returns false when no capture is open — the caller should offer the frame
   *  to the next collector. */
  append(conn: unknown, data: Buffer): boolean {
    const c = this.open.get(conn);
    if (!c) return false;
    if (c.bytes + data.length > MAX_PHOTO_BYTES) {
      // A truncated JPEG is undecodable (unlike truncated PCM), so mark it and
      // let end() refuse — but keep consuming frames so they don't leak into
      // another collector.
      c.truncated = true;
      return true;
    }
    c.chunks.push(Buffer.from(data));
    c.bytes += data.length;
    return true;
  }

  /**
   * Finish the capture: write the JPEG under the photo dir and return its
   * path. Returns null when cancelled, empty, truncated, or nothing was open.
   */
  end(conn: unknown, msg: Record<string, unknown>): PhotoCaptureResult | null {
    const c = this.open.get(conn);
    this.open.delete(conn);
    if (!c) return null;
    if (msg.cancel === true) {
      debug('photo', 'capture cancelled by device');
      return null;
    }
    if (c.bytes === 0) {
      debug('photo', 'capture empty — nothing received');
      return null;
    }
    if (c.truncated) {
      debug('photo', `capture exceeded ${MAX_PHOTO_BYTES} bytes — dropped`);
      return null;
    }
    const claimed = typeof msg.bytes === 'number' ? msg.bytes : undefined;
    if (claimed !== undefined && claimed !== c.bytes) {
      // Frame loss over a flaky link produces a corrupt JPEG; better an
      // explicit failure the board can show than a garbage image prompt.
      debug('photo', `byte mismatch: board sent ${claimed}, received ${c.bytes} — dropped`);
      return null;
    }
    const jpeg = Buffer.concat(c.chunks);
    mkdirSync(this.photoDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = join(this.photoDir, `${stamp}-${c.board}.jpg`);
    writeFileSync(path, jpeg);
    prunePhotoDir(this.photoDir);
    debug('photo', `capture end: ${c.bytes} bytes → ${path}`);
    return {
      sessionId: c.sessionId,
      board: c.board,
      path,
      bytes: c.bytes,
      width: c.width,
      height: c.height,
      truncated: c.truncated,
    };
  }

  /**
   * Save a photo that arrived whole (HTTP POST body) rather than assembled
   * from chunks. Same directory, retention and result shape as end().
   */
  saveDirect(jpeg: Buffer, meta: {
    board: string; sessionId: string; width: number; height: number;
  }): PhotoCaptureResult {
    mkdirSync(this.photoDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = join(this.photoDir, `${stamp}-${meta.board}.jpg`);
    writeFileSync(path, jpeg);
    prunePhotoDir(this.photoDir);
    debug('photo', `direct upload: ${jpeg.length} bytes → ${path}`);
    return {
      sessionId: meta.sessionId,
      board: meta.board,
      path,
      bytes: jpeg.length,
      width: meta.width,
      height: meta.height,
      truncated: false,
    };
  }

  /** Drop a capture whose socket died mid-stream. */
  abandon(conn: unknown): void {
    if (this.open.delete(conn)) debug('photo', 'capture abandoned (socket closed)');
  }

  /**
   * Reap captures whose photo_end never arrived. Returns the reaped
   * connections so the caller can tell each board its shutter press died —
   * a silently expired capture left the strip showing "sending" forever.
   */
  sweep(now = Date.now()): unknown[] {
    const expired: unknown[] = [];
    for (const [conn, c] of this.open) {
      if (now - c.startedAt > CAPTURE_TTL_MS) {
        this.open.delete(conn);
        expired.push(conn);
        debug('photo', `capture expired without photo_end (${c.bytes} bytes buffered)`);
      }
    }
    return expired;
  }

  get openCount(): number {
    return this.open.size;
  }
}
