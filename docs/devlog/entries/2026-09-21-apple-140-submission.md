# 2026-09-21 — Apple 1.4.0 submitted for review

Apple-only delivery: macOS and iOS/iPadOS 1.4.0. No npm, deck-plugin,
Android, or firmware channel was published in this round.

## Delivery evidence

- [PR #352](https://github.com/puritysb/AgentDeck/pull/352) contains z.ai integration/usage lifecycle and preview improvements, Codex setup recovery, and localized release notes.
- [PR #353](https://github.com/puritysb/AgentDeck/pull/353) corrects the native CI host and pipeline failure propagation.
- Tag `apple-v1.4.0` points to `132b6b15cedd411580a67729516036001bcf8059`.
- [Release workflow](https://github.com/puritysb/AgentDeck/actions/runs/35543269140) passed both signed archive/export gates and both uploads. [GitHub Release](https://github.com/puritysb/AgentDeck/releases/tag/apple-v1.4.0) is published.
- [Apple receipt](https://github.com/puritysb/AgentDeck/actions/runs/35543822308) independently reports macOS **7001** and iOS **7001**, each version **1.4.0**, processing state **VALID**. Build numbers were read from Apple records.
- The portal confirmed **Waiting for Review** independently for iOS and macOS on 2026-09-21. Both retain automatic release after approval. This is submission, not public availability; **1.3.2** remains the last verified live version.
- [Post-submission status check](https://github.com/puritysb/AgentDeck/actions/runs/35544124586) records the final Apple state.

English, Korean, and Japanese What's New were saved for each platform.
macOS review notes explain optional z.ai configuration and Codex retry/file
reselection while retaining the existing account-free review path. Existing
screenshots, review contact, privacy settings, and rating retention were preserved.

## Verification and remaining uncertainty

The corrected native CI executed **903 tests, one skipped, zero failures**
([run](https://github.com/puritysb/AgentDeck/actions/runs/35543032153)).
The local full native suite executed 903 tests with two skips and no failures.
Node build/typecheck passed; 303 Vitest suites passed with 4,651 tests passed
and two skipped. Submission metadata and exported App Store invariants passed.

A support reply was sent describing the implemented recovery improvements,
explicitly distinguishing the unconfirmed cause on the reporting Mac from
reproduced installer/UI weaknesses. It requested only versions and minimal
configuration-shape information, not full configuration or credentials. No
release date or confirmed end-to-end resolution was promised.

Real z.ai account behavior, physical device flows, and the signed interactive
file-picker recovery were not newly exercised in this release round. The
reporter's exact cause remains unconfirmed pending their response.
