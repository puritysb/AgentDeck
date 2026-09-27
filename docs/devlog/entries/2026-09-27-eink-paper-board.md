# 2026-09-27 — Paper Board for the Android e-ink Dashboard

The Android e-ink Dashboard was a shrunken tablet: equal session cards cut off
behind "More sessions · swipe", a usage card floating over the terrarium, a
`S:5` masthead, and a bottom panel reading "IDLE — no active work" while
sessions were working. It is now the Paper Board of
[DESIGN.md §5.14](DESIGN.md): sessions ranked by what they ask of the
reader (needs you → working rows with live activity → one line of idle marks
and names), usage, finished work, and the terrarium in whatever space the text
leaves — never over a zone. Iterated on the Lenovo tablet at Crema geometry
(1072×1448, 220 dpi) over eight capture rounds, judged at full resolution by
glance value rather than data completeness.

Panel capability is used where it exists instead of designing for the weakest:
16-level grey keeps the grey terrarium; colour Kaleido puts the §2.7 paper hues
on the zone heading, the needs-you band and usage severity and draws brand
marks in brand colour; each text zone is its own refresh region (sessions A2,
usage and finished work DU), and the terrarium keeps its own animated region,
which moves only while a creature is active.

Usage took three passes. Page-wide bars in two columns wasted width and made
the numbers the smallest thing on the zone; compact chips then dropped the reset
time and thinned the bars; chips with `resets 4h 37m` repeated one word per
window and wrapped in no fixed order. It is now an aligned table — window, bar
of one fixed width, `42%`, `4h 37m` — with the captions said once, so the eye
runs straight down the numbers.

"Done" shows a judged task's `taskSummary`, else an answered turn's first
sentence; a prompt still awaiting its answer, automated turns, abandoned tasks
and tool rows never count. Building it exposed a daemon bug: the connect-time
`timeline_history` spent its 12 KB budget newest-first and only then had tool
rows stripped by the event transformer (surfaces negotiate after connect, so
every dashboard lacks the tool-event capability at that moment). With tool
noise dominating the tail, the tablet received one entry. `BridgeCore`
now applies the same readability filter before the byte cap
(`setConnectHistoryFilter`).
