// GENERATED from shared/src/usage-severity.ts and design token bindings. DO NOT EDIT.
import Foundation

enum UsageSeverity {
    enum Level: Int { case unknown, normal, warning, critical }
    static func level(_ used: Double) -> Level {
        if !used.isFinite || used < 0 { return .unknown }
        if used >= 90 { return .critical }
        if used >= 70 { return .warning }
        return .normal
    }
    static let bright: [UInt32] = [0x7a8a9c, 0x52D988, 0xFFA93D, 0xFF6B6B]
    static let paper: [UInt32] = [0x3d454e, 0x296c44, 0x7f541e, 0x7f3535]
    static func colorHex(_ used: Double, onPaper: Bool = false) -> UInt32 {
        (onPaper ? paper : bright)[level(used).rawValue]
    }
}
