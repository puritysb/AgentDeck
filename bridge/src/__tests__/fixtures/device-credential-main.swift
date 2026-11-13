import Foundation
struct DaemonLogger: Sendable { static let shared = DaemonLogger(); func error(_ message: String) {} }

@main
struct DeviceCredentialFixture {
    static func main() async throws { try await run() }
    @DaemonActor static func run() async throws {
        if CommandLine.arguments.count > 2 {
            let store = DeviceCredentialStore(directory: URL(fileURLWithPath: CommandLine.arguments[2]))
            switch CommandLine.arguments[1] {
            case "security-install":
                let owner = DeviceSecurityStore(directory: URL(fileURLWithPath: CommandLine.arguments[2]))
                try owner.install(DeviceSecurityRules.configuration(FileHandle.standardInput.readDataToEndOfFile()))
                print("ok")
            case "security-adopt":
                let owner = DeviceSecurityStore(directory: URL(fileURLWithPath: CommandLine.arguments[2]))
                try owner.adopt(FileHandle.standardInput.readDataToEndOfFile(), nonce: CommandLine.arguments[3])
                print("ok")
            case "security-seal":
                let owner = DeviceSecurityStore(directory: URL(fileURLWithPath: CommandLine.arguments[2]))
                FileHandle.standardOutput.write(try JSONEncoder().encode(owner.seal(nonce: CommandLine.arguments[3])))

            case "serve":
                let identity = try DeviceTLSIdentity.load(pfx: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3])), password: "test-only",
                    caDER: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[4])), hostname: CommandLine.arguments.contains("lan") ? "agentdeck-test.local" : "localhost")
                let server = DeviceTLSServer()
                try server.start(identity: identity, port: UInt16(CommandLine.arguments[5])!, loopbackOnly: !CommandLine.arguments.contains("lan"), credentials: store,
                    snapshot: { (sessions: [["id":"native-session","state":"idle","alive":true,"token":"must-not-leak"]], usage: ["usageStale":false]) })
                for _ in 0..<100 {
                    if server.isReady { break }; try await Task.sleep(for: .milliseconds(50))
                }
                guard server.isReady else { throw DeviceTLSFailure.message("test listener did not start") }
                FileHandle.standardOutput.write(Data("READY\n".utf8))
                try await Task.sleep(for: .seconds(CommandLine.arguments.contains("lan") ? 1200 : 60))
                server.stop()

            case "issue":
                let issued = try store.issue(name: "Native dock", scopes: ["sessions.read"])
                FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["token": issued.token, "id": issued.device.id]))
            case "authenticate":
                let token = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)!
                print(try store.authenticate(token) != nil ? "true" : "false")
            case "revoke": _ = try store.revoke(CommandLine.arguments[3])
            default: fatalError("Unknown test operation")
            }
            return
        }
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let rows = try JSONSerialization.jsonObject(with: input) as! [[String: Any]]
        let results: [Any] = rows.map { row in
            do {
                switch row["operation"] as? String {
                case "snapshot":
                    return DeviceSnapshotRules.build(scopes: row["scopes"] as! [String], sessions: row["sessions"]!, usage: row["usage"]!)
                case "parse":
                    let state = try DeviceCredentialRules.decode(JSONSerialization.data(withJSONObject: row["value"]!))
                    return try JSONSerialization.jsonObject(with: JSONEncoder().encode(state))
                case "merge":
                    let local = try DeviceCredentialRules.decode(JSONSerialization.data(withJSONObject: row["local"]!))
                    let peer = try DeviceCredentialRules.decode(JSONSerialization.data(withJSONObject: row["peer"]!))
                    return try JSONSerialization.jsonObject(with: JSONEncoder().encode(DeviceCredentialRules.merge(local, peer)))
                case "message": return DeviceCredentialRules.messageAllowed(row["value"] as! [String: Any])
                default: return NSNull()
                }
            } catch { return NSNull() }
        }
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys]))
    }
}
