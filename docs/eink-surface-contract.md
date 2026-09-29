---
id: spec.eink-surface
title: E-ink Surface Contract
description: The canonical face sets, push/pull delivery modes, arbitration, holds, and physical controls for AgentDeck e-ink surfaces.
category: Specs
locale: en
canonical: true
status: stable
owner: Surface maintainers
reviewed: 2026-08-30
revision: 2026-08-30
source_of_truth: docs/eink-surface-contract.md
validators: [pnpm docs:check, node scripts/build-design-system-viewer.mjs --check]
---

# E-ink Surface Contract

This is the source of truth for the **meaning and arbitration** of AgentDeck
e-ink faces. Pixel layout remains board-specific. Wire compatibility remains in
[AgentDeck Surface Protocol](surface-protocol.md), and physical numeric
specifications remain in [Hardware Compatibility](hardware-compatibility.md).

The governing test is: **is this still worth reading in ten minutes?** A fact
that does not pass that test belongs in the transient band, not the body, and
does not earn a panel refresh.

## 1. Two layers

- The **body** is server-authored durable meaning. The current ESP32 renderer
  maps structured daemon state into board-specific pixels; a daemon-rendered
  framebuffer is also valid. Firmware may choose geometry, but it must not
  reinterpret transient tool churn as a new face.
- The **band** is a small on-device status line: which session may speak next,
  current transport/activity state, and an absolute `as of HH:MM` timestamp.
  `PROCESSING`, tool churn, reconnecting, and similar transients are band words,
  never faces.

## 2. Face definitions

