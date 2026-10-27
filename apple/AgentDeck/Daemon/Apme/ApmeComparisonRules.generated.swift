// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/apme-comparison.ts
// Regenerate: pnpm generate-apme-display-rules (drift gated by shared/src/__tests__/apme-display-rules-sync.test.ts)

import Foundation

enum ApmeComparisonRules {
    static let minSamples = 3
    private static let nonModelIds: Set<String> = ["", "unknown", "mixed", "default", "<synthetic>", "agentdeck-fixture", "delivery-mirror", "gateway-injected"]
    private static let nonCategories: Set<String> = ["", "unknown", "_empty"]

    static func eligible(modelId: String, category: String?, samples: Int) -> Bool {
        let model = trimmed(modelId).lowercased()
        guard samples >= minSamples, !nonModelIds.contains(model), !model.hasPrefix("<"),
              let category else { return false }
        return !nonCategories.contains(trimmed(category).lowercased())
    }

    private static func trimmed(_ value: String) -> String {
        var scalars = value.unicodeScalars.drop(while: isJSWhitespace)
        while let last = scalars.last, isJSWhitespace(last) { scalars = scalars.dropLast() }
        return String(String.UnicodeScalarView(scalars))
    }

    private static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A,
             0x2028...0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }
}
