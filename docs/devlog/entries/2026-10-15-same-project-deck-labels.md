# 2026-10-15 — Same-project sessions get an id tag on the deck (#544)

Two Claude Code sessions in one repository (two terminal tabs) drew byte-identical
keys on the D200H/D200X and Stream Deck: same project name, creature and state.
The reporter's voice prompt went to the other `chezmoi` session and only the
daemon log showed it. The Stream Deck plugin already computed `#N` names, but
only its INFO readout used them; neither deck passed a label to the session key.

`shared/src/session-labels.ts` is now the one rule. Rows that share
`projectName` and `agentType` get the shortest prefix (≥ 4 chars) of the bare
session id that is unique in the group; a lone row stays untouched. An id tag,
not an ordinal, because `#N` renumbers when an older sibling ends, while the id
prefix is fixed for the session's life, is the same in both daemons' id forms
(`rawSessionId`), and matches Claude Code's `/status` and daemon logs. The tag
grows past a shared leading run, since UUIDv7 and OpenCode ids are time-ordered.
`sessionLabelText` shortens the project name first so the tag stays whole on
the 10/12-character INFO tiles.

The terminal tab title, `claude --name` and the git branch would read better,
but neither daemon puts any of them on the session row today (the Swift row has
no `cwd` either), so they need producer work first. No new wire field was added:
the Ulanzi VOICE tile sends to the session whose detail view is open, and that
view's INFO tile now carries the tag.

**Pre-merge review fixes (same PR).**
- **Tag choice for time-ordered ids.** Time-ordered ids (OpenCode `ses_…`, UUIDv7) share a long prefix. Their shortest unique prefix could outgrow the 10-character INFO tile and truncate into identical text again. Past six characters, the shorter unique tail is now used, written `…4e5f`.
- **Type-word stripping.** A Hermes `hermes-` type word is stripped. A uuid that starts with hex letters (`deadbeef-`) is not.
- **Truncation.** The label text counts code points, so an emoji or non-BMP project name is never split.
- **Mirror gate.** The Swift preview port is now behind a `SYNC-HASH shared/src/session-labels.ts` pin, with a row in the SSOT catalogue.
- **Wording.** The "never changes" wording is corrected: a tag can lengthen when a similar sibling appears.
