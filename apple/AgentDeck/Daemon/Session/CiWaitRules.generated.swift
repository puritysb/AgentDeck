// GENERATED FILE — DO NOT EDIT.
// SSOT: shared/src/ci-wait.ts; regenerate: pnpm generate-ci-wait.
// Byte drift and shared/ci-wait-vectors.json execution are gated by ci-wait-sync.test.ts.
import Foundation
import CoreFoundation

enum CiWaitVisual {
    static let cycleMs = 6000
    static let showAfterMs = 3000
    static let helperRGB: (UInt8, UInt8, UInt8) = (226, 232, 240)
    static func rgb(_ phase: String) -> (UInt8, UInt8, UInt8) {
        let colors: [String: UInt32] = ["unknown": 0x9a9aa2, "queued": 0x3ED6E8, "running": 0x3ED6E8, "passed": 0x52D988, "failed": 0xFF6B6B]
        let value = colors[phase] ?? colors["unknown"]!
        return (UInt8((value >> 16) & 255), UInt8((value >> 8) & 255), UInt8(value & 255))
    }
    static let none = 0
    static let unknown = 1
    static let queued = 2
    static let running = 3
    static let passed = 4
    static let failed = 5
    static let github: [UInt8] = [60, 126, 195, 195, 195, 231, 70, 36]
    static func phase(_ value: String?) -> Int {
        switch value {
        case "unknown": return 1
        case "queued": return 2
        case "running": return 3
        case "passed": return 4
        case "failed": return 5
        default: return unknown
        }
    }
    static func compactPhase(_ wait: [String: Any]?) -> Int {
        guard let wait else { return none }
        let id = phase(wait["phase"] as? String)
        if id == passed || id == failed { return id }
        guard let flag = wait["agentWaiting"] as? NSNumber,
              CFGetTypeID(flag) == CFBooleanGetTypeID(), flag.boolValue else { return none }
        return id
    }
}

struct CiWaitIntent: Codable, Equatable, Sendable {
    var kind = "ci"
    var provider = "github-actions"
    var mode: String
    var repo: String?
    var ref: String?
    var pr: Int?
    var runId: Int?
}

/// Command intent only: never evidence of actual execution or a CI verdict.
/// Stateless, bounded, and safe for either actor. No raw command/secret in result.
enum CiWaitRules {
    static let maxCommandChars = 16384
    static let maxIdentityChars = 255
    static let maxId = 9007199254740991
    private static let whitespace = CharacterSet(charactersIn: "\t\n\u{000b}\u{000c}\r                  　﻿")
    private static let forbidden = CharacterSet(charactersIn: "\u{0000}`$(){}")
    private static let numberPattern = "^[1-9][0-9]*$"
    private static let digitsPattern = "^[0-9]+$"
    private static let repoPattern = "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
    private static let branchPattern = "^[A-Za-z0-9_./-]+$"
    private static let assignmentPattern = "^[A-Za-z_][A-Za-z0-9_]*="
    private static let urlPattern = "^https://github\\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)/?$"
    private static let watchValues: Set<String> = ["--interval", "-i"]
    private static let watchSwitches: Set<String> = ["--exit-status", "--compact"]
    private static let prValues: Set<String> = ["--interval", "-i", "--json", "--jq", "-q", "--template", "-t"]
    private static let prSwitches: Set<String> = ["--fail-fast", "--required"]
    private static let listValues: Set<String> = ["--branch", "-b", "--json", "--jq", "-q", "--template", "-t", "--limit", "-L", "--workflow", "-w", "--status", "-s", "--event", "-e", "--user", "-u", "--commit", "-c", "--created"]
    private static let listSwitches: Set<String> = ["--all", "-a"]
    private struct Token { var value: String; var plain: Bool }

