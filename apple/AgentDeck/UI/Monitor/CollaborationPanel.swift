#if os(macOS)
import SwiftUI

@MainActor
final class CollaborationFeed: ObservableObject {
    @Published var task: CollaborationTask?
    @Published var children: [CollaborationChild] = []
    @Published var message = "왼쪽에서 세션을 선택하세요"
    @Published var fetchedAt: Date?
    @Published var failed = false

    func observe(sessionId: String, port: Int) async {
        task = nil; children = []; fetchedAt = nil; failed = false
        message = "작업 관계를 확인하고 있습니다…"
        guard !sessionId.isEmpty, port > 0 else {
            message = "왼쪽에서 세션을 선택하세요"; return
        }
        let sampleSessionID = ObservedAgentRules.rawSessionId(sessionId)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        while !Task.isCancelled {
            do {
                var url = URLComponents(string: "http://127.0.0.1:\(port)/apme/tasks")!
                url.queryItems = [URLQueryItem(name: "session", value: sampleSessionID), URLQueryItem(name: "limit", value: "1")]
                let page: CollaborationTaskPage = try await read(url.url!, using: session)
                try Task.checkCancellation()
                // Also validate the server's filter: an older route may ignore it.
                guard let latest = page.tasks.first, latest.sessionId == sampleSessionID else {
                    task = nil; children = []; failed = false; fetchedAt = Date()
                    message = "이 세션의 작업 기록이 아직 없습니다"
                    try await Task.sleep(for: .seconds(15)); continue
                }
                let detailURL = URL(string: "http://127.0.0.1:\(port)/apme/tasks")!
                    .appendingPathComponent(latest.id)
                let detail: CollaborationDetail = try await read(detailURL, using: session)
                try Task.checkCancellation()
                task = latest
                children = CollaborationProjection.children(sample: detail.sample, sessionId: sampleSessionID, taskId: latest.id)
                fetchedAt = Date(); failed = false
                message = detail.sample == nil ? "개별 위임 기록을 제공하지 않는 연결입니다" : "관측된 위임만 표시 · 결과 반영 여부는 별도 확인이 필요합니다"
            } catch {
                guard !Task.isCancelled else { return }
                failed = true
                message = fetchedAt == nil
                    ? "작업 기록을 읽을 수 없습니다 · 현재 세션 상태는 계속 표시합니다"
                    : "기록 갱신 실패 · 아래 관계는 마지막으로 읽은 기록입니다"
            }
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
        }
    }

    private func read<T: Decodable>(_ url: URL, using session: URLSession) async throws -> T {
        // Same authenticated local API as the existing APME window. Keep the
        // adopted daemon token only in ephemeral requests, never in UI/logs.
        var authorized = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        authorized.queryItems = (authorized.queryItems ?? []) + [URLQueryItem(name: "token", value: AuthManager.shared.token)]
        let (bytes, response) = try await session.bytes(from: authorized.url!)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.expectedContentLength <= 2_097_152 else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2_097_152 else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct CollaborationPanel: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var daemonService: DaemonService
    @StateObject private var feed = CollaborationFeed()
    @State private var inspectedID: String?
    @State private var showsSystem = false
    let maxHeight: CGFloat

    private var selected: SessionInfo? {
        stateHolder.state.siblingSessions.first { $0.id == inspectedID }
    }
    private var observationKey: String {
        "\(daemonService.port)|\(stateHolder.state.bridgeConnected)|\(selected?.id ?? "")"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("협업 보기", systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 17, weight: .semibold))
                Spacer()
                Text("실험").font(.caption).foregroundStyle(DesignTokens.UI.cyan)
                Button { showsSystem.toggle() } label: {
                    Image(systemName: "network")
                }.help("기존 시스템 상태 보기").popover(isPresented: $showsSystem) {
                    TopologyRail(maxHeight: 560).frame(width: 330).padding(12)
                }
            }
            Text("세션 선택 → 작업 → 확인된 하위 에이전트")
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            Divider().overlay(DesignTokens.Ink.s500)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let selected {
                        sessionHeader(selected)
                        if let task = feed.task {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(task.endedAt == nil ? "최근 작업 · 열린 기록" : "최근 작업 · 닫힌 기록",
                                      systemImage: "square.stack.3d.up")
                                    .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
                                Text(task.displayTitle).font(.system(size: 16, weight: .medium)).lineLimit(4)
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(DesignTokens.Ink.s700.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
                        }
                        if let census = selected.subagents {
                            HStack(spacing: 8) {
                                metric(census.active, "하위 활동", "circle.dotted", DesignTokens.UI.cyan)
                                metric(census.completed, "이번 묶음 종료", "checkmark.circle", DesignTokens.UI.ok)
                            }
                            Text("현재 세션 집계 · 아래 작업 기록과 범위가 다를 수 있습니다")
                                .font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                        }
                        if !feed.children.isEmpty {
                            Label("관측된 위임 관계", systemImage: "arrow.triangle.branch")
                                .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
                            ForEach(feed.children.prefix(24)) { child in childRow(child) }
                            if feed.children.count > 24 {
                                Text("외 \(feed.children.count - 24)개 · 이 화면은 24개까지 표시합니다").font(.caption)
                            }
                        } else {
                            VStack(spacing: 8) {
                                Image(systemName: "point.topleft.down.to.point.bottomright.curvepath")
                                    .font(.system(size: 28)).foregroundStyle(DesignTokens.Ink.s300)
                                Text("아직 확인된 가지가 없습니다").font(.subheadline)
                                Text("같은 프로젝트의 세션을 임의로 연결하지 않습니다.")
                                    .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
                            }.frame(maxWidth: .infinity).padding(.vertical, 16)
                        }
                        Label(feed.message, systemImage: feed.failed ? "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90" : "eye")
                            .font(.caption).foregroundStyle(feed.failed ? DesignTokens.UI.attn : DesignTokens.Ink.s300)
                        if let fetched = feed.fetchedAt {
                            Text("기록 확인 \(fetched.formatted(date: .omitted, time: .standard)) · 15초마다 갱신")
                                .font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                        }
                    } else {
                        Image(systemName: "cursorarrow.click.2").font(.largeTitle).padding(.top, 20)
                        Text(inspectedID == nil ? "왼쪽 세션이나 테라리움의 에이전트를 선택하세요" : "선택한 세션이 목록에서 사라졌습니다. 다른 세션을 선택하세요.")
                            .font(.subheadline)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.scrollBounceBehavior(.basedOnSize)
        }
        .padding(16).frame(maxHeight: maxHeight)
        .background(DesignTokens.Ink.s900.opacity(0.94), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(DesignTokens.Ink.s500.opacity(0.6)))
        .foregroundStyle(DesignTokens.Tide.s50)
        .onAppear { inspectedID = stateHolder.state.focusedSessionId }
        .onChange(of: stateHolder.state.focusedSessionId) { _, id in inspectedID = id }
        .task(id: observationKey) {
            await feed.observe(sessionId: stateHolder.state.bridgeConnected ? (selected?.id ?? "") : "", port: Int(daemonService.port))
        }
    }

