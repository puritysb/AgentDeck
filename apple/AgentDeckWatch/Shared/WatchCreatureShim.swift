import SwiftUI

/// The generated brand-feature table names `CrayfishCreature.parseSvgPath`;
/// the Watch has no terrarium, so it resolves that name to the shared parser.
enum CrayfishCreature {
    static func parseSvgPath(_ data: String) -> SwiftUI.Path { SvgPathParser.parseSvgPath(data) }
}
