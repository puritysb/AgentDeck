# 2026-10-18 — A Codex approval can wait for a device, opt-in

The 2026-10-16 roadmap item was the Codex `PermissionRequest` hold. Before this
change both daemons showed a Codex approval display-only. Codex already sends
`PermissionRequest` only when it is about to ask, so a device answer needs no
prediction. The open questions were whether Codex waits for the hook, what it
reads back, and how a new handler survives Codex's hook trust.

**Measured (codex-cli 0.160.1, 2026-10-18).** The already-trusted AgentDeck
notification handler was pointed at a scratch receiver through `AGENTDECK_PORT`.
The receiver logged the request and delayed its answer within the handler's
0.8 s curl budget. The TUI showed `Working · Running hook` while the receiver
waited. It drew `Would you like to run the following command?` 119 ms after the
receiver answered (PTY log: request at 6953 ms, answer at 7389, prompt at 7508).
The stdin payload carried `session_id`, `turn_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`, `permission_mode`, `tool_name` and `tool_input`
(`command`, `description`), but no `tool_use_id`. PreToolUse arrived before
PermissionRequest. The capture is `capturedPermissionRequest` in
[shared/codex-approval-hold-vectors.json](shared/codex-approval-hold-vectors.json),
with the home path scrubbed.

**Read, not measured.** Codex's [hooks documentation](https://developers.openai.com/codex/hooks)
gives the output schema. A handler allows with
`hookSpecificOutput.decision.behavior = "allow"`. It denies with `"deny"` plus a
`message` that Codex hands to the model. Any deny wins, and empty stdout with
exit 0 means no decision. The `updatedInput`, `updatedPermissions` and
`interrupt` fields are reserved and fail closed.

The compiled handler fields are `type`, `command`, `commandWindows`, `timeout`,
`async`, `statusMessage` and `additionalContextLimit`.

Trust is keyed `<source>:<event_snake>:<group>:<handler>` with a `trusted_hash`
per handler. A new handler gets the startup "Review hooks" screen.
Byte-identical content matches its old trust record.

Still unmeasured: a decision printed by a *trusted* hold handler taking effect
in real Codex. Making the handler trusted is the user's step. The one
shortcut, a probe under `--dangerously-bypass-hook-trust`, was refused by the
session's safety classifier and was not worked around. The installers never
write `[hooks.state]` trust records.

**Design.**

- **Second handler.** The hold is a second handler inside AgentDeck's own
  `PermissionRequest` group. The notification handler keeps its index, hash and
  trust. A user's group (workmux is group 1 on this machine) keeps its key.
  Adding a group ahead of it would re-key it.
- **Same endpoint, marked by a header.** The handler posts the notification's
  payload to the same `/hooks/codex_permission_request` endpoint with
  `X-AgentDeck-Hold: 55`. It prints the answer only when it contains
  `"hookSpecificOutput"`. A daemon without the hold ingests the request as one
  more notification and answers `{"received":true}` at once, so the handler
  prints nothing and Codex shows its own prompt.
- **No double ingestion.** The two posts cannot be deduplicated, because the
  replay fingerprint needs `tool_use_id`. So the daemons never ingest the hold
  request; they only put the prompt and its `requestId` on the row.
- **Old installers degrade cleanly.** An installer that predates the hold owns
  any group whose commands contain `/hooks/codex_` and whose fields are limited
  to `matcher`, `type`, `command`, `timeout` and `notify`. Such an installer
  rewrites the block without the hold instead of refusing the file. That rules
  out `statusMessage`. It also includes the App Store app, which reruns its
  installer on every in-process daemon start.

**Rejected:**

- a separate event name (old daemons route it nowhere);
- a group of its own (re-keys trust);
- a `statusMessage` (old installers refuse the file);
- holding by default.

Holding by default was rejected because both costs land on the person at the
terminal: one review screen, and `Running hook` instead of the prompt for up to
25 s. The default policy `auto` keeps whatever the managed block carries.

**Bounds.**

- **When a request is held.** Only with a connected client, a visible session
  that is neither a background thread nor a folded `codex exec` child, and no
  open hold on it.
- **How long.** At most the observed-approval hold (25 s), and never longer
  than the command's budget minus 3 s.
- **Early release.** The turn's own end (stop, interrupt, turn complete,
  session end or a new prompt) releases the hold as `ended`. On Node only, the
  hook's socket closing does too.
- **Undecided release.** The prompt stays on the row display-only, since Codex
  draws it.

The rules live in [shared/src/codex-approval-hold.ts](shared/src/codex-approval-hold.ts),
with the Swift mirror generated behind a byte gate.

**Known gap.** The Swift HTTP server cannot see a hook's socket close while the
handler is suspended. If Codex kills the hook without firing `Interrupt`, the
Swift daemon keeps the button until the hold times out.

**Verification so far.**

- Node: unit suites replay the vectors; the real-shell installer test exercises
  allow, empty answer, `{"received":true}`, 404 and a closed port.
- Node e2e: `tests/e2e/daemon-hub.e2e.test.ts` passes 13/13 locally against a
  real isolated daemon on macOS, with `AGENTDECK_E2E_ALLOW_DARWIN=1` and a fake
  `security` on PATH so no Keychain dialog can open. It covers an unattended
  pass, a WS allow and deny, the deck-key presses below, and an interrupt
  release.
- Swift: XCTest replays the same vectors, the policy round-trip, the gate
  lifecycle, the press decision and the OpenClaw id guard.

**Review fixes (same day).** An adversarial review of the PR found three
defects.

- **The deck's keys did nothing.** A Stream Deck's Allow / Deny keys send an
  option press (`session_command{select_option, index, question}`), never
  `permission_decision`. A held Codex approval ignored them in both daemons;
  only a client sending `permission_decision` could answer. Both daemons now
  map a press on an open hold onto the same resolution: index 0 or `y` allows,
  1 or `n` denies (`codexHoldPressDecision`, generated into Swift; the vectors'
  `presses` are replayed by both suites). A press that echoes a question the
  hold does not show is dropped, as the Claude gate does. The e2e presses a
  stale Deny, then Allow with the shown question, then a bare `select_option`
  Deny on a 31-character id prefix.
- **Swift answered the wrong approval.** A `permission_decision` that no gate
  claimed fell through to whichever OpenClaw approval was up, whatever its
  `requestId`. It now reaches the approval only when the id is that
  approval's; an unknown id resolves nothing and is logged.
- **A managed PTY ingested the hold request.** A Claude or OpenCode bridge
  forwarded a nested Codex hold request without its header, so the daemon
  ingested it as a second notification. The forwarder now restates the header
  as its own 2 s budget, below the hold minimum, so the daemon answers at once
  without ingesting. A Codex bridge answers the hold request itself without
  emitting. Inside a managed PTY the hold is therefore inactive and Codex shows
  its own prompt.

Mutation checks: reverting the Node press routing fails the e2e, disabling the
echo guard fails its unit test in both suites, and dropping the Swift id guard
fails its XCTest.

Left alone, as the review noted:

- `codex_user_prompt_submit` releases an open hold as `ended`, like the other
  turn-end events.
- `retractCodexThread` does not release an open hold. The hold outlives the
  row until its timeout or the turn's end.
- The #273 relay worker refuses option answers for non-Claude ids, so a hub's
  Stream Deck cannot answer a relayed Codex hold. Surfaces that send
  `permission_decision` can.
- Swift routing inside `handleCommand` has no unit seam. XCTest covers the pure
  press decision (`codexApprovalPress`) and the adapter's id guard; the Node
  e2e drives the routes.
