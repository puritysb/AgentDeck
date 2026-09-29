# Hermes Agent integration study and observer preview

Tracked in [#423](https://github.com/puritysb/AgentDeck/issues/423). Research pinned
to `NousResearch/hermes-agent@16c59d0e7876383de7377f12bf0708f08246d063` on
2026-09-30. This is an opt-in Node/deck preview, not whole-product support.

## What actually identifies Hermes

| Symbol | Evidence and current use | AgentDeck decision |
|---|---|---|
| Nous girl, monochrome face | [Official icon generator](https://github.com/NousResearch/hermes-agent/blob/16c59d0e7876383de7377f12bf0708f08246d063/scripts/generate_icons.py) declares `assets/nous-girl-{black,white}.svg` as the source; the current [desktop BrandMark](https://github.com/NousResearch/hermes-agent/blob/16c59d0e7876383de7377f12bf0708f08246d063/apps/desktop/src/components/brand-mark.tsx) uses it. App icons and website favicons derive from it. | Use the existing Lobe Icons package's normalized Hermes mark unchanged for shared deck identity. |
| Caduceus, ☤ | [Official default skin](https://hermes-agent.nousresearch.com/docs/user-guide/features/skins/) uses a gold caduceus banner and response label; `hermes_cli/banner.py::HERMES_CADUCEUS` contains the actual art. | Authentic CLI symbol; a candidate for tiny displays after readability review, not a newly invented animal. |
| Winged-helmet messenger carrying a caduceus | [Original `hermes.png`](https://github.com/NousResearch/hermes-agent/blob/16c59d0e7876383de7377f12bf0708f08246d063/apps/desktop/public/hermes.png), [eight-pose sprite](https://github.com/NousResearch/hermes-agent/blob/16c59d0e7876383de7377f12bf0708f08246d063/apps/desktop/public/hermes-sprite.png), and `hermes-frames/` exist in the upstream repository, introduced by desktop PR #20059 on 2026-05-31. Current desktop source does not reference these filenames. | A real upstream character reference, **not the current default app mascot**. Its presence alone does not establish any current in-app use. |
| User-selected Petdex pet | [Official pet documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/pets/) says floating pets are off by default and appear only after a user installs and selects one. | A user's optional pet choice does not define Hermes's brand; Hermes has no default floating pet. |

The Nous girl SVG normalization is from `@lobehub/icons-static-svg@1.94.0`, the
same pinned MIT package used by the existing agent marks. The original path
geometry is preserved in [hermes.svg](../design/brand/hermes.svg); provenance is
in [the resource map](../design/RESOURCES.md). It is a third-party identity mark,
not an AgentDeck mascot or a claim of endorsement. Invented shell/crab/animal
characters are explicitly excluded by the user's direction.

The Apple aquarium creature implements the user's requested mermaid
derived from the Nous girl portrait: preserve her dark bob, bangs, pale face,
and recognizable silhouette while adding an underwater body and motion. This
is an AgentDeck-original adaptation, not an official Hermes mascot. The
winged messenger remains a separate upstream illustration reference, not the
chosen aquarium creature. The compact brand mark in this preview remains the
unaltered Nous girl geometry.

## Native aquarium motion

The Blender source is `assets/terrarium/hermes-mermaid.blend`, reproducibly
built by `build-hermes-mermaid.py`. Apple bundles its USDZ; a portable GLB is
kept beside the authoring source for the later Android renderer. The model has
separate head, eye, arm, tail and fin pivots. The app's `HermesSwim` controller
owns bounded three-dimensional travel, damped velocity, banking, delayed tail
and fin strokes, blinking, neighbour greetings and state transitions. Nearby
idle residents can turn or wave back; these are cosmetic social behaviours,
not evidence of collaboration. Work only accelerates from observed processing;
waiting raises a hand, and working-to-idle triggers one short settling gesture.
Actual active-child counts remain explicitly labelled. No peer task assignment
is invented from proximity, project names or model providers.

The same observed Hermes identity is rendered in Apple's Canvas fallback,
with selection and name tags. Reduced Motion stops swimming and articulation;
state labels still update. Meshes and rig handles are cached per resident and
removed with the session. `preview-hermes-motion.swift` samples the real motion
controller; `render-hermes-preview.py` renders that trajectory with Blender for
visual review (outputs under ignored `diagnostics/hermes-mermaid/`).

## OpenClaw and Hermes have different observation contracts

| Dimension | Existing OpenClaw integration | Hermes observer preview |
|---|---|---|
| Live source | Authenticated Gateway WebSocket RPC plus complementary transcript tool rows | Python plugin callbacks inside the common agent core, across CLI and gateway |
| Visible identity | One virtual gateway row; session keys still scope timeline/APME | One observed conversation row, identified by a hash of profile home + native session ID |
| End of work | Gateway final-response event | `on_session_end` ends one run/turn; **only finalize/reset ends a conversation identity** |
| Response ownership | Gateway final response outranks message projections | Cache `post_llm_call.assistant_response`, emit one Stop on `on_session_end` with its actual outcome |
| Control | Gateway supports prompt/abort/approval RPCs | Observation only; no device approvals, prompt injection, terminal steering, or voice targeting |
| Memory and skills | Existing agent-specific telemetry | Report observed tool names; do not infer learning, intelligence, or growth from time/tokens |
| Model | Separate from harness identity | Always `agentType: hermes`; preserve supplied model name, do not relabel it as Claude/Codex |

Primary contract: [observer hooks](https://hermes-agent.nousresearch.com/docs/developer-guide/observer-hooks/)
and [plugin API](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/).
Gateway filesystem `HOOK.yaml` handlers are a separate gateway-only extension;
OpenClaw's gateway protocol cannot be reused simply because both products call a
component “gateway”.

Persistent memory is [profile-scoped and injected as a session-start snapshot](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/).
A `memory` tool call alone is not proof that a write succeeded. This preview
exports tool names only, so it deliberately makes no “learned a skill” claim.

## Try the preview

Requires a rebuilt Node daemon advertising `hermesObserver: 1` in local health.
This branch does not restart an existing daemon or modify a Hermes profile.
Install explicitly into the intended profile:

```bash
agentdeck hermes-observer --home /path/to/hermes-profile
# In that same Hermes profile:
hermes plugins enable agentdeck-observer
```

Restart Hermes after enabling. Hermes owns enablement in its configuration;
AgentDeck never rewrites that configuration or enables the plugin implicitly.
Without `--home`, the installer uses `HERMES_HOME`, then `~/.hermes`.
An existing unowned plugin directory is refused. Disable with
`hermes plugins disable agentdeck-observer`, or set `AGENTDECK_NO_HERMES_HOOKS=1`
in the Hermes process environment.

The observer exports bounded prompt/final-response text (8,192 characters each),
model, platform, CLI working directory and tool name to the local daemon. It
never exports full conversation history, tool arguments/results, profile memory,
credentials, or provider request bodies. Profile paths/native IDs are hashed
for identity; CLI cwd is intentionally visible as project context.

One daemon worker serializes sends, with a 128-item queue, a five-second queue
age limit and bounded HTTP timeouts. Proxy settings and redirects are disabled.
Discovery reads the user's `.agentdeck/daemon.json`; it does not scan ports or
fallback to an old/native receiver that would misclassify Hermes hooks. Callback
failures are ignored; callbacks always return `None`. CLI exit allows up to one
second for queued events to drain. Transport is best effort, without retries or
persistent event storage. Losing events can leave incomplete timeline evidence;
30 minutes of silence retires a row without claiming task success.

Child sessions with explicit parent IDs or observed `subagent_start` identities
are suppressed from the top-level deck. Parent census and subagent timeline
projection remain a rollout gate. Session/child caches are bounded.

## Validation and remaining rollout gates

- Shared packages, bridge and both deck plugins build via the repo workflow.
- Python tests drive real callbacks and loopback HTTP delivery, including
  receiver capability gating, interrupted turns, reset identity, child
  suppression, privacy bounds and queue saturation.
- Node tests cover session lifetime, mid-turn recovery, malformed callbacks,
  isolated conversations, stale cleanup and bounded retention.
- Brand tests compare all rendered paths to the pinned SVG, including
  monochrome negative space; generated protocol/prefix mirrors include Hermes.
- Local Hermes source at `6d42313deee63b13dbf2f262d9a31cf603d3f1bc` was inspected
  at `agent/turn_context.py` and `agent/turn_finalizer.py`. Its real Plugin Doctor
  loaded this plugin with all nine hooks and no findings, and confirmed identity separation using Hermes’s real
  context-local profile overrides. Doctor runs under a temporary home
  with sockets blocked during registration. This is runtime registration
  evidence, not a completed live model conversation.

Follow-up tickets: [native/device coverage #425](https://github.com/puritysb/AgentDeck/issues/425)
and [live compatibility verification #426](https://github.com/puritysb/AgentDeck/issues/426).

Before whole-product support: native Swift ingestion, Android terrarium
renderers, ESP32/matrix glyphs, profile/channel labels, approval observation and
explicit capability checks across voice/control surfaces need implementation
and review. Older firmware can select a project named Hermes as a voice target;
the Node preview has no terminal/command route, so delivery fails visibly.
No native App Store subprocess or companion-install UI is added.
A real CLI and gateway conversation capture, including reset, interruption and
shutdown, must verify end-to-end behavior before release. None of these gates
is waived by the preview tests or the existence of an upstream sprite.
