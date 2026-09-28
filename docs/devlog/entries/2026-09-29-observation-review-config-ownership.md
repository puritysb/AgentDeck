# 2026-09-29 — Preserve Codex settings added inside the integration fence

## Review and fixes

The review on [PR #412](https://github.com/puritysb/AgentDeck/pull/412) found two data-loss cases missed by the original fixtures: toml_edit inserts new root settings after AgentDeck's notify assignment, and `codex features enable` inserts new flags into the managed features table. Both additions can be inside the comment fence and were deleted on restart migration or removal.

Node and Swift now identify generated entries instead of treating the fence as ownership. Foreign root keys, tables, hook trust, comments and values retain their TOML scope. A features table with additional keys transfers to user ownership, including hooks=true; removal leaves that opt-in intact. Modified managed hook groups that cannot be separated safely are refused instead of partially removed. Encoded Windows commands are recognized from their decoded AgentDeck endpoint, not merely from the presence of `-EncodedCommand`.

A shared fixture suite now covers later settings, disabled hooks, foreign tables/notify/hooks, Windows command ownership, multiline basic/literal strings, embedded fake fences, multiline arrays, CRLF and incomplete input. A lexical statement scanner permits complete multiline values without interpreting their contents as insertion boundaries. Node removal throws on refusal/write failure so callers cannot silently report success, and symlink refusal names the actual cause.

OpenCode plugin/SSE replies accept the older permissionID field; native questions also use the header fallback. Kiro nested metadata reads workspacePaths for the project name.

## Evidence and remaining work

In isolated temporary configuration directories, Codex 0.156.0 `features enable unified_exec` and toml_edit 0.25.15 root-key insertion both reproduced the review's placement inside the fence. Migration to another daemon port and uninstall preserve the resulting settings. Python tomllib independently checks parsed values and table scopes. These probes launch no model turn and change no real Codex settings.

Full repository build/typecheck/Vitest and targeted native XCTest results are recorded on the PR. Native tests use ad-hoc signing without entitlements; sandbox consent and live approval/coexistence checks remain on [#411](https://github.com/puritysb/AgentDeck/issues/411).

The minor Kiro stale-turn concern is retained on #411: an unmatched turn_start can currently show processing until the 30-minute roster window expires. A shorter arbitrary timer would turn silence into an unsupported idle/completion claim. Follow-up should define how stale observation is represented across Node/Swift and devices, then test interrupted sessions and long silent tools together. This revision does not silently introduce such a state policy.
