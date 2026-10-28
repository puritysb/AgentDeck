import AppKit
import Foundation
import Security
import SwiftUI

// Developer fixture only. Production host, OAuth, transport, storage and paths
// are compiled unchanged from sources.txt. No product app lifecycle is imported.
enum HarnessIdentity {
    static let bundle = "dev.agentdeck.dot-native-local-host"
    static let team = "QF36NDHYHD"
    static let group = team + "." + bundle
    static let port: UInt16 = 19476
    static let origin = "http://127.0.0.1:\(port)"
}

enum HarnessIsolation {
    static func verify() throws -> [String: String] {
        func require(_ condition: Bool, _ reason: String) throws {
            if !condition { throw DotFailure.message("격리 검사 실패: " + reason) }
        }
        let environment = ProcessInfo.processInfo.environment
        try require(Bundle.main.bundleIdentifier == HarnessIdentity.bundle, "bundle ID")
        try require(environment["APP_SANDBOX_CONTAINER_ID"] == HarnessIdentity.bundle, "실제 sandbox container")
        for key in ["AGENTDECK_DATA_DIR", "XCTestConfigurationFilePath", "XCTestBundlePath"] {
            try require(environment[key] == nil, "허용하지 않는 환경 변수 " + key)
        }
        var code: SecCode?
        try require(SecCodeCopySelf([], &code) == errSecSuccess && code != nil, "실행 중인 코드 정체성")
        try require(SecCodeCheckValidity(code!, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess, "코드 서명 유효성")
        var staticCode: SecStaticCode?
        try require(SecCodeCopyStaticCode(code!, [], &staticCode) == errSecSuccess && staticCode != nil, "실행 코드의 서명 객체")
        var information: CFDictionary?
        try require(SecCodeCopySigningInformation(staticCode!, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess, "서명 정보")
        guard let info = information as? [String: Any],
              let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] else {
            throw DotFailure.message("격리 검사 실패: 실행 서명 entitlement를 읽을 수 없습니다.")
        }
        try require(info[kSecCodeInfoTeamIdentifier as String] as? String == HarnessIdentity.team, "서명 team")
        let permitted: Set<String> = ["com.apple.security.app-sandbox", "com.apple.security.network.client", "com.apple.security.network.server",
            "com.apple.application-identifier", "com.apple.developer.team-identifier", "keychain-access-groups"]
        try require(Set(entitlements.keys) == permitted, "예상하지 않은 entitlement")
        for key in ["com.apple.security.app-sandbox", "com.apple.security.network.client", "com.apple.security.network.server"] {
            try require(entitlements[key] as? Bool == true, key)
        }
        try require(entitlements["com.apple.application-identifier"] as? String == HarnessIdentity.group, "application identifier")
        try require(entitlements["com.apple.developer.team-identifier"] as? String == HarnessIdentity.team, "entitlement team")
        try require(entitlements["keychain-access-groups"] as? [String] == [HarnessIdentity.group], "전용 Keychain access group")
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        try require(support.path.contains("/Library/Containers/" + HarnessIdentity.bundle + "/Data/"), "전용 Application Support")
        // Exercise only this fixture's group before DotVault can read or replace
        // configuration. An inaccessible or rejected group is a hard failure.
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: HarnessIdentity.bundle + ".isolation", kSecAttrAccount as String: UUID().uuidString,
            kSecAttrAccessGroup as String: HarnessIdentity.group, kSecUseDataProtectionKeychain as String: true]
        var insertion = query
        insertion[kSecValueData as String] = Data(UUID().uuidString.utf8)
        insertion[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        insertion[kSecReturnAttributes as String] = true
        var result: CFTypeRef?
        let status = SecItemAdd(insertion as CFDictionary, &result)
        try require(status == errSecSuccess, "전용 Keychain 쓰기 (\(status))")
        defer { SecItemDelete(query as CFDictionary) }
        let attributes = result as? [String: Any]
        try require(attributes?[kSecAttrAccessGroup as String] as? String == HarnessIdentity.group, "실제 Keychain 저장 그룹")
        return ["bundleId": HarnessIdentity.bundle, "teamId": HarnessIdentity.team, "keychainAccessGroup": HarnessIdentity.group,
            "sandboxContainer": environment["APP_SANDBOX_CONTAINER_ID"]!, "applicationSupport": support.path,
            "origin": HarnessIdentity.origin, "pid": String(ProcessInfo.processInfo.processIdentifier)]
    }
}

@DaemonActor
final class HarnessHost {
    static let shared = HarnessHost()
    private let host = DotHost()
    private let owner = UUID()
    private var isolation: [String: String]?
    private var previousReceipt: Data?
    private var audit: [[String: String]] = []
    private var observedReports: [String: String] = [:]
    private var directory: URL { AgentDeckPaths.baseDirectory.appendingPathComponent("native-host-validation", isDirectory: true) }

