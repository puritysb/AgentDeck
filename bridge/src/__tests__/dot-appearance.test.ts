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

it('draws a centered tiny pearl while retaining its state rail', () => {
  const dot = {configured:true,hosting:true,reportState:'working',reportedAt:Date.now(),expiresAt:null};
  const before=new Uint8Array(11*11*3).fill(13);
  const result=paintDotPixels(before.slice(),11,dot,Date.now(),{x:5,y:5,size:9,beacon:true});
  expect(result).not.toEqual(before);
  for(let x=0;x<11;x++) for(const y of [0,10]) expect(result.slice((y*11+x)*3,(y*11+x+1)*3)).toEqual(before.slice((y*11+x)*3,(y*11+x+1)*3));
});

it('keeps the pearl and closed shell in the resident band with both eyes readable', () => {
  const now=1800000000000;
  const quiet={configured:true,hosting:true,reportState:null,reportedAt:null,expiresAt:null};
  for(const width of [32,64]) {
    const plain=new Uint8Array(width*width*3).fill(13);
    const size=Math.max(R.pixelMinSize,Math.floor(width/R.pixelSizeDivisor));
    const home={x:Math.floor(width*.43),y:Math.floor(width*.72)};
    const ready=paintDotPixels(plain.slice(),width,quiet,now,home);
    const stopped=paintDotPixels(plain.slice(),width,{...quiet,hosting:false},now,home);
    expect(ready).not.toEqual(plain);
    expect(stopped).not.toEqual(plain); // configured homes survive endpoint shutdown
    expect(stopped).not.toEqual(ready);
    expect(ready.slice(0,width*10*3)).toEqual(plain.slice(0,width*10*3));
    expect(paintDotPixels(plain.slice(),width,{...quiet,configured:false},now,home)).toEqual(plain);
    const center=paintDotPixels(plain.slice(),width,quiet,now,{x:16,y:16,size,beacon:true});
    for(const eye of [5,10]) {
      const x=16-Math.floor(size/2)+Math.round(eye*(size-1)/15);
      const y=16-Math.floor(size/2)+Math.round(5*(size-1)/15);
      expect(center[(y*width+x)*3]).toBeLessThan(60);
    }
    const working={...quiet,reportState:'working',reportedAt:now,expiresAt:now+60000};
    expect(paintDotPixels(plain.slice(),width,working,now+60001,home)).toEqual(stopped);
  }
});
