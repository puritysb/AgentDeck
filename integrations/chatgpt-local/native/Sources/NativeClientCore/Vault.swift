import Foundation
import Security
import LocalAuthentication
import Darwin

public struct Credentials: Codable, Equatable {
    var version = 1
    var resource: String
    var clientID: String
    var access: String
    var refresh: String
    var expiresAt: Int
    var refreshing: Bool
    func validate(endpoint: Endpoint) throws {
        guard version == 1, resource == endpoint.resource, clientID == DotLocalMCP.clientId,
              access.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              refresh.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              expiresAt > 0 else { throw ClientFailure.authorizationRequired }
    }
}
public protocol CredentialVault {
    func load() throws -> Credentials?
    func save(_ value: Credentials) throws
    func remove() throws
}

public final class KeychainVault: CredentialVault {
    // Separate from the App Store app's service; no app container/access-group sharing.
    private let service = "bound.serendipity.agentdeck.local-client.preview"
    private let account: String
    public init(account: String, endpoint: Endpoint) throws {
        guard account.range(of: "^[A-Za-z0-9_.-]{1,64}$", options: .regularExpression) != nil else { throw ClientFailure.invalidInput }
        self.account = "\(account):\(endpoint.port)"
    }
    private var query: [String: Any] {
        let context = LAContext(); context.interactionNotAllowed = true
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: account, kSecUseAuthenticationContext as String: context]
    }
    public func load() throws -> Credentials? {
        var query = query; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw ClientFailure.keychain(status) }
        guard let data = result as? Data, data.count <= 8192 else { throw ClientFailure.unsafeStorage }
        return try JSONDecoder().decode(Credentials.self, from: data)
    }
    public func save(_ value: Credentials) throws {
        let data = try JSONEncoder().encode(value)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw ClientFailure.keychain(status) }
        var item = query; item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw ClientFailure.keychain(added) }
    }
    public func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ClientFailure.keychain(status) }
    }
}

/// Advisory lock survives no process: the kernel releases it even after SIGKILL.
/// The file is deliberately retained, so another process cannot lock a replacement inode.
public final class PrivateLock {
    private var descriptor: Int32 = -1
    public init(directory: URL, name: String) throws {
        guard name.range(of: "^[A-Za-z0-9_.-]{1,80}$", options: .regularExpression) != nil else { throw ClientFailure.invalidInput }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw ClientFailure.unsafeStorage }
        let fd = open(directory.appendingPathComponent(name + ".lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ClientFailure.unsafeStorage }
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_nlink == 1 else { close(fd); throw ClientFailure.unsafeStorage }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw ClientFailure.busy }
        descriptor = fd
    }
    deinit { if descriptor >= 0 { close(descriptor) } }
}
