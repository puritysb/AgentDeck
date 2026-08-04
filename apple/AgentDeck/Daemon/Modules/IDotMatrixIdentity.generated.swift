// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/idotmatrix-identity.ts
// Regenerate: pnpm generate-idotmatrix-identity (drift gated by shared/src/__tests__/idotmatrix-identity.test.ts)

import Foundation

/// Brand-independent identity of an iDotMatrix-protocol BLE panel. The same
/// hardware advertises as `IDM-…` (iDotMatrix) or `iPixel-…`, so a scan filters
/// on the advertised service first and only falls back to the name families.
enum IDotMatrixIdentity {
    static let serviceUUIDString = "000000fa-0000-1000-8000-00805f9b34fb"
    static let writeCharacteristicUUIDString = "0000fa02-0000-1000-8000-00805f9b34fb"
    static let namePrefixes: [String] = ["IDM-", "IPIXEL"]

    /// Expand a 16-bit (`fa02`) or 32-bit (`000000fa`) UUID to its full
    /// Bluetooth-base form, lowercased — advertisements carry either, and
    /// `CBUUID.uuidString` does not promise to keep the leading zeroes.
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
