import Foundation
import Darwin

public enum Framing {
    /// Idle stdio is allowed; a partially received frame must finish within the HTTP budget.
    public static func readFrames(fd: Int32 = STDIN_FILENO, deadline: Date? = nil, consume: (Data) throws -> Void) throws {
        var pending = Data(), began: Date?
        while true {
            if let deadline, Date() >= deadline { throw ClientFailure.deadline }
            if let began, Date().timeIntervalSince(began) >= Contract.timeout { throw ClientFailure.deadline }
            var item = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let result = poll(&item, 1, began == nil && deadline == nil ? -1 : 100)
            if result < 0 { if errno == EINTR { continue }; throw ClientFailure.unavailable }
            if result == 0 { continue }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = read(fd, &bytes, bytes.count)
            if count == 0 { if !pending.isEmpty { throw ClientFailure.invalidInput }; return }
            if count < 0 { if errno == EINTR || errno == EAGAIN { continue }; throw ClientFailure.unavailable }
            if began == nil { began = Date() }
            for byte in bytes.prefix(count) {
                if byte == 10 {
                    if !pending.isEmpty { try consume(pending) }
                    pending.removeAll(keepingCapacity: true); began = nil
                } else {
                    if began == nil { began = Date() }
                    pending.append(byte)
                    if pending.count > Contract.bodyLimit { throw ClientFailure.oversized }
                }
            }
        }
    }
    public static func readSingle(fd: Int32 = STDIN_FILENO, timeout: TimeInterval = Contract.timeout) throws -> Data {
        var result: Data?
        try readFrames(fd: fd, deadline: Date().addingTimeInterval(timeout)) { frame in
            guard result == nil else { throw ClientFailure.invalidInput }
            result = frame
        }
        guard let result else { throw ClientFailure.invalidInput }
        return result
    }
    public static func write(_ value: Any, fd: Int32 = STDOUT_FILENO) throws {
        var data = try Contract.encode(value); data.append(10)
        let previous = fcntl(fd, F_GETFL)
        guard previous >= 0, fcntl(fd, F_SETFL, previous | O_NONBLOCK) == 0 else { throw ClientFailure.unavailable }
        defer { _ = fcntl(fd, F_SETFL, previous) }
        let deadline = Date().addingTimeInterval(Contract.timeout)
        try data.withUnsafeBytes { bytes in
            var sent = 0
            while sent < bytes.count {
                guard Date() < deadline else { throw ClientFailure.deadline }
                var item = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                let ready = poll(&item, 1, 100)
                if ready < 0 { if errno == EINTR { continue }; throw ClientFailure.unavailable }
                if ready == 0 { continue }
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: sent), min(4096, bytes.count - sent))
                if count < 0 { if errno == EINTR || errno == EAGAIN { continue }; throw ClientFailure.unavailable }
                sent += count
            }
        }
    }
}
