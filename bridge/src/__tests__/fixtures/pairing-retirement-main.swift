// Disposable executable; every store operation requires an explicit temp directory.
import Foundation
import SQLite3
struct DaemonLogger { static let shared = DaemonLogger(); func error(_ message: String) {}; func debug(_ category: String, _ message: String) {} }
@main struct Main {
    static func main() async throws {
        if CommandLine.arguments[1] == "--vectors" {
            let rows = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
            let results: [[String: Any]] = rows.map { row in
                do {
                    let local = try PairingCredentialRules.decode(JSONSerialization.data(withJSONObject: row["local"]!))
                    let next: PairingCredentialRules.State?
                    if row["operation"] as? String == "rotate" {
                        guard let floor = PairingCredentialRules.revision(row["minimumRevision"]) else { throw PairingCredentialRules.Failure.invalidState }
                        next = try PairingCredentialRules.rotate(local, token: row["token"] as! String, eventId: row["eventId"] as! String, minimumRevision: floor)
                    } else { next = try PairingCredentialRules.adopt(local, token: row["token"] as! String, metadata: row["metadata"]) }
                    return ["kind": next == nil ? "unchanged" : "adopted", "state": try JSONSerialization.jsonObject(with: JSONEncoder().encode(next ?? local))]
                } catch { return ["kind": "refused"] }
            }
            print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
            return
        }
        let directory = URL(fileURLWithPath: CommandLine.arguments[2])
        let manager = AuthManager(directory: directory)
        if CommandLine.arguments[1] == "--adopt" {
            let payload = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
            _ = try await manager.adoptPeerToken(payload["token"] as? String, retirement: payload["metadata"])
            for retired in payload["rejected"] as? [String] ?? [] { precondition(!manager.validateToken(retired)) }
        }
        if CommandLine.arguments[1] == "--unavailable" {
            precondition(!manager.rotationAvailable)
            do { try await manager.adoptPeerToken(nil, retirement: NSNull()); fatalError("unavailable peer was adopted") }
            catch PairingCredentialRules.Failure.invalidState { }
            print("{\"available\":false}")
            return
        }
        if CommandLine.arguments[1] == "--rotate-barrier" {
            let gate = directory.appendingPathComponent("gate-go")
            try Data().write(to: directory.appendingPathComponent("ready-swift"))
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while !FileManager.default.fileExists(atPath: gate.path) {
                guard ContinuousClock.now < deadline else { throw PairingCredentialRules.Failure.unavailable }
                try await Task.sleep(for: .milliseconds(10))
            }
            _ = try await manager.rotate(minimumRevision: 0)
        }
        if CommandLine.arguments[1] == "--rotate" { _ = try await manager.rotate(minimumRevision: 0) }
        if CommandLine.arguments[1] == "--reject-legacy" {
            do { try await manager.adoptPeerToken(String(repeating: "a", count: 32)); throw PairingCredentialRules.Failure.invalidState }
            catch PairingCredentialRules.Failure.retiredPeer { }
            let stale = try String(contentsOf: AgentDeckPaths.authTokenAccepted(in: directory), encoding: .utf8).split(separator: "\n")
            precondition(!manager.validateToken(String(repeating: "a", count: 32)))
            for token in stale { precondition(!manager.validateToken(String(token))) }
        }
        precondition(manager.validateToken(manager.token))
        print(String(data: try JSONEncoder().encode(manager.credentials), encoding: .utf8)!)
    }
}
