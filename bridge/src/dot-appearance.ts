import { createHash } from 'node:crypto';
import { atomicWritePrivateFile, readBoundedRegularFile } from './private-files.js';
import { join } from 'node:path';
import sharp from 'sharp';
import { DOT_APPEARANCE_RULES as R, validDotAppearance, type DotAppearance } from '@agentdeck/shared';

export async function importDotAppearance(file: string, directory: string): Promise<DotAppearance> {
  const bytes = readBoundedRegularFile(file, R.sourceBytes);
  if (!bytes) throw new Error('Character image is too large or unreadable');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('Choose a static PNG, WebP or JPEG character');
  const metadata = await sharp(bytes, { limitInputPixels: R.sourcePixels, animated: false }).metadata();
  if (!['png', 'webp', 'jpeg'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
    throw new Error('Choose a static PNG, WebP or JPEG character');
  const image = sharp(bytes, { limitInputPixels: R.sourcePixels }).rotate();
  const portrait = await image.clone().resize(R.portraitSize, R.portraitSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const rgba = await image.clone().resize(R.glyphSize, R.glyphSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer();
  if (portrait.length > R.portraitBytes || rgba.length !== R.glyphBytes) throw new Error('Character conversion exceeded its budget');
  const appearance: DotAppearance = { version: R.version, id: createHash('sha256').update(portrait).digest('hex'), png: portrait.toString('base64'), rgba: rgba.toString('base64') };
  saveDotAppearance(appearance, directory);
  return appearance;
}
export function saveDotAppearance(value: DotAppearance | null, directory: string): void {
  const file = join(directory, 'dot-appearance.json');
  atomicWritePrivateFile(file, JSON.stringify(value));
}
export function readDotAppearance(directory: string): DotAppearance | null {
  try {
    const file = join(directory, 'dot-appearance.json');
    const bytes = readBoundedRegularFile(file, R.portraitBytes * 2);
    if (!bytes) return null;
    const a: unknown = JSON.parse(bytes.toString('utf8'));
    return validDotAppearance(a) ? a : null;
  } catch { return null; }
}
