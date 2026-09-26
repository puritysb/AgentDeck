# Managed-only capability inventory: launch arguments and terminal affordances

Working measurement for [#273](https://github.com/puritysb/AgentDeck/issues/273), gates
**Custom launch arguments** and **Terminal-only gaps**. Measured against `3f7dc473`.

The other two gates are not fully covered here. Remote attach names a
real-topology validation as its completion condition, so it cannot be closed
from a source reading. Session ordering has a daemon-first implementation in
BOTH daemons (Node `session-order.json` pins mirrored by the Swift store,
`agentdeck order` CLI — see
[daemon.md](daemon.md#observed-session-order-pins-273)); its remaining open
condition is the real-user tab-to-deck scenario, not a missing mechanism.

Every row below is either **measured** (a cited source line) or **open** (named as
unmeasured). Nothing here decides a replacement design; it establishes what a replacement
would have to reproduce.

## September 27 implementation update

`agentdeck run <claude|codex|opencode>` now implements the local non-PTY launch
candidate. It retains login-shell/custom-command grammar, typed scalar override,
raw agent defaults, the both-layer opt-out and inherited terminal streams. A real
macOS TTY fixture confirmed input/output and exit 7, plus Ctrl-C exit 130; real CLI
invocations confirmed quoted arguments, env append/opt-out and exit 23. The
cross-platform shell test is also included in the Windows Node 22/24/26 CI matrix.
A real Claude request hit the account's weekly limit, so this is not a successful
agent-turn or Windows desktop attribution receipt. Remote relay, weights at launch
and terminal-only controls remain on the managed compatibility path.

---

## 1. Custom launch arguments

### 1.1 The contract as implemented

| Knob | Where | Exact semantics |
|---|---|---|
| `-c, --command <cmd>` | `bridge/src/cli.ts:859` (claude), `:905` (codex), `:964` (opencode) | Default `claude`/`codex`/`opencode`. Free-form **string**, not an argv array. `monitor` has no `-c` — it spawns no agent. |
| `AGENTDECK_COMMANDER_ARGS` | `applyGlobalEnvArgs`, `cli.ts:705` | Tokenized, spliced into argv at index 3 — immediately after the subcommand. Keyed on `argv[2]` being one of `claude`/`codex`/`opencode`/`monitor`; any other command is a true no-op even when a positional *value* equals a session word. |
| `AGENTDECK_CLAUDE_ARGS` / `AGENTDECK_CODEX_ARGS` / `AGENTDECK_OPENCODE_ARGS` | `weaveAgentCommand`, `cli.ts:741` | Raw string append to the `-c` command (`` `${command} ${extra}`.trim() ``). Weaves onto a user `-c` rather than replacing it. |
| `--no-env-args` | `cli.ts:870`, consumed at `:879` via `opts.envArgs !== false` | Disables **both** layers for the invocation. The commander half is decided pre-parse on raw argv (`cli.ts:729`); the per-agent half in the action. |
| `--weight <n>` | `cli.ts:871` | Not an agent argument, but rides the same env-splice layer — `AGENTDECK_COMMANDER_ARGS="--weight 5"` is a tested path (`cli.test.ts:380`). |

### 1.2 The load-bearing fact: the command string is shell-interpreted

`PtyManager.spawn` (`bridge/src/pty-manager.ts:98-103`) does not exec the command. It execs a shell:

- POSIX: `(process.env.SHELL || '/bin/bash')` with `['-l', '-c', command]`
- Windows: `(process.env.COMSPEC || 'cmd.exe')` with `['/d', '/s', '/c', command]`

Three consequences a replacement inherits, none of them optional:

1. **`-l` is a login shell.** The user's profile is sourced before the agent starts, so
   `PATH`, version managers (nvm/rbenv/mise), and profile-exported credentials are in
   scope. A daemon-first launcher that spawns the agent binary directly reproduces the
   flags but not this environment.
2. **Full shell grammar is in play.** The `-c` string may contain expansion, quoting,
   pipes, `&&`. The per-agent env append is documented as riding this same path
   deliberately (`.claude/rules/managed-sessions.md`).
3. **Two different grammars.** `cmd.exe /d /s /c` quoting is not POSIX quoting, and the
   same `AGENTDECK_CLAUDE_ARGS` value is appended verbatim on both.

By contrast `AGENTDECK_COMMANDER_ARGS` is tokenized in pure JS by `tokenizeArgString`
(`cli.ts:668`) — quote grouping only, **no** expansion, globbing, or escapes. So the two
env layers have deliberately different power, and the rule file says so.

### 1.3 What "resume-command composition" turned out to be

The gate wording implies an AgentDeck-owned resume builder. There is none. A repository
grep for `--resume` finds only: the user's own `-c "claude --resume X"` in docs and tests
(`docs/cli.md:73,90`, `cli.test.ts:200,260`), and Kiro's unrelated `--resume-id` parsing
in `passive-observer.ts:1020,1085`.

So the contract is narrower and easier than the gate suggests: **resume is user-supplied
text, and AgentDeck's only obligation is that the env append does not clobber it.** That
obligation is covered (`cli.test.ts:260`).

### 1.4 Existing regression coverage

`bridge/src/__tests__/cli.test.ts:165-488` already pins: splice position, the `argv[2]`
gate, non-session no-op, empty/unset var, the typed hatch, the **env-smuggled
`--no-env-args`** strip (`:243`), per-agent selection by agent type, whitespace-only
values, last-write scalar override through a real commander parse (`:360`), and both-layer
disable through `parseAsync` (`:467`).

The gate's own ask — *"add regression fixtures from representative
configurations"* — was missing the contract's load-bearing half. Added in this branch:

- `bridge/src/__tests__/pty-manager-launch-contract.test.ts` — POSIX login shell
  (`-l -c`) and its `/bin/bash` fallback, win32 `cmd.exe /d /s /c` and its `COMSPEC`
  fallback, and the command string reaching the shell verbatim. It mocks `node-pty` and
  drives the real `spawn()`, so it covers the combinator, not a pure helper that a later
  edit to `spawn()` could bypass while staying green.
- `cli.test.ts` weave cases — user quoting, `&&`, a Windows path, and a quoted env value
  appended raw rather than tokenized.

Each was mutation-checked rather than trusted for passing: dropping `-l`, JSON-escaping
the command, and quoting the woven value each turn the new cases red.

The tests pin that `-l` is passed, not what sourcing the profile produces — that needs a
real spawn, so it was measured directly instead (§2.7).

### 1.5 Replacement assessment

| Candidate | Verdict |
|---|---|
| Agent-native config (`~/.claude/settings.json` etc.) | Cannot express per-invocation values, and the vars exist precisely to vary per terminal tab. Fails scalar override. |
| Argument profiles in `daemon.json` | Expressible, but moves the value out of the shell profile, which is where a per-machine `PATH`-dependent value naturally lives. |
| Lightweight non-PTY launch path (`spawn` the same shell, no PTY ownership) | The only candidate that preserves §1.2 in full. AgentDeck would still compose and hand off the command string, but would not own the terminal. **Unmeasured:** whether a handed-off shell process can be hook-attributed to the resulting observed session. |

---

## 2. Terminal-only affordances

### 2.1 Everything `OutputParser` produces, and where it goes

Seventeen distinct events (`bridge/src/output-parser.ts`). The Claude adapter forwards
twelve (`adapters/claude-code.ts:32-70`) under a comment that states the boundary
directly: *"Never add turn lifecycle or tool events here: hooks own state, timeline, and
APME correctness."*

| Parser event | Forwarded as | Observed (hook) equivalent | Verdict |
|---|---|---|---|
| `permission_prompt` | `terminal_ui` | Held `PreToolUse` gate (`observed-steering.ts`) | Partial — different semantics, see §2.2 |
| `option_prompt` | `terminal_ui` | AskUserQuestion gate + terminal injection | Partial |
| `diff_prompt` | `terminal_ui` | the underlying decision yes, the diff no — §2.5 | Partial |
| `status_line` | `terminal_ui` → `usageTracker.setDuration/setOutputTokens` (`state-machine.ts:381`) | tokens yes (§2.3), duration no | Partial |
| `project_name` | `terminal_ui` | bridge-resolved, git-aware; parser scrape is the fallback (`claude-code.ts:98`) | Covered |
| `model_info` | `terminal_ui` | transcript `message.model` (`passive-observer.ts:324`) | Covered |
| `mode_change` | `terminal_ui` | none found | **Managed-only** |
| `suggested_prompt` | `terminal_ui` | none found | **Managed-only** |
| `remote_url` | `terminal_ui` | none found | Managed-only (low value) |
| `cursor_update` | `metadata` | none — no cursor exists to track | **Managed-only by construction** |
| `usage_info` | `metadata` | daemon usage/quota clients (`usage-*.ts`) | Covered by a better source |
| `user_prompt` | `metadata` | `UserPromptSubmit` hook / transcript | Covered |
| `spinner_start` | *not forwarded* | hooks | lifecycle — hook-owned |
| `spinner_stop` | *not forwarded* | hooks | lifecycle — hook-owned |
| `idle` | *not forwarded* | hooks | lifecycle — hook-owned |
| `tool_action` | *not forwarded* | `PreToolUse` | hook-owned |
| `effort_level` | *not forwarded* | — | unused |

The five unforwarded events do not reach the state machine at all, and the boundary is
enforced twice rather than by convention. Both PTY adapters refuse to forward them, each
with the reason in a comment (`claude-code.ts:33`, `codex-cli.ts:26`), and the receiving
end filters independently: terminal events arrive at `handleTerminalUiEvent`
(`index.ts:669`), which drops anything outside `TERMINAL_UI_EVENTS`
(`state-machine.ts:56-67`) — a set that excludes `spinner_start`, `spinner_stop`, `idle`
and `tool_action`.

So **principle 2 of #273 is not violated anywhere today**: no terminal parse authors
lifecycle, in the managed path or outside it. That is worth stating positively, because a
replacement design does not have to budget for undoing one.

The neighbouring `case 'parser'` (`index.ts:661-666`) is easy to misread as the terminal
route. It is not: `source: 'parser'` is emitted only by the **structured** adapters —
OpenCode SSE and the OpenClaw Gateway — which normalize native event streams into the same
vocabulary. A consequence worth knowing before reading the state machine: those adapters'
`spinner_start` still transitions with the literal source label `'pty'`
(`state-machine.ts:327`), which is a stale name for a non-terminal producer, not evidence
of terminal parsing.

### 2.2 Command semantics: managed vs observed

`handleObservedClaudeCommand` (`daemon-server.ts:5462`) states the divergence in its own
comment, and the code confirms it:

| Deck command | Managed PTY | Observed |
|---|---|---|
| `interrupt` | `\x03` written to the PTY (`pty-manager.ts:204`) — immediate | `requestStop(uuid)` → soft stop, denied at the **next tool call**. Pure text generation runs to completion. |
| `escape` | a *different* key — `\x1b` (`pty-adapter.ts:127`), dismiss/cancel, not interrupt | collapsed onto the same `requestStop` as `interrupt` (`daemon-server.ts:5464`), so ESC has **no** observed equivalent at all — a larger divergence than the interrupt row |
| `send_prompt` | typed into the PTY | queued, delivered by the `Stop` hook as `{decision:'block'}` |
| `respond` / `select_option` | key injection into the owned PTY | held gate if the daemon owns it; otherwise key injection into the user's terminal via the host ladder (§2.4) |
| `switch_mode` (Shift+Tab) | `\x1b[Z` + 100 ms debounce (`claude-code.ts:81`) | **absent** — not handled anywhere in `handleObservedClaudeCommand`; only `session-focus-relay.ts:48` lists it, and that relays to a managed session |

`switch_mode` is the cleanest managed-only capability in the repository: there is no hook,
no API, and no injection path for it.

It is **not** a dead control on observed rows today, because no observed-facing surface
offers one:

- The live session deck (`buildSessionDeck`, `d200h-layout.ts:874`) emits seven command
  types — `escape`, `interrupt`, `permission_decision`, `send_prompt`, `session_command`,
  and the observed answer path's `select_option` / `respond` (`:1141`, `:1146`). No mode
  command is among them.
- The MODE tile that does emit `{ type: 'mode_toggle' }` (`d200h-layout.ts:651,669`) lives
  in `computeLayout`, the legacy single-page direct-HID grid. `D200HLayoutModel.swift:55-58`
  records that path as superseded by the session-centric deck, and the direct-HID drivers
  are gone.
- The remaining mode button (`index.ts:1231`, gated on state at `:1230`) is built inside
  `startSession` — the session-bridge path, so its session is managed by construction.

Two dead mirrors survive and both read like evidence that observed mode switching works.
The Swift daemon carries a `mode_toggle` handler (`DaemonServer.swift:4847`) routing
`switchMode` through the focus relay, which no live layout emits; and Android's
`BridgeConnection.sendSwitchMode()` (`BridgeConnection.kt:216`) has no callers anywhere in
the Android tree.

The consequence for #273 is sharper than "partial": today `switch_mode` is reachable
**only** from a managed session's own deck, so removing the managed path removes the
capability outright rather than degrading it.

### 2.3 The telemetry row in #273 is too pessimistic

#273's table records *"Terminal status-line token/cost telemetry — None"* for the
daemon-first replacement. Measured, that is wrong for tokens:

`passive-observer.ts:328-333` accumulates `input_tokens + output_tokens +
cache_read_input_tokens + cache_creation_input_tokens` from the transcript and derives
`contextPercent` (`:379-381`); both reach the wire (`protocol.ts:504`) and are rendered
(`shared/src/d200h-layout.ts:691`). Codex has the parallel path (`:485-536`).

What is genuinely terminal-only:

- **Turn duration** — `usageTracker.setDuration` has exactly one feed, the `status_line`
  parse (`state-machine.ts:386`).
- **The live status-line readout itself**, as text.

And `usage_info` (quota percent, `costSpent`/`costLimit`, reset time — `output-parser.ts:830-864`)
is a scrape of Claude's `/usage` output. The daemon already has first-class clients for
that data, so this is a duplicate source rather than a unique capability.

This row should be corrected in the issue before anyone designs against it.

### 2.4 Observed injection is real, but platform-bounded

`injectObservedSelection` (`observed-inject.ts:373`) is a four-rung ladder: tmux
`send-keys` → iTerm2 → Terminal.app tab select + JXA key post → app-hosted (labelled
button, then key post, then raise). `injectObservedText` (`:436`) does the same for a
dictated line, terminal hosts only, by explicit design.

Rungs 2-4 are `osascript` (`:341`, `:352`) — **macOS only**. Rung 1 needs `tmux`. So on
Windows and on Linux without tmux, an observed session has no injection path at all, and
the file says so in its header: *"Node-daemon only by design: every rung needs a
subprocess."*

This is a platform axis #273's table does not carry. A replacement claiming parity has to
state which platforms it claims it on.

### 2.5 `diff_prompt` is unrendered, not unreachable

The edit-approval prompt looked structurally terminal-only. It is not.

`Write`, `Edit`, `MultiEdit` and `NotebookEdit` are all in the prompting set
(`shared/src/claude-permission-rules.ts:66`), so an edit fires `PreToolUse` and is eligible
for the held device gate like any other tool. The **decision** an observed user would make
at the diff prompt is therefore already reachable daemon-first.

What is lost is the diff itself, and the loss happens on our side of the hook, not at it.
`daemon-server.ts:3677` has the full `toolInput` in hand — for an edit that includes
`old_string` and `new_string` — and passes it to `buildGateQuestion`, which
(`observed-steering.ts:76`) reduces it to `Allow Edit: <file_path>`. Only that one-line
string reaches the overlay; the overlay keeps `question` and `options`
(`awaiting-overlay.ts:29-60`), never the tool input.

So the accurate statement for #273 is: **the diff data arrives at the daemon and is
discarded before anything could render it.** Closing this gap is a rendering decision, not
a protocol or hook limitation. The third terminal affordance — "(V)iew diff" as a
navigable option next to Apply/Deny — has no equivalent, since the deck's gate is
allow/deny.

### 2.6 Hook attribution of a handed-off process is mechanically available

§1.5's replacement candidate — AgentDeck composes and hands off the command but does not
own the PTY — depends on the daemon being able to tell that the observed session which
appears is the one it launched. The machinery for that already exists:

- Every Claude hook posts `X-AgentDeck-Pid: $PPID`, folded into the payload as
  `agentdeck_pid` (`daemon-server.ts:2969-2977`) — described there as *"the only
  consent-free session→process link"*.
- `coordination.registerPid` (`coordination-evidence.ts:264`) already handles a wrapper
  sitting between the hook shell and the agent: it walks up to four levels of `ppid` until
  it finds an agent process (`isAgentProcessCommand`, `:153`), so a shell in the middle
  does not break the link.
- `passiveSessionObserver.processes()` supplies the pid/ppid table both directions.

The risk was that the ancestry might not survive — a shell that forks and exits re-parents
the agent away from the daemon's child. Measured (§2.7): it does not fork. The pid the
daemon spawns *becomes* the agent, so attribution does not even need the walk.

### 2.7 Two runtime measurements

Both were open questions a source reading could not close. Measured on this desk,
macOS 25.6, `/bin/zsh` as `$SHELL`, reproducing `PtyManager`'s exact invocation shape.

**The shell execs the command; it does not fork.** Spawning `$SHELL -l -c "sleep 30"` and
then reading `ps -Ao pid=,ppid=,comm=`, the pid handed back by `spawn()` was itself
`sleep`, with no children — under zsh and bash, and under a compound `cd /tmp && sleep 30`
as well (the final command is exec'd either way).

Consequence for §2.6: a daemon that hands off `$SHELL -l -c "<agent>"` keeps the agent as
its **own direct child**, with the pid it already holds. Attribution needs no ancestry walk
and no new consent surface; `registerPid`'s wrapper walk is a safety net, not the mechanism.

**`-l` genuinely rewrites the environment.** Handing the shell a deliberately minimal
`PATH=/usr/bin:/bin`, the login shell reported a profile-built `PATH`
(`/usr/local/bin:/System/Cryptexes/…` and the rest), while the same shell with `-c` and no
`-l` reported the minimal value back unchanged.

Consequence for §1.2: the login flag is load-bearing, not decorative. A replacement that
execs the agent binary directly gets the daemon's `PATH`, not the user's — which is exactly
how a version-managed agent binary goes missing.

**Not covered:** any shell but zsh and bash. `PtyManager` uses whatever `$SHELL` names, and
a shell without the final-command exec optimization (or a command shape that defeats it)
leaves the spawned pid as the shell — exactly the case §2.6 concludes attribution no longer
has to handle. The conclusion is safe for the two shells measured and should be re-measured
before being relied on for others.

**Also not covered:** Windows. `cmd.exe /d /s /c` has no `exec`, so the
interpreter stays as the agent's parent and the pid the daemon spawned is *not* the agent
pid. Any attribution design has to carry the ancestry walk for Windows even though POSIX
does not need it. This desk cannot measure that.

---

## 3. Corrections this measurement suggests for #273

1. Telemetry row: tokens and context percent **are** available daemon-first; scope the row
   to turn duration and the status-line text (§2.3).
2. Add a platform axis to the terminal-affordance rows — observed injection is macOS or
   tmux (§2.4).
3. Split the "terminal UI observation" row: `project_name`, `model_info`, `user_prompt`,
   `usage_info` are already covered or better-sourced; `diff_prompt`, `mode_change`,
   `suggested_prompt`, `cursor_update` are the real remainder (§2.1).
4. "Resume-command composition" is not an AgentDeck feature and needs no replacement
   design — only the no-clobber guarantee it already has (§1.3).
5. `diff_prompt` should not read as managed-only: the decision is already hook-reachable
   and the diff data reaches the daemon before being discarded (§2.5).

## 4. Still unmeasured

- The Windows half of §2.7: `cmd.exe /d /s /c` cannot exec, so the spawned pid is the
  interpreter, not the agent. Needs a Windows desk.
- Everything in the remote-attach and session-ordering gates.
