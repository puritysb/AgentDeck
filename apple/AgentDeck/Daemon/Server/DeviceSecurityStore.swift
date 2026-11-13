#if os(macOS)
import Foundation
import Darwin

@DaemonActor
final class DeviceSecurityStore {
    private let directory: URL
    let credentials: DeviceCredentialStore
    init(directory: URL = AgentDeckPaths.baseDirectory) {
        self.directory = directory; credentials = DeviceCredentialStore(directory: directory)
    }
    func read() throws -> DeviceSecurityRules.Configuration? {
        let fd = open(AgentDeckPaths.deviceSecurity(in: directory).path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { if errno == ENOENT { return nil }; throw DeviceSecurityRules.Failure.unavailable }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= DeviceSecurityRules.maxBytes else { throw DeviceSecurityRules.Failure.unavailable }
        var bytes = [UInt8](repeating: 0, count: DeviceSecurityRules.maxBytes + 1), count = 0
        while count < bytes.count {
            let remaining = bytes.count - count
            let n = bytes.withUnsafeMutableBytes { raw in Darwin.read(fd, raw.baseAddress!.advanced(by: count), remaining) }
            if n == 0 { break }; if n < 0 { if errno == EINTR { continue }; throw DeviceSecurityRules.Failure.unavailable }; count += n
        }
        return try DeviceSecurityRules.configuration(Data(bytes.prefix(count)))
    }
    private func write(_ value: DeviceSecurityRules.Configuration) throws {
        let bytes = try JSONEncoder().encode(value)
        _ = try DeviceSecurityRules.configuration(bytes)
        let temp = directory.appendingPathComponent(".device-security-" + UUID().uuidString)
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw DeviceSecurityRules.Failure.unavailable }
        defer { close(fd); unlink(temp.path) }
        var count = 0
        while count < bytes.count {
            let n = bytes.withUnsafeBytes { raw in Darwin.write(fd, raw.baseAddress!.advanced(by: count), bytes.count - count) }
            if n < 0 && errno == EINTR { continue }; guard n > 0 else { throw DeviceSecurityRules.Failure.unavailable }; count += n
        }
        guard fsync(fd) == 0, rename(temp.path, AgentDeckPaths.deviceSecurity(in: directory).path) == 0 else { throw DeviceSecurityRules.Failure.unavailable }
    }
    func install(_ value: DeviceSecurityRules.Configuration) throws {
        guard value.role == .owner else { throw DeviceSecurityRules.Failure.invalidConfiguration }
        try credentials.withLock {
            guard try read() == nil else { throw DeviceSecurityRules.Failure.alreadyConfigured }
            try write(value)
        }
    }
    /// Caller stops the TLS listener before sealing and does not restart it.
    func seal(nonce: String) throws -> DeviceSecurityRules.Transfer? {
        guard DeviceCredentialRules.hex(nonce, count: 32) else { throw DeviceSecurityRules.Failure.invalidTransfer }
        return try credentials.withLock {
            guard let configuration = try read() else { return nil }
            guard configuration.role == .owner else { throw DeviceSecurityRules.Failure.notOwner }
            let state = try credentials.snapshot()
            var replica = configuration; replica.role = .replica; try write(replica)
            return .init(nonce: nonce, configuration: configuration, credentials: state)
        }
    }
    /// Only called with a fresh response from the admitted current local owner.
    func adopt(_ data: Data, nonce: String) throws {
        let transfer = try DeviceSecurityRules.transfer(data, nonce: nonce)
        let current = try credentials.snapshot()
        if let current, let incoming = transfer.credentials { _ = try DeviceCredentialRules.merge(current, incoming) }
        else if let current, !current.devices.isEmpty, transfer.credentials == nil { throw DeviceSecurityRules.Failure.missingCustody }
        var replica = transfer.configuration; replica.role = .replica
        try credentials.withLock { try write(replica) }
        if let incoming = transfer.credentials { try credentials.adopt(incoming) }
        try credentials.withLock {
            guard try read() == replica else { throw DeviceSecurityRules.Failure.changedCustody }
            try write(transfer.configuration)
        }
    }
}
#endif
