# 2026-10-05 — CI wait command evidence foundation

Issue [#433](https://github.com/puritysb/AgentDeck/issues/433) starts with a shared
command classifier in `shared/src/ci-wait.ts`. It accepts explicit background
`gh run watch` / `gh pr checks --watch` intent and `run list` / `pr checks` in
balanced while/until loops. Repo, branch, PR and run IDs come only from arguments;
no cwd/project inference, shell execution, GitHub access or credentials are involved.

Quote-aware tokenization rejects examples printed by echo/printf, comments,
one-shot queries, incomplete loops, unsafe numeric IDs, multiple conflicting
watchers, malformed input and unsupported substitutions/functions. Unknown flags
fail closed. Environment values, query expressions, redirects and log output are
not returned. Input is bounded to 16,384 UTF-16 code units.

This is preparatory source, not installed CI-wait observation. Hook input is
intent before execution; process ancestry must confirm a running watcher, and
the future bounded GitHub probe must retain unknown on unreadable results.
`waitingOn` emission/explicit null clearing, daemon/native parity, timeline,
deck badges, aquarium station and hardware rendering remain in #433.

The planned App Store boundary is documented before integration: Swift may
consume hook evidence but must not spawn gh; Node owns process/GitHub probes.
Native rules must be generated from this canonical source before use.
