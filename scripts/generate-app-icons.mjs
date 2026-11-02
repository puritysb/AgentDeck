import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apple = 'apple/AgentDeck/Resources/Assets.xcassets';
const android = 'android/app/src/main/res';
const elgato = 'plugin/bound.serendipity.agentdeck.sdPlugin/static/imgs';
const ulanzi = 'plugin-ulanzi/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/resources/icons';

// One export policy for active consumers. Versioned marketplace listings and
// historical hardware artwork retain the assets of the release they document.
export const appIconExports = [
  { path: 'docs/media/agentdeck-icon.png', size: 640 },
  { path: `${apple}/AgentDeckIcon.imageset/agentdeck-icon.png`, size: 640 },
  { path: `${android}/drawable/agentdeck_icon.png`, size: 640 },
  ...[16, 32, 64, 128, 256, 512, 1024].map(size => ({
    path: `${apple}/AppIcon.appiconset/icon_${size}x${size}.png`, size, opaque: true,
  })),
  ...[['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]].map(([density, size]) => ({
    path: `${android}/mipmap-${density}/ic_launcher.png`, size,
  })),
  { path: `${elgato}/plugin.png`, size: 256 },
  { path: `${elgato}/plugin@2x.png`, size: 512 },
  { path: `${ulanzi}/plugin.png`, size: 144 },
  { path: `${ulanzi}/categoryIcon.png`, size: 196 },
];

// Fixed-point area resampling: source pixels span `size` units and output
// pixels span `sourceSize` units. Overlap weights and premultiplied colour sums
// are integers, so ARM/x86 and libvips versions produce identical pixels.
// Alpha-zero RGB contributes nothing. All exports are reductions of the master.
export function resizeIconPixels(source, sourceSize, size, background) {
  if (!Number.isInteger(size) || size < 1 || size > sourceSize || source.length !== sourceSize * sourceSize * 4) {
    throw new Error('Icon export must be a square reduction of RGBA master pixels');
  }
  const channels = background ? 3 : 4;
  const output = Buffer.alloc(size * size * channels);
  const area = sourceSize * sourceSize;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sums = [0, 0, 0, 0];
      for (let sy = Math.floor(y * sourceSize / size); sy < Math.ceil((y + 1) * sourceSize / size); sy++) {
        const wy = Math.min((sy + 1) * size, (y + 1) * sourceSize) - Math.max(sy * size, y * sourceSize);
        for (let sx = Math.floor(x * sourceSize / size); sx < Math.ceil((x + 1) * sourceSize / size); sx++) {
          const wx = Math.min((sx + 1) * size, (x + 1) * sourceSize) - Math.max(sx * size, x * sourceSize);
          const i = (sy * sourceSize + sx) * 4;
          const alphaWeight = source[i + 3] * wx * wy;
          sums[3] += alphaWeight;
          for (let c = 0; c < 3; c++) sums[c] += source[i + c] * alphaWeight;
        }
      }
      const index = (y * size + x) * channels;
      for (let c = 0; c < 3; c++) {
        output[index + c] = background
          ? Math.round((sums[c] + background[c] * (255 * area - sums[3])) / (255 * area))
          : sums[3] ? Math.round(sums[c] / sums[3]) : 0;
      }
      if (!background) output[index + 3] = Math.round(sums[3] / area);
    }
  }
  return output;
}

export async function renderAppIcon(entry, base = root) {
  const css = await readFile(resolve(base, 'design/tokens.css'), 'utf8');
  const token = css.match(/--ink-900:\s*(#[0-9a-f]{6})/i)?.[1];
  if (!token) throw new Error('Missing --ink-900 icon background token');
  const background = entry.opaque ? [1, 3, 5].map(i => parseInt(token.slice(i, i + 2), 16)) : undefined;
  const { data, info } = await sharp(resolve(base, 'design/brand/agentdeck-icon.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== info.height) throw new Error('Icon master must be square');
  const pixels = resizeIconPixels(data, info.width, entry.size, background);
  return sharp(pixels, { raw: { width: entry.size, height: entry.size, channels: entry.opaque ? 3 : 4 } }).png().toBuffer();
}

export async function generateAppIcons({ check = false, base = root } = {}) {
  const stale = [];
  for (const entry of appIconExports) {
    const expected = await renderAppIcon(entry, base);
    const path = resolve(base, entry.path);
    if (check) {
      try {
        const actual = sharp(await readFile(path));
        const metadata = await actual.metadata();
        const pixels = await actual.ensureAlpha().raw().toBuffer();
        const expectedPixels = await sharp(expected).ensureAlpha().raw().toBuffer();
        if (metadata.width !== entry.size || metadata.height !== entry.size ||
            Boolean(metadata.hasAlpha) === Boolean(entry.opaque) || !pixels.equals(expectedPixels)) stale.push(entry.path);
      } catch { stale.push(entry.path); }
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, expected);
    }
  }
  if (stale.length) throw new Error(`Stale app icons; run pnpm generate-app-icons:\n${stale.join('\n')}`);
  return appIconExports.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const count = await generateAppIcons({ check });
  console.log(`${check ? 'Verified' : 'Generated'} ${count} app/brand icon exports`);
}
