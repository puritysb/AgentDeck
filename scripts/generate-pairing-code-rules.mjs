#!/usr/bin/env node
// Generate the Swift/Kotlin mirrors of the pairing-code SSOT
// (shared/src/pairing-code.ts).
//
//   pnpm generate-pairing-code-rules            regenerate the mirrors
//   pnpm generate-pairing-code-rules --check    exit 1 if any mirror drifted
//
// Requires shared to be built first (`pnpm --filter @agentdeck/shared build`),
// since the CLI reads the constants from shared/dist. The vitest sync test
// imports the emitters below against the TS source, so drift is caught in CI
// even when this CLI is never run.
//
// Why the logic is emitted and not just the numbers: a redemption verdict is a
// wire contract. Both daemons must answer the same HTTP status for the same
// (window, code, clock), because a client's retry policy branches on it — 401
// means "ask the human again", 410/429 mean "the window is gone, stop". Two
// hand-written evaluators would drift on exactly the ordering rules that make
// the cap a cap (expiry before code, malformed before mismatch).
//
// Swift gets the whole evaluator because the macOS app hosts a daemon. Kotlin
// gets normalize/format only — Android is a client; it submits codes and never
// judges them, and an evaluator it cannot reach would be dead mirror surface.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/pairing-code.ts\n' +
  'Regenerate: pnpm generate-pairing-code-rules (drift gated by shared/src/__tests__/pairing-code-rules-sync.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

export function emitSwift(rules) {
  return `${comment('//')}

import Foundation

/// Operator-authorized pairing codes — see shared/src/pairing-code.ts for why
/// this path exists and what it deliberately does not weaken.
///
/// Pure, injected-clock, no daemon state: \`PairingWindowStore\` owns the mutable
/// window and asks this type for every verdict, so the Swift daemon and the Node
/// daemon answer a redemption identically.
enum PairingCodeRules {

    /// Digits in a pairing code.
    static let digits = ${rules.digits}

    /// How long an operator-opened window stays open, in milliseconds.
    static let windowMs = ${rules.windowMs}

    /// Wrong codes the whole window tolerates before it closes. Global rather
    /// than per-peer: an attacker picks their source address.
    static let maxFailedAttempts = ${rules.maxFailedAttempts}

    /// Credentials one window hands out unless the operator asks for more.
    static let defaultRedemptions = ${rules.defaultRedemptions}

    /// State a daemon keeps for an open window, and all these rules read.
    struct WindowSnapshot: Sendable {
        var code: String
        /// Epoch milliseconds after which the window is closed regardless.
        var expiresAt: Int
        var failedAttempts: Int
        var redemptionsRemaining: Int

        init(code: String, expiresAt: Int, failedAttempts: Int = 0, redemptionsRemaining: Int = PairingCodeRules.defaultRedemptions) {
            self.code = code
            self.expiresAt = expiresAt
            self.failedAttempts = failedAttempts
            self.redemptionsRemaining = redemptionsRemaining
        }
    }

    enum Outcome: String, Sendable {
        case accepted
        case noWindow = "no-window"
        case expired
        case exhausted
        case mismatch
        case malformed
    }

    struct Result: Sendable {
        var outcome: Outcome
        /// The HTTP status to answer with — part of the shared contract.
        var status: Int
        var attemptsRemaining: Int
        /// True when the daemon must drop the window as a result of this call.
        var closes: Bool
    }

    /// Reduce a human-entered code to its canonical form, or nil if it is not one.
    ///
    /// Filters to ASCII digits, which is also why the TS/Swift string-unit trap
    /// does not apply here: after filtering, UTF-16 code units, Characters and
    /// bytes all agree, so \`count\` cannot disagree with TS \`.length\`.
    static func normalize(_ input: String?) -> String? {
        guard let input else { return nil }
        let digitsOnly = input.unicodeScalars.filter { $0.value >= 48 && $0.value <= 57 }
        guard digitsOnly.count == digits else { return nil }
        return String(String.UnicodeScalarView(digitsOnly))
    }

    /// True when \`code\` is exactly what \`normalize\` emits.
    static func isPairingCode(_ code: String?) -> Bool {
        guard let code else { return false }
        return normalize(code) == code
    }

    /// Group a code for display: \`482913\` → \`482 913\`.
    static func format(_ code: String) -> String {
        guard let normalized = normalize(code) else { return code }
        let half = digits / 2
        let split = normalized.index(normalized.startIndex, offsetBy: half)
        return "\\(normalized[normalized.startIndex..<split]) \\(normalized[split...])"
    }

    /// Length-independent compare, so a wrong code cannot be measured digit by digit.
    private static func codesMatch(_ a: String, _ b: String) -> Bool {
        let lhs = Array(a.utf8), rhs = Array(b.utf8)
        guard lhs.count == rhs.count else { return false }
        var diff: UInt8 = 0
        for i in lhs.indices { diff |= lhs[i] ^ rhs[i] }
        return diff == 0
    }

    /// The whole redemption decision, as a function of the window and the code.
    ///
    /// Order is contract: expiry is decided before the code is looked at, so a
    /// stale window is not probeable for free, and \`malformed\` is decided before
    /// \`mismatch\`, so a typo does not spend one of the operator's attempts.
    static func evaluate(window: WindowSnapshot?, submitted: String?, now: Int) -> Result {
        guard let window else {
            return Result(outcome: .noWindow, status: 401, attemptsRemaining: 0, closes: false)
        }
        if now >= window.expiresAt {
            return Result(outcome: .expired, status: 410, attemptsRemaining: 0, closes: true)
        }
        if window.redemptionsRemaining <= 0 || window.failedAttempts >= maxFailedAttempts {
            return Result(outcome: .exhausted, status: 429, attemptsRemaining: 0, closes: true)
        }

        let attemptsBefore = maxFailedAttempts - window.failedAttempts
        guard let code = normalize(submitted) else {
            return Result(outcome: .malformed, status: 400, attemptsRemaining: attemptsBefore, closes: false)
        }
        if !codesMatch(code, window.code) {
            let attemptsRemaining = attemptsBefore - 1
            return Result(outcome: .mismatch, status: 401, attemptsRemaining: attemptsRemaining, closes: attemptsRemaining <= 0)
        }

        let redemptionsLeft = window.redemptionsRemaining - 1
        return Result(outcome: .accepted, status: 200, attemptsRemaining: attemptsBefore, closes: redemptionsLeft <= 0)
    }

    /// Seconds left on a window, floored at 0 — for countdown copy.
    static func secondsRemaining(window: WindowSnapshot?, now: Int) -> Int {
        guard let window else { return 0 }
        let remaining = window.expiresAt - now
        if remaining <= 0 { return 0 }
        return (remaining + 999) / 1000
    }
}
`;
}

