#!/usr/bin/env node
// One-off asset prep: crop raw hardware photos into the Devices catalog card frames.
//
//   node scripts/crop-hardware-images.mjs [sourceDir]
//
// Sources live in assets/hardware-photos/ (committed): the captures actually
// used, re-encoded with the EXIF rotation baked in so they are already upright.
// Pass a directory to crop from the raw camera originals instead. The task
// table records which capture each shipped image came from, so re-framing a
// card never depends on files outside the repo.
//
// CRITICAL: `.rotate()` with NO argument applies the EXIF orientation tag. Many
// iPhone captures here are orientation 6 — the stored buffer is 4032x3024 while
// the photo is really 3024x4032 portrait. Crop coordinates below are in DISPLAY
// space (post-EXIF), so rotate() must run before extract(). Passing an explicit
// angle instead skips EXIF handling and crops from the wrong buffer entirely.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = process.argv[2] || path.join(__dirname, '../assets/hardware-photos');
// Archived sources are .jpg; the raw camera originals are .jpeg.
const resolveSource = (name) => {
  const jpg = path.join(sourceDir, name.replace(/\.jpeg$/, '.jpg'));
  return fs.existsSync(jpg) ? jpg : path.join(sourceDir, name);
};
const destDir = path.join(__dirname, '../docs/media');
// The Waveshare 1.47" never made it into the photo set; this hand-captured
// screenshot is the only image of it. Override with WAVESHARE_SRC if it moves.
const WAVESHARE_SRC = process.env.WAVESHARE_SRC ||
  path.join(__dirname, '../assets/hardware-photos/waveshare-147-source.jpg');

// Output frames. Keep in sync with the .shot aspect rules in docs/hardware/index.html.
const STANDARD = { width: 1400, height: 800 }; // 1.75:1 — single-column device card
const WIDE = { width: 2240, height: 600 }; //     3.73:1 — .device.wide card
const HERO = { width: 2400, height: 1600 }; //    3:2    — desk overview hero

// Side-by-side composites: one card, two devices.
const composites = [
  {
    name: 'streamdeck-family.jpg',
    out: WIDE,
    panes: [
      { src: 'IMG_9703.jpeg', crop: { left: 108, top: 300, width: 3816, height: 2041 } }, // Stream Deck+
      { src: 'IMG_9692.jpeg', crop: { left: 0, top: 308, width: 4032, height: 2156 } },   // Stream Deck 15-key
    ],
  },
];

