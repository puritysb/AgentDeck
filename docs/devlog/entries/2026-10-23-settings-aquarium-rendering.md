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
Settings/minimized samples and lifecycle log in the main checkout. The clean
[full verification receipt](verification/receipts/2026-10-23-e075748.json)
at `e0757488f439f9b8c0dadb719c8a5c5e89596302` records `dirty=false` and all
**25 automatic gates passing in 26 min 3 s**. [PR #600](https://github.com/puritysb/AgentDeck/pull/600)
merged as `24be55d2fa41462d1ab6106a2006e73876573fb6`, with the same tree as that
verified source. Source CI passed 13 checks with the TTGO PR check skipped;
Windows runtime was skipped locally and passed in CI on Node 22/24/26. Three
lab gates remain unattested.

The macOS 9401 [upload run](https://github.com/puritysb/AgentDeck/actions/runs/39964340470)
succeeded and the Store artifact passed signing and archive checks. A
Development-signed derivative with equivalent code/resources and unchanged
entitlements passed two Settings-close cycles and a minimize/restore cycle in
PID 79713, with seven live sessions. Its six click/AX pairs totalled **6.485 s**;
Settings and minimized samples again had no DisplayLinkClock/frame-pacing
sightings. These are separate 9401 measurements, not a relabelling of the v5
Debug data above. Full evidence and tool-timing limits are in the
[delivery record](RELEASING.md#2026-10-23-macos-settings-responsiveness-replacement).
Physical deck input and sleep/wake remain unverified.

### Submission state propagation stopped the first attempt safely

After the portal withdrew 9301 and attached 9401,
[preparation](https://github.com/puritysb/AgentDeck/actions/runs/39969347034)
read back the exact build and release copy. The
[first submit run](https://github.com/puritysb/AgentDeck/actions/runs/39969479997)
created the intended draft and item, but stopped before the final mutation
because the version's Ready for Review state had not propagated yet. The portal
then showed the ready version and correct 9401 association. A
[resumed run](https://github.com/puritysb/AgentDeck/actions/runs/39969655330)
reused the same draft, confirmed submission at **2026-10-23T14:27:02.393Z**,
and returned submission `ab60c632-4870-4b07-b22e-8b367a2d13a8`.
No duplicate draft or broader guard was needed. The exact copy hash stayed
`53c224bbb3c8dfeedf54fdfe321aa7a37b4e8cebdcf0076cd1329171beeb2bac` and
`AFTER_APPROVAL` was retained. The
[final readback](https://github.com/puritysb/AgentDeck/actions/runs/39969780932)
confirmed the version and new submission as `WAITING_FOR_REVIEW`, with 9401
`VALID` and unexpired and the old submission `COMPLETE`. Apple's actual
submission time was **2026-10-23T14:26:58.418Z**, before the helper returned.
This is not a public-release claim. Logs are in `diagnostics/release600-runtime/`.
