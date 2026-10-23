# 2026-10-23 — Background aquarium rendering and Settings latency

The [unused Keychain read](docs/devlog/entries/2026-10-23-settings-main-thread-keychain.md)
was a concrete main-thread dependency, but removing it did not explain all
Settings delays. This follow-up records the comparison and failed first
candidate so that later successful samples do not erase those limits.

### Same-process baseline

On master `06926684`, app PID **90257** stayed running while the aquarium was
changed from 3D to default 2D and back to 3D. Each measured Settings sequence
visited six tabs. The user's 3D preference was restored afterward.

| Measurement | Default 2D | Restored 3D |
| --- | --- | --- |
| Six click calls, summed | 708 ms | 11,384 ms |
| Six following AX reads, summed | 4,102 ms | 12,037 ms |
| Combined measured calls | **4.810 s** | **23.421 s** |
| Main-thread sample count | 2,075 | 2,001 |
| DisplayLinkClock branch | 0 | 1,557 |
| Dominant waitForFramePacing branch | 0 | 915 |

The roughly **5-second versus 24-second** comparison includes automation and AX
work; it is not input-to-paint latency. Sample counts aggregate stack sightings,
not CPU consumption or one continuous stall. An earlier sequence exceeded its
30-second whole-call budget; it did not establish a single 30-second AX call.
The file named `90257-minimized-settings.sample.txt` is not a valid minimized
control: a screen capture showed Dashboard visible again. A separate Cmd-W
timeout in PID 56984 had no frame-pacing branch and remains an unresolved
automation/window-targeting case.

The baseline receipt and samples are in the main checkout's gitignored
`diagnostics/settings-rendering-20261023/`, particularly
`comparison-before.json`, `90257-default-settings.sample.txt` and
`90257-restored3d-settings.sample.txt`.

### Why animation pause alone was insufficient

Cancelling SceneEvents updates or pausing entity animations does not remove
RealityKit's renderer. Apple's [AnimationPlaybackController documentation](https://developer.apple.com/documentation/realitykit/animationplaybackcontroller)
describes animation playback control, not suspension of the renderer's frame
clock; completed or stopped controllers are invalid. The chosen candidate
therefore removes RealityView while Settings is frontmost, using a static 2D
fallback, and recreates the renderer around retained scene entities and camera
state on return. Hidden, minimized and fully occluded dashboards use the same
rendering boundary. It does not change the stored appearance preference.

### First candidate did not establish success

The first local Debug candidate, **1.9.2/5, PID 41114**, launched at 21:22 KST.
Its initial Settings sample at **21:23:08 KST** still contained **1,360**
DisplayLinkClock sightings and **917** in the dominant frame-pacing branch,
out of **2,053** main-thread samples. A later sample at **21:25:09 KST** had
neither branch among **1,506** main-thread samples. That later zero is evidence
for that interval only; it does not make the initial transition acceptable.
The navigation automation exceeded a **60-second budget for the whole CUA
loop**, not a measured single 60-second AX call. These samples are retained as
`diagnostics/settings-rendering-postfix-settings.sample.txt` and
`diagnostics/settings-rendering-postfix-settled.sample.txt` in the main checkout.

Independent review also identified a P2 lifetime boundary: disappearance
cancelled the subscription and released the mount, but SwiftUI could retain the
existing RealityView. On return its creation closure would not run again,
leaving it stopped. The correction gates rendering on visibility and changes
the child identity on disappearance to force a fresh renderer. This review
finding is not a proven explanation of the initial runtime delay.

### Later candidates improved Settings but failed 3D restoration

Candidate **v2, PID 61814**, completed the same six Settings clicks and AX reads
in **5.520 seconds**, versus the baseline 3D **23.421 seconds**. Opening Settings
took 227 ms for the action and 871 ms for the following AX read. Its Settings
sample had **2,183** main-thread sightings, **zero DisplayLinkClock** and
**zero frame pacing**. A separate minimized sample had **734** main-thread
sightings and zero for both rendering branches.

This was **not an acceptance pass**: after Settings closed, the 3D aquarium
remained blank for about two minutes. The restored sample contained **211**
DisplayLinkClock sightings among **1,061** main-thread samples, and the scene's
update callback was active. A renderer ticking again therefore did not prove
that its entities were visible. The receipt also notes another app was
foreground during portions of the capture; the timing remains an automation/AX
measurement. Evidence is in `diagnostics/settings-rendering-v2.json` and its
`-settings`, `-minimized` and `-restored` sample files in the main checkout.

Candidate **v3** explicitly removed content before transferring the retained
roots. Diagnostics reported `detach=0`, then `attach=7/7`, but the aquarium was
still blank. Candidate **v4** used a new UUID and remained blank as well.
Successful scene association and renewed view identity were therefore
insufficient to restore the visible scene. Candidate **v5** therefore creates a
fresh camera for each renderer while preserving the camera pose and component
state; the camera object itself is not reused.

### v5 local runtime result

The installed **Debug 1.9.2/5, PID 10511** contains the uncommitted v5 source
above `06926684`. Its debug dylib SHA-256 is
`11c1383e43dac8e184e57b4d1ec696cec2427d9c5bc21afc05b995e17545900b`.
Two Settings-close cycles visually restored the habitat, fish and residents,
with eight live sessions still present. The blank-scene failure did not recur
in these cycles. Mount diagnostics showed active, anchored, enabled roots with
finite transforms; asset import and scene assembly each occurred once.

The final six Settings click/AX-read pairs, in milliseconds, were
**377/689, 248/972, 374/1053, 155/803, 97/1077, 161/1115**: **7.121 seconds**
combined, versus baseline 3D **23.421 seconds**. This is a separate run from
v2's 5.520 seconds. A 30-second Settings sample had **2,240** main-thread
sightings and **zero DisplayLinkClock/frame-pacing sightings**. A 10-second
minimized sample had **738** main-thread sightings and zero for both branches;
Raise then visibly restored 3D in the same process.

One combined AX-read/close/screenshot operation exceeded its **30-second whole
call budget after Settings had actually closed**. Later separate captures,
taking 14–25 seconds, showed working 3D. This establishes neither a 30-second
close delay nor input-to-paint latency. Those automation limits remain distinct
from the observed rendering correction.

The raw receipt is `diagnostics/settings-rendering-v5.json`, with the v5
Settings/minimized samples and lifecycle log in the main checkout. Required
quick/changed/full verification is in progress, with results still pending.
This is local Debug evidence, not acceptance of a signed Store artifact or a
new submission. Earlier 9301/9101/9201 receipts do not cover this correction;
physical deck input and sleep/wake remain unverified.
