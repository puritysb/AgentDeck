# 2026-09-13 — Companion controls and measured release delivery

PR #324 implements TTGO Usage default and the two companion interactions:
T-Embed presents a stable FIFO approval queue with explicit answer selection;
T-Display-S3-Pro pins sessions by ID and offers a paginated waiting list without
stealing navigation. Pending-answer and exact-request guards prevent a stale
selection from answering a replacement request. Host tests drive the actual
LVGL controls for both boards, alongside five native C++ suites.

## Startup defect caught by installed-runtime verification

The npm release soak exposed a pre-existing unbounded synchronous registry-file
read: opening the protected Apple container could prevent an agent from starting
before the bounded HTTP request was ever reached. PR #325 bounds the Python
lookup to 200 ms in every installer mirror and makes the OpenCode registry read
asynchronous and bounded, with at most one outstanding read per registry path.
Regression coverage uses a blocked FIFO and a permanently pending read.

4494 JavaScript tests passed with one skipped; build, typecheck, protocol drift,
token mirrors, version, docs, design-system and devlog checks passed. Clean-source
design lint remained at the 89-violation baseline. The macOS Release archive
verification passed locally and in the distribution workflow.

Installed Swift-only, npm CLI-only and coexistence tests used real OpenCode turns,
Mac/deck previews and a single daemon owner. A normal CLI stop promoted the Swift
app, which reclaimed 9120 after the existing kernel port hold expired. A
standalone Codex probe was not observed and is not counted as delivery evidence;
changed hook commands require Codex's normal trust refresh. Full evidence:
[release delivery record](https://github.com/puritysb/AgentDeck/issues/314#issuecomment-5653078997).

## Channel states measured on September 13

| Channel | Outcome |
|---|---|
| npm | 1.3.3 public; all four package versions and `latest` read from the registry. CI run 34755486192. |
| Apple | 1.3.0 live; iOS and macOS 1.3.2 build 6801 submitted, API `WAITING_FOR_REVIEW`, `AFTER_APPROVAL`. Distribution run 34755060912; readback run 34756195166. 1.3.1 build 6701 was superseded before submission. |
| Android | 1.3.1 (17) public on Play at 21:08 KST; 100% rollout, 177 countries, managed publishing off. APK release run 34753626261. Lenovo upgraded in place and launched. |
| ESP32 | 1.3.0 public, run 34753627616; 12 boards and 62 assets. All 60 binaries downloaded and checked against SHA256SUMS plus manifest size/hash fields. |
| Elgato | 1.2 live, 1.3 Pending review. Auto-publish changes do not persist while review is pending. The owner's authorization to publish after approval remains in effect. |
| Ulanzi | 1.3.0 remains in Works under review; the submitted package and seven-language listing were preserved. |

The Elgato DRM download was installed and connected: 23 keypad actions and four
encoder registrations, with live session/usage rendering on the normal Stream
Deck preview. This is not a physical encoder-rotation or touch-strip appearance
test. Package digest and the publication-setting limitation are recorded in
[the listing](marketplace/elgato/LISTING.md).

T-Embed received 1.3.0 over WiFi OTA and T-Display-S3-Pro over verified merged USB
flash. Their post-boot build identities were read back. Physical button/optical
verification remains separate from the actual-LVGL host interaction tests.