export function emitKotlin(rules) {
  return `${comment('//')}
package dev.agentdeck.net

/**
 * Operator-authorized pairing codes — the credential path for a reader with no
 * camera to scan \`agentdeck qr\` with and no USB channel to be provisioned over.
 * See shared/src/pairing-code.ts for the security reasoning.
 *
 * Android is a client here: it collects the code the operator reads off the Mac
 * and redeems it for a token. Judging a redemption is the daemon's job, so the
 * evaluator is deliberately not mirrored — only the shape both sides must agree
 * on, so the app can validate the field before spending one of the operator's
 * five attempts on a typo.
 */
object PairingCodeRules {

    /** Digits in a pairing code. */
    const val DIGITS = ${rules.digits}

    /** How long an operator-opened window stays open, in milliseconds. */
    const val WINDOW_MS = ${rules.windowMs}L

    /** Wrong codes the whole window tolerates before it closes. */
    const val MAX_FAILED_ATTEMPTS = ${rules.maxFailedAttempts}

    /** Credentials one window hands out unless the operator asks for more. */
    const val DEFAULT_REDEMPTIONS = ${rules.defaultRedemptions}

    /**
     * Reduce a human-entered code to its canonical form, or null if it is not one.
     *
     * Filters to ASCII digits, which is also why the Kotlin/TS string-unit trap
     * does not apply: after filtering, UTF-16 code units and characters agree.
     */
    fun normalize(input: String?): String? {
        if (input == null) return null
        val digitsOnly = input.filter { it in '0'..'9' }
        return if (digitsOnly.length == DIGITS) digitsOnly else null
    }

    /** True when [code] is exactly what [normalize] emits. */
    fun isPairingCode(code: String?): Boolean = code != null && normalize(code) == code

    /** Group a code for display: \`482913\` → \`482 913\`. */
    fun format(code: String): String {
        val normalized = normalize(code) ?: return code
        val half = DIGITS / 2
        return "\${normalized.substring(0, half)} \${normalized.substring(half)}"
    }
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Model/PairingCodeRules.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/net/PairingCodeRules.generated.kt', emitKotlin],
];

export function rulesFrom(mod) {
  return {
    digits: mod.PAIRING_CODE_DIGITS,
    windowMs: mod.PAIRING_WINDOW_MS,
    maxFailedAttempts: mod.PAIRING_MAX_FAILED_ATTEMPTS,
    defaultRedemptions: mod.DEFAULT_PAIRING_REDEMPTIONS,
  };
}

async function main() {
  let mod;
  try {
    mod = await import('../shared/dist/pairing-code.js');
  } catch {
    console.error('shared/dist not found — run `pnpm --filter @agentdeck/shared build` first');
    process.exit(1);
  }
  const rules = rulesFrom(mod);
  const check = process.argv.includes('--check');
  let drifted = false;
  for (const [rel, emit] of OUTPUTS) {
    const abs = path.join(projectDir, rel);
    const next = emit(rules);
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (check) {
      if (prev !== next) {
        console.error(`DRIFT: ${rel}`);
        drifted = true;
      }
    } else if (prev !== next) {
      fs.writeFileSync(abs, next);
      console.log(`wrote ${rel}`);
    } else {
      console.log(`up-to-date ${rel}`);
    }
  }
  if (check) {
    console.log(drifted ? 'pairing code rules mirrors DRIFTED' : 'pairing code rules mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
