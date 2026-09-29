# 2026-07-27 — `--weight` session sort override: CLI → registry → wire → every surface (PR #62)

Session commands (`claude`/`codex`/`opencode`/`monitor`) accept `--weight <n>`,
an explicit deck/tab sort pin. Structurally this threads one integer through
the whole stack: `parseWeight` (CLI, rejects non-integers and out-of-range) →
`SessionOptions.weight` → `SessionEntry.weight` (sessions.json) →
`EnrichedSession`/`SessionInfo.weight` (wire) → shared `sortSessions`, whose
primary key is now weight ascending (negatives → unweighted/0 → positives),
with the old agentType→project→startedAt→id order intact within a band. The
Swift daemon learns the weight through `session_push_register` — the sandboxed
daemon cannot read the Node world's sessions.json, so the register frame always
carries an explicit integer (0 included, never omitted; retain-on-absent
receivers would otherwise latch a pin one-way) and `mergedPushRegisterEntry`
preserves it across every entry-reconstruction site, including the push_state
projectName recreate and the session_start hook overwrite.

Two rules this feature forced into words. First, **the Codex display fold runs
before sorting on every surface**, so the fold key now includes the normalized
weight band in all three implementations (shared TS, Swift daemon payload fold,
D200H preview hand-port) — a weight-blind key silently discarded one of two
pinned same-project tabs, on the wire in the Swift daemon's case. Second, the
documented range **-9999..9999** lives in `shared/src/session-utils.ts` as
`SESSION_WEIGHT_MIN/MAX`, is emitted to Swift/Kotlin by
`scripts/generate-session-weight-rules.mjs` (vitest drift gate, terrarium-rules
pattern), and is enforced at every boundary: CLI parse, Node aggregator
ingestion, Swift emission choke point (`sessionToDict`), and display-side
normalize (trunc + clamp). Out-of-range weights are not a cosmetic concern —
kotlinx decodes `weight` as `Int?`, so one 2^40 on the wire aborted the entire
`sessions_list` decode and froze the Android dashboard. All comparators are
three-way (`compareTo` / `<`), never subtraction: Swift traps on overflow,
Kotlin wraps and reverses the ordering.

---
