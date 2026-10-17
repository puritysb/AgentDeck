#!/usr/bin/env node
// Generate the Swift mirror of the Claude Code status-line relay rules:
//   shared/src/claude-statusline.ts
//     → apple/AgentDeck/Daemon/Core/ClaudeStatuslineRules.generated.swift
//
//   pnpm generate-claude-statusline-rules            regenerate the mirror
//   pnpm generate-claude-statusline-rules --check    exit 1 if it drifted
//
// Requires shared to be built first (`pnpm build`), since the CLI reads the
// constants from shared/dist. The vitest sync test
// (shared/src/__tests__/claude-statusline-sync.test.ts) imports the emitter
// against the TS source, so drift is caught in CI even when this CLI is never
// run. Behaviour is pinned by shared/claude-statusline-vectors.json, which
// both suites replay.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function rulesFrom(mod) {
  return {
    route: mod.CLAUDE_STATUSLINE_ROUTE,
    freshMs: mod.CLAUDE_STATUSLINE_FRESH_MS,
    carryOverMs: mod.CLAUDE_OAUTH_CARRY_OVER_MS,
    scopedRefreshMs: mod.CLAUDE_OAUTH_SCOPED_REFRESH_MS,
    changeEpsilon: mod.CLAUDE_STATUSLINE_CHANGE_EPSILON,
    msThreshold: mod.CLAUDE_STATUSLINE_MS_THRESHOLD,
    sessionLimit: mod.CLAUDE_STATUSLINE_SESSION_LIMIT,
    relayedSessionUsageFields: mod.RELAYED_SESSION_USAGE_FIELDS,
    crossSourceResetToleranceMs: mod.CLAUDE_STATUSLINE_CROSS_SOURCE_RESET_TOLERANCE_MS,
    crossSourcePercentTolerance: mod.CLAUDE_STATUSLINE_CROSS_SOURCE_PERCENT_TOLERANCE,
  };
}

function num(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  return Number.isInteger(value) ? `${value}` : `${value}`;
}

