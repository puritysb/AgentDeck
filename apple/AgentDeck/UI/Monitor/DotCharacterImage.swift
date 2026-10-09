import SwiftUI
import ImageIO

struct DotCharacterImage: View {
    let appearance: DotAppearance?
    var tint: Color = DesignTokens.Ink.s300
    @State private var image: CGImage?
    var body: some View {
        Group {
            if let image { Image(decorative: image, scale: 1).resizable().scaledToFit() }
            else {
                ZStack {
                    Circle().fill(tint)
                    HStack(spacing: 8) { Capsule().frame(width: 3, height: 7); Capsule().frame(width: 3, height: 7) }
                        .foregroundStyle(DesignTokens.Ink.s900)
                }
            }
        }.task(id: appearance?.id) {
            image = nil
            if let data = appearance?.portrait, let source = CGImageSourceCreateWithData(data as CFData, nil) {
                image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: DotAppearanceRules.portraitSize] as CFDictionary)
            }
        }
    }
}
