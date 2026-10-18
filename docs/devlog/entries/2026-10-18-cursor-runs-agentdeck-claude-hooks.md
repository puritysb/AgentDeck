# 2026-10-18 — Cursor runs AgentDeck's Claude hooks, and both daemons file its turns as Claude Code

Workshop item ③a ([2026-10-16-position-workshop-decisions.md](docs/devlog/entries/2026-10-16-position-workshop-decisions.md))
asked whether the Claude hooks AgentDeck installs fire inside Cursor and get
attributed to Claude. They do, by Cursor's design. This entry records the
evidence, what it does to AgentDeck today, and why nothing changes in code
yet.

**Evidence level.** The owner does not run Cursor, so there is no AgentDeck
capture. The findings come from Cursor's documentation and changelog, Cursor
staff replies on forum.cursor.com, and payload captures published by other
projects that hook Claude Code (MidBrain, ai-memory, yardsort, clawd-on-desk).
Below, "documented" means Cursor's docs, and "captured" means someone recorded
a real run.

**What Cursor does with `~/.claude/settings.json`.**

- **Who loads it.** Cursor loads the hooks in that file from three surfaces:
  - The IDE loads them behind *Include Third-Party Plugins, Skills, and Other
    Configs* (Settings → Agents → Third-Party Imports). This is documented as
    on by default, except Enterprise, which has defaulted to off since Cursor
    3.0.
  - The `cursor-agent` CLI always loads them. Cursor staff say there is no
    key, flag or environment variable to turn this off. The CLI has done so
    since release 2.4 (2026-01-22).
  - The `@cursor/sdk` local runtime loads them too.
  - Captured on IDE 2.6.11 through 3.24.9 and on CLI builds up to
    2026.10.01.
- **The payload is Cursor's own**, not translated:
  - `hook_event_name` is `beforeSubmitPrompt`, `preToolUse` and so on.
  - Tools are named `Shell` and `Write`.
  - Results arrive as `tool_output`.
  - `cwd` is `""` or absent.
  - `session_id` equals `conversation_id`.
  - `cursor_version` is on every payload. Six independent projects use it as
    the discriminator.
  - `transcript_path` is null early in a turn. Later it is
    `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, which is
    not Claude's transcript format.
- **Events.**
  - Mapped: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop,
    SubagentStop and PreCompact.
  - SessionEnd is mapped but unreliable in the IDE.
  - Never delivered: Notification, PermissionRequest, SubagentStart and
    PostToolUseFailure. A CLI debug log names each as skipped.
  - Headless `cursor-agent -p` fires no prompt or stop event.
- **Output.**
  - Empty stdout with exit 0 means no opinion. Exit 2 blocks.
  - The nested `permissionDecision` is honoured by the CLI, documented for
    the IDE with no capture of it being enforced, and ignored by the SDK.
  - A top-level `decision:"block"` on PreToolUse is ignored.
  - On Stop, `decision:"block"` plus `reason` becomes Cursor's next user
    message, with no loop cap for imported hooks.
  - Imported hooks are never fail-closed.

**What that does to AgentDeck today.** Checked in the code at `de8800ee`. It
has not been run against Cursor.

- **Misattribution.** `isCodexHookPayload` (`shared/src/hook-harness.ts`)
  finds no Codex evidence in a Cursor payload, so both daemons ingest it on
  the Claude route.
  - A Cursor conversation becomes a Claude Code session row and a
    `claude-code` APME run.
  - Its turns are stamped with Cursor's `model` value (often `default`).
  - Nothing in the tree reads `cursor_version`.
- **A PERM Cursor never asked for.** A Cursor `preToolUse` carries no
  `permission_mode`, which `shouldGatePreToolUse` reads as `default`.
  `Write`, `WebFetch` and `WebSearch` are in `PROMPT_PRONE_TOOLS`; Cursor's
  shell tool is `Shell`, which is not. So with device approval on and a deck
  connected, a Cursor file edit can be held for the gate's 25 s while the deck
  shows an approval. Deny on the deck would block the edit under the CLI.
- **The tool-event matcher.** `buildHookEntry` writes `matcher: "*"` for
  PreToolUse, PostToolUse and PostToolUseFailure.
  - Whether Cursor's Claude loader accepts `"*"` is unknown. Only `""` is
    proven live.
  - One forum reporter (not staff) read the bundle as passing matchers to
    `new RegExp`, which throws on `"*"`.
  - If so, AgentDeck's tool hooks never run under Cursor, and the hold above
    cannot happen.
- **Deck follow-ups.** A follow-up queued from a deck for such a session would
  arrive as Cursor's next user message. The daemon sends one per queued item,
  so Cursor's missing loop cap does not matter.
- **Process attribution.** `X-AgentDeck-Pid: $PPID` points into Cursor's
  process tree, so process-ancestry attribution finds no agent there.

**Decision.** No code change in this entry. The workshop said a positive probe
leads to a generic host axis, not a Cursor-specific path, and that axis is in
phase 3. Its first step will be a harness check on `cursor_version` in both
daemons: a Node SSOT plus a generated Swift mirror and a shared vector file,
the same shape as the Codex check in `hook-harness.ts`. It will also decide
whether a Cursor payload is dropped or becomes its own agent.

Rejected alternatives:

- **A Node-only guard now.** Either daemon may hold 9120. A guard in only one
  of them would make the same Cursor turn appear or vanish depending on which
  daemon won the port.
- **A new `cursor` agentType now.** Every surface's agent handling is an
  allow-list, so it would render as nothing on every client that predates it.
  It also needs a brand mark and creature that do not exist yet.

The misattribution only reaches users who run both products.

**Fixtures.** The repo rejects fixtures composed from a reader's expectations
(the Kiro parser incident). These published captures can serve:

- MidBrain's verbatim CLI `beforeSubmitPrompt` payload,
  [midbrain-memory-mcp#101](https://github.com/MidbrainAI/midbrain-memory-mcp/pull/101)
  (cursor-agent 2026.10.01).
- yardsort's recorded headless fixtures,
  [crates/core/fixtures/cursor](https://github.com/joaoh82/yardsort/tree/63f2ea592beea6002a33640003b3e45225122d69/crates/core/fixtures/cursor/2026.09.23-86fc751)
  (cursor-agent 2026.09.23).
- ai-memory's IDE notes,
  [docs/desktop/cursor.md](https://github.com/akitaonrails/ai-memory/blob/995e35d5866973c3176709261e924a67e3c76158/docs/desktop/cursor.md)
  (IDE 3.24.9).

An AgentDeck capture still needs someone with Cursor. They would install
AgentDeck's hooks, run one prompt in the IDE and one in `cursor-agent`, and
share the daemon's `/hooks/*` bodies.

**Open questions.**

1. Does an imported entry with `matcher: "*"` run?
2. Do cloud agents honour a repository's `.claude/settings.json`?
3. Does the IDE enforce the nested `permissionDecision`?
4. Does a hook command that begins with a variable assignment line run under
   `cursor-agent`? ai-memory saw inline `VAR=… cmd` prefixes skipped, and
   AgentDeck's command starts with `PORT="${AGENTDECK_PORT:-}"`.
5. Captures disagree on whether `transcript_path` is ever set in the CLI.
