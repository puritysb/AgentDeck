import AppKit
import SwiftUI

@main
@MainActor
struct AgentDeckConnectApp: App {
    @NSApplicationDelegateAdaptor(ConnectAppDelegate.self) private var delegate
    @StateObject private var model = ConnectModel()

    init() { ConnectTheme.installResources() }

    var body: some Scene {
        Window("AgentDeck 연결", id: "agentdeck-connect") {
            ConnectView(model: model)
                .task { model.inspect() }
        }
        .defaultSize(width: 650, height: 670)
        .windowResizability(.contentMinSize)
        .commands { CommandGroup(replacing: .newItem) {} }
    }
}

@MainActor
final class ConnectAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@MainActor
private struct ConnectView: View {
    @ObservedObject var model: ConnectModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 9) {
                    Text("로컬 연결 검증 · 미출시")
                        .font(ConnectTheme.font(13, bold: true))
                        .foregroundStyle(ConnectTheme.secondary)
                    Text("AgentDeck 연결")
                        .font(ConnectTheme.font(31, bold: true))
                    Text("이 Mac에서 공유한 요청을 읽고, 그 요청의 진행과 결과를 보고하도록 연결해요.")
                        .font(ConnectTheme.font(16))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Divider()
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 10) {
                        if model.isBusy { ProgressView().controlSize(.small) }
                        else { Circle().fill(statusColor).frame(width: 9, height: 9) }
                        Text(statusTitle).font(ConnectTheme.font(21, bold: true))
                    }
                    Text(statusDetail)
                        .font(ConnectTheme.font(15))
                        .foregroundStyle(ConnectTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if case .waiting(let consent) = model.phase {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("AgentDeck 화면과 비교할 코드")
                                .font(ConnectTheme.font(13, bold: true))
                            Text(consent.verificationCode)
                                .font(ConnectTheme.font(34, bold: true))
                                .tracking(4)
                                .textSelection(.enabled)
                                .accessibilityLabel("비교 코드 \(consent.verificationCode)")
                            Text("요청한 권한: \(consent.scopes.joined(separator: " · "))")
                                .font(ConnectTheme.font(14))
                                .textSelection(.enabled)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ConnectTheme.color("tide-100", fallback: .clear))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
                HStack(spacing: 12) {
                    Button("연결 시작") { model.connect() }
                        .buttonStyle(.borderedProminent)
                        .tint(ConnectTheme.healthy)
                        .disabled(!model.canConnect)
                        .accessibilityIdentifier("connect-start")
                    Button("연결 철회") { model.disconnect() }
                        .buttonStyle(.bordered)
                        .disabled(!model.canDisconnect)
                        .accessibilityIdentifier("connect-revoke")
                    Spacer()
                    Button("저장 상태 확인") { model.inspect() }
                        .buttonStyle(.borderless)
                        .disabled(!model.canInspect)
                        .accessibilityIdentifier("connect-inspect")
                }
                .font(ConnectTheme.font(14, bold: true))
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    Text("공유 범위와 연결 관리")
                        .font(ConnectTheme.font(14, bold: true))
                    Text("선택해 공유한 문맥과 결과는 OpenAI에서 처리해요. 이 연결은 전체 Dot 활동을 감지하지 않아요.")
                    Text("철회는 이후 접근을 차단해요. 이미 전달한 문맥을 소급 삭제하거나 진행 중인 Dot 작업을 취소하지 않아요.")
                    Text("Dot의 컴퓨터 접근은 별도 권한이며 ChatGPT에서 관리해요.")
                }
                .font(ConnectTheme.font(13))
                .foregroundStyle(ConnectTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(30)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 610, minHeight: 640)
        .foregroundStyle(ConnectTheme.foreground)
        .background(ConnectTheme.background)
        .preferredColorScheme(.light)
    }

    private var statusTitle: String {
        switch model.phase {
        case .checking: "저장된 연결을 확인하고 있어요"
        case .ready: "아직 연결하지 않았어요"
        case .starting: "승인을 요청하고 있어요"
        case .waiting: "AgentDeck에서 승인해 주세요"
        case .authorized: "연결 승인을 받았어요"
        case .stored: "저장된 연결이 있어요"
        case .disconnecting: "연결을 철회하고 있어요"
        case .disconnected: "연결 철회를 완료했어요"
        case .failed(let issue, let revocation): revocation ? "연결 철회를 완료하지 못했어요" : issue.title
        }
    }

    private var statusDetail: String {
        switch model.phase {
        case .checking: "이 Mac의 키체인에 저장된 정보만 확인해요. 새 권한을 만들지 않아요."
        case .ready: "연결 시작을 누른 뒤 AgentDeck에 표시되는 코드와 권한을 확인해 주세요. 승인 전에는 연결 정보를 저장하지 않아요."
        case .starting: "이 Mac의 AgentDeck에만 연결을 요청해요. 승인 화면이 열릴 때까지 잠시 기다려 주세요."
        case .waiting: "코드가 일치하는지 확인하고 AgentDeck에서 직접 승인해 주세요. 중단하려면 AgentDeck에서 거절해 주세요. 승인 요청은 자동으로 만료돼요."
        case .authorized: "AgentDeck의 승인을 받고 키체인에 연결 정보를 저장했어요. 실제 Dot의 도구 인식과 요청 왕복은 별도 확인이 필요해요."
        case .stored: "저장된 정보가 있다는 뜻이에요. 현재 호스트 접근이나 실제 Dot의 도구 인식을 확인한 상태는 아니에요. 연결을 바꾸려면 먼저 철회해 주세요."
        case .disconnecting: "이 연결의 권한을 철회하고, 이 Mac에 저장된 연결 정보를 정리해요."
        case .disconnected: "이 연결의 철회와 키체인 정리를 완료했어요. 다시 사용하려면 새로 동의해 주세요."
        case .failed(let issue, let revocation):
            (revocation ? "철회와 로컬 정리가 완료되었는지 확인하지 못했어요. " : "") + issue.detail
        }
    }

    private var statusColor: Color {
        switch model.phase {
        case .waiting: ConnectTheme.awaiting
        case .authorized: ConnectTheme.healthy
        case .failed: ConnectTheme.error
        default: ConnectTheme.quiet
        }
    }
}