export function emitSwift(rules) {
  return `// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/claude-statusline.ts
// Regenerate: pnpm generate-claude-statusline-rules (drift gated by shared/src/__tests__/claude-statusline-sync.test.ts)
#if os(macOS)
import Foundation

/// Claude Code status-line relay — the sanctioned subscription-quota source.
/// The installed status line POSTs Claude Code's status document to the local
/// daemon; these rules read the \`five_hour\` / \`seven_day\` windows out of it,
/// age the reading, decide when the OAuth poll may stay quiet (Node) and when a
/// repaint is worth broadcasting. Behaviour is pinned by
/// \`shared/claude-statusline-vectors.json\` (\`ClaudeStatuslineRulesTests\`).
enum ClaudeStatuslineRules {
    static let route = ${JSON.stringify(rules.route)}
    /// A reading younger than this is the live source.
    static let freshMs: Double = ${num(rules.freshMs)}
    /// The last OAuth reading's scoped caps ride along this long.
    static let oauthCarryOverMs: Double = ${num(rules.carryOverMs)}
    /// Account authorization and quota refresh this often, with or without scoped caps.
    static let oauthScopedRefreshMs: Double = ${num(rules.scopedRefreshMs)}
    /// Percent moves below this do not broadcast on their own.
    static let changeEpsilon: Double = ${num(rules.changeEpsilon)}
    /// A \`resets_at\` above this is already epoch milliseconds.
    static let msThreshold: Double = ${num(rules.msThreshold)}
    /// Bounded per-session replay memory.
    static let sessionLimit: Int = ${num(rules.sessionLimit)}
    /// Session fields may accompany a relay without replacing the daemon's account quota.
    static let relayedSessionUsageFields: [String] = ${JSON.stringify(rules.relayedSessionUsageFields)}
    /// Against an OAuth-family reading, resets this close are one window
    /// (status line: whole seconds; OAuth: microseconds).
    static let crossSourceResetToleranceMs: Double = ${num(rules.crossSourceResetToleranceMs)}
    /// Against an OAuth-family reading of the same window, a status-line percent
    /// this much lower is rounding (OAuth reports whole percent).
    static let crossSourcePercentTolerance: Double = ${num(rules.crossSourcePercentTolerance)}

    struct Window: Equatable {
        let usedPercent: Double
        /// ISO-8601 UTC with milliseconds, or nil when the window carries no reset.
        let resetsAt: String?
    }

    struct Reading: Equatable {
        let fiveHour: Window?
        let sevenDay: Window?
        let sessionId: String?
        let model: String?
        let version: String?
        /// Daemon receipt time, epoch ms.
        let receivedAtMs: Double
        /// Session elapsed time orders documents across resumes, never freshness.
        let durationMs: Double?
        let apiDurationMs: Double?
        let inputTokens: Double?
        let outputTokens: Double?

        init(
            fiveHour: Window?, sevenDay: Window?, sessionId: String?, model: String?, version: String?,
            receivedAtMs: Double, durationMs: Double? = nil, apiDurationMs: Double? = nil,
            inputTokens: Double? = nil, outputTokens: Double? = nil
        ) {
            self.fiveHour = fiveHour
            self.sevenDay = sevenDay
            self.sessionId = sessionId
            self.model = model
            self.version = version
            self.receivedAtMs = receivedAtMs
            self.durationMs = durationMs
            self.apiDurationMs = apiDurationMs
            self.inputTokens = inputTokens
            self.outputTokens = outputTokens
        }
    }

    enum Age: Equatable { case fresh, aged, unknown }

    /// A formatter per call: \`ISO8601DateFormatter\` is not Sendable, so a shared
    /// static would not pass Swift 6 isolation checking, and a status line
    /// arrives at most every 300 ms.
    private static func isoString(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f.string(from: date)
    }

    /// JSON booleans arrive as NSNumber too; the TS rule rejects them.
    private static func finiteNumber(_ raw: Any?) -> Double? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let v = n.doubleValue
        return v.isFinite ? v : nil
    }

    private static func nonEmptyString(_ raw: Any?) -> String? {
        guard let s = raw as? String, !s.isEmpty else { return nil }
        return s
    }

    private static func counter(_ raw: Any?) -> Double? {
        guard let value = finiteNumber(raw), value >= 0 else { return nil }
        return value
    }

    /// Compare reset instants, including OAuth ISO strings with a different offset or precision.
    private static func resetMs(_ raw: String?) -> Double {
        guard let raw else { return .nan }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = f.date(from: raw) { return (date.timeIntervalSince1970 * 1000).rounded() }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: raw).map { ($0.timeIntervalSince1970 * 1000).rounded() } ?? .nan
    }

    static func parseWindow(_ raw: Any?) -> Window? {
        guard let o = raw as? [String: Any], let pct = finiteNumber(o["used_percentage"]), pct >= 0 else { return nil }
        var resetsAt: String?
        if let r = finiteNumber(o["resets_at"]), r > 0 {
            let ms = r > msThreshold ? r : r * 1000
            if ms <= 8.64e15 {
                resetsAt = isoString(Date(timeIntervalSince1970: ms.rounded() / 1000))
            }
        }
        return Window(usedPercent: min(100, pct), resetsAt: resetsAt)
    }

    /// Nil when the document carries neither subscription window — the caller
    /// changes nothing.
    static func parse(_ payload: Any?, receivedAtMs: Double) -> Reading? {
        guard let p = payload as? [String: Any], let rl = p["rate_limits"] as? [String: Any] else { return nil }
        let fiveHour = parseWindow(rl["five_hour"])
        let sevenDay = parseWindow(rl["seven_day"])
        guard fiveHour != nil || sevenDay != nil else { return nil }
        let model = (p["model"] as? [String: Any])?["id"]
        let cost = p["cost"] as? [String: Any]
        let context = p["context_window"] as? [String: Any]
        return Reading(
            fiveHour: fiveHour, sevenDay: sevenDay,
            sessionId: nonEmptyString(p["session_id"]),
            model: nonEmptyString(model),
            version: nonEmptyString(p["version"]),
            receivedAtMs: receivedAtMs,
            durationMs: counter(cost?["total_duration_ms"]),
            apiDurationMs: counter(cost?["total_api_duration_ms"]),
            inputTokens: counter(context?["total_input_tokens"]),
            outputTokens: counter(context?["total_output_tokens"])
        )
    }

    /// Three answers: a missing or zero stamp is unknown, never fresh and never aged.
    static func age(receivedAtMs: Double?, nowMs: Double) -> Age {
        guard let receivedAtMs, receivedAtMs.isFinite, receivedAtMs > 0 else { return .unknown }
        return nowMs - receivedAtMs <= freshMs ? .fresh : .aged
    }

    /// Should the OAuth poll run on this tick? (The Swift daemon has no OAuth
    /// poll; the rule is mirrored so both daemons answer alike for a relay.)
    static func shouldPollOAuth(
        statuslineReceivedAtMs: Double?, lastOAuthFetchAtMs: Double?, oauthHasScopedLimits: Bool, nowMs: Double
    ) -> Bool {
        if age(receivedAtMs: statuslineReceivedAtMs, nowMs: nowMs) != .fresh { return true }
        guard let last = lastOAuthFetchAtMs, last.isFinite, last > 0 else { return true }
        return nowMs - last >= oauthScopedRefreshMs
    }

    /// OAuth failures preserve a live statusline; successful older caches never rewind quota.
    static func preserveUsageOnOAuth(currentFetchedAt: Double, nextFetchedAt: Double, fresh: Bool, statuslineLive: Bool) -> Bool {
        (!fresh && statuslineLive) || (fresh && nextFetchedAt < currentFetchedAt)
    }

    /// API and context counters may decrease on resume or compaction; session elapsed time may not.
    static func progressRegressed(previous: Reading?, next: Reading) -> Bool {
        guard let before = previous?.durationMs, let after = next.durationMs else { return false }
        return after < before
    }

    /// Cached renders never renew receipt freshness. A fresh cross-session quota also
    /// rejects older reset windows, same-window decreases, and another session's expiry removal.
    /// Exact between status-line readings; against an OAuth-family (or unknown)
    /// \`currentSource\` the order is read at the precision both carriers share.
    static func shouldAccept(previousForSession: Reading?, current: Reading?, next: Reading, currentSource: String? = nil) -> Bool {
        if progressRegressed(previous: previousForSession, next: next) { return false }
        if let previous = previousForSession,
           previous.fiveHour == next.fiveHour, previous.sevenDay == next.sevenDay,
           previous.apiDurationMs == next.apiDurationMs,
           previous.inputTokens == next.inputTokens, previous.outputTokens == next.outputTokens {
            return false
        }
        if let current, age(receivedAtMs: current.receivedAtMs, nowMs: next.receivedAtMs) == .fresh {
            let crossSource = currentSource != "statusline"
            let resetSlack = crossSource ? crossSourceResetToleranceMs : 0
            let percentSlack = crossSource ? crossSourcePercentTolerance : 0
            // An unparseable reset is NaN, which compares false both ways: no claim.
            let sameWindow = { (x: String?, y: String) -> Bool in abs(resetMs(x) - resetMs(y)) <= resetSlack }
            let windows: [(Window?, Window?, Window?)] = [
                (current.fiveHour, next.fiveHour, previousForSession?.fiveHour),
                (current.sevenDay, next.sevenDay, previousForSession?.sevenDay),
            ]
            for (a, b, previous) in windows {
                if let a, b == nil, let reset = a.resetsAt, !reset.isEmpty,
                   resetMs(reset) > next.receivedAtMs,
                   !sameWindow(previous?.resetsAt, reset) { return false }
                guard let a, let b, let aReset = a.resetsAt, !aReset.isEmpty,
                      let bReset = b.resetsAt, !bReset.isEmpty else { continue }
                let delta = resetMs(bReset) - resetMs(aReset)
                if delta < -resetSlack { return false }
                if abs(delta) <= resetSlack && b.usedPercent < a.usedPercent - percentSlack { return false }
            }
        }
        return true
    }

    /// May the last OAuth-family reading's scoped caps still ride along?
    static func oauthCarryOverFresh(lastOAuthFetchAtMs: Double?, nowMs: Double) -> Bool {
        guard let last = lastOAuthFetchAtMs, last.isFinite, last > 0 else { return false }
        return nowMs - last <= oauthCarryOverMs
    }

    private static func windowChanged(_ a: Window?, _ b: Window?) -> Bool {
        guard let a, let b else { return (a == nil) != (b == nil) }
        if a.resetsAt != b.resetsAt { return true }
        return abs(a.usedPercent - b.usedPercent) >= changeEpsilon
    }

    /// Does \`next\` say anything a surface would repaint for?
    static func changed(prev: Reading?, next: Reading) -> Bool {
        guard let prev else { return true }
        return windowChanged(prev.fiveHour, next.fiveHour) || windowChanged(prev.sevenDay, next.sevenDay)
    }
}
#endif
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Core/ClaudeStatuslineRules.generated.swift', emitSwift],
];

async function main() {
  let mod;
  try {
    mod = await import(path.join(projectDir, 'shared/dist/claude-statusline.js'));
  } catch (err) {
    console.error(`shared/dist is missing — run \`pnpm build\` first (${err.message})`);
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
  if (drifted) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
