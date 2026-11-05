# design/fonts

CJK companions to the brand type stack (DESIGN.md §3: IBM Plex Sans / KR / JP
as one family — Korean and Japanese are never set in a Latin-only face).

| File | Source | License |
|---|---|---|
| IBMPlexSansKR-{Regular,Bold}.ttf | google/fonts `ofl/ibmplexsanskr` | OFL 1.1 |
| IBMPlexSansJP-{Regular,Bold}.ttf | google/fonts `ofl/ibmplexsansjp` | OFL 1.1 |

Latin IBM Plex Sans and JetBrains Mono live in `bridge/assets/fonts/` (the
bridge renderers were their first consumer). Marketing composition
(`scripts/compose-appstore-screenshots.py`) uses both locations.

The Ulanzi build stages the KR and JP faces with `OFL-IBMPlexSansKR.txt` and
`OFL-IBMPlexSansJP.txt` from this canonical directory; generated copies under
plugin resources are ignored. Its WASM renderer cannot fall back to system
fonts, so a script with no bundled face renders as tofu.