    private static func match(_ text: String, _ pattern: String) -> NSTextCheckingResult? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let result = regex.firstMatch(in: text, range: range) else { return nil }
        if pattern != assignmentPattern && result.range != range { return nil }
        return result
    }
    private static func number(_ value: String?) -> Int? {
        guard let value, match(value, numberPattern) != nil,
              let n = Int(value), n >= 1, n <= maxId else { return nil }
        return n
    }
    private static func identity(_ value: String?, _ pattern: String) -> String? {
        guard let value, !value.isEmpty, value.utf16.count <= maxIdentityChars,
              match(value, pattern) != nil else { return nil }
        return value
    }
    static func normalized(_ value: Any?) -> CiWaitIntent? {
        guard let v = value as? [String: Any],
              Set(v.keys).isSubset(of: ["kind", "provider", "mode", "repo", "ref", "pr", "runId"]),
              v["kind"] as? String == "ci", v["provider"] as? String == "github-actions",
              let mode = v["mode"] as? String, ["watch", "poll"].contains(mode) else { return nil }
        var intent = CiWaitIntent(mode: mode)
        if let raw = v["repo"] {
            guard let value = raw as? String, let repo = identity(value, repoPattern) else { return nil }
            intent.repo = repo
        }
        if let raw = v["ref"] {
            guard let value = raw as? String, let ref = identity(value, branchPattern) else { return nil }
            intent.ref = ref
        }
        for key in ["pr", "runId"] {
            if let raw = v[key] {
                guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                      value.doubleValue >= 1, value.doubleValue <= Double(maxId),
                      value.doubleValue.rounded() == value.doubleValue else { return nil }
                if key == "pr" { intent.pr = value.intValue } else { intent.runId = value.intValue }
            }
        }
        return intent
    }
    private static func segments(_ command: String) -> [[Token]]? {
        guard command.utf16.count <= maxCommandChars,
              command.rangeOfCharacter(from: forbidden) == nil else { return nil }
        let trimmed = command.trimmingCharacters(in: whitespace)
        if trimmed.hasSuffix("&&") || trimmed.hasSuffix("||") || trimmed.hasSuffix("|") { return nil }
        let chars = Array(command.unicodeScalars)
        var out: [[Token]] = [], words: [Token] = []
        var value = "", started = false, plain = true
        var quote: Unicode.Scalar?
        func word() {
            if started { words.append(Token(value: value, plain: plain)) }
            value = ""; started = false; plain = true
        }
        func segment() { word(); if !words.isEmpty { out.append(words) }; words = [] }
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if let active = quote {
                if c == active { quote = nil }
                else if c == "\\" && active == "\"" {
                    i += 1; if i == chars.count { return nil }
                    value.unicodeScalars.append(chars[i])
                } else { value.unicodeScalars.append(c) }
                i += 1; continue
            }
            if c == "\"" || c == "'" { quote = c; started = true; plain = false }
            else if c == "\\" {
                i += 1; if i == chars.count { return nil }
                if chars[i] != "\n" { value.unicodeScalars.append(chars[i]); started = true; plain = false }
            } else if c == "#" && !started {
                while i < chars.count && chars[i] != "\n" { i += 1 }
                segment()
            } else if c == ";" || c == "\n" || c == "|" || c == "&" {
                segment()
                if i + 1 < chars.count && (chars[i + 1] == c || (c == "|" && chars[i + 1] == "&")) { i += 1 }
            } else if c == ">" || c == "<" {
                word(); words.append(Token(value: String(c), plain: true))
                if i + 1 < chars.count && chars[i + 1] == c {
                    if c == "<" { return nil }; i += 1
                }
            } else if whitespace.contains(c) { word() }
            else { value.unicodeScalars.append(c); started = true }
            i += 1
        }
        if quote != nil { return nil }; segment(); return out
    }
    private static func github(_ tokens: [Token], polling: Bool) -> CiWaitIntent? {
        let redirect = tokens.firstIndex { $0.plain && ($0.value == ">" || $0.value == "<") } ?? tokens.count
        var executable = Array(tokens.prefix(redirect))
        while let first = executable.first, first.plain, match(first.value, assignmentPattern) != nil {
            executable.removeFirst()
        }
        var argv = executable.map(\.value)
        func shift() -> String? { argv.isEmpty ? nil : argv.removeFirst() }
        if argv.first == "command" { _ = shift() }
        guard argv.first?.components(separatedBy: "/").last == "gh" else { return nil }; _ = shift()
        var repository: String?
        func takeRepo() -> Bool {
            if argv.first == "-R" || argv.first == "--repo" {
                _ = shift(); repository = identity(shift(), repoPattern); return true
            }
            if let first = argv.first, first.hasPrefix("--repo=") {
                _ = shift(); repository = identity(String(first.dropFirst(7)), repoPattern); return true
            }
            return false
        }
        while takeRepo() {}
        let group = shift(), action = shift()
        guard (group == "run" && (action == "watch" || action == "list")) ||
              (group == "pr" && action == "checks") else { return nil }
        var watch = action == "watch"
        var id: String?, ref: String?
        let values = action == "watch" ? watchValues : group == "pr" ? prValues : listValues
        let switches = action == "watch" ? watchSwitches : group == "pr" ? prSwitches : listSwitches
        while !argv.isEmpty {
            if takeRepo() { continue }
            guard let arg = shift() else { return nil }
            if arg == "--watch" { if group != "pr" { return nil }; watch = true; continue }
            let parts = arg.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let option = String(parts[0])
            if values.contains(option) {
                let value = parts.count == 1 ? shift() : String(parts[1])
                guard let value, !value.isEmpty else { return nil }
                if option == "--branch" || option == "-b" { ref = identity(value, branchPattern) }
            } else if switches.contains(arg) { continue }
            else if arg.hasPrefix("-") || id != nil { return nil }
            else { id = arg }
        }
        if !watch && !polling { return nil }
        if group == "run" && action == "list" && id != nil { return nil }
        let runId = group == "run" && action == "watch" ? number(id) : nil
        if group == "run" && action == "watch" && runId == nil { return nil }
        var pr: Int?
        if group == "pr", let id {
            if let url = match(id, urlPattern), let repoRange = Range(url.range(at: 1), in: id),
               let prRange = Range(url.range(at: 2), in: id) {
                guard let urlRepo = identity(String(id[repoRange]), repoPattern) else { return nil }
                if let repository, repository != urlRepo { return nil }
                repository = urlRepo; pr = number(String(id[prRange])); if pr == nil { return nil }
            } else {
                pr = number(id)
                if pr == nil {
                    guard match(id, digitsPattern) == nil, let branch = identity(id, branchPattern) else { return nil }
                    ref = branch
                }
            }
        }
        return CiWaitIntent(mode: watch ? "watch" : "poll", repo: repository, ref: ref, pr: pr, runId: runId)
    }
    static func classify(command: Any?, runInBackground: Any?) -> CiWaitIntent? {
        // JSONSerialization bridges integer 1 as Bool too; admit only CFBoolean.
        guard let flag = runInBackground as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(),
              flag.boolValue, let command = command as? String, let commands = segments(command) else { return nil }
        var loops: [Bool] = [], found: [CiWaitIntent] = []
        for original in commands {
            var tokens = original
            func keyword() -> String? { tokens.first?.plain == true ? tokens.first?.value : nil }
            if keyword() == "done" {
                if loops.popLast() != true || tokens.count != 1 { return nil }; continue
            }
            if keyword() == "while" || keyword() == "until" { loops.append(false); tokens.removeFirst() }
            if keyword() == "do" {
                if loops.isEmpty || loops.last == true { return nil }
                loops[loops.count - 1] = true; tokens.removeFirst()
            }
            if keyword() == "!" { tokens.removeFirst() }
            if let intent = github(tokens, polling: !loops.isEmpty) { found.append(intent) }
        }
        guard loops.isEmpty, let first = found.first, found.allSatisfy({ $0 == first }) else { return nil }
        return first
    }
}

