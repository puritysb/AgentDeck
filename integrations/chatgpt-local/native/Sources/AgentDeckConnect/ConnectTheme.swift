import SwiftUI
import CoreText

/// Reads the packaged canonical CSS rather than introducing another palette mirror.
@MainActor
enum ConnectTheme {
    private static var colors: [String: Color] = [:]

    static func installResources(bundle: Bundle = .main) {
        if let root = bundle.resourceURL?.appendingPathComponent("Fonts"),
           let files = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            for url in files where ["ttf", "otf"].contains(url.pathExtension.lowercased()) {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
        guard let path = bundle.url(forResource: "design-tokens", withExtension: "css"),
              let css = try? String(contentsOf: path, encoding: .utf8),
              let expression = try? NSRegularExpression(pattern: "--([a-z0-9-]+)\\s*:\\s*#([A-Fa-f0-9]{6})\\s*;") else { return }
        let source = css as NSString
        for match in expression.matches(in: css, range: NSRange(location: 0, length: source.length)) {
            let key = source.substring(with: match.range(at: 1))
            guard colors[key] == nil, let value = UInt32(source.substring(with: match.range(at: 2)), radix: 16) else { continue }
            colors[key] = Color(red: Double((value >> 16) & 255) / 255,
                                green: Double((value >> 8) & 255) / 255,
                                blue: Double(value & 255) / 255)
        }
    }

    static func color(_ token: String, fallback: Color = .primary) -> Color { colors[token] ?? fallback }
    static func font(_ size: CGFloat, bold: Bool = false) -> Font {
        .custom(bold ? "IBMPlexSansKR-Bold" : "IBMPlexSansKR-Regular", size: size)
    }
    static var background: Color { color("tide-50", fallback: Color(nsColor: .windowBackgroundColor)) }
    static var foreground: Color { color("ink-900") }
    static var secondary: Color { color("ink-500", fallback: .secondary) }
    static var quiet: Color { color("ink-300", fallback: .secondary) }
    static var healthy: Color { color("kelp-700", fallback: .primary) }
    static var awaiting: Color { color("amber-500", fallback: .primary) }
    static var error: Color { color("coral-700", fallback: .primary) }
}
