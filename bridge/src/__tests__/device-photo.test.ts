import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DevicePhotoCollector, prunePhotoDir } from '../device-photo.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CONN = Symbol('conn');
const OTHER = Symbol('other');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentdeck-photo-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('DevicePhotoCollector', () => {
  it('assembles frames into a JPEG file and reports the target session', () => {
    const c = new DevicePhotoCollector(dir);
    c.begin(CONN, { sessionId: 'observed:claude:abc', board: 't_display_pro', width: 480, height: 320 });
    c.append(CONN, Buffer.from([0xff, 0xd8, 0xff]));
    c.append(CONN, Buffer.alloc(500, 7));
    const out = c.end(CONN, { bytes: 503 });
    expect(out).not.toBeNull();
    expect(out!.sessionId).toBe('observed:claude:abc');
    expect(out!.board).toBe('t_display_pro');
    expect(out!.width).toBe(480);
    const jpeg = readFileSync(out!.path);
    expect(jpeg.length).toBe(503);
    expect(jpeg[0]).toBe(0xff);
    expect(out!.path.startsWith(dir)).toBe(true);
  });

  it('ignores binary frames with no open capture', () => {
    const c = new DevicePhotoCollector(dir);
    expect(c.append(CONN, Buffer.alloc(64))).toBe(false);
    expect(c.isOpen(CONN)).toBe(false);
  });

  it('keeps captures separate per connection', () => {
    const c = new DevicePhotoCollector(dir);
    c.begin(CONN, { sessionId: 'a' });
    c.begin(OTHER, { sessionId: 'b' });
    c.append(CONN, Buffer.alloc(100));
    expect(c.openCount).toBe(2);
    expect(c.end(OTHER, {})).toBeNull();      // nothing captured on OTHER
    expect(c.end(CONN, {})!.sessionId).toBe('a');
  });

  it('returns null for a cancelled or empty capture', () => {
    const c = new DevicePhotoCollector(dir);
    c.begin(CONN, {});
    c.append(CONN, Buffer.alloc(64));
    expect(c.end(CONN, { cancel: true })).toBeNull();
    c.begin(CONN, {});
    expect(c.end(CONN, {})).toBeNull();
  });

  it('drops a capture whose byte count disagrees with the board claim', () => {
    // Frame loss produces a corrupt JPEG — an explicit failure beats a garbage
    // image prompt.
    const c = new DevicePhotoCollector(dir);
    c.begin(CONN, {});
    c.append(CONN, Buffer.alloc(400));
    expect(c.end(CONN, { bytes: 512 })).toBeNull();
  });

  it('drops an oversized capture instead of writing a truncated JPEG', () => {
    const c = new DevicePhotoCollector(dir);
    c.begin(CONN, {});
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 5; i++) expect(c.append(CONN, chunk)).toBe(true);
    expect(c.end(CONN, {})).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('reaps captures whose photo_end never arrived', () => {
    const c = new DevicePhotoCollector(dir);
    c.begin(CONN, {});
    c.append(CONN, Buffer.alloc(10));
    c.sweep(Date.now() + 120_000);
    expect(c.openCount).toBe(0);
    expect(c.end(CONN, {})).toBeNull();
  });

  it('abandon drops the open capture for a dead socket', () => {
    const c = new DevicePhotoCollector(dir);
    c.begin(CONN, {});
    c.abandon(CONN);
    expect(c.openCount).toBe(0);
  });
});

describe('prunePhotoDir', () => {
  it('keeps only the newest N photos', () => {
    for (let i = 0; i < 6; i++) {
      const p = join(dir, `photo-${i}.jpg`);
      writeFileSync(p, Buffer.alloc(4));
      const t = new Date(Date.now() - (6 - i) * 60_000);
      utimesSync(p, t, t);
    }
    prunePhotoDir(dir, 3);
    const left = readdirSync(dir).sort();
    expect(left).toEqual(['photo-3.jpg', 'photo-4.jpg', 'photo-5.jpg']);
  });

  it('is silent on a missing directory', () => {
    expect(() => prunePhotoDir(join(dir, 'nope'))).not.toThrow();
  });
});

describe('photo file names', () => {
  it('keeps a hostile board id inside the photo directory', () => {
    const c = new DevicePhotoCollector(dir);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const saved = c.saveDirect(jpeg, { board: '../../escape/evil', sessionId: '', width: 0, height: 0 });
    expect(saved.path.startsWith(dir + '/')).toBe(true);
    expect(saved.path).toMatch(/-escapeevil\.jpg$/);
    expect(saved.board).toBe('../../escape/evil');
    expect(readdirSync(dir).filter((f) => f.endsWith('.jpg'))).toHaveLength(1);
  });

  it('falls back to esp32 when nothing usable is left', () => {
    const c = new DevicePhotoCollector(dir);
    const saved = c.saveDirect(Buffer.from([1]), { board: '../..', sessionId: '', width: 0, height: 0 });
    expect(saved.path).toMatch(/-esp32\.jpg$/);
  });

  it('keeps ordinary board ids unchanged', () => {
    const c = new DevicePhotoCollector(dir);
    const saved = c.saveDirect(Buffer.from([1]), { board: 't_display_s3_pro', sessionId: '', width: 0, height: 0 });
    expect(saved.path).toMatch(/-t_display_s3_pro\.jpg$/);
  });
});
