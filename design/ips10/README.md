# IPS10 aquarium assets

The active background is `ocean.png`, generated with the built-in image generation tool on 2026-09-23. It contains only underwater scenery; all logos, characters, text, gauges and interaction remain live LVGL objects. Original output is retained unchanged. `encode_ocean.py` performs the technical resize to 640×400 and RGB565 conversion, producing one shared 500 KiB flash-resident image, displayed at 2× on the landscape IPS10. No runtime decompression or full-screen canvas is allocated.

Run `python3 design/ips10/encode_ocean.py` to regenerate the header; add `--check` to detect PNG-to-consumer drift. Preview with the real IPS10 native interaction suite, not only the asset.

Generation prompt (built-in tool): “Create an AgentDeck dashboard BACKGROUND ASSET ONLY, landscape 16:10, full bleed, no device frame. Beautiful restrained 3D rendered underwater aquarium diorama. Deep midnight navy and muted teal, soft blue light shafts from surface. Main upper 75 percent exceptionally dark quiet open water, only subtle depth and gradients, empty for live UI overlays. Bottom 18 percent a low continuous reef of smooth dark blue rocks and sparse elegant teal kelp at left and right outer edges. Tiny dim suspended bubbles only near edges. Crisp polished low-poly sculptural forms with soft realistic ambient occlusion, sophisticated calm aquarium. Palette derived from deep navy, ink teal, muted kelp teal, very subtle cyan highlights. No bright central objects. Absolutely NO text, NO letters, NO numbers, NO logos, NO characters, NO animals, NO fish, NO UI, NO cards, NO buttons, NO gauges. The dark centre must remain legible behind overlaid live white text. All decorative content low contrast. 1280x800 composition.”

Typography uses the existing OFL IBM Plex Sans KR family, with Regular body/metadata and Bold ASCII headings at 20px and 28px (`font_studio_20` / `font_studio_28`). Generated `.cinc` headers record the exact lv_font_conv 1.5.3 arguments. Both faces add `LV_FONT_DECLARE(font_workspace_20)` and `.fallback = &font_workspace_20` so received Korean activity remains readable. Trailing generated blank lines are normalized. All dashboard-owned labels are English; user/agent content is not translated. The header uses the existing `img_logo_48` AgentDeck mark, with cyan tint.

The previous `room.py`/`room.png`/`encode_room.py` Blender workbench and `keycap.py`/`keycap.png`/`encode.py` are preserved design iterations. Their images are no longer compiled into the active aquarium UI.

## Alignment contract (September 23 refinement)

The IPS10 borrows native monitor grouping and type hierarchy, scaled for a desk display. `Grid` in `ips10_workspace.cpp` owns the project-row geometry. Outer margins are 24px; project tracks are equal width with 16px gutters and 16px inner padding. Quota remains a 252px secondary rail separated by 16px. Project and quota headings share a baseline. Each project starts its agent rows after a 96px header; every agent has a 96–120px row, fitted to the space above the voice dock, with its illustration at left and aligned status/activity/worker text at right. When a single project has at least 600px of width, its peer rows share equal horizontal tracks instead of stretching a vertical list across the display. Project results start below the tallest visible peer group, consistently across columns. Unknown activity still stays hidden; blank decorative labels are never added to fill a row.

Typography roles: 28px bold for the wordmark, 20px bold for compact quota values, 20px bold for section/project headings, 20px Regular for work descriptions and results, and 16px Regular for metadata, status, window/reset labels and footer context. Existing 36px numerals remain in detail filters/census. The new ASCII `font_studio_16` is generated with lv_font_conv 1.5.3 from the OFL IBM Plex Sans KR Regular source, 2bpp/no compression, with `font_workspace_20` fallback for received CJK. Exact conversion arguments are recorded in its generated header.

`creatures.py` uses Blender 5.2 to extrude the existing canonical alpha masks into three shallow reliefs (Claude, Codex, OpenClaw), with colors from `design/tokens.css`. It preserves the current scene and never edits the original marks. These are baked 112px RGBA illustrations, not new live 3D creatures. `encode_creatures.py --check` verifies their generated flash-resident RGB565+A8 consumers (110.25 KiB total). All seats share those three images; other agents retain their canonical glyphs. There is no new runtime renderer, canvas or image-decompression allocation.

### USAGE and voice dock (v8)

USAGE groups actual Claude/Codex/z.ai windows and confirmed subscription metadata
by provider. Missing windows are omitted, including a missing 5h allowance. Luna
uses a crescent and remaining percentage only while regular Codex quota is exhausted;
the next reset snapshot restores the ordinary windows. Antigravity is plan/date only.
The list is content-sized and scrolls within its available height when fully populated.

The header contains the product mark and a two-segment Aquarium/Details switch.
Connection failures belong in the attention banner. The bottom dock replaces token
counters: wake availability, listening, recognition, processing owner, heard text and
reply. Text is bounded and marshalled from audio/network tasks; only the UI task
updates widgets. Details shares live-census labels and waiting-on-work policy with
macOS Collaboration. Live counts and task-scoped observations are not interchangeable.
