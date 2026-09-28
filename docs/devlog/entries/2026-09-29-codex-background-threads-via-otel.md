# 2026-09-29 — Codex background threads came back through OTel as a "Codex" project

With one Codex Desktop session open on ViewTrans, the dashboard also showed a
project named "Codex" and a second ViewTrans row. Neither was the user's work.
`/diag` listed four OTel threads but only one real thread. Codex's own
`threads` table held one row, and there was one rollout file. The first prompts
in `~/.codex/logs_2.sqlite` identified the other three: the memory-consolidation
agent ("Memory Writing Agent: Phase 2"), the ambient-suggestion generator
("# Overview … Generate 0 to 3 hyperpersonalized suggestions"), and its safety
review.

There were two separate holes. First, the hook gate
(`bridge/src/codex-ambient-hooks.ts`, Swift `CodexAmbientHookRules`) did drop
the memory and safety threads; the daemon log said so. But `CodexOtelTracker`
never heard about it. Their spans found no hook row to overlay, so the fallback
synthesized an `observed:codex-app:<id>` row. The turn spans carry no cwd, so
the label fell back to `Codex`. Swift opened a `codex:<id>` row the same way.
Second, the generator prompt now starts with a Markdown heading (`# Overview`),
and the signature regex expected `Overview` at the very start. The generator
thread therefore passed the gate, and its hook cwd, now the real project rather
than `/`, produced the second ViewTrans row plus a `chat_start`/`chat_response`
pair.

Fix: the OTel tracker consults the hook classifier. In Node, `isBackgroundThread`
filters spans and synthesis, and `forget()` retracts a row whose spans arrived
before the identifying hook. In Swift, `sessionIdForCodexOtelThread` refuses
ambient ids, and the memory-cwd path now retracts as well. The regex accepts an
optional heading marker. The verbatim live prompt and a user prompt headed
"Overview" were added to `shared/codex-ambient-vectors.json`. The old
"live 2026-09-11" vector had lost its `#`, which is why the suites never caught
the miss.
