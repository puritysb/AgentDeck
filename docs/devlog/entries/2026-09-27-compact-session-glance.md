# 2026-09-27 — Compact task pickers and readable IPS10 summaries

ESP32 session names now have a separate optional compact display label. Both
daemons verify the worktree metadata before shortening auto-generated names,
number duplicate labels by ID across the whole roster, and preserve original
project names and control IDs. The generated Swift naming kernel and shared
fixtures guard parity. Labels only consume spare transport budget; firmware
uses a fixed 40-byte field per session (20 on TTGO), with no render-loop
allocation. Legacy peers keep their existing names.

T-Display-Pro/Pocket task pickers prefer the waiting question or current work
over a previous turn's result. T-Embed shares this allocation-free policy.
Fixed line heights stop long captions from drawing over adjacent rows. TTGO
and TC001 remain usage-first; task-name improvements affect their secondary
surfaces. E-ink cards and creature tags consume the same compact labels.

IPS10 retains exact project grouping and touch-to-inspect detail, while showing
two wider project columns. Each agent has a smaller creature/status header,
a separate reported role/task line when available, and a full-width current
summary. Narrow project columns show two agents at a time with fair rotation;
a single wide project still shows three side by side. Whole-line text heights
and ellipses replace clipped wrapping; historical activity stays in a separate
footer. The simulator adds a long-worktree/long-summary scene and retains
selection, paging, voice, quota and attribution interaction checks.

Validation: 4,870 Vitest tests pass (2 skipped), TypeScript build/typecheck,
18 macOS resolver/parity tests and a signed Debug build pass. IPS10 and both
companion interaction suites pass; their existing tests now exercise the
current explicit waiting-list navigation and first-focus pinning policy.
Real firmware renderers were inspected with long task text in the simulator.
Protocol, preview-mirror, documentation and token gates pass; clean-source
design lint remains at the existing 89 violations. The legacy HUD now copies
only its bounded display fields into a reused 520-byte store instead of
placing ten full session records on the UI stack.

TTGO uses a 12-byte compact base before duplicate numbering to fit its 20-byte
field and static DRAM budget. Shared fixtures cover both daemons. Recolor-enabled
HUD rows sanitize literal hash marks so ordinals cannot consume status colors.
