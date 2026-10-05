#!/usr/bin/env node
// CI wait intent SSOT -> native pure classifier. No runtime I/O or subprocess.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const OUTPUT = 'apple/AgentDeck/Daemon/Session/CiWaitRules.generated.swift';
const quote = value => JSON.stringify(value).replace(/\\f/g, '\\u{000c}').replace(/\\u([0-9a-f]{4})/gi, '\\u{$1}');
const list = values => `[${values.map(quote).join(', ')}]`;
export function emitSwift(mod) {
  const r = mod.CI_WAIT_RULES;
  return String.raw`// GENERATED FILE — DO NOT EDIT.
// SSOT: shared/src/ci-wait.ts; regenerate: pnpm generate-ci-wait.
// Byte drift and shared/ci-wait-vectors.json execution are gated by ci-wait-sync.test.ts.
import Foundation
import CoreFoundation

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
`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mod = await import('../shared/dist/ci-wait.js');
  const target = fileURLToPath(new URL('../' + OUTPUT, import.meta.url));
  const next = emitSwift(mod);
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== next) throw new Error('CI wait mirror drifted');
  } else fs.writeFileSync(target, next);
}
