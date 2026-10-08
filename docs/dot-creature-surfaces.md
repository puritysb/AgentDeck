---
id: design.dot-creature-surfaces
title: Dot Creature Surface Design
description: Dot identity, activity, relationship visualization and adaptation across every AgentDeck surface family.
category: Design
locale: en
canonical: true
status: required
owner: Design system and surface maintainers
reviewed: 2026-10-09
revision: 2026-10-09
source_of_truth: docs/dot-creature-surfaces.md
validators: [pnpm docs:check, pnpm design-system:check]
---

# Dot Creature Surface Design

Dot is an independent companion in AgentDeck's aquarium. Its appearance adapts to the surface while preserving the meaning of activity, report age and relationships. This is the adopted design contract for those adaptations; the implementation column below records what exists in the current development branch. It does not assert shipped support or real Dot-account interoperability.

Existing agent creatures retain their canonical provider geometry under [DESIGN.md §6.4](../DESIGN.md#64-creature-marks). Dot's companion is an AgentDeck-original light orb with two eyes, not an official OpenAI logo or a replacement for the Codex creature. Hardware dimensions and availability remain owned by [Hardware Compatibility](hardware-compatibility.md#surface-matrix); this document owns Dot's visual treatment, not hardware specifications.

## Identity and role

- Keep the round body, paired eyes and readable separation between body and background across detailed, pixel and monochrome variants. Remove glow and shading before removing identity. At a size where the eyes cannot be distinguished, use a labeled neutral Dot glyph rather than a misleading miniature face.
- In rich scenes, place Dot outside the coding-session roster. It must not occupy an agent session slot, increase working/waiting agent counts, acquire another provider's mark, or consume a session LED in a fleet ring.
- A connected but quiet Dot is not necessarily doing nothing in the cloud. Labels describe only this integration's known requests. Local ChatGPT app presence, AgentDeck hosting, connection authorization and reported activity remain separate facts.
- Selecting the companion opens requests, results and relationship history. An information card is not a command, retry, cancellation or approval button. Future controls need their own capability and authorization contract.
- Cosmetic proximity, looking toward another creature or swimming beside it never establishes delegation. Relationship visualization requires an explicit correlated record.

## Activity and accessible state grammar

Use semantic tokens from [the design system](../DESIGN.md#27-status-semantics). Add text or shape so color and animation are never the sole state signal. Numeric freshness and completion durations are owned by [dot-rules.ts](../shared/src/dot-rules.ts); surface implementations must consume generated or daemon-authored values rather than copy durations.

| Meaning | Required appearance and wording | Motion and recovery |
|---|---|---|
| Integration not configured | No persistent Dot resident; setup remains in settings | No phantom connection or session |
| Hosting stopped | Quiet gray, stopped-host wording; last report may remain as history | No work motion; does not mean cloud Dot stopped |
| Awaiting connection | Quiet gray with connection wording | No work motion |
| Connected, no work reported | Resting orb, explicit quiet/connected wording; a green connection cue means health | No inference of global idle |
| Request sent or callback accepted, no report | Waiting-for-report wording, neutral body; no work spark | Delivery receipt alone never starts working motion |
| Fresh working report | Cyan activity cue, work marker and “reported by Dot” wording | Gentle displacement is allowed; no brightness pulse |
| Reported attention | Amber attention cue and visible `!`, with the reported issue | Optional amber pulse only; Reduce Motion freezes motion |
| Completed request | Completion label or check, retained result and timestamp | Bounded completion reaction, then rest; never an endless success loop |
| Reported failure / delivery failure | Red failure cue with explicit distinction between report failure and delivery failure | No work motion; no implied automatic retry |
| Stale, future-dated, expired or unknown activity | Gray/unknown cue, report time and unknown-current-activity wording | Stop work motion; silence is not completion |

These are required cross-surface semantics, not a claim that all badges already exist. The current macOS 2D companion has text and attention/unknown badges. The 3D resident shares its phase resolver and palette, but in-scene non-color status badges and full accessibility/occlusion acceptance remain follow-up work. Do not claim accessibility parity from a successful geometry test.

## Surface adaptation matrix

**Implemented** means present in this branch and locally tested. **Producer only** means both daemons can emit an inert `dot` module card; each client still needs decoder/rendering acceptance and may skip an unknown module. **Planned** means this contract defines the intended treatment but the surface has no dedicated Dot renderer yet. None of these labels means deployed.

| Surface family and members | Creature treatment | Relationship and interaction treatment | Current implementation |
|---|---|---|---|
| macOS 3D aquarium | Independent shaded orb with paired eyes; preserve separation from residents, labels and selection targets | Tap opens relationship panel. Future spatial links connect only independently bound targets; unverified references stay in a separate panel | Implemented for the in-process host; geometry, motion and session separation tested. Assembled-scene visual acceptance pending |
| macOS 2D habitat/dashboard | Flat orb, restrained halo, eyes and adjacent status text; companion remains separate from session creatures | Compact relationship summary opens full history, direction, target and provenance | Implemented for the in-process host; SwiftUI fixture rendered |
| macOS menu bar / compact popup | Monochrome or compact orb with nearby Dot label; preserve the existing app icon and session counters | Latest relationship as text, with a route to full detail; no animated relationship graph in a narrow popup | Planned |
| iPhone / iPad 2D and 3D | Same identity in flat or volumetric form; keep touch targets and status text readable independently of creature scale | Selected relationship in a sheet; retain direction, stage and provenance when layout collapses | Planned; local macOS host polling does not provide remote companion state |
| Android LCD tablet, including 2D and 3D habitats | Same orb silhouette and semantic state cues; flat or volumetric according to the selected habitat | Relationship panel beside or below the habitat; avoid persistent edges across unrelated residents | Planned |
| Android e-ink readers, including Crema/Onyx/Kobo configurations | Static high-contrast outline/filled silhouette; eyes cut out clearly, no glow or transparency | Text-first durable report, direction and absolute “as of” time; retain paper face/refresh arbitration | Planned; portable card producer only where a client consumes the feed |
| Stream Deck, Mini, XL, + and + XL keys | Compact orb plus status text in the fixed first list key; existing action identities remain unchanged | Read-only result/relationship view first; no assumed control meaning for a press | Implemented read-only first key through existing session-slot actions; relationship detail and physical-device acceptance pending |
| Stream Deck encoder touch strips | Small glyph plus legible stage/target text, no miniature 3D scene | Focused relationship detail; existing dial assignments remain intact until a separate control design is adopted | Planned |
| Ulanzi D200H / D200X LCD keys | Flat orb and status marker; any baked animation must close seamlessly and be deterministic | Bounded relationship detail within vendor-plugin layout; no implied D200X encoder support | Implemented shared read-only first-key renderer; relationship detail and physical-device acceptance pending. These are LCD keys, not e-ink |
| ESP32 IPS 3.5 / 86 Box / IPS 10.1 | Flat orb on smaller panels, existing relief style on the large panel; use reserved companion space | Direction and stage near the companion; detailed history only where text fits; preserve session priority | Planned; generated Dot glyph/relief assets do not exist yet |
| ESP32 round AMOLED 1.8 | Centered compact orb within the circular safe area; status outside the eyes | One selected relationship at a time; target and stage in a readable band, not lines clipped by the round mask | Planned |
| TTGO T-Display 1.14 / Waveshare LCD 1.47 / T-Display-S3-Pro Focus Strip | Small flat glyph and text; do not shrink a complete aquarium into a strip | Prefer stage + direction + target; long result belongs in detail. Preserve Focus pinning and result arbitration | Planned |
| T-Embed Companion Knob | Compact on-screen Dot icon; existing ring continues to represent actual sessions | Local inspect/detail first. Encoder, voice and approval actions do not automatically apply to Dot | Planned |
| TRMNL 7.5 / RockBase NM-EPD-420 / LilyGo T5 ePaper S3 | Static paper silhouette; black/white shape carries state even on tri-color or grayscale panels | Durable report/relationship card with absolute time; no per-animation refresh and no transient work event taking over the body | Planned dedicated creature; producer-only card fallback, device acceptance pending |
| XTeink X3 / X4 readers | Paper glyph beside a text report, following the reader's supported face set | Selected relation and report age; preserve offline history without presenting cached work as live | Planned dedicated creature; producer-only fallback subject to client compatibility |
| Divoom Pixoo64 | Dedicated pixel orb, generated from the approved companion artwork; shape-coded state cue | A selected relationship may earn an event scene, with direction and provenance available in the companion UI; no cosmetic message particles as execution proof | Planned; existing provider masks remain unchanged |
| iDotMatrix 32×32 | Pixel orb only in a justified Dot event scene; keep normal fleet counts truthful | Do not add Dot to live/working/waiting session counts; never relabel existing ASK/SENT semantics as target acknowledgement | Planned |
| Divoom Timebox Mini 11×11 | Preserve the collective robot face. A future Dot cue must be distinguishable and explicitly scoped; omit it if the grid cannot communicate that | No graph or target-identification claim on the face; details stay on a larger display | Planned; no Dot-specific expression implemented |
| Ulanzi TC001 32×8 | Minimal labeled glyph/marker with stage text where legible; no tiny 3D shading or two-agent tableau | Direction and stage take priority over long target names; detail is deferred to the host | Planned |
| TUI dashboard | Text glyph/name and explicit state; color is redundant | Plain directional text, stage, report time and source; safe truncation, no implicit interactive control | Planned |
| Third-party/browser/SSE surfaces | Choose flat glyph, text or no creature according to the negotiated profile | Display only fields actually supplied by the selected public contract. Generic SSE availability does not imply a Dot snapshot or relationship feed | Planned renderer integration; direct MCP and portable cards are distinct interfaces |

This matrix covers the product surface families in the hardware catalogue, plus their compact and 3D presentation modes. It does not add hardware support, new protocol capabilities or distribution claims.

## Fixed deck placement

When the daemon reports a configured integration, Dot occupies the first AgentDeck list key on every page, including when HTTPS hosting is stopped. The remaining keys retain the existing session order: Hermes and OpenClaw share the assistant priority group, and existing weight/project ordering still applies. Neither agent is displaced from the roster or given a new relative ranking. Dot is not a session and does not enter agent counts.

Both plugins use [dot-deck.ts](../shared/src/dot-deck.ts) for reservation and the same static orb/status SVG. Pagination accounts for the reserved key. With one or two placed keys, reservation is omitted if it would hide sessions or navigation; with Dot and usage gauges together, session/navigation capacity takes precedence. Detail pages and encoder assignments retain their existing behavior. A Dot key press is inert; rich relationship inspection remains in the macOS companion.

Both daemons emit a sanitized optional snapshot on `sessions_list`. Missing/null snapshots and disconnect clear the plugin cache. The snapshot reports hosting and the latest request's report state/age, not global cloud activity, ChatGPT process presence or target acknowledgement. The native D200H preview model accepts the same reservation policy, but live preview input wiring is not part of this change.

## Relationship grammar

The canonical relationship types, directions and stages live in [dot-interactions.ts](../shared/src/dot-interactions.ts); the native model is generated. A relationship carries request/attempt identity, relation identity, sequence, kind, direction, nullable target reference, bounded summary, receipt time and provenance. Keep it separate from creature pose and parent request completion.

| Meaning | Visual grammar |
|---|---|
| Direction | Explicit arrow from sender to recipient. Text fallback uses the same order; do not reverse arrows for scene composition |
| Kind | Name delegation, message, control, result or attention; color alone must not encode the kind |
| Stage | Show requested, delivered, accepted, running, needs_attention, completed, failed or cancelled as reported. Missing earlier stages are not fabricated |
| Dot-authored evidence | Always label “Dot report.” A reported acceptance or completion does not establish target-side acknowledgement |
| Unknown or unbound target | Show “Unknown target” or the sanitized reference with “target unverified”; do not draw a line to a real agent based on matching name, project, provider or proximity |
| Independently confirmed target | Future extension only: require an authenticated target-side correlation before attaching a spatial edge, and retain the distinction between report and acknowledgement |
| Old evidence | Retain history with absolute timestamps; make current uncertainty explicit and stop transient transfer/work motion |
| Multiple relations | Group by relation identity, preserve sequence history, prioritize the selected/attention relation and expose a bounded remainder count; never turn a crowded scene into an unreadable graph |

A future rich-scene edge uses a directional arrow and a kind/stage label. Report-only edges use a dashed treatment and explicit provenance; a solid confirmed edge is reserved for independently verified binding, which is not implemented. On paper use line style and text rather than translucency. On a small matrix, omit the edge if its direction and meaning cannot be read. Cosmetic eye gaze is allowed but must not substitute for this grammar.

For compact cards, retain **kind → stage → direction → target** in that priority order, with provenance and absolute time in context. Truncate the target/summary before losing the stage. If the destination cannot display provenance, downgrade to a neutral “Dot report” notification rather than imply verified agent execution. Current cards are informational and contain no response choices.

## Assets, motion and delivery

The current native reference implementations are [DotCompanionView.swift](../apple/AgentDeck/UI/Monitor/DotCompanionView.swift) and [DotAquariumResident.swift](../apple/AgentDeck/Terrarium/DotAquariumResident.swift). [DotPresentation.swift](../apple/AgentDeck/Daemon/Dot/DotPresentation.swift) resolves the macOS phase; [DotInteractionView.swift](../apple/AgentDeck/UI/Monitor/DotInteractionView.swift) renders the evidence panel. The phase resolver is not yet a generated cross-platform consumer, and no Dot USDZ/GLB, shared vector master or matrix mask is shipped by this work.

Before implementing the remaining renderers, establish one approved companion geometry source and generate flat silhouettes, pixel masks and paper variants from it. Keep it separate from upstream provider marks. Add the source, generator and drift gate to [Design Resources](../design/RESOURCES.md) and the [architecture SSOT catalogue](architecture.md#cross-platform-ssot-catalogue). Promote phase/shape rules into shared generated data before adding platform-specific copies; do not describe the current Swift implementation as that completed pipeline.

Animation expresses known activity and must stop on stale evidence, backgrounding or Reduce Motion. Never use animation as the only sign of work. Baked loops must close; paper never animates; limited-bandwidth displays update on meaningful report/state changes. Screen wake, card refresh and animation ticks never create MCP Events or new work.

Both daemons currently emit bounded read-only Dot cards. That producer does not automatically make every dashboard a Dot client. The first-party deck snapshot now carries only configuration, hosting and latest-report state/timestamps. Rich remote creature snapshots still need an additive, capability-aware contract with freshness, absence/clearing and reconnect behavior; do not invent a session to transport them. Existing clients may skip an unknown module. The [e-ink contract](eink-surface-contract.md) and [surface protocol](surface-protocol.md) retain authority over delivery, arbitration and controls.

## Acceptance before marking a surface complete

1. Verify identity at the actual display size, monochrome/high contrast and reduced motion; status remains legible without animation or hue.
2. Exercise stopped hosting, missing authorization, delivery-only receipt, fresh work, attention, completion, failure, future/stale timestamps and reconnect. Compare phase semantics against the shared reference when that mirror is introduced.
3. Exercise both directions and each relationship kind, unknown targets, long/CJK text, duplicate/reordered reports and terminal history. Verify that reports cannot become approval or execution commands.
4. Check dense-scene occlusion, selection, accessibility labels and focus. Dot must not hide a higher-priority resident or affect session counts.
5. For hardware, inspect actual pixels and inputs, offline recovery, refresh/transport budget and loop closure. For 3D, inspect the assembled scene as well as model geometry.
6. Record contract, runtime, device and release evidence separately under the [handover evidence levels](../agentdeck-design-system/docs/handover.md#evidence-levels). Local tests and a preview are not live Dot or hardware acceptance.

Implementation and interoperability evidence stays in the [Dot integration plan](dot-mcp-events-plan.md); this document is the canonical visual contract.