| Face | Admission contract |
|---|---|
| `DECISION` | A real actionable request with structured choices or a request ID. It is the only face that may preempt an unheld body. Bare waiting/processing state is not a decision. |
| `ANSWER` | A durable receipt for a user-initiated voice turn: the immutable user transcript above the answer, an absolute timestamp, delivery result, and retry affordance. A reply to a turn the user did not start at this device does not qualify — its result belongs on `GLANCE` (a card's work line and the recent strip). No board admits `ANSWER` until a capture path exists; firmware that switched to it whenever any turn finished replaced the fixed-zone board with a page nobody asked for, and was retired on 2026-09-28. |
| `DIGEST` | A producer-sealed, immutable, bounded document with an absolute creation time. It is summoned and paged; it never becomes a live scrolling log. |
| `GLANCE` | The normal resting face: durable state and explicit age only. No activity feed or seconds-level status. |
| `ROSTER` | Static no-content/no-daemon fallback. It is not the normal dashboard and contains no live session choreography. |

`DECISION > ANSWER > DIGEST > GLANCE > ROSTER` is the strict priority among
faces that are eligible in the current delivery mode.

## 3. Push and pull change the face set

Push/pull is not a refresh-rate tuning knob. It changes which face states can be
reached.

- **Push base set:** `{DECISION, ANSWER, DIGEST, GLANCE, ROSTER}` (`ANSWER` reachable only through a voice turn, see §2). The device is
  continuously reachable and may receive unsolicited durable work.
- **Pull base set:** `{DIGEST, GLANCE, ROSTER}`. A sleeping device cannot promise
  unsolicited decisions or answers.
- A physical wake on a pull device opens an **interactive lease** for at most
  eight minutes. During that lease its eligible set is temporarily promoted to
  the push set, so a user-initiated PTT turn can produce `ANSWER` and a real
  decision can surface. Escape or lease expiry returns directly to `GLANCE` and
  restores the pull base set.

Power source does not silently select delivery mode. In particular, plugging a
battery board into USB for development does not make it push-capable unless its
firmware or configuration explicitly declares a continuously reachable push
mode.

## 4. Arbitration and holds

1. Admit only content that satisfies its face contract, then select the highest
   eligible priority.
2. A physical user action (button or accepted speech) holds the current body for
   eight minutes. Repeated actions renew the same bounded hold; they do not make
   it infinite.
3. During a hold, a higher-priority event may announce itself in the band but
   cannot steal the body.
4. Escape always cancels the hold and interactive lease and returns to
   `GLANCE`. It does not mean Deny, cancel the agent, or interrupt a session.
5. Expiry has the same surface result as escape: `GLANCE`, followed by normal
   arbitration on a later cycle. There is no hidden forever screen.

## 5. Board binding and invariant controls

| Board | Delivery mode | Deep-sleep wake | PTT | Physical controls |
|---|---|---|---|---|
| TRMNL 7.5" / Seeed TRMNL 7.5 | **Push**; USB-powered and continuously reachable | Not used by current firmware | None (no microphone) | `KEY1` cycles board → aquarium → digest → board; `KEY2` returns to the live AgentDeck board. No face replaces the board on its own except `DECISION`. |
| RockBase NM-EPD-420 | **Pull** by default; explicit tethered configuration may promote it to push | `BOOT` / GPIO0 | `BOOT` hold remains reserved until the ES8311 capture path is enabled. Playback is live: the codec answers at 0x18 (probed 2026-08-30) and the board advertises `audio_out`. | Home: `BOOT` opens/pages, `USER` returns home. Decision: `BOOT` advances the highlighted option; `USER` selects, then confirms it. |
| LilyGo T5 ePaper S3 / EPD47 | **Pull** | User button / GPIO21; `BOOT` / GPIO0 is recovery fallback. Touch IRQ GPIO47 is not a wake source without a hardware reroute. | None (no onboard microphone) | Detected touch opens work/usage details from the stable home and selects options; the owned unit answers at 0x5D once its P6 FPC is seated. Decision options drop their numeric prefix when a controller is present. Without touch, a short GPIO21 press selects a home target; a hold opens it. In a detail, a short GPIO21 press returns home; holding a focused actionable request opens its decision. Decision input remains tap-next / hold-confirm. |

On pull boards, a physical primary/wake action starts the eight-minute
interactive lease. Outside that lease, `DECISION` and `ANSWER` are ineligible;
loss of the daemon selects the static `ROSTER` fallback. The current NM build
reserves a fresh `BOOT` hold for PTT but does not yet enable the ES8311 capture
driver. Until capture lands, the retained footer documents only implemented
short-press controls and does not advertise a non-working talk action.

EPD47 presents one stable `GLANCE` home: work, actual usage windows with their
reset times, and recent durable results on its left; the session roster on its
right; non-zero state counts in the header. Session counts
never switch pages. Tapping work, all-work, or usage opens a detail for eight
minutes; explicit Home or hold expiry returns to the same home. Work-list taps
bind to the session identity painted in that row, not its current sort index.
Only actual structured options admit an automatic decision face. Option sends
are rejected if the current decision identity/content differs from the painted
request. Displayed-page holds retain the existing face priority boundary.

NM uses the full width for a ranked list — the session that needs the reader
with its question, then working sessions with their activity, overflow named by
kind ("+3 working") — under a census of non-zero counts, with actual usage
windows below. Its speaker plays a two-note chime when a session starts waiting,
because a ~10 s repaint cannot flash. Up to four windows reclaim space from the
summary/recent-result band rather than overprinting it. The standard tri-color
SKU retains the stock full-color refresh waveform and coalescing policy; it
never uses the EPD47 touch navigation or experimental BW partial updates.

TRMNL reserves a readable subscription column alongside actual quota windows.
A plan with no quota windows gets a subscription row rather than tiny corner
text. Dates retain the producer's meaning; a date alone does not authorize a
renewal label or an invented subscription-period progress bar.

The NM audio path is deliberately half-duplex at the product level: codec and
speaker amplifier stay disabled during capture, then may be enabled for a short
confirmation cue after capture. Printed `ANSWER` is the response; speech output
is not required. A future wake/hold implementation must still separate the wake
release from a fresh capture hold.

## 6. Evaluation telemetry

E-ink firmware that owns the panel SHOULD emit two optional `device_info`
counters, both monotonic since boot:

- `repaintCount`: actual physical panel refreshes after content and rate gates;
- `fullRefreshCount`: the hard anti-ghost/full-waveform subset of `repaintCount`
  (EPD47 differential frame replacements do not increment it).

The counters reset on reboot and may be absent on older or non-e-ink firmware.
Both daemons expose them over serial and WiFi so a redesign can be evaluated
without replaying logs by hand. See the field-level contract in
[ESP32 Client Contract](esp32-client-contract.md).
