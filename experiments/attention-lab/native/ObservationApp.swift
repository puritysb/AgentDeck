// Development-only native host. Not part of the App Store target.
// Reads a negotiated, loopback-only dashboard roster. It cannot start a daemon.
import SwiftUI
import Foundation
import CoreText

@MainActor
final class AttentionObservationFeed: ObservableObject {
    @Published var snapshot = AttentionContextSnapshot()
    @Published var connectionLabel = "연결 준비"
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var session: URLSession?
    private var lastReceived = Date.distantPast

    func connect() {
        disconnect()
        guard let raw = ProcessInfo.processInfo.environment["AGENTDECK_ATTENTION_PORT"] ?? Bundle.main.object(forInfoDictionaryKey: "AttentionDaemonPort") as? String,
              let port = Int(raw), (1024...65535).contains(port),
              let url = URL(string: "ws://127.0.0.1:\(port)") else {
            connectionLabel = "검증된 데몬 포트가 필요합니다."
            return
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 20
        let session = URLSession(configuration: config)
        self.session = session
        let socket = session.webSocketTask(with: url)
        socket.maximumMessageSize = 4 * 1024 * 1024
        self.socket = socket
        connectionLabel = "로컬 데몬 :\(port) 연결 중"
        lastReceived = Date()
        socket.resume()
        receiveTask = Task { [weak self] in
            guard let self else { return }
            do {
                // This is the sole outbound application message. No optional control capabilities.
                let registration = #"{"type":"client_register","clientType":"companion","clientLabel":"Attention Lab — read only","surface":{"protocol":1,"clientId":"dev.agentdeck.attention-lab","clientVersion":"0.1.0","productId":"dev.agentdeck.attention-lab","profiles":[{"id":"dashboard-live/v1","capabilities":["sessions.read"]}]}}"#
                try await socket.send(.string(registration))
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard self.socket === socket else { return }
                    let data: Data
                    switch message {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: continue
                    }
                    let envelope = try JSONDecoder().decode(Envelope.self, from: data)
                    if envelope.type == "surface_welcome" {
                        guard envelope.profile == "dashboard-live/v1", envelope.capabilities?.contains("sessions.read") == true else {
                            self.disconnect()
                            self.connectionLabel = "세션 읽기 권한이 협상되지 않았습니다."
                            return
                        }
                    }
                    if envelope.type == "sessions_list", let rows = envelope.sessions {
                        self.lastReceived = Date()
                        self.snapshot = AttentionContextSnapshot(rows: rows, connected: true, receivedAt: self.lastReceived)
                        self.connectionLabel = "실제 세션 관측 · 127.0.0.1:\(port) · 전송 동작 없음"
                    }
                }
            } catch {
                guard self.socket === socket else { return }
                self.disconnect()
                self.connectionLabel = "연결 끊김 · 아래에서 다시 연결할 수 있습니다."
            }
        }
        // Bound silent peers as well as connection establishment. Manual retry avoids background churn.
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                if Date().timeIntervalSince(self.lastReceived) > 20 {
                    self.disconnect()
                    self.connectionLabel = "20초 동안 목록 수신 없음 · 마지막 관측"
                    return
                }
            }
        }
    }

    func disconnect() {
        receiveTask?.cancel(); receiveTask = nil
        watchdog?.cancel(); watchdog = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        session?.invalidateAndCancel(); session = nil
        snapshot.connected = false
    }

    private struct Envelope: Decodable {
        var type: String
        var profile: String?
        var capabilities: [String]?
        var sessions: [AttentionContextRow]?
    }
}

@main
struct AttentionObservationApp: App {
    @StateObject private var feed = AttentionObservationFeed()
    init() {
        if let root = ProcessInfo.processInfo.environment["AGENTDECK_ATTENTION_REPO"] ?? Bundle.main.object(forInfoDictionaryKey: "AttentionRepoPath") as? String {
            for path in ["design/fonts/IBMPlexSansKR-Regular.ttf", "design/fonts/IBMPlexSansKR-Bold.ttf", "bridge/assets/fonts/JetBrainsMono-Regular.ttf"] {
                CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: root).appendingPathComponent(path) as CFURL, .process, nil)
            }
        }
    }
    var body: some Scene {
        Window("AgentDeck · Attention 관찰", id: "attention-observation") {
            VStack(spacing: 0) {
                HStack {
                    Text(feed.connectionLabel).font(.custom("IBMPlexSansKR-Regular", size: 12))
                    Spacer()
                    Button("다시 연결") { feed.connect() }
                }.padding(14)
                ScrollViewReader { proxy in
                    ScrollView {
                        AttentionContextPanel(snapshot: feed.snapshot, onSelect: {
                            proxy.scrollTo("attention-context", anchor: .top)
                        })
                        .id("attention-context")
                    }
                }
                Text("기존 앱·데몬은 그대로 · 이 창을 닫으면 관측 종료 · 기록 저장 없음")
                    .font(.custom("IBMPlexSansKR-Regular", size: 11)).padding(12)
            }
            .foregroundStyle(DesignTokens.Tide.s50)
            .background(DesignTokens.Ink.s900)
            .frame(minWidth: 380, minHeight: 500)
            .task { feed.connect() }
            .onDisappear { feed.disconnect() }
        }
        .defaultSize(width: 450, height: 780)
    }
}