    func start() async throws -> DotHostSnapshot {
        guard isolation == nil else { throw DotFailure.message("이 실행에서는 이미 시작했습니다. 중지 후에는 앱을 다시 실행하세요.") }
        let verified = try HarnessIsolation.verify()
        isolation = verified
        host.owned(by: owner)
        do {
            try host.load()
            if host.snapshot().origin.isEmpty { try host.configureLocal(port: HarnessIdentity.port) }
            guard host.snapshot().origin == HarnessIdentity.origin else { throw DotFailure.message("기존 실험 설정의 origin이 다릅니다. 변경하지 않았습니다.") }
            try host.start()
            for _ in 0..<50 {
                if host.snapshot().hosting { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            guard host.snapshot().hosting else { throw DotFailure.message("전용 포트의 listener가 준비되지 않았습니다.") }
            try record("host_started")
            return host.snapshot()
        } catch {
            host.release(owner)
            try? record("start_failed")
            throw error
        }
    }

    func refresh() throws -> DotHostSnapshot? {
        guard isolation != nil else { return nil }
        let value = host.snapshot()
        try saveReceipt(value)
        return value
    }

    func decide(_ id: String, allow: Bool) throws {
        guard isolation != nil else { throw DotFailure.message("격리 검사를 먼저 실행하세요.") }
        try host.approve(id, allowed: allow)
        try record(allow ? "consent_approved" : "consent_denied")
    }

    func create(grant: String) throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        guard isolation != nil, host.snapshot().grants.contains(where: { $0.id == grant && !$0.revoked && $0.expiresAt > now }) else {
            throw DotFailure.message("유효한 실험 연결이 필요합니다.")
        }
        let numbers = (0..<3).map { _ in Int.random(in: 10...99) }
        let marker = "native-dot-" + UUID().uuidString.lowercased()
        let context = "Synthetic validation only. Marker: \(marker). Numbers: \(numbers.map(String.init).joined(separator: ", ")). Add the three numbers and include the marker and sum in the final request report. No external action is required."
        try host.request(grant: grant, profile: "native-validation", context: context, key: UUID().uuidString)
        try record("synthetic_request_created")
    }

    func revoke(_ id: String) throws {
        guard isolation != nil else { throw DotFailure.message("격리 검사를 먼저 실행하세요.") }
        try host.revoke(id)
        try record("grant_revoked")
    }

    func stop() {
        guard isolation != nil else { return }
        host.release(owner)
        try? record("host_stopped")
    }

    private func record(_ action: String) throws {
        audit.append(["at": ISO8601DateFormatter().string(from: Date()), "action": action])
        if audit.count > 200 { audit.removeFirst(audit.count - 200) }
        try saveReceipt(host.snapshot())
    }

    private func saveReceipt(_ value: DotHostSnapshot) throws {
        guard let isolation else { return }
        for row in value.reports {
            guard let report = row.report else { continue }
            let signature = "\(report.sequence):\(report.state):\(report.receivedAt)"
            if observedReports[row.id] != signature {
                audit.append(["at": ISO8601DateFormatter().string(from: Date()), "action": "request_report_observed",
                              "requestId": row.id, "state": report.state, "sequence": String(report.sequence)])
                observedReports[row.id] = signature
            }
        }
        if audit.count > 200 { audit.removeFirst(audit.count - 200) }
        let reports: [[String: Any]] = value.reports.map { row in
            ["requestId": row.id, "grantId": row.owner, "context": row.context, "expiresAt": row.expiresAt,
             "state": row.report?.state as Any? ?? NSNull(), "sequence": row.report?.sequence as Any? ?? NSNull(),
             "summary": row.report?.summary as Any? ?? NSNull(), "receivedAt": row.report?.receivedAt as Any? ?? NSNull()]
        }
        let object: [String: Any] = ["scope": "private synthetic native host harness; not release acceptance", "isolation": isolation,
            "hosting": value.hosting, "status": value.status, "grants": value.grants.map { ["id": $0.id, "revoked": $0.revoked, "expiresAt": $0.expiresAt] as [String: Any] },
            "requests": reports, "audit": audit]
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        guard bytes != previousReceipt else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("receipt.json")
        try bytes.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        previousReceipt = bytes
    }
}

@MainActor
final class HarnessModel: ObservableObject {
    @Published var snapshot: DotHostSnapshot?
    @Published var message = "아직 시작하지 않았습니다. 격리 검사 후에만 Keychain과 호스트에 접근합니다."
    @Published var busy = false
    @Published var attempted = false
    func run(_ action: @escaping @DaemonActor @Sendable () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do { try await action(); snapshot = try await HarnessHost.shared.refresh(); message = "마지막 동작 완료" }
            catch { message = error.localizedDescription }
        }
    }
    func start() {
        attempted = true
        run { _ = try await HarnessHost.shared.start() }
    }
    func poll() async {
        while !Task.isCancelled {
            do { if let value = try await HarnessHost.shared.refresh() { snapshot = value } }
            catch { message = error.localizedDescription }
            try? await Task.sleep(for: .seconds(1))
        }
    }
}

// Keep the developer control window independent of changing consent/report
// content. A fixed viewport scrolls instead of resizing with each snapshot.
enum HarnessWindowLayout {
    static let width: CGFloat = 780
    static let height: CGFloat = 640
}

struct HarnessView: View {
    @StateObject private var model = HarnessModel()
    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Dot 네이티브 연결 검증").font(.title2.bold())
                Text("개인 실험 · 합성 데이터 전용. 전체 AgentDeck 앱, 장비 연결 또는 정식 릴리즈 검증을 대신하지 않습니다.")
                Text(HarnessIdentity.origin + "/mcp").textSelection(.enabled)
                HStack {
                    Button("격리 확인 후 호스트 시작") { model.start() }.disabled(model.busy || model.attempted)
                    Button("호스트 중지") { model.run { HarnessHost.shared.stop() } }.disabled(model.busy || model.snapshot?.hosting != true)
                }
                Text(model.message).textSelection(.enabled).accessibilityIdentifier("harness-status")
                if let snapshot = model.snapshot {
                    Text("호스트: \(snapshot.status) · 준비: \(snapshot.hosting ? "예" : "아니요")")
                    Divider()
                    Text("승인 대기").font(.headline)
                    if snapshot.consents.isEmpty { Text("대기 중인 연결이 없습니다.").foregroundStyle(.secondary) }
                    ForEach(snapshot.consents) { consent in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(consent.clientName + " · " + consent.clientKind.rawValue)
                            Text("비교 코드: " + consent.verificationCode).font(.headline).textSelection(.enabled)
                            Text(consent.scopes.joined(separator: ", "))
                            Text(consent.redirectURI).textSelection(.enabled)
                            Text("클라이언트에 표시된 코드와 일치할 때만 승인하세요. 등록된 클라이언트 이름은 자체 신고 값입니다.").foregroundStyle(.secondary)
                            HStack {
                                Button("코드 일치 · 승인") { model.run { try HarnessHost.shared.decide(consent.id, allow: true) } }
                                Button("거절") { model.run { try HarnessHost.shared.decide(consent.id, allow: false) } }
                            }.disabled(model.busy)
                        }.padding(.vertical, 6)
                    }
                    Divider()
                    Text("실험 연결").font(.headline)
                    ForEach(snapshot.grants) { grant in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(grant.id).textSelection(.enabled)
                            Text(grant.revoked ? "철회됨" : "승인됨")
                            HStack {
                                Button("합성 요청 만들기") { model.run { try HarnessHost.shared.create(grant: grant.id) } }
                                    .disabled(grant.revoked || !snapshot.hosting)
                                Button("연결 철회") { model.run { try HarnessHost.shared.revoke(grant.id) } }.disabled(grant.revoked)
                            }.disabled(model.busy)
                        }.padding(.vertical, 6)
                    }
                    Divider()
                    Text("요청 결과").font(.headline)
                    ForEach(snapshot.reports) { request in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("요청 ID: " + request.id).textSelection(.enabled)
                            Text("상태: " + (request.report?.state ?? "보고 대기") + " · sequence: \(request.report?.sequence ?? 0)")
                            if let report = request.report { Text(report.summary).textSelection(.enabled) }
                        }.padding(.vertical, 6)
                    }
                    Text("토큰 없는 기록: 전용 앱 컨테이너 / Library / Application Support / AgentDeck / native-host-validation / receipt.json")
                        .foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
        .frame(width: HarnessWindowLayout.width, height: HarnessWindowLayout.height)
        .task { await model.poll() }
    }
}

@MainActor
final class HarnessDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task {
            await HarnessHost.shared.stop()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@main
struct NativeLocalHostApp: App {
    @NSApplicationDelegateAdaptor(HarnessDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup { HarnessView() }
            .defaultSize(width: HarnessWindowLayout.width, height: HarnessWindowLayout.height)
            .windowResizability(.contentSize)
    }
}
