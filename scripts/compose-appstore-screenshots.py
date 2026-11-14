#!/usr/bin/env python3
"""Compose App Store marketing screenshots from raw app captures.

    python3 scripts/compose-appstore-screenshots.py                # all locales/platforms
    python3 scripts/compose-appstore-screenshots.py ko             # one locale
    python3 scripts/compose-appstore-screenshots.py ko macOS      # one locale+platform

Reads the raw captures written by `capture-appstore-screenshots.sh` from
`apple/appstore-submission/screenshots-raw/<platform>/` and writes captioned,
framed versions to `.../screenshots/<locale>/<platform>/` — the directories the
submission validator checks — at exactly the raw pixel dimensions (already
App Store-legal). App Previews stay locale-common; only stills are localized.

Design-system compliance (DESIGN.md):
  * Marketing palette only (`--ink/tide/kelp/amber`), never the `--ui-*`
    product brights (§2.6 rule) and no off-token hex.
  * Two faces: IBM Plex Sans for human copy, JetBrains Mono for the kicker —
    "Mono is also the kicker" (§3). Korean/Japanese set in IBM Plex Sans KR/JP
    (design/fonts/, OFL) — never a Latin-only face (§3 rule).
App Review safety, deliberately:
  * The app UI is inset unmodified — never redrawn, retouched, or re-skinned.
  * Captions describe only capabilities this sandboxed build actually ships.
  * No Apple hardware bezel or product likeness; a neutral rounded card
    avoids both the wrong-device-frame rejection and trademark issues.
  * No real desk photography: the committed hardware shots include live
    browser/terminal windows and personal desk context, which the runbook's
    capture rules exclude from store assets.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "apple" / "appstore-submission" / "screenshots-raw"
SHOTS = ROOT / "apple" / "appstore-submission" / "screenshots"

FONTS = {
    "en": (
        ROOT / "bridge" / "assets" / "fonts" / "IBMPlexSans-Bold.ttf",
        ROOT / "bridge" / "assets" / "fonts" / "IBMPlexSans-Regular.ttf",
    ),
    "ko": (
        ROOT / "design" / "fonts" / "IBMPlexSansKR-Bold.ttf",
        ROOT / "design" / "fonts" / "IBMPlexSansKR-Regular.ttf",
    ),
    "ja": (
        ROOT / "design" / "fonts" / "IBMPlexSansJP-Bold.ttf",
        ROOT / "design" / "fonts" / "IBMPlexSansJP-Regular.ttf",
    ),
}
FONT_MONO = ROOT / "bridge" / "assets" / "fonts" / "JetBrainsMono-Bold.ttf"

# design/tokens.css — marketing surface only.
INK_900 = (0x0E, 0x1F, 0x1F)
INK_800 = (0x15, 0x30, 0x2F)
INK_700 = (0x1F, 0x45, 0x44)
TIDE_50 = (0xF5, 0xF3, 0xEC)
TIDE_300 = (0xA8, 0xB0, 0x9A)
KELP_300 = (0x6F, 0xB6, 0xA8)
AMBER_500 = (0xC8, 0x92, 0x3A)

# beat -> locale -> (headline, sub). Accent kept per beat, not per locale.
ACCENTS = {
    "01-fleet": KELP_300,
    "02-all-sessions": KELP_300,
    "03-attention": AMBER_500,
    "04-complete": KELP_300,
    "05-devices": KELP_300,
    "05-remote": AMBER_500,
}

CAPTIONS = {
    "01-fleet": {
        "en": ("Every coding agent,\none calm surface",
               "Claude Code, Codex, OpenCode and OpenClaw — side by side, live."),
        "ko": ("모든 코딩 에이전트를\n하나의 잔잔한 화면에",
               "Claude Code · Codex · OpenCode · OpenClaw — 나란히, 실시간으로."),
        "ja": ("すべてのコーディングエージェントを\nひとつの静かな画面に",
               "Claude Code、Codex、OpenCode、OpenClaw — 並んで、リアルタイムで。"),
    },
    "02-all-sessions": {
        "en": ("Five sessions,\none timeline",
               "Deselect a session and every agent's activity streams together."),
        "ko": ("다섯 개의 세션,\n하나의 타임라인",
               "세션 선택을 해제하면 모든 에이전트의 활동이 한 흐름으로 모입니다."),
        "ja": ("5つのセッション、\nひとつのタイムライン",
               "選択を外せば、全エージェントの動きがひとつの流れに。"),
    },
    "03-attention": {
        "en": ("Know the moment\nyou're needed",
               "Amber means an agent is waiting on you. Nothing else animates."),
        "ko": ("당신이 필요한 순간을\n바로 알 수 있게",
               "황색은 에이전트가 기다린다는 신호 — 그 외엔 아무것도 깜빡이지 않습니다."),
        "ja": ("呼ばれた瞬間が\nすぐわかる",
               "琥珀色はエージェントが待っている合図。ほかは何も点滅しません。"),
    },
    "04-complete": {
        "en": ("Work lands.\nThe tank goes quiet.",
               "Finished sessions settle to the floor — calm you can see."),
        "ko": ("작업이 끝나면\n수조는 고요해집니다",
               "끝난 세션은 바닥에 내려앉습니다 — 눈에 보이는 평온."),
        "ja": ("仕事が終われば\n水槽は静かになる",
               "終わったセッションは底へ沈む — 見える静けさ。"),
    },
    # iPhone/iPad Remote tab (2.2.0): the read-only iCloud reader that the
    # Apple Watch app shares. Synthetic WatchFixture "busy" snapshot.
    "05-remote": {
        "en": ("Away from your Mac,\nstill in the loop",
               "Read-only work counts, sessions and allowance through your\nprivate iCloud — on iPhone, iPad and Apple Watch."),
        "ko": ("Mac을 떠나 있어도\n흐름은 그대로",
               "개인 iCloud로 받는 읽기 전용 작업 수 · 세션 · 사용량 —\niPhone, iPad, Apple Watch에서."),
        "ja": ("Macを離れていても\n流れはそのまま",
               "プライベートiCloudで届く読み取り専用の件数・セッション・使用量 —\niPhone、iPad、Apple Watchで。"),
    },
    # macOS-only feature panel: the downstream rail, cropped from the fleet
    # capture. The rail is the one surface that shows the whole desk fleet.
    "05-devices": {
        "en": ("Your desk runs\ndownstream",
               "Stream Deck, D200H, pixel displays and e-ink mirror the tank, live."),
        "ko": ("책상 위 기기들이\n함께 흐릅니다",
               "Stream Deck · D200H · 픽셀 디스플레이 · e-ink가 수조를 실시간으로 비춥니다."),
        "ja": ("デスクのデバイスも\nいっしょに流れる",
               "Stream Deck、D200H、ピクセルディスプレイ、e-inkが水槽を映します。"),
    },
}

# Derived beats: (output stem, source raw stem, crop box in fractional coords)
# A crop shows a real region of the untouched capture at larger scale — feature
# introduction without fabricating UI. Fractions chosen to frame the topology
# rail (UPSTREAM + DOWNSTREAM) with a little water around it.
DERIVED = {
    "macOS": [("05-devices", "01-fleet", (0.735, 0.015, 1.0, 0.72))],
}


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def rounded_shadow(size: tuple[int, int], radius: int, blur: int) -> Image.Image:
    shadow = Image.new("L", size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        [0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=190
    )
    return shadow.filter(ImageFilter.GaussianBlur(blur))


def round_corners(image: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, image.size[0] - 1, image.size[1] - 1], radius=radius, fill=255
    )
    out = image.convert("RGBA")
    out.putalpha(mask)
    return out


def vertical_wash(size: tuple[int, int]) -> Image.Image:
    """Deep-water gradient: ink-900 at the edges, ink-700 through the middle."""
    width, height = size
    base = Image.new("RGB", (1, height))
    px = base.load()
    for y in range(height):
        t = y / max(1, height - 1)
        k = 1 - abs(t - 0.33) * 1.7
        k = max(0.0, min(1.0, k))
        px[0, y] = tuple(
            int(INK_900[i] + (INK_700[i] - INK_900[i]) * k) for i in range(3)
        )
    return base.resize((width, height))


def paste_card(canvas: Image.Image, card: Image.Image, pos: tuple[int, int], unit: int) -> None:
    radius = int(unit * 0.022)
    cx, cy = pos
    shadow = rounded_shadow(card.size, radius, int(unit * 0.018))
    shadow_layer = Image.new("RGB", card.size, INK_900)
    canvas.paste(shadow_layer, (cx, cy + int(unit * 0.008)), shadow)
    rounded = round_corners(card, radius)
    canvas.paste(rounded, (cx, cy), rounded)
    ImageDraw.Draw(canvas).rounded_rectangle(
        [cx, cy, cx + card.size[0] - 1, cy + card.size[1] - 1],
        radius=radius,
        outline=INK_800,
        width=max(1, int(unit * 0.0018)),
    )


def draw_caption(draw: ImageDraw.ImageDraw, locale: str, stem: str,
                 origin: tuple[int, int], unit: int, portrait: bool) -> int:
    """Kicker + headline + sub at `origin`; returns the y below the block."""
    headline, sub = CAPTIONS[stem][locale]
    accent = ACCENTS[stem]
    bold_path, reg_path = FONTS[locale]

    eyebrow_size = int(unit * (0.021 if portrait else 0.018))
    head_size = int(unit * (0.058 if portrait else 0.046))
    sub_size = int(unit * (0.026 if portrait else 0.021))

    f_eyebrow = font(FONT_MONO, eyebrow_size)  # mono kicker — DESIGN.md §3
    f_head = font(bold_path, head_size)
    f_sub = font(reg_path, sub_size)

    x, y = origin
    draw.text((x, y), "AGENTDECK", font=f_eyebrow, fill=accent)
    y += int(eyebrow_size * 2.0)
    for line in headline.split("\n"):
        draw.text((x, y), line, font=f_head, fill=TIDE_50)
        y += int(head_size * 1.18)
    y += int(sub_size * 0.5)
    for line in sub.split("\n"):
        draw.text((x, y), line, font=f_sub, fill=TIDE_300)
        y += int(sub_size * 1.4)
    return y + int(sub_size * 0.8)


def compose_full(shot: Image.Image, locale: str, stem: str) -> Image.Image:
    """Caption on top, full app capture inset below."""
    W, H = shot.size
    portrait = H > W
    unit = min(W, H)
    margin = int(unit * 0.062)

    canvas = vertical_wash((W, H))
    y = draw_caption(ImageDraw.Draw(canvas), locale, stem, (margin, margin), unit, portrait)

    avail_h = H - y - margin
    avail_w = W - margin * 2
    scale = min(avail_w / W, avail_h / H)
    card = shot.resize((int(W * scale), int(H * scale)), Image.LANCZOS)
    paste_card(canvas, card, ((W - card.size[0]) // 2, y), unit)
    return canvas


def compose_panel(shot: Image.Image, locale: str, stem: str,
                  crop_frac: tuple[float, float, float, float]) -> Image.Image:
    """Caption left, enlarged crop of the capture right (landscape only)."""
    W, H = shot.size
    unit = min(W, H)
    margin = int(unit * 0.08)

    left, top, right, bottom = crop_frac
    panel = shot.crop((int(W * left), int(H * top), int(W * right), int(H * bottom)))

    canvas = vertical_wash((W, H))
    draw_caption(ImageDraw.Draw(canvas), locale, stem,
                 (margin, int(H * 0.30)), unit, portrait=False)

    avail_h = H - margin * 2
    avail_w = int(W * 0.40)
    scale = min(avail_w / panel.size[0], avail_h / panel.size[1])
    card = panel.resize(
        (int(panel.size[0] * scale), int(panel.size[1] * scale)), Image.LANCZOS
    )
    cx = W - margin - card.size[0]
    cy = (H - card.size[1]) // 2
    paste_card(canvas, card, (cx, cy), unit)
    return canvas


def main() -> int:
    args = sys.argv[1:]
    locales = [a for a in args if a in FONTS] or list(FONTS)
    platforms = [a for a in args if a in ("macOS", "iPhone", "iPad")] or ["macOS", "iPhone", "iPad"]

    for locale in locales:
        for platform in platforms:
            raw_dir = RAW / platform
            if not raw_dir.is_dir():
                print(f"skip {platform}: no captures", file=sys.stderr)
                continue
            out_dir = SHOTS / locale / platform
            out_dir.mkdir(parents=True, exist_ok=True)
            for raw in sorted(raw_dir.glob("*.png")):
                if raw.stem not in CAPTIONS:
                    continue
                shot = Image.open(raw).convert("RGB")
                out = compose_full(shot, locale, raw.stem)
                out.convert("RGB").save(out_dir / raw.name)
                print(f"composed {locale}/{platform}/{raw.name} ({shot.size[0]}x{shot.size[1]})")
            for out_stem, src_stem, crop in DERIVED.get(platform, []):
                src = raw_dir / f"{src_stem}.png"
                if not src.is_file():
                    continue
                shot = Image.open(src).convert("RGB")
                out = compose_panel(shot, locale, out_stem, crop)
                out.convert("RGB").save(out_dir / f"{out_stem}.png")
                print(f"composed {locale}/{platform}/{out_stem}.png ({shot.size[0]}x{shot.size[1]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