    private func sessionHeader(_ session: SessionInfo) -> some View {
        let waiting = session.state?.hasPrefix("awaiting") == true
        let working = session.state == "processing"
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: waiting ? "person.crop.circle.badge.exclamationmark" : "circle.hexagongrid.fill")
                    .font(.system(size: 25)).foregroundStyle(waiting ? DesignTokens.UI.attn : DesignTokens.UI.cyan)
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.projectName ?? "프로젝트 미확인").font(.headline).lineLimit(2)
                    Text("\(session.agentType ?? "Unknown agent") · \(ObservedAgentRules.rawSessionId(session.id).prefix(8))")
                        .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
                }
            }
            Label(waiting ? "주 에이전트 · 사용자 입력 필요" : working ? "주 에이전트 · 실행 중" : "주 에이전트 · \(session.state ?? "상태 미확인")",
                  systemImage: waiting ? "hand.raised.fill" : working ? "waveform" : "pause.circle")
                .font(.caption).foregroundStyle(waiting ? DesignTokens.UI.attn : DesignTokens.UI.cyan)
            if let activity = session.activity, !activity.isEmpty {
                Text(activity).font(.subheadline).lineLimit(3)
            }
            if waiting {
                Text(session.question ?? "질문 내용은 기존 응답 화면에서 확인하세요")
                    .font(.subheadline).lineLimit(4).padding(10)
                    .background(DesignTokens.UI.attn.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                Text("응답은 기존 질문 카드 또는 원래 에이전트에서 진행하세요")
                    .font(.caption).foregroundStyle(DesignTokens.UI.attn)
            }
        }
    }

    private func metric(_ number: Int, _ title: String, _ symbol: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label("\(max(0, number))", systemImage: symbol).font(.system(size: 24, weight: .semibold))
            Text(title).font(.system(size: 11))
        }.foregroundStyle(color).frame(maxWidth: .infinity, alignment: .leading).padding(10)
            .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private func childRow(_ child: CollaborationChild) -> some View {
        let ended = child.phase == "completed"
        return HStack(alignment: .top, spacing: 8) {
            // An explicit branch from the selected task, not a decorative network.
            Image(systemName: "arrow.turn.down.right").foregroundStyle(DesignTokens.Ink.s300).padding(.top, 12)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: ended ? "checkmark.circle.fill" : "circle.dotted")
                        .foregroundStyle(ended ? DesignTokens.UI.ok : DesignTokens.UI.cyan)
                    Text(child.name).font(.subheadline.bold()).lineLimit(2)
                    Spacer(minLength: 0)
                }
                Text(ended ? "종료 관측 · 결과 반영 여부 미확인" : "시작 관측 · 현재 실행 여부는 집계 참고")
                    .font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                if let summary = child.summary, !summary.isEmpty {
                    Text(summary).font(.caption).lineLimit(4)
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
#endif
