#!/usr/bin/env node
// Generate the Swift/Python mirrors of the iDotMatrix BLE identity SSOT
// (shared/src/idotmatrix-identity.ts).
//
//   pnpm generate-idotmatrix-identity            regenerate the mirrors
//   pnpm generate-idotmatrix-identity --check    exit 1 if any mirror drifted
//
// Requires shared to be built first (`pnpm --filter @agentdeck/shared build`
// or `pnpm build`) — the CLI imports the constants from shared/dist. The vitest
// sync test imports the emitters below directly with the TS source, so drift is
// caught in CI even if this CLI is never run.
//
// Two scanners must agree on which peripherals are iDotMatrix panels: the Swift
// CoreBluetooth scan in the App Store daemon and the Python/bleak scan in the
// terminal-managed daemon. Neither can import TypeScript, and the quicktype
// protocol pipeline carries types rather than constants or logic — so the
// predicate rides its own emitter, same shape as generate-session-weight-rules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/idotmatrix-identity.ts\n' +
  'Regenerate: pnpm generate-idotmatrix-identity (drift gated by shared/src/__tests__/idotmatrix-identity.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

export function emitSwift(identity) {
  const prefixes = identity.namePrefixes.map((p) => `"${p}"`).join(', ');
  return `${comment('//')}

import Foundation

/// Brand-independent identity of an iDotMatrix-protocol BLE panel. The same
/// hardware advertises as \`IDM-…\` (iDotMatrix) or \`iPixel-…\`, so a scan filters
/// on the advertised service first and only falls back to the name families.
enum IDotMatrixIdentity {
    static let serviceUUIDString = "${identity.serviceUuid}"
    static let writeCharacteristicUUIDString = "${identity.writeCharacteristicUuid}"
    static let namePrefixes: [String] = [${prefixes}]

    /// Expand a 16-bit (\`fa02\`) or 32-bit (\`000000fa\`) UUID to its full
    /// Bluetooth-base form, lowercased — advertisements carry either, and
    /// \`CBUUID.uuidString\` does not promise to keep the leading zeroes.
    static func normalizeUUID(_ value: String) -> String {
        let s = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !s.isEmpty, s.allSatisfy({ $0.isHexDigit }) else { return s }
        if s.count <= 4 {
            return "0000" + String(repeating: "0", count: 4 - s.count) + s + "-0000-1000-8000-00805f9b34fb"
        }
        if s.count <= 8 {
            return String(repeating: "0", count: 8 - s.count) + s + "-0000-1000-8000-00805f9b34fb"
        }
        return s
    }

    /// Whether an advertised local name belongs to a known panel family.
    static func matchesName(_ name: String, extraPrefixes: [String] = []) -> Bool {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if n.isEmpty { return false }
        for prefix in namePrefixes + extraPrefixes {
            let p = prefix.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if !p.isEmpty, n.hasPrefix(p) { return true }
        }
        return false
    }

    /// The discovery predicate: service UUID first, name families second.
    static func matchesAdvertisement(name: String,
                                     serviceUUIDs: [String],
                                     extraPrefixes: [String] = []) -> Bool {
        for uuid in serviceUUIDs where normalizeUUID(uuid) == serviceUUIDString {
            return true
        }
        return matchesName(name, extraPrefixes: extraPrefixes)
    }
}
`;
}

export function emitPython(identity) {
  const prefixes = identity.namePrefixes.map((p) => `"${p}"`).join(', ');
  return `${comment('#')}
"""Brand-independent identity of an iDotMatrix-protocol BLE panel.

The same hardware advertises as 'IDM-...' (iDotMatrix) or 'iPixel-...', so a
scan filters on the advertised service first and only falls back to the name
families.
"""

IDOTMATRIX_SERVICE_UUID = "${identity.serviceUuid}"
IDOTMATRIX_WRITE_CHARACTERISTIC_UUID = "${identity.writeCharacteristicUuid}"
IDOTMATRIX_NAME_PREFIXES = [${prefixes}]

_HEX = set("0123456789abcdef")


def normalize_uuid(value):
    """Expand a 16-bit ('fa02') or 32-bit ('000000fa') UUID to Bluetooth-base form.

    Short forms are left-padded first: 'fa' and '00fa' are the same service.
    """
    s = (value or "").strip().lower()
    if not s or not set(s) <= _HEX:
        return s
    if len(s) <= 4:
        return "0000" + s.rjust(4, "0") + "-0000-1000-8000-00805f9b34fb"
    if len(s) <= 8:
        return s.rjust(8, "0") + "-0000-1000-8000-00805f9b34fb"
    return s


def matches_name(name, extra_prefixes=()):
    """Whether an advertised local name belongs to a known panel family."""
    n = (name or "").strip().upper()
    if not n:
        return False
    for prefix in list(IDOTMATRIX_NAME_PREFIXES) + list(extra_prefixes or ()):
        p = (prefix or "").strip().upper()
        if p and n.startswith(p):
            return True
    return False


def matches_advertisement(name, service_uuids, extra_prefixes=()):
    """The discovery predicate: service UUID first, name families second."""
    for uuid in service_uuids or ():
        if normalize_uuid(uuid) == IDOTMATRIX_SERVICE_UUID:
            return True
    return matches_name(name, extra_prefixes)
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Modules/IDotMatrixIdentity.generated.swift', emitSwift],
  ['bridge/src/idotmatrix/identity_generated.py', emitPython],
];

async function main() {
  let identity;
  try {
    const shared = await import('../shared/dist/idotmatrix-identity.js');
    identity = {
      serviceUuid: shared.IDOTMATRIX_SERVICE_UUID,
      writeCharacteristicUuid: shared.IDOTMATRIX_WRITE_CHARACTERISTIC_UUID,
      namePrefixes: [...shared.IDOTMATRIX_NAME_PREFIXES],
    };
  } catch {
    console.error('shared/dist not found — run `pnpm --filter @agentdeck/shared build` first');
    process.exit(1);
  }
  const check = process.argv.includes('--check');
  let drifted = false;
  for (const [rel, emit] of OUTPUTS) {
    const abs = path.join(projectDir, rel);
    const next = emit(identity);
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
    console.log(drifted ? 'iDotMatrix identity mirrors DRIFTED' : 'iDotMatrix identity mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
