#!/usr/bin/env node
// CI wait intent SSOT -> native pure classifier. No runtime I/O or subprocess.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const OUTPUT = 'apple/AgentDeck/Daemon/Session/CiWaitRules.generated.swift';
const quote = value => JSON.stringify(value).replace(/\\f/g, '\\u{000c}').replace(/\\u([0-9a-f]{4})/gi, '\\u{$1}');
const list = values => `[${values.map(quote).join(', ')}]`;
export const KOTLIN_OUTPUT = 'android/app/src/main/kotlin/dev/agentdeck/terrarium/CiWaitVisual.generated.kt';
export const HERMES_OUTPUT = 'hooks/hermes-agentdeck/ci-wait-rules.json';
export const emitHermesRules = mod => JSON.stringify(mod.CI_WAIT_RULES, null, 2) + '\n';
export const CPP_OUTPUT = 'esp32/src/state/ci_wait_generated.h';
export function emitKotlin(mod) {
  const r = mod.CI_WAIT_VISUAL;
  return `// GENERATED from shared/src/ci-wait.ts.
package dev.agentdeck.terrarium

object CiWaitVisual {
` +
    Object.entries(r).filter(([, value]) => typeof value === 'number').map(([k,v]) => `    const val ${k.toUpperCase()} = ${v}
`).join('') +
    `    val github = intArrayOf(${r.github.join(', ')})
}
`;
}
export function emitCpp(mod) {
  const r = mod.CI_WAIT_VISUAL;
  return `// GENERATED from shared/src/ci-wait.ts. No heap or mutable storage.
#pragma once
#include <stdint.h>
#include <string.h>
namespace CiWaitVisual {
static constexpr unsigned long CYCLE_MS = ${mod.CI_WAIT_CUE.cycleMs};
static constexpr unsigned long SHOW_AFTER_MS = ${mod.CI_WAIT_CUE.showAfterMs};
static constexpr uint32_t HELPER_COLOR = 0x${mod.CI_WAIT_CUE.helperColor.slice(1)};
` +
    Object.entries(r).filter(([, value]) => typeof value === 'number').map(([k,v]) => `static constexpr uint8_t ${k.toUpperCase()} = ${v};
`).join('') +
    `static constexpr uint8_t GITHUB[8] = {${r.github.join(', ')}};
static constexpr uint8_t GITHUB_ALPHA_SIZE = ${mod.CI_WAIT_CUE.standardGlyphSize};
static constexpr uint8_t GITHUB_ALPHA[GITHUB_ALPHA_SIZE * GITHUB_ALPHA_SIZE] = {${r.githubAlpha.join(', ')}};
inline uint8_t phase(const char* value) {
` +
    Object.entries(r).filter(([k, value]) => typeof value === 'number' && k !== 'none').map(([k,v]) => `    if (value && !strcmp(value, "${k}")) return ${v};
`).join('') +
    `    return UNKNOWN;
}
inline uint8_t compactPhase(const char* value, bool agentWaiting) {
    const uint8_t id = phase(value);
    return id == PASSED || id == FAILED || agentWaiting ? id : NONE;
}
template<typename Wait> inline uint8_t fromJsonWait(const Wait& wait) {
    return compactPhase(wait["phase"] | "unknown",
        wait["agentWaiting"].template is<bool>() && wait["agentWaiting"].template as<bool>());
}
}
`;
}
export function emitSwift(mod) {
  const r = mod.CI_WAIT_RULES;
  return String.raw`// GENERATED FILE — DO NOT EDIT.
// SSOT: shared/src/ci-wait.ts; regenerate: pnpm generate-ci-wait.
// Byte drift and shared/ci-wait-vectors.json execution are gated by ci-wait-sync.test.ts.
import Foundation
import CoreFoundation

enum CiWaitVisual {
    static let cycleMs = ${mod.CI_WAIT_CUE.cycleMs}
    static let showAfterMs = ${mod.CI_WAIT_CUE.showAfterMs}
    static let helperRGB: (UInt8, UInt8, UInt8) = (${[1, 3, 5].map(i => parseInt(mod.CI_WAIT_CUE.helperColor.slice(i, i + 2), 16)).join(', ')})
    static func rgb(_ phase: String) -> (UInt8, UInt8, UInt8) {
        let colors: [String: UInt32] = [${Object.entries(mod.CI_WAIT_CUE.colors).map(([k,v]) => `"${k}": 0x${v.slice(1)}`).join(', ')}]
        let value = colors[phase] ?? colors["unknown"]!
        return (UInt8((value >> 16) & 255), UInt8((value >> 8) & 255), UInt8(value & 255))
    }
${Object.entries(mod.CI_WAIT_VISUAL).filter(([, value]) => typeof value === 'number').map(([k,v]) => `    static let ${k} = ${v}`).join('\n')}
    static let github: [UInt8] = [${mod.CI_WAIT_VISUAL.github.join(', ')}]
    static func phase(_ value: String?) -> Int {
        switch value {
${Object.entries(mod.CI_WAIT_VISUAL).filter(([k, value]) => typeof value === 'number' && k !== 'none').map(([k,v]) => `        case "${k}": return ${v}`).join('\n')}
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
    static let maxCommandChars = ${r.maxCommandChars}
    static let maxIdentityChars = ${r.maxIdentityChars}
    static let maxId = ${r.maxId}
    private static let whitespace = CharacterSet(charactersIn: ${quote(r.whitespace)})
    private static let forbidden = CharacterSet(charactersIn: ${quote(r.forbidden)})
    private static let numberPattern = ${quote(r.numberPattern)}
    private static let digitsPattern = ${quote(r.digitsPattern)}
    private static let repoPattern = ${quote(r.repoPattern)}
    private static let branchPattern = ${quote(r.branchPattern)}
    private static let assignmentPattern = ${quote(r.assignmentPattern)}
    private static let urlPattern = ${quote(r.urlPattern)}
    private static let watchValues: Set<String> = ${list(r.runWatch.values)}
    private static let watchSwitches: Set<String> = ${list(r.runWatch.switches)}
    private static let prValues: Set<String> = ${list(r.prChecks.values)}
    private static let prSwitches: Set<String> = ${list(r.prChecks.switches)}
    private static let listValues: Set<String> = ${list(r.runList.values)}
    private static let listSwitches: Set<String> = ${list(r.runList.switches)}
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
        let waits = (sessions[sid] ?? []).filter { now - ($0.status["openedAt"] as? Int ?? 0) < ${mod.CI_WAIT_LIFECYCLE.maxAgeMs} }
        if waits.isEmpty { sessions.removeValue(forKey: sid); return nil }
        sessions[sid] = waits
        return waits.first?.status
    }
    func forget(_ sid: String) { sessions.removeValue(forKey: sid) }
    private static let hookEvents: [String: String] = [${Object.entries(mod.CI_WAIT_HOOK_EVENTS).map(([key, value]) => `${quote(key)}: ${quote(value)}`).join(', ')}]
    @discardableResult
    func note(_ sid: String, event rawEvent: String, json: [String: Any], now: Int) -> Bool {
        let event = Self.hookEvents[rawEvent] ?? rawEvent
        guard !sid.isEmpty, sid.utf16.count <= ${mod.CI_WAIT_LIFECYCLE.maxSessionChars}, now >= 0, now <= ${r.maxId} else { return false }
        let before = snapshot(sid, now: now)
        if ["session_start", "session_end", "user_prompt_submit", "interrupt"].contains(event) {
            sessions.removeValue(forKey: sid)
        } else if event == "stop" {
            sessions[sid] = (sessions[sid] ?? []).filter { $0.background }
        } else {
            guard let id = (json["tool_use_id"] ?? json["tool_call_id"] ?? json["call_id"]) as? String,
                  !id.isEmpty, id.utf16.count <= ${mod.CI_WAIT_LIFECYCLE.maxToolIdChars} else { return false }
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
                    guard waits.count < ${mod.CI_WAIT_LIFECYCLE.maxTools},
                          sessions[sid] != nil || sessions.count < ${mod.CI_WAIT_LIFECYCLE.maxSessions} else { return false }
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
`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mod = await import('../shared/dist/ci-wait.js');
  for (const [output, emit] of [[OUTPUT, emitSwift], [KOTLIN_OUTPUT, emitKotlin], [CPP_OUTPUT, emitCpp], [HERMES_OUTPUT, emitHermesRules]]) {
    const target = fileURLToPath(new URL('../' + output, import.meta.url));
    const next = emit(mod);
    if (process.argv.includes('--check')) {
      if (fs.readFileSync(target, 'utf8') !== next) throw new Error('CI wait mirror drifted: ' + output);
    } else fs.writeFileSync(target, next);
  }
}
