#!/usr/bin/env node
// Generate the Swift evaluator of the same-machine trust rule:
//   shared/src/local-trust.ts
//     → apple/AgentDeck/Daemon/Server/LocalTrustRules.generated.swift
//
//   pnpm generate-local-trust-rules            regenerate the mirror
//   pnpm generate-local-trust-rules --check    exit 1 if it drifted
//
// Requires shared to be built first (`pnpm build`). The vitest sync test
// (shared/src/__tests__/local-trust-sync.test.ts) imports the emitter against
// the TS source, so drift is caught in CI even when this CLI is never run.
// Behaviour is pinned by shared/local-trust-vectors.json, which both suites
// replay. The daemon's inputs (its addresses, host name and port) and the
// refusal log stay in the hand-written LocalTrust.swift beside it, as they do
// in bridge/src/auth.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function swiftString(value) {
  if (!/^[\x20-\x7e]*$/.test(value) || /["\\]/.test(value)) throw new Error(`cannot embed ${value} in a Swift string`);
  return `"${value}"`;
}

export function rulesFrom(mod) {
  return {
    safeMethods: [...mod.LOCAL_TRUST_SAFE_METHODS],
    defaultPorts: Object.entries(mod.LOCAL_TRUST_DEFAULT_PORTS),
    fileOrigin: mod.LOCAL_TRUST_FILE_ORIGIN,
  };
}

export function emitSwift(rules) {
  const methods = rules.safeMethods.map(swiftString).join(', ');
  const ports = rules.defaultPorts.map(([scheme, port]) => `${swiftString(scheme)}: ${Number(port)}`).join(', ');
  return `// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/local-trust.ts
// Regenerate: pnpm generate-local-trust-rules (drift gated by shared/src/__tests__/local-trust-sync.test.ts)
import Foundation

/// Whether a same-machine request may skip the pairing token: a web page in a
/// browser here connects from 127.0.0.1 like a local program, and only its
/// \`Host\` and \`Origin\` tell them apart. \`Host\` must name this machine without
/// asking the network; on a WebSocket upgrade or a method that changes state,
/// \`Origin\` must be absent, the daemon's own origin, or \`file://\`. The
/// reasoning is in the TS source; behaviour is pinned by
/// \`shared/local-trust-vectors.json\` (\`LocalTrustVectorsTests\`).
///
/// Text is read as Unicode scalars and compared exactly, with whitespace and
/// case handled as ASCII only, as the TS source handles it: \`String\` equality
/// and \`Character\` matching follow canonical equivalence and grapheme
/// clusters, which a combining mark after a digit was enough to tell apart.
enum LocalTrustRules {
    enum Verdict: String, Sendable {
        case trusted
        case foreignHost = "foreign-host"
        case foreignOrigin = "foreign-origin"
    }

    struct Environment: Sendable {
        /// The port this server listens on, which its own pages' origin carries.
        let port: Int
        /// Whether an IP literal (no brackets, no zone) is one of this
        /// machine's addresses, loopback included.
        let isLocalAddress: @Sendable (String) -> Bool
        /// This machine's host names (\`gethostname\`), in any case; only a
        /// \`.local\` one is trusted.
        let hostNames: [String]
    }

    /// Methods that do not change state; a browser sends no \`Origin\` on a same-origin GET or HEAD.
    static let safeMethods: Set<String> = [${methods}]
    /// The port an origin names when it names none.
    static let defaultPorts: [String: Int] = [${ports}]
    /// The literal \`Origin\` the ESP32 WebSocket library sends; a browser never sends it.
    static let fileOrigin = ${swiftString(rules.fileOrigin)}

    /// Whether a same-machine request may skip the pairing token, and why not.
    static func verdict(
        method: String, upgrade: Bool, origin: String?, host: String?, environment env: Environment
    ) -> Verdict {
        let hostHeader = trimAscii(scalars(host ?? ""))
        var addressed: Authority?
        if !hostHeader.isEmpty {
            // A browser reaches an IP literal without DNS, so rebinding cannot produce one.
            guard let parsed = splitAuthority(hostHeader),
                  isIpLiteral(parsed.host) || isThisMachineName(parsed.host, env) else { return .foreignHost }
            addressed = parsed
        }
        let methodName = asciiUpper(trimAscii(scalars(method)))
        guard upgrade || !safeMethods.contains(where: { scalars($0) == methodName }) else { return .trusted }
        let originText = trimAscii(scalars(origin ?? ""))
        if originText.isEmpty || asciiLower(originText) == scalars(fileOrigin) { return .trusted }
        return isOwnOrigin(originText, addressed, env) ? .trusted : .foreignOrigin
    }

    private typealias Scalars = [Unicode.Scalar]

    private struct Authority {
        /// ASCII lower case, without brackets or a trailing dot.
        let host: Scalars
        /// Digits, or empty when the authority names no port.
        let port: Scalars
    }

    private static func scalars(_ text: String) -> Scalars { Array(text.unicodeScalars) }

    private static func string<C: Collection>(_ text: C) -> String where C.Element == Unicode.Scalar {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: text)
        return String(view)
    }

    /// Trim ASCII whitespace only, as the TS source's \`trimAscii\`.
    private static func trimAscii(_ text: Scalars) -> Scalars {
        var start = text.startIndex
        var end = text.endIndex
        while start < end, isAsciiSpace(text[start]) { start += 1 }
        while end > start, isAsciiSpace(text[end - 1]) { end -= 1 }
        return Array(text[start..<end])
    }

    private static func isAsciiSpace(_ c: Unicode.Scalar) -> Bool {
        c == " " || (c.value >= 0x09 && c.value <= 0x0D)
    }

    private static func asciiLower(_ text: Scalars) -> Scalars {
        text.map { ("A"..."Z").contains($0) ? Unicode.Scalar(UInt8($0.value) + 32) : $0 }
    }

    private static func asciiUpper(_ text: Scalars) -> Scalars {
        text.map { ("a"..."z").contains($0) ? Unicode.Scalar(UInt8($0.value) - 32) : $0 }
    }

    private static func hasSuffix(_ text: Scalars, _ suffix: Scalars) -> Bool {
        text.count >= suffix.count && Array(text.suffix(suffix.count)) == suffix
    }

    /// Split \`host[:port]\` or \`[ipv6][:port]\`; nil when it is neither.
    private static func splitAuthority(_ authority: Scalars) -> Authority? {
        let text = asciiLower(trimAscii(authority))
        var host: Scalars
        var port: Scalars = []
        if text.first == "[" {
            guard let close = text.firstIndex(of: "]") else { return nil }
            host = Array(text[1..<close])
            let rest = text[(close + 1)...]
            if !rest.isEmpty {
                guard rest.first == ":" else { return nil }
                port = Array(rest.dropFirst())
            }
        } else if let colon = text.firstIndex(of: ":") {
            let afterColon = text[(colon + 1)...]
            if afterColon.contains(":") {
                // More than one colon: a bare IPv6 literal, which names no port.
                host = text
            } else {
                host = Array(text[..<colon])
                port = Array(afterColon)
            }
        } else {
            host = text
        }
        if host.last == "." { host.removeLast() }
        guard !host.isEmpty, port.isEmpty || isAsciiDigits(port, maxCount: 5) else { return nil }
        return Authority(host: host, port: port)
    }

    private static func isAsciiDigits<C: Collection>(_ text: C, maxCount: Int) -> Bool
    where C.Element == Unicode.Scalar {
        !text.isEmpty && text.count <= maxCount && text.allSatisfy { ("0"..."9").contains($0) }
    }

    /// The value of 1-5 ASCII digits.
    private static func number<C: Collection>(_ digits: C) -> Int where C.Element == Unicode.Scalar {
        digits.reduce(0) { $0 * 10 + Int($1.value) - 48 }
    }

    /// An IPv4 dotted quad, or an IPv6 literal with or without a zone.
    private static func isIpLiteral(_ host: Scalars) -> Bool {
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        if octets.count == 4, octets.allSatisfy({ isAsciiDigits($0, maxCount: 3) }) {
            return octets.allSatisfy { number($0) <= 255 }
        }
        let address = withoutZone(host)
        return address.contains(":") && address.allSatisfy { "0123456789abcdef:.".unicodeScalars.contains($0) }
    }

    private static func withoutZone(_ host: Scalars) -> Scalars {
        guard let percent = host.firstIndex(of: "%") else { return host }
        return Array(host[..<percent])
    }

    private static func isThisMachineName(_ host: Scalars, _ env: Environment) -> Bool {
        if host == scalars("localhost") || hasSuffix(host, scalars(".localhost")) { return true }
        // Only the mDNS name, which the system resolver answers from this
        // machine's own records: never a name derived from it, which DNS would answer.
        let local = scalars(".local")
        for raw in env.hostNames {
            guard let name = splitAuthority(scalars(raw))?.host else { continue }
            if name.count > local.count && hasSuffix(name, local) && host == name { return true }
        }
        return false
    }

    private static func isOwnOrigin(_ origin: Scalars, _ addressed: Authority?, _ env: Environment) -> Bool {
        // The TS source's /^([a-z][a-z0-9+.-]*):\\/\\/([^/?#]*)\\/?$/i: the
        // scheme holds no ":", so the first one ends it.
        guard let colon = origin.firstIndex(of: ":") else { return false }
        let scheme = asciiLower(Array(origin[..<colon]))
        guard isScheme(scheme), let defaultPort = defaultPorts[string(scheme)] else { return false }
        var rest = origin[(colon + 1)...]
        guard rest.starts(with: scalars("//")) else { return false }
        rest = rest.dropFirst(2)
        // A browser never sends a path; a trailing slash from a non-browser
        // client is tolerated, since host and port still have to be this daemon's.
        if rest.last == "/" { rest = rest.dropLast() }
        guard !rest.contains(where: { "/?#@".unicodeScalars.contains($0) }),
              let authority = splitAuthority(Array(rest)) else { return false }
        let port = authority.port.isEmpty ? defaultPort : number(authority.port)
        let addressedHere = addressed.map {
            $0.host == authority.host && ($0.port.isEmpty ? defaultPort : number($0.port)) == port
        } ?? false
        guard addressedHere || port == env.port else { return false }
        // An IP literal must be this machine's: any address with the daemon's
        // port would admit a page served from another host's server on that port.
        if isIpLiteral(authority.host) { return env.isLocalAddress(string(withoutZone(authority.host))) }
        return isThisMachineName(authority.host, env)
    }

    private static func isScheme(_ scheme: Scalars) -> Bool {
        guard let first = scheme.first, ("a"..."z").contains(first) else { return false }
        return scheme.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || "+.-".unicodeScalars.contains($0) }
    }
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Server/LocalTrustRules.generated.swift', emitSwift],
];

async function main() {
  let mod;
  try {
    mod = await import(path.join(projectDir, 'shared/dist/local-trust.js'));
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
      if (prev !== next) { console.error(`DRIFT: ${rel}`); drifted = true; }
    } else if (prev !== next) {
      fs.writeFileSync(abs, next);
      console.log(`wrote ${rel}`);
    } else {
      console.log(`up-to-date ${rel}`);
    }
  }
  if (check) {
    console.log(drifted ? 'local trust rules mirror DRIFTED' : 'local trust rules mirror in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
