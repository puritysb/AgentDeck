# 2026-09-29 — "What we verify" stops calling non-required checks blocking

The Build Health "What we verify" tab labelled eleven gates **Blocking** (`blocking: true` in `scripts/verification-catalog.json`), while master branch protection requires one status check, ESP32 Sim Compile (`gh api repos/puritysb/AgentDeck/branches/master/protection`, 2026-09-29). A red `test`, E2E, typecheck or Windows run marks a pull request but does not stop GitHub from merging it.

The catalog now separates the two facts: `blocking` means a failure turns its workflow red, and `required` marks a gate whose check branch protection lists. Only a required gate renders **Required to merge**; other failing-CI gates render **Fails CI**. Branch protection is a repository setting the Pages workflow's token cannot read, so `merge_policy.as_of` dates the manual comparison and the page shows it in a "Merge policy" card. `verification-catalog.test.ts` requires every required gate to be a failing-CI workflow gate and the date to be present; `build-health-report.test.ts` fails if the rendered page says "Blocking" again.

Making more checks required is a separate repository-settings decision: `apple-test.yml` and `android-test.yml` are path-filtered, so requiring them as they are would leave unrelated pull requests waiting on a check that never runs (see the note in `esp32-sim.yml`).
