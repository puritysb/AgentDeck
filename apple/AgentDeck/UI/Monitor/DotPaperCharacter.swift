import SwiftUI
/// Static paper adaptation, using the same fixed RGBA glyph as the firmware.
struct DotPaperCharacter: View {
    let appearance: DotAppearance?
    var body: some View {
        let p = appearance?.glyph.map { [UInt8]($0) } ?? DotPixelOverlay.defaultRgba
        Canvas { context, size in
            let side = DotAppearanceRules.glyphSize
            for y in 0..<side { for x in 0..<side {
                let i = (y * side + x) * 4
                guard p[i+3] >= 128 else { continue }
                let edge = x == 0 || y == 0 || x == side-1 || y == side-1 ||
                    p[i-4+3] < 128 || p[i+4+3] < 128 || p[i-side*4+3] < 128 || p[i+side*4+3] < 128
                let dark = edge || Int(p[i]) + Int(p[i+1]) + Int(p[i+2]) < 384
                let rect = CGRect(x: CGFloat(x) * size.width / CGFloat(side), y: CGFloat(y) * size.height / CGFloat(side),
                                  width: size.width / CGFloat(side), height: size.height / CGFloat(side))
                context.fill(Path(rect), with: .color(dark ? DesignTokens.Ink.s900 : DesignTokens.Tide.s50))
            } }
        }
    }
}
