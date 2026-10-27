#if os(macOS)
// ApmeDashboardWindow.swift — In-app APME dashboard via WKWebView.
//
// The rich dashboard is served as HTML + JS + CSS at /apme on the Swift
// daemon's port. Instead of bouncing users to their browser (which breaks
// menu-bar-app UX on macOS — the browser steals focus, token is visible
// in the address bar, tab proliferation), we embed WKWebView inside a
// SwiftUI Window scene.
//
// Sandbox notes:
//   - `com.apple.security.network.client` is already granted for WS.
//   - Loading `http://127.0.0.1:PORT/...` does not require additional
//     entitlements. ATS exceptions are not needed for localhost loads
//     in WKWebView when the scheme is explicitly http (App Transport
//     Security allows localhost by default in macOS 11+).
//
// Token handling: the URL is built fresh each time the view appears so
// token rotation (future feature) is picked up without a rebuild. Token
// lives only in the WebView's navigation state — it's never persisted
// in history because this is a fresh window every time.

import SwiftUI
import WebKit

@MainActor
final class ApmeDashboardNavigation: ObservableObject {
    static let shared = ApmeDashboardNavigation()
    @Published var sessionId: String?
    @Published var taskIndex: Int?
    @Published var startedAt: Int?
    func select(sessionId: String? = nil, taskIndex: Int? = nil, startedAt: Int? = nil) {
        self.sessionId = sessionId; self.taskIndex = taskIndex; self.startedAt = startedAt
    }
}

struct ApmeDashboardWindow: View {
    @ObservedObject private var navigation = ApmeDashboardNavigation.shared
    @EnvironmentObject var daemonService: DaemonService

    var body: some View {
        Group {
            if daemonService.port == 0 {
                unavailableView
            } else if let url = dashboardURL {
                ApmeWebView(url: url)
                    .id(url.absoluteString)
            } else {
                unavailableView
            }
        }
        .frame(minWidth: 900, minHeight: 640)
    }

    private var dashboardURL: URL? {
        let port = daemonService.port
        guard port > 0 else { return nil }
        let token = AuthManager.shared.token
        var components = URLComponents(string: "http://127.0.0.1:\(port)/apme")
        var items = [URLQueryItem(name: "token", value: token)]
        if let session = navigation.sessionId, let index = navigation.taskIndex {
            items += [URLQueryItem(name: "session", value: session), URLQueryItem(name: "taskIndex", value: String(index))]
            if let startedAt = navigation.startedAt { items.append(URLQueryItem(name: "startedAt", value: String(startedAt))) }
        }
        components?.queryItems = items
        return components?.url
    }

    private var unavailableView: some View {
        VStack(spacing: 12) {
            Image(systemName: "chart.bar.xaxis")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("APME Dashboard Unavailable")
                .font(.title3)
            Text("The local dashboard service is not running. Reopen AgentDeck and try again.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// NSViewRepresentable wrapper around WKWebView. Loads a fixed URL and
/// does not expose navigation controls — the dashboard is a self-contained
/// SPA that fetches its own data.
struct ApmeWebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // No persistent storage between launches — APME data is all
        // server-side and the dashboard is stateless. Avoids leaking the
        // token into a shared cache.
        config.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Re-load if the URL changes (port changed, token rotated).
        if webView.url != url {
            webView.load(URLRequest(url: url))
        }
    }
}
#endif
