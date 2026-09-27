# 2026-09-27 — TRMNL roster follows the Paper Board

The TRMNL 7.5" dashboard gave every session an equal card, so an idle session
took the space of a working one, and a card with no summary printed filler
("Working. Waiting for the next update.", "Ready for the next request."). The
masthead said "5 sessions" without saying which kind.

Now only sessions that need the reader or are working get a card; quiet
sessions collapse into one IDLE line of glyph + name at the foot of the card
band, with "+N ACTIVE" when active cards overflow. With nothing active, the
quiet sessions get the cards back. The masthead counts by state ("1 need you, 3
working, 3 idle") and degrades on a narrow panel by dropping the quiet
categories, then the font — the X4 geometry diagnostic had shown it printing
over the wordmark. Filler copy is gone.

A card's second line is now the state marker plus the live activity at full
body size, with the state word only when there is no activity or the session
waits on the reader. Sharing one line as `WORKING: <activity>` had pushed long
activity down the fit cascade into the CP437 classic font, and the 107 px
cards of a 2×2 grid have room for three text lines, which left the work summary
below the card floor.

The ANSWER face picks a session that has an answer, fills the page below it
with the other recent finished items, and says "Nothing finished yet." rather
than a placeholder sentence. Geometry is unchanged (`eink_dashboard_layout.h`
and the XTeink mirror are untouched); the idle line is carved from the card
band inside `dashboardLayout`. `Trmnl75Preview.swift` mirrors the change and
is re-pinned.

Sim caveat: the host U8g2 shim is a no-op, so every non-ASCII line — Korean
text, and any work summary containing ` · ` — is invisible in sim renders
while the hardware draws it.
