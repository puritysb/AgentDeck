#!/usr/bin/env node
// Generate Swift/Kotlin mirrors of the Codex snapshot-freshness SSOT
// (shared/src/format-utils.ts: CODEX_SNAPSHOT_STALE_MS + the age-label bands).
//
//   pnpm generate-codex-freshness-rules            regenerate the mirrors
//   pnpm generate-codex-freshness-rules --check    exit 1 if any mirror drifted
//
// Requires shared to be built first (`pnpm --filter @agentdeck/shared build`
// or `pnpm build`) — the CLI imports the constant from shared/dist. The vitest
// sync test imports the emitters below directly with the TS source, so drift is
// caught in CI even if this CLI is never run.
//
// WHY THIS IS GENERATED, not hand-mirrored: Codex usage is a passive read of
// local rollout files, so "how old is this reading" is the only thing that
// separates a live percentage from a frozen one — and every surface (menubar,
// dashboard rail, D200H tiles, Android e-ink) must answer it identically. A
// threshold that drifts by platform means one screen calls a number live while
// the next calls it stale. Same shape as generate-session-weight-rules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/format-utils.ts (CODEX_SNAPSHOT_STALE_MS, codexUsageFootnote)\n' +
  'Regenerate: pnpm generate-codex-freshness-rules (drift gated by shared/src/__tests__/codex-freshness-rules.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

export function emitSwift(rules) {
  return `${comment('//')}

import Foundation

/// Freshness of a passively-read Codex usage snapshot.
///
/// Two axes, deliberately separate — never fold one into the other:
///   • \`stale\` (on the window)  the window has ENDED; slot-based consumers
///     (Pixoo renderers, ESP32 firmware) drop the gauge entirely on it.
///   • \`capturedAt\` (here)      when the value was measured. An old reading of
///     a still-live window keeps rendering, dimmed, with its age shown.
///
/// Derived against the local clock at paint time, never from a producer-set
/// boolean — such a flag freezes between pushes exactly like the percentage it
/// is meant to qualify.
enum CodexUsageFreshness {
    /// How old a snapshot may get before its numbers stop reading as live.
    /// ABSOLUTE on purpose: a fraction of the window length would scale to 8h+
    /// on the weekly window and never fire, which is the hole this closes.
    static let snapshotStaleInterval: TimeInterval = ${rules.staleMs / 1000}

    /// Age of a snapshot in seconds, or nil when unknown/unparseable.
    static func snapshotAge(_ capturedAt: String?, now: Date = Date()) -> TimeInterval? {
        guard let capturedAt, !capturedAt.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        guard let date = fractional.date(from: capturedAt) ?? plain.date(from: capturedAt) else { return nil }
        return max(0, now.timeIntervalSince(date))
    }

    /// True when the snapshot is too old to present as live. A missing stamp is
    /// "unknown", NOT "old" — a producer that sends none must not leave every
    /// Codex gauge permanently dimmed.
    static func isSnapshotAged(
        _ capturedAt: String?,
        now: Date = Date(),
        maxAge: TimeInterval = snapshotStaleInterval
    ) -> Bool {
        guard let age = snapshotAge(capturedAt, now: now) else { return false }
        return age > maxAge
    }

    /// Compact "when was this measured" label: "34m ago", "3h ago", "2d ago".
    /// Rounds DOWN so it never overstates freshness.
    static func formatSnapshotAge(_ capturedAt: String?, now: Date = Date()) -> String? {
        guard let age = snapshotAge(capturedAt, now: now) else { return nil }
        let minutes = Int(age / 60)
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\\(hours)h ago" }
        return "\\(hours / 24)d ago"
    }

    /// The one footnote a Codex gauge prints under its percentage. Three states,
    /// resolved identically on every surface:
    ///
    ///   • window ended (\`stale\`) → "stale",  dim — the number no longer applies
    ///   • snapshot aged          → "3h ago", dim — last true reading, not live
    ///   • live                   → nil            — caller prints its countdown
    ///
    /// \`stale\` wins over age: an ended window is a stronger statement than an old read.
    static func footnote(stale: Bool, capturedAt: String?, now: Date = Date()) -> String? {
        if stale { return "stale" }
        guard isSnapshotAged(capturedAt, now: now) else { return nil }
        return formatSnapshotAge(capturedAt, now: now) ?? "stale"
    }
}
`;
}