const tasks = [
  // --- Control decks ---
  // Stream Deck+ also appears in the streamdeck-family composite, but that one is
  // a two-pane WIDE card. The README gallery needs it as a single STANDARD card,
  // so it gets its own crop from the same frame — pulled up slightly from the
  // composite pane's box to make 1.75:1, and dropped below the lid logo so it is
  // not clipped mid-word.
  { name: 'streamdeck-plus.jpg', src: 'IMG_9703.jpeg', crop: { left: 108, top: 352, width: 3816, height: 2181 }, out: STANDARD },
  { name: 'd200h.jpg', src: 'IMG_9701.jpeg', crop: { left: 0, top: 288, width: 4032, height: 2304 }, out: STANDARD },

  // --- Apps ---
  { name: 'ipad.jpg', src: 'IMG_9691.jpeg', crop: { left: 0, top: 288, width: 4032, height: 2304 }, out: STANDARD },
  { name: 'android-tablet.jpg', src: 'IMG_9695.jpeg', crop: { left: 0, top: 324, width: 4032, height: 2304 }, out: STANDARD },
  { name: 'android-eink.jpg', src: 'IMG_9707.jpeg', crop: { left: 0, top: 270, width: 4032, height: 2304 }, out: STANDARD },

  // --- ESP32 displays ---
  { name: 'ips35.jpg', src: 'IMG_9704.jpeg', crop: { left: 0, top: 1161, width: 3024, height: 1728 }, out: STANDARD },
  { name: 'box86.jpg', src: 'IMG_9706.jpeg', crop: { left: 0, top: 1404, width: 3024, height: 1728 }, out: STANDARD },
  { name: 'round-amoled.jpg', src: 'IMG_9705.jpeg', crop: { left: 0, top: 1485, width: 3024, height: 1728 }, out: STANDARD },
  { name: 'ttgo.jpg', src: 'IMG_9702.jpeg', crop: { left: 0, top: 1444, width: 3024, height: 1728 }, out: STANDARD },
  { name: 'ips10.jpg', src: 'IMG_9696.jpeg', crop: { left: 0, top: 306, width: 4032, height: 2304 }, out: STANDARD },
  { name: 'inkdeck.jpg', src: 'IMG_9708.jpeg', crop: { left: 216, top: 396, width: 3780, height: 2160 }, out: STANDARD },
  { name: 'xteink.jpg', src: 'IMG_9682.jpeg', crop: { left: 0, top: 234, width: 4032, height: 2304 }, out: STANDARD },
  // The Companion Knob is the only board framed around an input, not a panel, so
  // the crop keeps the rotary encoder and the LED ring in frame beside the LCD.
  { name: 't-embed.jpg', src: 'IMG_0095.jpeg', crop: { left: 97, top: 1042, width: 2880, height: 1646 }, out: STANDARD },
  // Focus Strip: the no-camera unit, which boots the landscape Ticker UI. The
  // GC0308 unit boots portrait (Pocket UI) and was shot handheld, so it cannot
  // be framed to 1.75:1 without either clipping its tab bar or filling half the
  // card with hand — that capture stays archived as IMG_0096 (see the archive
  // README) and the camera option is carried by the spec sheet's second S3-Pro
  // row instead.
  { name: 't-display-pro.jpg', src: 'IMG_0097.jpeg', crop: { left: 137, top: 1085, width: 2800, height: 1600 }, out: STANDARD },
  // Waveshare has no shot in the photo set; this is the only capture of it, already
  // cropped by hand, so it is passed through with just the frame fit applied.
  { name: 'waveshare-147.jpg', srcPath: WAVESHARE_SRC, crop: { left: 109, top: 0, width: 949, height: 542 }, out: STANDARD },

  // --- Pixel displays ---
  { name: 'pixoo64.jpg', src: 'IMG_9700.jpeg', crop: { left: 0, top: 1471, width: 3024, height: 1728 }, out: STANDARD },
  { name: 'idotmatrix.jpg', src: 'IMG_9697.jpeg', crop: { left: 0, top: 1066, width: 3024, height: 1728 }, out: STANDARD },
  { name: 'timebox.jpg', src: 'IMG_9693.jpeg', crop: { left: 257, top: 468, width: 3591, height: 2052 }, out: STANDARD },
  { name: 'tc001.jpg', src: 'IMG_9698.jpeg', crop: { left: 578, top: 706, width: 3200, height: 1829 }, out: STANDARD },

  // --- README hero ---
  { name: 'setup-full.jpg', src: 'IMG_9710.jpeg', crop: { left: 0, top: 150, width: 4032, height: 2688 }, out: HERO },
];

async function run() {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  let ok = 0;
  for (const task of tasks) {
    const srcPath = task.srcPath || resolveSource(task.src);
    if (!fs.existsSync(srcPath)) {
      console.warn(`[crop] SKIP ${task.name} — source missing: ${srcPath}`);
      continue;
    }
    try {
      const { info } = await sharp(srcPath).rotate().toBuffer({ resolveWithObject: true });
      const { left, top, width: cw, height: ch } = task.crop;
      if (left + cw > info.width || top + ch > info.height) {
        console.warn(`[crop] SKIP ${task.name} — crop ${cw}x${ch}+${left}+${top} exceeds ${info.width}x${info.height}`);
        continue;
      }
      await sharp(srcPath)
        .rotate()
        .extract({ left, top, width: cw, height: ch })
        .resize(task.out.width, task.out.height, { fit: 'cover' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(path.join(destDir, task.name));
      console.log(`[crop] ${task.name} ← ${task.src || path.basename(srcPath)} (${info.width}x${info.height} → ${cw}x${ch})`);
      ok += 1;
    } catch (err) {
      console.error(`[crop] FAIL ${task.name} ← ${task.src}: ${err.message}`);
    }
  }
  for (const comp of composites) {
    try {
      const gap = 12;
      const paneW = Math.floor((comp.out.width - gap) / 2);
      const panes = [];
      for (const pane of comp.panes) {
        const srcPath = resolveSource(pane.src);
        if (!fs.existsSync(srcPath)) throw new Error(`source missing: ${pane.src}`);
        panes.push(
          await sharp(srcPath).rotate().extract(pane.crop)
            .resize(paneW, comp.out.height, { fit: 'cover' }).toBuffer(),
        );
      }
      await sharp({
        create: { width: comp.out.width, height: comp.out.height, channels: 3, background: '#0e1f1f' },
      })
        .composite(panes.map((input, i) => ({ input, left: i * (paneW + gap), top: 0 })))
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(path.join(destDir, comp.name));
      console.log(`[crop] ${comp.name} ← ${comp.panes.map((p) => p.src).join(' + ')} (composite)`);
      ok += 1;
    } catch (err) {
      console.error(`[crop] FAIL ${comp.name}: ${err.message}`);
    }
  }
  console.log(`[crop] ${ok}/${tasks.length + composites.length} written → docs/media/`);
}

run();
