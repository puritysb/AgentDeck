// GENERATED FILE — DO NOT EDIT.
// Source of truth: bridge/src/apme/task-gradeability.ts
// Regenerate: pnpm generate-apme-display-rules (drift gated by shared/src/__tests__/apme-display-rules-sync.test.ts)

import Foundation

/// Decide whether a closed task contains agent work that an LLM may judge.
/// A nil return means gradeable; a non-nil value is the machine-readable
/// reason persisted in tasks.notes_json and shown on the Work board.
///
/// Parity is pinned by shared/task-gradeability-vectors.json, replayed by
/// both the TypeScript and Swift suites. String length intentionally uses
/// UTF-16 code units because the source rule uses JavaScript String.length.
enum TaskGradeabilityRules {

    static let workEvidenceMinToolCalls = 3
    static let trivialPromptMaxChars = 12
    static let trivialReplyMaxChars = 200
    static let notificationEnvelopeTag = "task-notification"

    static func notGradeableReason(_ turns: [[String: Any]]) -> String? {
        if turns.isEmpty { return "no_reply" }
        if turns.allSatisfy({ isNotificationEnvelope($0["prompt"]) }) { return "notification_only" }
        let worked = turns.filter { text($0["end_source"]) != "aborted" }
        if worked.isEmpty { return "aborted_only" }

        if !worked.contains(where: hasTextReply) {
            let tools = worked.reduce(0) { $0 + int($1["tool_calls"]) }
            let files = worked.reduce(0) {
                $0 + int($1["files_modified"]) + int($1["files_created"])
            }
            if tools < workEvidenceMinToolCalls && files == 0 { return "no_reply" }
        }

        if worked.count == 1,
           int(worked[0]["tool_calls"]) == 0,
           text(worked[0]["prompt"]).utf16.count <= trivialPromptMaxChars,
           text(worked[0]["response"]).utf16.count <= trivialReplyMaxChars {
            return "trivial"
        }
        return nil
    }

    static func notGradeableNotes(_ reason: String) -> String {
        "{\"notGradeable\":\"\(reason)\"}"
    }

    private static func text(_ value: Any?) -> String {
        (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// shared/src/harness-queued-message.ts: after leading whitespace the
    /// prompt opens with the tag, ASCII letters in either case, followed by
    /// `>` or whitespace (JavaScript's, see isJSWhitespace). Only leading
    /// whitespace is skipped, because a trimmed tail could remove the
    /// character that decides the match. A prompt that only quotes the tag
    /// further in is the user's own text.
    private static func isNotificationEnvelope(_ value: Any?) -> Bool {
        guard let prompt = value as? String else { return false }
        var rest = prompt.unicodeScalars.drop(while: isJSWhitespace)
        for expected in ("<" + notificationEnvelopeTag).unicodeScalars {
            guard let scalar = rest.first, asciiLowercased(scalar) == expected else { return false }
            rest = rest.dropFirst()
        }
        guard let next = rest.first else { return false }
        return next == ">" || isJSWhitespace(next)
    }

    /// JavaScript's `\s`, the set `trimStart()` strips, as the generator's
    /// engine reports it. Unicode's White_Space (`properties.isWhitespace`)
    /// adds NEL U+0085 and leaves out BOM U+FEFF, so using it would decide a
    /// prompt opening with either the other way.
    private static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A,
             0x2028...0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    private static func asciiLowercased(_ scalar: Unicode.Scalar) -> Unicode.Scalar {
        guard (0x41...0x5A).contains(scalar.value) else { return scalar }
        return Unicode.Scalar(UInt8(scalar.value + 0x20))
    }

    private static func int(_ value: Any?) -> Int {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        return 0
    }

    /// response_kind as the collector tagged it, else derived from the row.
    private static func hasTextReply(_ turn: [String: Any]) -> Bool {
        if let raw = turn["efficiency_json"] as? String,
           !raw.isEmpty,
           let data = raw.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data),
           let dict = object as? [String: Any],
           let kind = dict["response_kind"] as? String {
            if kind == "tool_only" || kind == "empty" { return false }
            if kind == "text" { return !text(turn["response"]).isEmpty }
        }
        return !text(turn["response"]).isEmpty
    }
}