export function emitKotlin(rules) {
  return `${comment('//')}
package dev.agentdeck.util

import java.time.OffsetDateTime

/**
 * Freshness of a passively-read Codex usage snapshot.
 *
 * Two axes, deliberately separate — never fold one into the other:
 *  - \`stale\` (on the window): the window has ENDED; slot-based consumers
 *    (Pixoo renderers, ESP32 firmware) drop the gauge entirely on it.
 *  - \`capturedAt\` (here): when the value was measured. An old reading of a
 *    still-live window keeps rendering, dimmed, with its age shown.
 *
 * Derived against the local clock at paint time, never from a producer-set
 * boolean — such a flag freezes between pushes exactly like the percentage it
 * is meant to qualify.
 */
object CodexFreshnessRules {
    /**
     * How old a snapshot may get before its numbers stop reading as live.
     * ABSOLUTE on purpose: a fraction of the window length would scale to 8h+
     * on the weekly window and never fire, which is the hole this closes.
     */
    const val SNAPSHOT_STALE_MS: Long = ${rules.staleMs}L

    /** Age of a snapshot in ms, or null when unknown/unparseable. */
    fun snapshotAgeMs(capturedAt: String?, nowMs: Long = System.currentTimeMillis()): Long? {
        if (capturedAt.isNullOrEmpty()) return null
        val t = try {
            // OffsetDateTime handles both "Z" and "+09:00", with or without fraction.
            OffsetDateTime.parse(capturedAt).toInstant().toEpochMilli()
        } catch (_: Exception) {
            return null
        }
        return (nowMs - t).coerceAtLeast(0L)
    }

    /**
     * Compact "when was this measured" label: "34m ago", "3h ago", "2d ago".
     * Rounds DOWN so it never overstates freshness.
     */
    fun formatSnapshotAge(capturedAt: String?, nowMs: Long = System.currentTimeMillis()): String? {
        val age = snapshotAgeMs(capturedAt, nowMs) ?: return null
        val minutes = age / 60_000L
        if (minutes < 1) return "now"
        if (minutes < 60) return "\${minutes}m ago"
        val hours = minutes / 60
        if (hours < 24) return "\${hours}h ago"
        return "\${hours / 24}d ago"
    }

    /**
     * The one footnote a Codex gauge prints under its percentage:
     *  - window ended (\`stale\`) -> "stale"  (the number no longer applies)
     *  - snapshot aged          -> "3h ago" (last true reading, not live)
     *  - live                   -> null     (caller prints its countdown)
     *
     * A missing stamp is "unknown", NOT "old" — a producer that sends none must
     * not leave every Codex gauge permanently dimmed.
     */
    fun footnote(
        stale: Boolean,
        capturedAt: String?,
        nowMs: Long = System.currentTimeMillis(),
    ): String? {
        if (stale) return "stale"
        val age = snapshotAgeMs(capturedAt, nowMs) ?: return null
        if (age <= SNAPSHOT_STALE_MS) return null
        return formatSnapshotAge(capturedAt, nowMs) ?: "stale"
    }
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Model/CodexFreshnessRules.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/util/CodexFreshnessRules.generated.kt', emitKotlin],
];

async function main() {
  let staleMs;
  try {
    ({ CODEX_SNAPSHOT_STALE_MS: staleMs } = await import('../shared/dist/format-utils.js'));
  } catch {
    console.error('shared/dist not found — run `pnpm --filter @agentdeck/shared build` first');
    process.exit(1);
  }
  const rules = { staleMs };
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
    console.log(drifted ? 'codex freshness rules mirrors DRIFTED' : 'codex freshness rules mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
