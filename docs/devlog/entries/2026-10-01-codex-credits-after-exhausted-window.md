# 2026-10-01 — Codex credits replace an exhausted plan window on every usage surface

### What changed

When a Codex 5h or weekly window reaches 100% and the account still holds purchased credits, every usage surface now shows the remaining balance (`62.5K CREDITS LEFT`) in place of the exhausted window, with the time the plan window resets (the latest reset among the exhausted windows). A zero or unreported balance shows nothing. PR #431.

The rule lives once in `shared/src/usage-presentation.ts` (`usageCreditsActive`, `codexCreditBalance`, `selectedCodexCredits`, `formatCreditBalance`) and is generated into Swift, Kotlin and C++ by `pnpm generate-usage-presentation`. `shared/credit-balance-vectors.json` is replayed by the TS, Swift, Kotlin and ESP32 suites. The display contract is recorded in `.claude/rules/usage-quota.md`.

### Measured input

Local rollouts on 2026-09-30 carried the shape this is built for: `plan_type: "pro"`, the weekly window at 92–94%, and `credits: {"has_credits": true, "unlimited": false, "balance": "62500"}` on the same `limit_id: "codex"` line. Of 7,254 recent `credits` blocks, 7,218 were the empty `{"has_credits": false, "balance": "0"}`, so a credits reading must never appear merely because the block is present.

### Decisions

- **Credits before Luna.** Where a surface fits two Codex readings, credits come first and the Luna reserve second. Where it fits one, credits win, because credits are what the account is spending. The D200H strip drops the Luna tile first when full; the SD+ encoder pairs the two in its wide view; ESP32 orders the rows `[Credits, Luna]`, so any surface that keeps only the first row follows the rule automatically.
- **No severity or fill.** A balance has no cap, so a bar or a ramp colour would be a fake percentage.
- **Truncate, never round up.** `formatCreditBalance` uses integer-only arithmetic (`62500 → 62.5K`, `7.49 → 7.4`) so every mirror agrees and no surface overstates the balance.
- **Credit-only plans are separate.** Plans with no windows at all keep their existing credits readout; the new reading requires an exhausted window.

### Pitfalls found

- **"100% LEFT" was wider than the key.** At 28px bold Arial it measures about 150px on a 144px Stream Deck/D200H key, and from the encoder's x=72 anchor it overran the 200px LCD, clipping the final `T`. `remainingPercentSvgText` (`shared/src/svg-renderers/usage-reserve-marks.ts`) now sets `LEFT` at half the number's size; both tiles were rendered in Chrome to confirm.
- **A ringed coin with a bar reads as a power button.** The credit mark is a stack of three coins instead.
- **ESP32 fonts have no ∞.** Unlimited credits read `UNL` on firmware only; the TTGO 16/28px fonts contain only digits and `%`, so the balance uses the 12px font there.
- **The Node serial whitelist dropped `credits`.** `prepareForSerial` forwards only listed fields, so the balance never reached boards over USB until it was added; the Swift daemon already passes the whole block.

### Not yet verified

PlatformIO firmware builds and `esp32/sim/render.sh` did not run: the package mirror `sin1.contabostorage.com` refused connections. The ESP32 host tests and `-fsyntax-only` checks passed. `design/lint.sh` needs bash 4 or newer and did not run on stock macOS bash.
