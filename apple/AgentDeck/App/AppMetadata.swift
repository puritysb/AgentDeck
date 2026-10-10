import Foundation

/// Identity of the installed app, shared by UI and peer handshakes.
/// Never substitute a historical release when bundle metadata is unavailable.
struct AppMetadata: Sendable {
    static let current = AppMetadata(info: Bundle.main.infoDictionary ?? [:])
    static let appStoreURL = URL(string: "https://apps.apple.com/app/id6784822497")!
    static let reviewURL = appStoreURL.appending(queryItems: [
        URLQueryItem(name: "action", value: "write-review")
    ])

    let name: String
    let version: String
    let build: String
    let bundleIdentifier: String

    init(info: [String: Any]) {
        func value(_ key: String) -> String? {
            guard let raw = info[key] as? String else { return nil }
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, !text.contains("$(") else { return nil }
            return text
        }
        name = value("CFBundleDisplayName") ?? value("CFBundleName") ?? "AgentDeck"
        version = value("CFBundleShortVersionString") ?? "Unknown"
        build = value("CFBundleVersion") ?? "Unknown"
        bundleIdentifier = value("CFBundleIdentifier") ?? "Unknown"
    }
}
