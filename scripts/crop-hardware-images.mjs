#!/usr/bin/env node
// Reproducible asset prep: crop raw hardware photos into the Devices catalog card frames.
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

// September 28, 2026 real-device captures. Coordinates are upright source pixels.
// Contain square/portrait hardware instead of cutting off its bezel or usage rail.
const BACKGROUND = '#0e1f1f';
const composites = [
  {
    name: 'streamdeck-family.jpg', out: WIDE,
    panes: [
      { src: 'IMG_0704.jpeg', crop: { left: 1450, top: 2410, width: 570, height: 530 } },
      { src: 'IMG_0704.jpeg', crop: { left: 1130, top: 2590, width: 435, height: 370 } },
    ],
  },
];

const tasks = [
  // Control decks: the closer desk overview keeps the keys, strip and encoders.
  { name: 'streamdeck-plus.jpg', src: 'IMG_0704.jpeg', crop: { left: 1450, top: 2410, width: 570, height: 530 }, out: STANDARD, fit: 'contain' },
  { name: 'd200h.jpg', src: 'IMG_0684.jpeg', crop: { left: 1650, top: 2040, width: 1040, height: 984 }, out: STANDARD, fit: 'contain' },

  // Apps: genuine screens photographed on the desk; native screenshots stay separate.
  { name: 'ipad.jpg', src: 'IMG_0688.jpeg', crop: { left: 0, top: 0, width: 4032, height: 2920 }, out: STANDARD, fit: 'contain' },
  { name: 'android-tablet.jpg', src: 'IMG_0689.jpeg', crop: { left: 360, top: 420, width: 3672, height: 2450 }, out: STANDARD, fit: 'contain' },
  { name: 'android-eink.jpg', src: 'IMG_0700.jpeg', crop: { left: 190, top: 80, width: 3842, height: 2870 }, out: STANDARD, fit: 'contain' },
  { name: 'crema-eink.jpg', src: 'IMG_0699.jpeg', crop: { left: 0, top: 0, width: 3024, height: 4032 }, out: { width: 1000, height: 1333 }, fit: 'contain' },
  { name: 'macos-desk.jpg', src: 'IMG_0702.jpeg', crop: { left: 0, top: 100, width: 3900, height: 2200 }, out: STANDARD },

  // ESP32 panels: close-ups preserve the complete panel and current UI.
  { name: 'ips35.jpg', src: 'IMG_0698.jpeg', crop: { left: 1340, top: 1100, width: 1500, height: 1000 }, out: STANDARD, fit: 'contain' },
  { name: 'box86.jpg', src: 'IMG_0696.jpeg', crop: { left: 1170, top: 620, width: 2000, height: 1800 }, out: STANDARD, fit: 'contain' },
  { name: 'round-amoled.jpg', src: 'IMG_0694.jpeg', crop: { left: 240, top: 930, width: 2320, height: 2220 }, out: STANDARD, fit: 'contain' },
  { name: 'ttgo.jpg', src: 'IMG_9702.jpeg', crop: { left: 0, top: 1444, width: 3024, height: 1728 }, out: STANDARD },
  { name: 'ips10.jpg', src: 'IMG_0693.jpeg', crop: { left: 190, top: 240, width: 3770, height: 2220 }, out: STANDARD, fit: 'contain' },
  // The distant TRMNL overview is less legible than its existing close-up.
  { name: 'trmnl_75.jpg', src: 'IMG_9708.jpeg', crop: { left: 216, top: 396, width: 3780, height: 2160 }, out: STANDARD },
  { name: 'epd47.jpg', src: 'IMG_0687.jpeg', crop: { left: 0, top: 370, width: 4032, height: 2460 }, out: STANDARD, fit: 'contain' },
  { name: 'nm-epd-420.jpg', src: 'IMG_0695.jpeg', crop: { left: 720, top: 270, width: 3100, height: 2600 }, out: STANDARD, fit: 'contain' },
  { name: 'xteink.jpg', src: 'IMG_9682.jpeg', crop: { left: 0, top: 234, width: 4032, height: 2304 }, out: STANDARD },
  { name: 't-embed.jpg', src: 'IMG_0095.jpeg', crop: { left: 97, top: 1042, width: 2880, height: 1646 }, out: STANDARD },
  { name: 't-display-pro.jpg', src: 'IMG_0701.jpeg', crop: { left: 300, top: 790, width: 3732, height: 1940 }, out: STANDARD, fit: 'contain' },
  { name: 'waveshare-147.jpg', srcPath: WAVESHARE_SRC, crop: { left: 109, top: 0, width: 949, height: 542 }, out: STANDARD },

  // Pixel displays: full matrices, with real light diffusion and bezel intact.
  { name: 'pixoo64.jpg', src: 'IMG_0692.jpeg', crop: { left: 140, top: 390, width: 2800, height: 2910 }, out: STANDARD, fit: 'contain' },
  { name: 'idotmatrix.jpg', src: 'IMG_0684.jpeg', crop: { left: 1650, top: 790, width: 900, height: 1030 }, out: STANDARD, fit: 'contain' },
  { name: 'timebox.jpg', src: 'IMG_0697.jpeg', crop: { left: 1200, top: 1000, width: 1400, height: 1470 }, out: STANDARD, fit: 'contain' },
  { name: 'tc001.jpg', src: 'IMG_0690.jpeg', crop: { left: 440, top: 730, width: 3460, height: 1390 }, out: STANDARD, fit: 'contain' },
  { name: 'tc001-usage.jpg', src: 'IMG_0691.jpeg', crop: { left: 400, top: 770, width: 3390, height: 1320 }, out: STANDARD, fit: 'contain' },

  // A full desk view is linked from the foreground hero.
  { name: 'desk-overview.jpg', src: 'IMG_0704.jpeg', crop: { left: 0, top: 0, width: 3024, height: 4032 }, out: { width: 1500, height: 2000 } },
  // Desk hero: foreground devices, leaving unrelated monitor windows outside.
  { name: 'setup-full.jpg', src: 'IMG_0704.jpeg', crop: { left: 0, top: 2016, width: 3024, height: 2016 }, out: HERO },
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
        .resize(task.out.width, task.out.height, { fit: task.fit || 'cover', background: BACKGROUND })
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
            .resize(paneW, comp.out.height, { fit: 'contain', background: BACKGROUND }).toBuffer(),
        );
      }
      await sharp({
        create: { width: comp.out.width, height: comp.out.height, channels: 3, background: BACKGROUND },
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
  if (ok !== tasks.length + composites.length) process.exitCode = 1;
}

run();
