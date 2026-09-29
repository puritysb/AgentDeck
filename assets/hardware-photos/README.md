# Hardware capture archive

Source photographs for the device cards on the public Devices catalog
(`docs/hardware/index.html`) and the hardware sections of `README.md`.
The current public gallery primarily uses the September 28, 2026 captures.
Earlier close-ups remain where the new set does not show the device as clearly.

`scripts/crop-hardware-images.mjs` reads this directory by default and writes the
cropped results into `docs/media/`. Both the sources and the crops are committed,
so re-framing a card never depends on files outside the repository:

```bash
node scripts/crop-hardware-images.mjs              # from this archive
node scripts/crop-hardware-images.mjs ~/some/dir   # from raw camera originals
```

## Why these files differ from the camera originals

- **EXIF rotation is baked in.** The originals carry orientation tag 6 on many
  frames — stored 4032×3024 while the photo is really 3024×4032 portrait. Every
  file here is already upright, so the crop table's coordinates are plain
  display-space pixels and no orientation handling is needed to read them. This
  removes the failure that produced a round of unusable crops: passing an
  explicit angle to sharp's `.rotate()` skips the EXIF tag and crops from the
  unrotated buffer.
- **Re-encoded at quality 78** (mozjpeg), at full capture resolution, with camera metadata
  (including GPS) stripped. Outputs are sized for the public gallery; square and portrait devices
  use a dark stage to retain their complete screen. Small devices cropped from
  the desk overview carry less detail than dedicated close-ups.

Filenames keep their original `IMG_####` identity so each row of the crop table
maps to a capture one-to-one.

## Not from the camera set

- `waveshare-147-source.jpg` — the Waveshare LCD 1.47" was never photographed in
  the session set. This is a hand-cropped screenshot, the only capture of that
  board, so it is passed through with just the card frame applied.

## Archived but not shipped as a card

- `IMG_0096.jpg` — the T-Display-S3-Pro **camera unit**, handheld, on its CAM
  page. It is the only capture of the rear camera actually capturing and of the
  portrait Pocket UI that unit boots into, so it is kept here. It is not a card
  source: the device is portrait and handheld, and no 1.75:1 frame around it
  avoids either clipping the tab bar or filling half the card with hand. The
  Focus Strip card now uses `IMG_0701` (the September usage-page close-up).

## September 28, 2026 selection

These photographs were supplied by the project owner for public documentation.
The generator rotates, crops, resizes, pads, and JPEG-encodes them. Original
screens and reflections are preserved, including the captured IPS10 voice timeout.

| Camera source | Published view |
|---|---|
| `IMG_0684.jpg` | Ulanzi D200H; iDotMatrix status board |
| `IMG_0687.jpg` | LilyGo EPD47 focused work and usage |
| `IMG_0688.jpg` | iPad native aquarium |
| `IMG_0689.jpg` | Android tablet native aquarium |
| `IMG_0690.jpg` | TC001 agent creatures |
| `IMG_0691.jpg` | TC001 usage page |
| `IMG_0692.jpg` | Pixoo64 aquarium and usage |
| `IMG_0693.jpg` | IPS10 project and usage dashboard |
| `IMG_0694.jpg` | Round AMOLED aquarium |
| `IMG_0695.jpg` | NM-EPD-420 e-ink glance face |
| `IMG_0696.jpg` | 86 Box aquarium |
| `IMG_0697.jpg` | Timebox Mini expressive face |
| `IMG_0698.jpg` | IPS 3.5-inch landscape aquarium |
| `IMG_0699.jpg` | Crema S portrait e-ink dashboard |
| `IMG_0700.jpg` | Moaan Pantone landscape color e-ink dashboard |
| `IMG_0701.jpg` | T-Display-S3-Pro usage page |
| `IMG_0702.jpg` | macOS dashboard on a monitor |
| `IMG_0704.jpg` | Full desk, foreground hero, Stream Deck+ and 15-key family |

The near-duplicate `IMG_0685`, `IMG_0686`, and `IMG_0703` were not imported.
Existing TRMNL, TTGO, XTeink, T-Embed, and Waveshare close-ups stay in use.
The foreground hero omits unrelated monitor windows; its full-desk link opens
`docs/media/desk-overview.jpg`. The macOS crop omits the App Store Connect table
below the dashboard. All crop coordinates and output dimensions live in the
[generator](../../scripts/crop-hardware-images.mjs).

Consumers: [README](../../README.md), [Apple guide](../../docs/apple-app.md),
[Android guide](../../docs/android.md), [Devices catalog](../../docs/hardware/index.html),
and the [Pages landing template](../../scripts/pages-index.html). The design
system Asset library indexes this archive and the generated `docs/media/` files.
