// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/session-utils.ts (SESSION_WEIGHT_MIN/MAX)
// Regenerate: pnpm generate-session-weight-rules (drift gated by shared/src/__tests__/session-weight-rules.test.ts)

/// Documented cross-platform `--weight` range. A session weight on the wire
/// is always an integer inside [min, max]; `clamp` is the shared normalize
/// step every Swift consumer applies before comparing or emitting.
enum SessionWeightRules {
    static let min = -9999
    static let max = 9999

    static func clamp(_ weight: Int) -> Int {
        if weight < min { return min }
        if weight > max { return max }
        return weight
    }
}
