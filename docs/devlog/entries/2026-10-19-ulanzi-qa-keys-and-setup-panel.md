# 2026-10-19 — Ulanzi QA (1.8.1, Windows): blank keys, a panel that saw no sessions, a command that started nothing

Ulanzi's Studio QA ran plugin 1.8.1 on Windows and reported eight things. The
causes, as found in the code.

**Row 1 went blank when a fifth key went on page 2.** The plugin kept one
instance per Studio *context* and laid out `instances.map(key)`. A context
encodes its key (`uuid___key___actionid`), so a page-1 context and a page-2
context can name the same key; the plugin ignored `setactive`, so both stayed
in the position list. `buildSessionDeck` writes cells into a `Map` keyed by
position, so the duplicate took a slot from the engine's count and row 1
ended up with fewer sessions than keys. The plugin now tracks `active` per
context (`plugin-ulanzi/src/key-registry.ts`). A newly added context displaces
any other context on its key. The displaced one is deactivated, not deleted,
so a later `setactive` or press brings it back. `sortPositions` also dedupes,
as a second guard.

**A replaced key stayed empty.** `renderAll` returns early when the deck
signature equals the last one. The signature hashed only the sorted key list,
and a replace (add new, clear old, same key) leaves that list identical, so
the new context never got an image. The signature now includes the contexts.
`clear` invalidates and schedules a render; before, it only deleted the
instance, so the rest of the deck kept a layout that counted the removed key.

**"No agent session yet" over a full deck.** The panel decided step 2 from
`state !== 'disconnected'`. The daemon reports `disconnected` whenever no
*managed* session is focused, which is the normal state for observed
`claude`/`codex` sessions. `/setup-status` now carries `sessions`, the count
the deck shows, in both daemons, and the panel prefers it. Older daemons send
no count, so the panel falls back to the old rule. The payload is
cross-origin (`Access-Control-Allow-Origin: *`), so its key set is pinned for
both daemons by `shared/setup-status-contract.json`. It also carries
`claudeHooks`. Node reads `~/.claude/settings.json` and answers
installed/missing/unknown. The sandboxed app cannot read that file, so it
answers `installed` only for its own consented install and `unknown`
otherwise, never `missing`. Codex hook status was not added.

**The setup command did not start the daemon.** The panels said
`npx @agentdeck/setup`. In the setup the tester ran, leaving out `--yes`
meant the daemon was neither installed nor started; the only pointer was
`agentdeck daemon install` in a list of next steps. Since
[the setup onboarding change](docs/devlog/entries/2026-10-19-setup-root-owned-prefix-and-ulanzi-onboarding.md),
setup asks at a terminal, but the panel spells out the unattended form anyway.
The panels and the guide now say `npx -y @agentdeck/setup --yes`. `--yes`
sets `autoInstallDaemon`, which runs `agentdeck daemon install`; that
installs and starts the unit and refreshes the Claude, Kiro, Codex and
OpenCode hooks. The Windows pane had carried macOS, App Store and ChatGPT
notes under a shared command row. Each pane now has its own command, notes
and troubleshooting, including the PowerShell `npx.ps1` execution-policy
case. The old guidance also claimed that a running daemon with no session
shows OFFLINE. The deck shows HUB READY / NO SESSION in that case.

**"Full guide" did nothing.** It was an `<a target=_blank>` inside Studio's
webview. It now goes through `$UD.openUrl`, which opens the system browser.
The tutorial button keeps `$UD.openView` and gains an "open in browser" link
(`openUrl` with `local=true`), because the openView window can land behind
Studio.

**Smaller items.** BACK in the detail view names the session. The list keeps
the order sessions first appeared in (`plugin-ulanzi/src/session-order.ts`):
weight still wins, newcomers append, and `sortSessions` is unchanged for every
other surface. `sessions_list` rows are deduped by id, last copy wins. The
"CODEX —" tile was `renderCreditsTile` for a Codex limit with no balance and
no windows; it is hidden now. The plugin icon is 144x144, and a 196x196
CategoryIcon is generated from `design/brand/agentdeck-icon.png`, matching the
SDK sample sizes.

**Not verified.** Nothing here ran inside Ulanzi Studio, on Windows or on a
D200H/D200X. The `setactive` and `clear` payload shapes come from the SDK
source and its sample plugins, not from a captured Studio session; the new RAW
log lines for `clear` and `setactive` are there to capture one. Whether Studio
honours `openUrl` with `local=true` for `./property-inspector/tutorial.html`
is per the SDK's documentation, unmeasured. The translations of the new panel
strings were not reviewed by native speakers.
