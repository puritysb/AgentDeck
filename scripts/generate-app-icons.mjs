import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reduce CPU-specific resampling differences. Transparent RGB is compared by
// its visible contribution below, with a one-level 8-bit rounding allowance.
sharp.simd(false);

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

export async function renderAppIcon(entry, base = root) {
  const css = await readFile(resolve(base, 'design/tokens.css'), 'utf8');
  const background = css.match(/--ink-900:\s*(#[0-9a-f]{6})/i)?.[1];
  if (!background) throw new Error('Missing --ink-900 icon background token');
  let image = sharp(resolve(base, 'design/brand/agentdeck-icon.png'));
  // Flatten before reduction so the edge antialiasing matches the final plate.
  if (entry.opaque) image = image.flatten({ background }).removeAlpha();
  return image.resize(entry.size, entry.size, { fit: 'contain' }).png().toBuffer();
}

// RGB underneath zero alpha is not artwork. Check both black and white plates;
// every background between them is bounded too. Keep the allowance at 1/255,
// rather than permitting a fraction of arbitrarily different pixels.
export function compareIconPixels(actual, expected) {
  if (actual.length !== expected.length || actual.length % 4) return { matches: false };
  let maxVisibleDeltaUnits = 0;
  let maxAlphaDelta = 0;
  let maxRawDelta = 0;
  for (let i = 0; i < actual.length; i += 4) {
    const a = actual[i + 3];
    const b = expected[i + 3];
    maxAlphaDelta = Math.max(maxAlphaDelta, Math.abs(a - b));
    for (let channel = 0; channel < 3; channel++) {
      const delta = actual[i + channel] * a - expected[i + channel] * b;
      maxRawDelta = Math.max(maxRawDelta, Math.abs(actual[i + channel] - expected[i + channel]));
      maxVisibleDeltaUnits = Math.max(maxVisibleDeltaUnits, Math.abs(delta), Math.abs(delta - (a - b) * 255));
    }
  }
  return { matches: maxAlphaDelta <= 1 && maxVisibleDeltaUnits <= 255,
    maxVisibleDelta: maxVisibleDeltaUnits / 255, maxAlphaDelta, maxRawDelta };
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
        const comparison = compareIconPixels(pixels, expectedPixels);
        if (metadata.width !== entry.size || metadata.height !== entry.size ||
            Boolean(metadata.hasAlpha) === Boolean(entry.opaque) ||
            (entry.opaque ? !pixels.equals(expectedPixels) : !comparison.matches)) {
          stale.push(`${entry.path} (${JSON.stringify(comparison)})`);
        } else if (!pixels.equals(expectedPixels)) {
          console.log(`Icon rounding: ${entry.path} ${JSON.stringify(comparison)}`);
        }
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
