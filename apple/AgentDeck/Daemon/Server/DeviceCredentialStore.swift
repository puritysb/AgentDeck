#if os(macOS)
import Foundation
import CryptoKit
import Security
import SQLite3
import Darwin

/// No cached bearer secrets. Every decision rereads authoritative persisted state.
@DaemonActor
final class DeviceCredentialStore {
    private let directory: URL
    enum Failure: Error { case unavailable, invalidIssuance }
    init(directory: URL = AgentDeckPaths.baseDirectory) { self.directory = directory }

    func snapshot() throws -> DeviceCredentialRules.State? {
        let fd = open(AgentDeckPaths.deviceCredentials(in: directory).path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { if errno == ENOENT { return nil }; throw Failure.unavailable }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size <= DeviceCredentialRules.maxBytes else { throw Failure.unavailable }
        var bytes = [UInt8](repeating: 0, count: DeviceCredentialRules.maxBytes + 1)
        var count = 0
        while count < bytes.count {
            let available = bytes.count - count
            let amount = bytes.withUnsafeMutableBytes { raw in read(fd, raw.baseAddress!.advanced(by: count), available) }
            if amount == 0 { break }
            if amount < 0 { if errno == EINTR { continue }; throw Failure.unavailable }
            count += amount
        }
        guard count <= DeviceCredentialRules.maxBytes else { throw Failure.unavailable }
        return try DeviceCredentialRules.decode(Data(bytes.prefix(count)))
    }
    func withLock<T>(_ body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var handle: OpaquePointer?
        guard sqlite3_open_v2(AgentDeckPaths.authCredentialLock(in: directory).path, &handle,
              SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db = handle else {
            if let handle { sqlite3_close(handle) }; throw Failure.unavailable
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, Int32(PairingCredentialRules.timeoutMs))
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { throw Failure.unavailable }
        defer { sqlite3_exec(db, "ROLLBACK", nil, nil, nil) }
        return try body()
    }
    private func write(_ state: DeviceCredentialRules.State) throws {
        let bytes = try JSONEncoder().encode(state)
        _ = try DeviceCredentialRules.decode(bytes)
        let temp = directory.appendingPathComponent(".device-credential-" + UUID().uuidString)
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Failure.unavailable }
        defer { close(fd); unlink(temp.path) }
        var count = 0
        while count < bytes.count {
            let amount = bytes.withUnsafeBytes { raw in Darwin.write(fd, raw.baseAddress!.advanced(by: count), bytes.count - count) }
            if amount < 0 && errno == EINTR { continue }
            guard amount > 0 else { throw Failure.unavailable }; count += amount
        }
        guard fsync(fd) == 0, rename(temp.path, AgentDeckPaths.deviceCredentials(in: directory).path) == 0 else { throw Failure.unavailable }
    }
    private func random(_ count: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { throw Failure.unavailable }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
    private func digest(_ token: String) -> String { SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined() }
    func issue(name: String, scopes: [String], now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws -> (token: String, device: DeviceCredentialRules.Device) {
        try withLock {
            var state = try snapshot() ?? .init(authority: random(16), revision: 0, devices: [])
            let id = try random(16), token = DeviceCredentialRules.prefix + id + "." + (try random(32))
            let device = DeviceCredentialRules.Device(id: id, name: name, verifier: digest(token), scopes: scopes.sorted(), createdAt: now, revokedAt: nil)
            state.devices.append(device); state.revision += 1
            try write(state)
            return (token, device)
        }
    }
    func authenticate(_ token: String) throws -> DeviceCredentialRules.Device? {
        guard let id = DeviceCredentialRules.id(token), let device = try snapshot()?.devices.first(where: { $0.id == id }), device.revokedAt == nil else { return nil }
        let expected = Array(device.verifier.utf8), actual = Array(digest(token).utf8)
        guard expected.count == actual.count else { return nil }
        var difference: UInt8 = 0
        for i in expected.indices { difference |= expected[i] ^ actual[i] }
        return difference == 0 ? device : nil
    }
    @discardableResult func revoke(_ id: String, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws -> Bool {
        try withLock {
            guard var state = try snapshot(), let index = state.devices.firstIndex(where: { $0.id == id }) else { return false }
            if state.devices[index].revokedAt != nil { return true }
            state.devices[index].revokedAt = max(now, state.devices[index].createdAt); state.revision += 1
            try write(state); return true
        }
    }
    /// Only an admitted current local owner may supply this state.
    func adopt(_ incoming: DeviceCredentialRules.State) throws {
        try withLock {
            let merged = try snapshot().map { try DeviceCredentialRules.merge($0, incoming) } ?? incoming
            try write(merged)
        }
    }
}
#endif
