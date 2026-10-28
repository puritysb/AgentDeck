import Foundation
import CoreFoundation
import NativeClientCore

/// Package-selected identity only. There is no editable host, account, port or API key.
struct ConnectConfiguration: Sendable {
    let account: String
    let endpoint: Endpoint

    init(bundle: Bundle = .main) throws {
        if let raw = bundle.object(forInfoDictionaryKey: "AgentDeckConnectionAccount") {
            guard let value = raw as? String,
                  value.range(of: "^[A-Za-z0-9_.-]{1,64}$", options: .regularExpression) != nil else {
                throw ClientFailure.invalidInput
            }
            account = value
        } else {
            account = "plugin-native-preview"
        }
        if let raw = bundle.object(forInfoDictionaryKey: "AgentDeckConnectionPort") {
            guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                  value.doubleValue.rounded(.towardZero) == value.doubleValue else {
                throw ClientFailure.invalidInput
            }
            endpoint = try Endpoint(port: value.intValue)
        } else {
            endpoint = try Endpoint()
        }
    }
}

struct PendingConsent: Sendable {
    let verificationCode: String
    let scopes: [String]
}

enum CredentialPresence: Sendable, Equatable {
    case absent, stored, unknown
}

enum ConnectIssue: Sendable {
    case configuration, denied, existing, needsConsent, needsReconnect, hostUnavailable
    case keychain, storage, busy, timedOut, invalidResponse, unexpected

    init(_ error: Error) {
        guard let failure = error as? ClientFailure else { self = .unexpected; return }
        self = switch failure {
        case .authorizationDenied: .denied
        case .connectionExists: .existing
        case .authorizationRequired: .needsConsent
        case .reconnectRequired: .needsReconnect
        case .unavailable: .hostUnavailable
        case .keychain: .keychain
        case .unsafeStorage: .storage
        case .busy: .busy
        case .deadline: .timedOut
        case .invalidResponse, .oversized: .invalidResponse
        case .invalidInput: .configuration
        }
    }

    var title: String {
        switch self {
        case .configuration: "연결 설정을 사용할 수 없어요"
        case .denied: "AgentDeck에서 연결을 거절했어요"
        case .existing: "저장된 연결이 이미 있어요"
        case .needsConsent: "승인을 완료하지 못했어요"
        case .needsReconnect: "연결에 다시 동의해야 해요"
        case .hostUnavailable: "이 Mac의 AgentDeck에 연결할 수 없어요"
        case .keychain: "키체인에 접근할 수 없어요"
        case .storage: "연결 정보를 안전하게 사용할 수 없어요"
        case .busy: "다른 요청이 이 연결을 사용하고 있어요"
        case .timedOut: "응답을 제때 확인하지 못했어요"
        case .invalidResponse: "AgentDeck의 응답을 확인할 수 없어요"
        case .unexpected: "연결 작업을 완료하지 못했어요"
        }
    }

    var detail: String {
        switch self {
        case .configuration: "이 앱의 연결 설정이 올바르지 않아요. 앱 제공자에게 확인해 주세요."
        case .denied: "이 요청의 연결 정보는 저장하지 않았어요. 연결하려면 다시 시작하고 범위를 확인해 주세요."
        case .existing: "새 권한으로 덮어쓰지 않았어요. 연결을 바꾸려면 먼저 연결 철회를 완료해 주세요."
        case .needsConsent: "AgentDeck의 승인 화면과 상태를 확인한 뒤 다시 시도해 주세요."
        case .needsReconnect: "AgentDeck을 사용할 수 있을 때 연결을 철회하고, 새 연결에 동의해 주세요."
        case .hostUnavailable: "AgentDeck이 실행 중인지 확인한 뒤 다시 시도해 주세요. 기존 연결 정보를 임의로 지우지 않았어요."
        case .keychain: "Mac의 키체인 접근 상태를 확인한 뒤 다시 시도해 주세요. 연결 정보를 파일로 대신 저장하지 않아요."
        case .storage: "이 Mac의 안전한 저장소를 확인해 주세요. 새 연결 정보나 파일을 임의로 만들지 않았어요."
        case .busy: "진행 중인 요청이 끝나면 다시 시도해 주세요. 같은 연결의 작업을 동시에 실행하지 않아요."
        case .timedOut: "작업의 완료 여부를 단정하지 않았어요. AgentDeck에서 상태를 확인한 뒤 다시 시도해 주세요."
        case .invalidResponse: "접근 확인을 완료하지 않았어요. AgentDeck의 상태를 확인한 뒤 다시 시도해 주세요."
        case .unexpected: "연결 정보를 출력하거나 다른 저장소로 옮기지 않았어요. 상태를 확인한 뒤 다시 시도해 주세요."
        }
    }
}

struct WorkerResult: Sendable {
    let presence: CredentialPresence
    let issue: ConnectIssue?
}

/// LocalClient performs bounded synchronous I/O. Keep its full lifetime and all
/// Keychain operations on this worker actor, away from the UI's main executor.
actor ConnectionWorker {
    private let configuration: ConnectConfiguration
    init(configuration: ConnectConfiguration) { self.configuration = configuration }

    private var lockDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AgentDeckLocalClient", isDirectory: true)
    }

    private func makeVault() throws -> KeychainVault {
        try KeychainVault(account: configuration.account, endpoint: configuration.endpoint)
    }

    private func makeClient(vault: KeychainVault) -> LocalClient {
        let directory = lockDirectory
        let name = "\(configuration.account)-\(configuration.endpoint.port)"
        return LocalClient(endpoint: configuration.endpoint, vault: vault,
                           acquireLock: { try PrivateLock(directory: directory, name: name) })
    }

    private func presence() throws -> CredentialPresence {
        let lock = try PrivateLock(directory: lockDirectory,
                                   name: "\(configuration.account)-\(configuration.endpoint.port)")
        defer { withExtendedLifetime(lock) {} }
        return try makeVault().load() == nil ? .absent : .stored
    }

    func inspectStoredConnection() -> WorkerResult {
        do { return WorkerResult(presence: try presence(), issue: nil) }
        catch { return WorkerResult(presence: .unknown, issue: ConnectIssue(error)) }
    }

    func connect(pending: @escaping @Sendable (PendingConsent) -> Void) -> WorkerResult {
        do {
            let vault = try makeVault()
            try makeClient(vault: vault).authorize { fields in
                guard let code = fields["verificationCode"] as? String, !code.isEmpty,
                      let scopes = fields["scopes"] as? [String], !scopes.isEmpty else {
                    throw ClientFailure.invalidResponse
                }
                pending(PendingConsent(verificationCode: code, scopes: scopes))
            }
            return WorkerResult(presence: .stored, issue: nil)
        } catch {
            return WorkerResult(presence: (try? presence()) ?? .unknown, issue: ConnectIssue(error))
        }
    }

    func disconnect() -> WorkerResult {
        do {
            let vault = try makeVault()
            try makeClient(vault: vault).disconnect()
            return WorkerResult(presence: .absent, issue: nil)
        } catch {
            // The core retains credentials when revocation cannot be confirmed.
            return WorkerResult(presence: (try? presence()) ?? .unknown, issue: ConnectIssue(error))
        }
    }
}