enum CiWaitAccounting {
    static func foregroundMs(_ events: [[String: Any]], turnIndex: Int, start: Int, end: Int) -> Int {
        guard start >= 0, end >= start else { return 0 }
        var open: [String: Int] = [:], spans: [(Int, Int)] = []
        for event in events {
            guard event["kind"] as? String == "relation", event["relation"] as? String == "waiting_on",
                  event["evidence"] as? String == "ci_wait_foreground", event["turnIndex"] as? Int == turnIndex,
                  let id = event["relationId"] as? String, let ts = event["ts"] as? Int else { continue }
            if event["phase"] as? String == "open" { if open[id] == nil { open[id] = ts } }
            else if let began = open.removeValue(forKey: id), ts >= began { spans.append((began, ts)) }
        }
        for began in open.values { spans.append((began, end)) }
        spans.sort { $0.0 < $1.0 }
        var total = 0, through = start
        for span in spans {
            let left = max(start, span.0), right = min(end, span.1)
            if right > left { total += max(0, right - max(through, left)); through = max(through, right) }
        }
        return total
    }
}

#if os(macOS)
/// Hook-scoped CI waits; generated together with the command classifier.
@DaemonActor
final class CiWaitTracker {
    private struct Wait { var token: Int; var id: String; var background: Bool; var status: [String: Any] }
    private var sessions: [String: [Wait]] = [:]
    private var nextToken = 0
    func waitsFor(_ sid: String, now: Int) -> [(token: Int, background: Bool, openedAt: Int)] {
        _ = snapshot(sid, now: now)
        return (sessions[sid] ?? []).map { ($0.token, $0.background, $0.status["openedAt"] as? Int ?? now) }
    }
    func tokenFor(_ sid: String) -> Int? { sessions[sid]?.first?.token }
    func isForeground(_ sid: String) -> Bool { sessions[sid]?.first?.background == false }
    func snapshot(_ sid: String, now: Int) -> [String: Any]? {
        let waits = (sessions[sid] ?? []).filter { now - ($0.status["openedAt"] as? Int ?? 0) < 86400000 }
        if waits.isEmpty { sessions.removeValue(forKey: sid); return nil }
        sessions[sid] = waits
        return waits.first?.status
    }
    func forget(_ sid: String) { sessions.removeValue(forKey: sid) }
    private static let hookEvents: [String: String] = ["SessionStart": "session_start", "SessionEnd": "session_end", "UserPromptSubmit": "user_prompt_submit", "PreToolUse": "tool_start", "PostToolUse": "tool_end", "PostToolUseFailure": "tool_failure", "Stop": "stop", "Interrupt": "interrupt", "codex_session_start": "session_start", "codex_session_end": "session_end", "codex_user_prompt_submit": "user_prompt_submit", "codex_tool_start": "tool_start", "codex_tool_end": "tool_end", "codex_tool_failure": "tool_failure", "codex_stop": "stop", "codex_interrupt": "interrupt", "codex_turn_complete": "stop", "opencode_session_start": "session_start", "opencode_session_end": "session_end", "opencode_user_prompt_submit": "user_prompt_submit", "opencode_tool_start": "tool_start", "opencode_tool_end": "tool_end", "opencode_tool_failure": "tool_failure", "opencode_stop": "stop", "opencode_interrupt": "interrupt", "opencode_turn_complete": "stop", "hermes_session_start": "session_start", "hermes_session_end": "session_end", "hermes_user_prompt_submit": "user_prompt_submit", "hermes_tool_start": "tool_start", "hermes_tool_end": "tool_end", "hermes_tool_failure": "tool_failure", "hermes_stop": "stop", "hermes_interrupt": "interrupt", "hermes_turn_complete": "stop"]
    @discardableResult
    func note(_ sid: String, event rawEvent: String, json: [String: Any], now: Int) -> Bool {
        let event = Self.hookEvents[rawEvent] ?? rawEvent
        guard !sid.isEmpty, sid.utf16.count <= 256, now >= 0, now <= 9007199254740991 else { return false }
        let before = snapshot(sid, now: now)
        if ["session_start", "session_end", "user_prompt_submit", "interrupt"].contains(event) {
            sessions.removeValue(forKey: sid)
        } else if event == "stop" {
            sessions[sid] = (sessions[sid] ?? []).filter { $0.background }
        } else {
            guard let id = (json["tool_use_id"] ?? json["tool_call_id"] ?? json["call_id"]) as? String,
                  !id.isEmpty, id.utf16.count <= 255 else { return false }
            var waits = sessions[sid] ?? []
            if event == "tool_start" {
                let tool = json["tool_name"] as? String
                let normalized = tool == "terminal" ? CiWaitRules.normalized(json["ci_wait_intent"]) : nil
                let input = json["tool_input"] as? [String: Any]
                guard normalized != nil || (input != nil && ["Bash", "bash", "shell", "shell_command", "exec_command"].contains(tool ?? "")) else { return false }
                let flag = (normalized != nil ? json["ci_wait_background"] : input?["run_in_background"]) as? NSNumber
                let background = flag.map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
                guard let intent = normalized ?? CiWaitRules.classify(command: input?["command"] ?? input?["cmd"], runInBackground: true),
                      background || intent.mode == "watch" else { return false }
                if !waits.contains(where: { $0.id == id }) {
                    guard waits.count < 8,
                          sessions[sid] != nil || sessions.count < 1024 else { return false }
                    var status: [String: Any] = ["kind": "ci", "provider": "github-actions", "phase": "unknown",
                        "agentWaiting": true, "evidence": "tool_input", "openedAt": now]
                    if let repo = intent.repo { status["repo"] = repo }
                    if let ref = intent.ref { status["ref"] = ref }
                    if let pr = intent.pr { status["pr"] = pr }
                    if let run = intent.runId { status["runId"] = run }
                    nextToken += 1
                    waits.append(Wait(token: nextToken, id: id, background: background, status: status))
                }
            } else if event == "tool_end" || event == "tool_failure" {
                let flag = json["is_error"] as? NSNumber
                let failed = flag.map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
                waits.removeAll { $0.id == id && (!$0.background || event == "tool_failure" || failed) }
            }
            if waits.isEmpty { sessions.removeValue(forKey: sid) } else { sessions[sid] = waits }
        }
        let after = snapshot(sid, now: now)
        return !NSDictionary(dictionary: before ?? [:]).isEqual(to: after ?? [:])
    }
}
#endif
