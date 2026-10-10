import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { it, expect } from 'vitest';
import { importDotAppearance, readDotAppearance, saveDotAppearance } from '../dot-appearance.js';
import { DOT_APPEARANCE_RULES as R, compactDotAppearance, defaultDotRGBA, dotSurfaceSnapshot, compactDotSnapshot, paintDotPixels, renderDotDeckSlot } from '@agentdeck/shared';
import { prepareForSerial, TIMELINE_HISTORY_BYTE_BUDGET } from '../esp32-serial.js';

it('imports only bounded static pixels, strips original metadata and resets without changing integration state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-character-'));
  try {
    const file = join(directory, 'face.png');
    await sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 210, g: 25, b: 10, alpha: 1 } } }).png().toFile(file);
    const a = await importDotAppearance(file, directory);
    expect(a.id).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(a.rgba, 'base64')).toHaveLength(R.glyphBytes);
    const meta = await sharp(Buffer.from(a.png!, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([R.portraitSize, R.portraitSize]);
    expect(meta.exif).toBeUndefined();
    expect(compactDotAppearance(a)).not.toHaveProperty('png');
    const loaded = readDotAppearance(directory);
    expect(loaded?.id).toBe(a.id);
    writeFileSync(file, '<svg><image href="https://not-fetched.example/image.png"/></svg>');
    await expect(importDotAppearance(file, directory)).rejects.toThrow('static');
    expect(readDotAppearance(directory)?.id).toBe(a.id);
    saveDotAppearance(null, directory);
    expect(readDotAppearance(directory)).toBeNull();
    expect(readFileSync(join(directory, 'dot-appearance.json'), 'utf8')).toBe('null');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('keeps normal portraits separate from compact packets and retains sessions when the glyph budget is exhausted', () => {
  const now = Date.now();
  const dot = dotSurfaceSnapshot({ configured: true, hosting: true, reportState: 'working', reportedAt: now, expiresAt: now + 60000 },
    { version: R.version, id: 'a'.repeat(64), png: 'iVBORw0KGgo=', rgba: Buffer.from(defaultDotRGBA()).toString('base64') });
  const frame = prepareForSerial({ type: 'sessions_list', sessions: [], dot } as any);
  expect((frame as any).dot.appearance.png).toBeUndefined();
  expect((frame as any).dot.code).toBe(2);
  expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(TIMELINE_HISTORY_BYTE_BUDGET);
  expect(compactDotSnapshot(dot)?.validForMs).toBeGreaterThan(0);
  expect(renderDotDeckSlot(dot)).toContain('<image');
  const many = Array.from({length:10}, (_,i) => ({id:String(i), agentType:'claude-code',state:'idle',alive:true,projectName:'name'.repeat(10),modelName:'model'.repeat(8),question:'q'.repeat(159),activity:'a'.repeat(79)}));
  const baseline = prepareForSerial({type:'sessions_list',sessions:many} as any) as any;
  const packed = prepareForSerial({type:'sessions_list',sessions:many,dot} as any) as any;
  expect(packed.sessions).toEqual(baseline.sessions);
  expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThanOrEqual(Math.max(TIMELINE_HISTORY_BYTE_BUDGET, Buffer.byteLength(JSON.stringify(baseline))));
});

it('preserves the collective 11-pixel face and changes only a separate Dot region on larger matrices', () => {
  const dot = {configured:true,hosting:true,reportState:'working',reportedAt:Date.now(),expiresAt:null};
  const small = new Uint8Array(11*11*3).fill(13);
  expect(paintDotPixels(small,11,dot)).toEqual(new Uint8Array(11*11*3).fill(13));
  const large = new Uint8Array(64*64*3).fill(13);
  const before = large.slice();
  paintDotPixels(large,64,dot);
  expect(large.slice(0,64*10*3)).toEqual(before.slice(0,64*10*3));
  expect(large).not.toEqual(before);
  expect(paintDotPixels(before.slice(),64,null)).toEqual(before);
});

it('keeps the matrix habitat unframed and unlettered, with a bounded activity cue', () => {
  const now = 1800000000000;
  const quiet = {configured:true, hosting:true, reportState:null, reportedAt:null, expiresAt:null};
  for (const width of [32,64]) {
    const plain = new Uint8Array(width*width*3).fill(13);
    expect(paintDotPixels(plain.slice(),width,quiet,now)).toEqual(plain);
    const active = {...quiet,reportState:'working',reportedAt:now,expiresAt:now+60000};
    const painted = paintDotPixels(plain.slice(),width,active,now);
    for (const hidden of [{...active,authorized:false},{...active,hosting:false},{...active,reportState:'stale'},{...active,reportedAt:now+1}]) {
      expect(paintDotPixels(plain.slice(),width,hidden,now)).toEqual(plain);
    }
    const size = Math.max(R.pixelMinSize,Math.floor(width/R.pixelSizeDivisor));
    const x0=width-size-R.pixelMargin, y0=Math.floor(width/R.pixelYDivisor);
    for(let y=0;y<width;y++) for(let x=0;x<width;x++) {
      if(x<x0 || x>=x0+size+2 || y<y0-2 || y>=y0+size) {
        expect([...painted.slice((y*width+x)*3,(y*width+x+1)*3)]).toEqual([13,13,13]);
      }
    }
    // At native size both dark eyes must survive; nearest-neighbor shrink lost them.
    const eyeY=y0+Math.round(5*(size-1)/15);
    for(const eye of [5,10]) {
      const eyeX=x0+Math.round(eye*(size-1)/15);
      const i=(eyeY*width+eyeX)*3;
      expect(painted[i]).toBeLessThan(60);
    }
    const working = paintDotPixels(plain.slice(),width,{...quiet,reportState:'working',reportedAt:now,expiresAt:now+60000},now);
    expect(working).toEqual(painted);
    const expired=paintDotPixels(plain.slice(),width,{...quiet,reportState:'working',reportedAt:now,expiresAt:now+60000},now+60001);
    expect(expired).toEqual(plain);
  }
});
