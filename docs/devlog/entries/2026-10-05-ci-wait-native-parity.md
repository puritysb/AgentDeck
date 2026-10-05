# 2026-10-05 — CI wait native command parity

Continue [#433](https://github.com/puritysb/AgentDeck/issues/433) after the
[#457](https://github.com/puritysb/AgentDeck/pull/457) command-intent foundation.
CLI options, ASCII identity patterns, JavaScript whitespace and numeric/input
bounds now live as exported rule data in `shared/src/ci-wait.ts`.
`pnpm generate-ci-wait` emits the stateless Swift classifier; the Vitest byte
gate rejects native drift. No subprocess, network or new runtime resource.

The shared 97-vector corpus runs in TS, in a compiled Swift 6 executable on
macOS, and in `CiWaitRulesTests` through native XCTest. It includes JSON numeric
1 vs true, malformed input, maximum safe run IDs, Unicode whitespace, surrogate
pairs, quoted examples, loop scope and conflicting repo/PR identities. Regex
end anchors may match before a trailing line separator, so both classifiers
require exact whole-argument metadata matches and discard that unsafe suffix.
Generated Swift accepts only CFBoolean for the background flag: Foundation's
numeric-to-Bool bridge cannot manufacture background intent.

This remains preparatory source: neither daemon consumes the classifier yet.
Hook/process lifecycle confirmation and close, wire/null clearing, timeline,
deck badges, GitHub verdict probes and aquarium/device scenes remain open in
#433. No installed daemon, submitted app or public package was changed.
