# 2026-10-07 — Verification tiers and an honest Test Report

The Build Health page could not say whether several suites were tested at all. An audit of the published report and the workflows found:

- About ten Vitest cases gated on `process.platform === 'darwin'` ran on no CI runner, including the generated-Swift parity vectors (daemon policies, CI-wait classifier, IPS10 roster, matrix expressions, native TUI) and the launchd probe. They are skipped on ubuntu, and `apple-test.yml` runs XCTest, not Vitest.
- ESLint was configured but ran in no workflow and had grown to 181 errors. 166 of them were config noise: the vendored Ulanzi browser SDK linted with Node globals, plus a gitignored generated file that only some checkouts have.
- `esp32/sim/run-tests.sh` (the firmware policy-header assertions) was local-only.
- `pnpm test:report` failed on its first line on macOS, because the script needed bash 4 associative arrays.
- The page showed Apple XCTest and ESP32 Robot as "Not run" forever. Its History pass rate divided by a total that included skipped cases (99.7% with zero failures).

Changes:

- [`scripts/verify.mjs`](scripts/verify.mjs) runs three tiers defined in the catalog's `tiers` and `steps`: `pnpm verify:changed` (steps whose paths the diff touches; `vitest related` plus tests that name a changed data file), `pnpm verify:quick` (the ubuntu PR gates), and `pnpm verify:full` (adds coverage, every native toolchain on the host, the npm package acceptance and attested lab gates). Each run writes a receipt. `--record` commits the pre-release receipt that the report shows.
- CI gains a `macos-native-parity` job and an ESLint error ratchet (baseline 13). ESP32 host assertions now run in the ESP32 compile job. The design-lint ratchet moved to a script that counts tracked files only, so a built checkout gets the CI answer.
- The report adds a Verification tiers section (step × tier matrix, receipts). It lists every skipped case with the runner that executes it. Gate cards name their local tiers and their workflow's latest hosted run, and results from elsewhere get an outlined badge that never enters this page's totals.
- `verification-catalog.test.ts` now fails when a platform-gated test file is missing from its CI job, a lab gate has no pre-release step, or a changed-area path matches no tracked file.
