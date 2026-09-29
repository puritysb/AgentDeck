# 2026-09-14 — Windows hooks move to a script file because sh eats `$`

Every AgentDeck hook on a Windows 11 host failed with `Missing ')' in method
call`, on every event, on every turn. The command PowerShell actually received
was `='Stop'; [int]=0; [int]=0; ... [string]:AGENTDECK_PORT,[ref]))`.

That is POSIX parameter expansion, not a PowerShell problem. Claude Code spawns
hook commands through Git Bash (`sh -c`) on Windows, so `$ev`, `$port`,
`$candidate` and `$env` were expanded to empty strings before `powershell.exe`
parsed the line — `$env:AGENTDECK_PORT` survives as the literal
`:AGENTDECK_PORT` because `:` terminates the variable name. Double-quoting
inside the settings JSON does not help: the shell sees the whole command
string. The comment on the old builder named the wrong host — "the entire
`-Command` argument can stay double-quoted under cmd.exe".

[`buildHookCommandWin`](hooks/src/install.ts) now emits
`powershell -NoProfile -ExecutionPolicy Bypass -File "<home>\.agentdeck\agentdeck-hook.ps1" -HookEvent <Event>`,
with the body in `WINDOWS_HOOK_SCRIPT` and written by `ensureWindowsHookScript()`.
No `$` reaches the command line, so there is nothing for the shell to expand.
Port discovery, the strict 1..65535 parse, the UTF-8 stdin read, the UTF-8
byte POST and the 2s timeout are unchanged; the script's `ValidatePattern`
accepts `_` so the prefixed Kiro daemon events (`kiro_tool_start`) still pass.
`setup/src/setup.ts` carries the byte-identical copy it has to (it bootstraps
its own deps and cannot import `@agentdeck/hooks`); Swift `HookInstaller` has
no Windows path to mirror.

Two consequences beyond the builder. The `-File` command contains neither
`AGENTDECK_PORT` nor `localhost:9120`, the two markers every writer used to
decide "this hook is ours" — so a reinstall would have left the old entry and
appended a new one, one live hook per install. That test is now
`isAgentDeckHookCommand()`, in one place, and it matches all three shapes. And
migration 9's `[int]::TryParse` marker recognizes the broken inline form,
while the fixed form moves that validation into the script. Windows migration
now compares the rebuilt hook settings by value and repairs the script
independently, so current settings are not rewritten on each session start.

Verified by running the generated command through `sh -c` with a payload on
stdin: exit 0, no parse errors. The affected machine had accumulated the
inline entry alongside a hand-written `-File` one, firing both per event.

### Maintainer review

The original contribution is preserved in PR #329. Review reproduced a missing
script in standalone Kiro installation, and repeated writes of already-current
Windows settings. Kiro now provisions/repairs the script before its
already-current return and carries the supplied home into every command.
Windows migration repairs a missing/corrupt script without rewriting unchanged
settings, including the legacy-settings relocation path. Installer tests run
these Windows branches on every host, and a byte-comparison gate keeps the
bootstrap script synchronized. These tests do not substitute for the author's
Windows PowerShell runtime evidence.
