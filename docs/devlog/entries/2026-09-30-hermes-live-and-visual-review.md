# 2026-09-30 — Hermes app review and first live CLI capture

The iPad Simulator ran the actual Apple 3D aquarium with deterministic Hermes,
Claude, Codex and OpenCode state fixtures. The user rejected the runtime
mermaid's face and proportions; the model is not visually accepted. Two new
concept sheets were generated, with the latest following the user's explicit
request to keep the original Nous girl face. They remain authoring references,
not replacements for the current USDZ. Further mesh work must be checked
against the reference in the actual app before visual acceptance.

An isolated Node daemon received one real Hermes CLI turn using the installed
upstream commit `6d42313deee63b13dbf2f262d9a31cf603d3f1bc` and configured
`zai` / `glm-5.3` provider. Start, prompt, two terminal tool pairs, one Stop and
finalization were observed. The final response and two tool calls reached APME
with the correct model/provider and Stop boundary. A sanitized captured fixture
now tests replay; gateway, multi-turn/reset/cancel and shutdown guarantees remain
open in #426.

The observer now honors the existing `AGENTDECK_DATA_DIR` override, allowing a
throwaway receiver without changing the production daemon registry. An explicit
missing registry never falls back to another daemon. Ten focused Vitest tests
passed, including the Python transport suite's 14 cases. The app review used
fixtures; it is distinct from the separate live CLI/Node capture.
