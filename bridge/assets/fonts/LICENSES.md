# Bundled fonts

These TTFs are rasterized by resvg-js in the image renderers, including
`bridge/src/glance-frame.ts`. The native Glance renderer bundles these exact
files and uses the same pinned resvg engine. KR/JP are byte-checked copies of
the canonical CJK companions in `design/fonts/`. They are loaded explicitly via
`fontFiles` (not system-font scanning) so device tile rendering is fast and
deterministic across macOS/Linux.

All fonts are licensed under the **SIL Open Font License 1.1** (OFL-1.1),
which permits bundling and redistribution.

| File | Family | Source |
|------|--------|--------|
| `IBMPlexSans-Regular.ttf` | IBM Plex Sans | https://github.com/IBM/plex (OFL-1.1) |
| `IBMPlexSans-Bold.ttf` | IBM Plex Sans (Bold) | https://github.com/IBM/plex (OFL-1.1) |
| `JetBrainsMono-Regular.ttf` | JetBrains Mono | https://github.com/JetBrains/JetBrainsMono (OFL-1.1) |
| `JetBrainsMono-Bold.ttf` | JetBrains Mono (Bold) | https://github.com/JetBrains/JetBrainsMono (OFL-1.1) |

IBM Plex Sans + JetBrains Mono are the two canonical AgentDeck design-system
faces (see `DESIGN.md` §3). `IBM Plex Sans` is the `defaultFontFamily` passed to
resvg so any unresolved family in the shared SVG renderers (e.g. `Inter`,
`Arial`, `monospace`) falls back to a design-system face instead of dropping
text entirely.

Glance redistribution notices, including OFL texts, are in
[Glance-ThirdPartyNotices.txt](../../../apple/AgentDeck/Resources/Glance-ThirdPartyNotices.txt).
