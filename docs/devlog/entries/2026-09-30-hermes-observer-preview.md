# 2026-09-30 — #423: Hermes observer preview and upstream identity research

Hermes integration starts as explicit Node-daemon observation: the Python plugin
exports bounded turn/tool lifecycle events without changing agent behavior.
`on_session_end` closes a run, not the conversation; finalize/reset closes the
identity. Profile + session hashing separates conversations, delegated children
stay out of the top-level deck, and unknown receiver versions are refused.

Visual identity was checked against the official icon generator, desktop
BrandMark, CLI caduceus and repository messenger sprite. Shared deck rendering
uses the unchanged Nous girl geometry from the existing pinned Lobe Icons
package. Invented creatures are excluded. Native terrarium/firmware coverage
and live CLI/gateway capture remain review gates under #423; see
[Hermes study](docs/hermes-agent.md).
