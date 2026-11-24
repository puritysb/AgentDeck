# 2026-11-25 — Antigravity project names and Claude's automatic session names

### Antigravity showed "Antigravity" instead of the project

A conversation running in `epoch-of-tech` was listed as "Antigravity". The project map read only `cache/last_conversations.json`, which keeps the newest conversation per folder (`epoch-of-tech` → `83fa07b3…`). The running conversation (`9d32a54b…`) had no entry, so it fell back to the agent name.

Each conversation's own `summary.WorkspaceURIs` in `cache/conversation_metadata.json` names its folder. Locally, 157 of 170 conversations carry one. That file is 140 KB, above the 128 KiB `metadataBytes` cap used for the other metadata reads, so it gets its own `conversationMetadataBytes` cap (4 MiB). A single `file://` workspace names the conversation. Several roots or a non-file URI make no claim, and `last_conversations.json` remains the fallback. Node and Swift share the rule, and the Swift parity test compares both maps.

### `-89 #c4fe` on Stream Deck and D200H keys

Claude Code names sessions `<project>-<n>` (`epoch-of-tech-62`, `epoch-of-tech-89` in `~/.claude/sessions/<pid>.json`). Two sessions in one project get an id tag, so the label became `epoch-of-tech-89 #c4fe`. The key's name line is 13 columns and the label has no space within them, so the wrapper cut at column 13 and the second line read `-89 #c4fe` under the creature. `siblingName` drops a display name that is only `<project>-<digits>`. The tag already tells the sessions apart, and `epoch-of-tech #c4fe` wraps at its space.
