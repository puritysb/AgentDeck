# 2026-09-29 — A finished `codex exec` session no longer turns into a "Codex" app row

Found during #411 live acceptance against the deployed Node daemon (build `6c40cb4e06e7`, which already includes #417). A one-turn `codex exec` (Codex 0.156) was observed in this order:
- `observed:codex:<id>` idle → processing → idle, from SessionStart, UserPromptSubmit and Stop, as intended.
- About two seconds later, `observed:codex-app:<id>` idle, project **Codex**.

`codex exec` exports its OTel spans in one batch as the process exits, after the hook row has closed. The daemon composes rows as `hookCodexSessions.applyTo(codexOtel.applyTo(passive))`. The OTel fallback saw a thread with no process-scan row and synthesized a cwd-less `codex-app` row. Because that id already covered the uuid, the hook tracker then skipped its own richer row. The finished CLI session showed as an app session named "Codex" for up to a minute.

`CodexOtelTracker.isHookOwnedThread` now stops the fallback for any thread the Codex hooks know. That is a live hook row or a terminal tombstone, via `HookCodexSessions.knows`. It is the same ownership rule #412 applied to OpenCode: once hooks have seen a session, they own its row. OTel still overlays state onto process-scan rows and still covers threads no hook reported. `codex-otel.test.ts` replays the live order through both trackers in the daemon's composition order. The test fails without the change.

Not changed: the Swift daemon keys hook and OTel rows by the same `codex:<id>`, so it cannot show the app-row relabel. It does treat an OTel `turnStart` as a new-turn signal that clears the terminal tombstone, so a late batch may briefly reopen a finished exec session as processing. That path was not measured, because the Node daemon held 9120; it is recorded on #411.
