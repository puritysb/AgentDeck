#if os(macOS)
import Foundation
import ImageIO
import CryptoKit

@DaemonActor
enum DotAppearanceStore {
    private static var loaded = false
    private static var asset: DotAppearance?
    private static var file: URL { AgentDeckPaths.baseDirectory.appendingPathComponent("dot-appearance.json") }
    static func current() -> DotAppearance? {
        if !loaded {
            loaded = true
            if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
               size <= DotAppearanceRules.portraitBytes * 2, let data = try? Data(contentsOf: file), data.count <= DotAppearanceRules.portraitBytes * 2,
               let value = try? JSONDecoder().decode(DotAppearance.self, from: data), value.portrait != nil { asset = value }
        }
        return asset
    }
    static func reset() throws {
        try FileManager.default.createDirectory(at: AgentDeckPaths.baseDirectory, withIntermediateDirectories: true)
        try Data("null".utf8).write(to: file, options: .atomic)
        asset = nil; loaded = true
    }
    static func importImage(_ data: Data) throws {
        let value = try normalizeImage(data)
        try FileManager.default.createDirectory(at: AgentDeckPaths.baseDirectory, withIntermediateDirectories: true)
        try JSONEncoder().encode(value).write(to: file, options: .atomic)
        asset = value; loaded = true
    }
    static func normalizeImage(_ data: Data) throws -> DotAppearance {
        guard data.count <= DotAppearanceRules.sourceBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) == 1,
              let type = CGImageSourceGetType(source), ["public.png", "public.jpeg", "org.webmproject.webp"].contains(type as String),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= DotAppearanceRules.sourcePixels / height else {
            throw DotFailure.message("Choose a static character image within the size limit.")
        }
        func render(_ size: Int) throws -> (CGImage, Data) {
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: size, kCGImageSourceCreateThumbnailWithTransform: true]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
                  let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
                  let bytes = context.data else { throw DotFailure.message("Character conversion failed.") }
            context.clear(CGRect(x: 0, y: 0, width: size, height: size))
            let scale = CGFloat(size) / CGFloat(max(image.width, image.height))
            let w = CGFloat(image.width) * scale, h = CGFloat(image.height) * scale
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: (CGFloat(size) - w) / 2, y: (CGFloat(size) - h) / 2, width: w, height: h))
            guard let result = context.makeImage() else { throw DotFailure.message("Character conversion failed.") }
            var rgba = Data(bytes: bytes, count: size * size * 4)
            rgba.withUnsafeMutableBytes { raw in
                let p = raw.bindMemory(to: UInt8.self)
                for i in stride(from: 0, to: p.count, by: 4) {
                    let a = Int(p[i + 3])
                    if a > 0 { for c in 0..<3 { p[i + c] = UInt8(min(255, (Int(p[i + c]) * 255 + a / 2) / a)) } }
                }
            }
            return (result, rgba)
        }
        let (image, _) = try render(DotAppearanceRules.portraitSize)
        let (_, glyph) = try render(DotAppearanceRules.glyphSize)
        let png = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil) else {
            throw DotFailure.message("Character conversion failed.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), png.length <= DotAppearanceRules.portraitBytes else {
            throw DotFailure.message("Character image exceeds the display budget.")
        }
        let bytes = png as Data
        let value = DotAppearance(version: DotAppearanceRules.version, id: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
                                  png: bytes.base64EncodedString(), rgba: glyph.base64EncodedString())
        return value
    }
}
#endif
