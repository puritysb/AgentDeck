// GENERATED from shared/src/background-work-presentation.ts. DO NOT EDIT.
import Foundation
enum BackgroundDevicePolicy {
    static let maxCount = 4096
    static let maxDots = 3
    static let pixelRadiusFraction = 0.7
    static let pixelOrbitAspect = 0.45
    static let pixelMinRadius: Double = 3
    static let orbitMs = 4800
    static let finishMs = 1500
    static func count(_ value: Int?) -> Int? {
        guard let value, value >= 0, value <= maxCount else { return nil }
        return value
    }
    static func decode(_ raw: Any?) -> Int? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite, n.doubleValue.rounded(.down) == n.doubleValue,
              n.doubleValue >= 0, n.doubleValue <= Double(maxCount) else { return nil }
        return n.intValue
    }
    static func compact(_ value: Int?, standby: Int? = nil) -> String? {
        let waiting = count(standby) ?? 0
        if (count(value) ?? 0) == 0, waiting > 0 { return "STBY \(waiting)" }
        guard let value = count(value) else { return nil }
        return value == 0 ? "BG DONE" : "BG \(value)"
    }
}
