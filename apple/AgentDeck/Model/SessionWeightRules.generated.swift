// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/session-utils.ts (SESSION_WEIGHT_MIN/MAX, SESSION_ORDER_TTL_MS, MAX_SESSION_ORDER_PINS)
// Regenerate: pnpm generate-session-weight-rules (drift gated by shared/src/__tests__/session-weight-rules.test.ts)

/// Documented cross-platform `--weight` range. A session weight on the wire
/// is always an integer inside [min, max]; `clamp` is the shared normalize
/// step every Swift consumer applies before comparing or emitting.
///
/// `sessionOrderTtlMs` / `maxSessionOrderPins` extend the same contract onto
/// the daemon-persisted observed-session order pins (#273): the Node and
/// Swift daemons read and write one session-order.json, so its garbage-
/// collection rules must agree across implementations.
enum SessionWeightRules {
    static let min = -9999
    static let max = 9999
    static let sessionOrderTtlMs = 2592000000
    static let maxSessionOrderPins = 256

    static func clamp(_ weight: Int) -> Int {
        if weight < min { return min }
        if weight > max { return max }
        return weight
    }
}
