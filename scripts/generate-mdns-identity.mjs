#!/usr/bin/env node
// Generate the Swift mirror of the mDNS identity SSOT
// (shared/src/mdns-identity.ts).
//
//   pnpm generate-mdns-identity            regenerate the mirror
//   pnpm generate-mdns-identity --check    exit 1 if it drifted
//
// Both daemons advertise the same service on the same segment, so the shape of
// the instance name and the TXT keys is a contract between them — and, since
// the previous shape (`AgentDeck-9120`) was identical on every machine in an
// office, one whose value is entirely in being computed the same way twice.
// A hand-written second copy is exactly what this repo has been burned by.
//
// Swift only: the mobile/firmware clients READ the TXT record, they never
// build an instance name, and the keys they read (`agent`, `project`) are
// unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/mdns-identity.ts\n' +
  'Regenerate: pnpm generate-mdns-identity (drift gated by shared/src/__tests__/mdns-identity.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

export function emitSwift(rules) {
  return `${comment('//')}
#if os(macOS)

import Foundation

/// How this daemon names itself on \`_agentdeck._tcp\`.
///
/// A DNS-SD instance name must be unique per network SEGMENT, not per host,
/// and both daemons used to publish \`AgentDeck-<port>\` — the same string on
/// every Mac in an office. See the TypeScript source for the full story.
enum MdnsIdentity {
    /// TXT schema version, in lockstep with the Node daemon.
    static let txtSchemaVersion = "${rules.txtSchemaVersion}"
    static let hostLabelMax = ${rules.hostLabelMax}

    /// Characters that are safe and readable in a DNS-SD instance label.
    static func sanitizeLabel(_ raw: String, maxLength: Int = hostLabelMax) -> String {
        let shortName = raw.split(separator: ".").first.map(String.init) ?? ""
        var out = ""
        var lastWasDash = false
        for ch in shortName {
            if ch.isASCII && (ch.isLetter || ch.isNumber) {
                out.append(ch)
                lastWasDash = false
            } else if !lastWasDash {
                out.append("-")
                lastWasDash = true
            }
        }
        while out.hasPrefix("-") { out.removeFirst() }
        while out.hasSuffix("-") { out.removeLast() }
        return String(out.prefix(maxLength))
    }

    /// Short, stable, non-reversible tag for the OS user this daemon runs as.
    /// FNV-1a — a disambiguator, never a secret, and never the account name,
    /// which multicast would otherwise publish to the whole segment.
    static func userTag(uid: UInt32, username: String = "") -> String {
        var hash: UInt32 = 0x811c9dc5
        for byte in Array("\\(uid):\\(username)".utf8) {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return String(String(format: "%08x", hash).prefix(4))
    }

    /// This process's tag.
    static func currentUserTag() -> String {
        userTag(uid: getuid(), username: NSUserName())
    }

    /// The instance name to publish. Any empty component collapses out, so a
    /// platform that cannot answer one of the questions degrades to the old
    /// \`project-port\` shape rather than emitting a malformed name.
    static func instanceName(project: String, hostname: String, userTag: String, port: Int) -> String {
        let host = sanitizeLabel(hostname)
        let user = sanitizeLabel(userTag, maxLength: 8)
        return [project, host, user, String(port)].filter { !$0.isEmpty }.joined(separator: "-")
    }
}
#endif
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Modules/MdnsIdentity.generated.swift', emitSwift],
];

async function main() {
  let mod;
  try {
    mod = await import('../shared/dist/mdns-identity.js');
  } catch {
    console.error('shared/dist not found — run `pnpm --filter @agentdeck/shared build` first');
    process.exit(1);
  }
  const rules = {
    txtSchemaVersion: mod.MDNS_TXT_SCHEMA_VERSION,
    hostLabelMax: mod.MDNS_HOST_LABEL_MAX,
  };
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
    console.log(drifted ? 'mDNS identity mirror DRIFTED' : 'mDNS identity mirror in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
