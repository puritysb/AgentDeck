#if os(macOS)
import Foundation
import CryptoKit

struct DaemonReceipt: Codable, Sendable {
    var key: String
    var status: String
}

struct DaemonCheckpointPayload: Codable, Sendable {
    var version: Int
    var lineage: String
    var generation: Int
    var writer: String
    var sequence: Int
    var sealed: Bool
    var pocket: PocketAutonomy.State
    var receipts: [DaemonReceipt]
    var configuration: DaemonConfiguration? = nil
    var id: String { "\(writer):\(sequence)" }
}

/// No credentials, source grants, card text or queued commands belong here.
/// An active owner's profile is continued, not added to an unrelated total.
@DaemonActor
final class DaemonCheckpointStore {
    enum Failure: Error { case counterExhausted, invalid }
    private typealias P = DaemonParityRules
    private let directory: URL
    private let pocket: PocketAutonomy
    private let configuration: DaemonConfigurationStore?
    private let recovery: DaemonRecoverySession?
    private var current: DaemonCheckpointPayload
    private var content = Data()
    private static var latestAdmission: [String: Int] = [:]
    let restoredReceipts: [DaemonReceipt]

    static func receiptKey(_ decision: [String: Any]) -> String? {
        let values: [Any] = P.receiptFields.map { decision[$0] ?? NSNull() }
        guard JSONSerialization.isValidJSONObject(values),
              let bytes = try? JSONSerialization.data(withJSONObject: values, options: [.withoutEscapingSlashes]) else { return nil }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    static func parse(_ text: String) -> DaemonCheckpointPayload? {
        guard let data = text.data(using: .utf8), data.count <= P.checkpointMaxBytes,
              var value = try? JSONDecoder().decode(DaemonCheckpointPayload.self, from: data),
              value.version == P.checkpointVersion,
              let lineage = UUID(uuidString: value.lineage), let writer = UUID(uuidString: value.writer),
              value.generation >= 0, value.sequence >= 0,
              value.generation <= P.checkpointMaxCounter, value.sequence <= P.checkpointMaxCounter,
              value.receipts.count <= P.receiptLimit,
              value.receipts.allSatisfy({ $0.key.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil && P.receiptStatuses.contains($0.status) }),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawPocket = raw["pocket"] as? [String: Any],
              let state = PocketAutonomy.validatedState(rawPocket) else { return nil }
        if raw["configuration"] != nil {
            guard let configuration = try? DaemonConfigurationRules.parse(raw["configuration"]) else { return nil }
            value.configuration = configuration
        }
        value.lineage = lineage.uuidString.lowercased(); value.writer = writer.uuidString.lowercased()
        value.pocket = state
        return value
    }

    private static func newer(_ incoming: DaemonCheckpointPayload, than current: DaemonCheckpointPayload) -> Bool {
        if incoming.lineage != current.lineage { return true } // admission already verified the current local endpoint
        if incoming.generation != current.generation { return incoming.generation > current.generation }
        return incoming.writer != current.writer || incoming.sequence > current.sequence
    }
    private static func read(_ file: URL) throws -> DaemonCheckpointPayload? {
        let text: String
        do { text = try String(contentsOf: file, encoding: .utf8) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
        guard let value = parse(text) else { throw Failure.invalid }
        return value
    }
    static func encoded(_ value: DaemonCheckpointPayload) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        guard data.count <= P.checkpointMaxBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        return data
    }
    private static func write(_ value: DaemonCheckpointPayload, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoded(value).write(to: file, options: .atomic)
    }

    /// Called only for an admitted local-daemon frame, never a remote relay.
    static func stagePeer(_ text: String, directory: URL, admission: Int? = nil,
                          isCurrent: (@Sendable () -> Bool)? = nil) throws -> String? {
        guard isCurrent?() != false else { return nil }
        if let admission {
            guard admission >= (latestAdmission[directory.path] ?? 0) else { return nil }
            latestAdmission[directory.path] = admission
        }
        guard let incoming = parse(text) else { return nil }
        if let own = try read(directory.appendingPathComponent("daemon-checkpoint.json")),
           own.lineage == incoming.lineage, !newer(incoming, than: own) { return nil }
        let file = directory.appendingPathComponent("daemon-checkpoint-peer.json")
        if let prior = try read(file), !newer(incoming, than: prior) {
            let identical = try encoded(prior) == encoded(incoming)
            return prior.id == incoming.id && identical ? incoming.id : nil
        }
        guard isCurrent?() != false else { return nil }
        try write(incoming, to: file); return incoming.id
    }

    init(directory: URL, pocket: PocketAutonomy, configuration: DaemonConfigurationStore? = nil, recovery: DaemonRecoverySession? = nil) throws {
        self.directory = directory; self.pocket = pocket; self.configuration = configuration; self.recovery = recovery
        let recovered = try recovery?.prepare(configuration: configuration?.snapshot()) ?? false
        let own = try Self.read(directory.appendingPathComponent("daemon-checkpoint.json"))
        let peerFile = directory.appendingPathComponent("daemon-checkpoint-peer.json")
        let peer = try Self.read(peerFile)
        let adoptingPeer = peer.map { incoming in recovered || (own.map { Self.newer(incoming, than: $0) } ?? true) } ?? false
        let source = adoptingPeer ? peer : own
        guard (source?.generation ?? 0) < P.checkpointMaxCounter else { throw Failure.counterExhausted }
        if let source, source.lineage != own?.lineage || (source.generation == own?.generation && source.writer != own?.writer) {
            let previous = own ?? DaemonCheckpointPayload(version: P.checkpointVersion,
                lineage: UUID().uuidString.lowercased(), generation: 0, writer: UUID().uuidString.lowercased(),
                sequence: 0, sealed: false, pocket: pocket.state, receipts: [])
            let archive = "\(previous.lineage)-\(UUID().uuidString.lowercased())"
            try Self.write(previous, to: directory.appendingPathComponent("daemon-checkpoint-profile-\(archive).json"))
            let legacy = directory.appendingPathComponent("pocket-autonomy.json")
            if FileManager.default.fileExists(atPath: legacy.path) {
                try FileManager.default.moveItem(at: legacy, to: directory.appendingPathComponent("pocket-autonomy-profile-\(archive).json"))
            }
        }
        if adoptingPeer, let value = source?.configuration { try configuration?.adopt(value) }
        if let source { pocket.adopt(source.pocket) }
        restoredReceipts = source?.receipts ?? []
        current = DaemonCheckpointPayload(version: P.checkpointVersion,
            // A restart with no admitted current peer creates a new authority
            // branch while retaining local aggregates and receipts.
            lineage: own != nil && !adoptingPeer ? UUID().uuidString.lowercased() : source?.lineage ?? UUID().uuidString.lowercased(), generation: (source?.generation ?? 0) + 1,
            writer: UUID().uuidString.lowercased(), sequence: 0, sealed: false, pocket: pocket.state, receipts: restoredReceipts)
        _ = try capture(receipts: restoredReceipts)
        try? FileManager.default.removeItem(at: peerFile)
    }

    func capture(receipts: [DaemonReceipt], sealed: Bool = false) throws -> String {
        var next = current; next.pocket = pocket.state; next.receipts = receipts
        next.configuration = try configuration?.snapshot()
        next.sealed = sealed
        next.sequence = 0
        let signature = try Self.encoded(next)
        if signature != content {
            guard current.sequence < P.checkpointMaxCounter else { throw Failure.counterExhausted }
            next.sequence = current.sequence + 1
            try Self.write(next, to: directory.appendingPathComponent("daemon-checkpoint.json"))
            current = next; content = signature
        }
        let payload = String(decoding: try Self.encoded(current), as: UTF8.self)
        try recovery?.publish(payload)
        return payload
    }
}
#endif
