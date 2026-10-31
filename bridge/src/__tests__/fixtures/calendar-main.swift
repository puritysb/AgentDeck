// Test executable only; production parser/provider/consent classes are linked below.
import Foundation
@globalActor actor DaemonActor { static let shared = DaemonActor() }
private final class CalendarMemory: @unchecked Sendable {
    let lock = NSLock(); var data: Data?; var consent = false
    var storage: CalendarSecretStorage { .init(load: { self.lock.withLock { self.data } }, save: { d in self.lock.withLock { self.data = d } }, remove: { self.lock.withLock { self.data = nil } }, consent: { self.lock.withLock { self.consent } }, setConsent: { v in self.lock.withLock { self.consent = v } }) }
}
private actor ReplyMode {
    var fail = false
    var requests = 0
    let body: String
    init(_ body: String) { self.body = body }
    func configure(_ value: Bool) { fail = value }
    func request() throws -> CalendarReply {
        requests += 1
        if fail { throw CalendarICS.Failure.invalid }
        return .init(status: 200, body: Data(body.utf8))
    }
}
@main struct Main {
    static func main() async throws { try await run() }
    @DaemonActor static func run() async throws {
        let input = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
        var results: [Any] = []
        if CommandLine.arguments.contains("--live-store") || CommandLine.arguments.contains("--live-restore") || CommandLine.arguments.contains("--live-cleanup") || CommandLine.arguments.contains("--live-faults") {
            let options = input[0], service = options["service"] as! String
            let storage = CalendarSecretStorage.keychain(service: service)
            let connection = CalendarConnection(storage: storage), provider = CalendarProvider(connection: connection)
            var keep = false
            defer {
                provider.stop()
                if !keep { storage.setConsent(false); try? storage.remove(); UserDefaults.standard.removeObject(forKey: service + ".consent"); UserDefaults.standard.synchronize() }
            }
            if CommandLine.arguments.contains("--live-cleanup") {
                try await connection.disconnect(); results = [["removed":try storage.load() == nil]]
            } else if CommandLine.arguments.contains("--live-faults") {
                var rows: [[String: Any]] = []
                for c in options["cases"] as! [[String: String]] {
                    try await connection.connect(urls:[c["url"]!],consent:true)
                    let start = ContinuousClock.now
                    let snapshot = await provider.snapshot()
                    let elapsed = start.duration(to: .now).components
                    guard snapshot.status == "unknown", snapshot.events == nil else { throw CalendarICS.Failure.invalid }
                    rows.append(["kind":c["kind"]!,"status":snapshot.status,"elapsedMs":Double(elapsed.seconds)*1000 + Double(elapsed.attoseconds)/1e15])
                }
                try await connection.disconnect(); results = rows
            } else if CommandLine.arguments.contains("--live-store") {
                let url = options["url"] as! String
                let before = await provider.snapshot()
                guard before.status == "disabled" else { throw CalendarICS.Failure.invalid }
                try await connection.connect(urls:[url],consent:true)
                let first = await provider.snapshot(), second = await provider.snapshot()
                guard first.status == "fresh", second.status == "fresh", first.events == second.events else { throw CalendarICS.Failure.invalid }
                let leaked = UserDefaults.standard.dictionaryRepresentation().values.contains { ($0 as? String)?.contains(url) == true }
                guard !leaked else { throw CalendarICS.Failure.invalid }
                UserDefaults.standard.synchronize(); keep = true
                results = [["before":before.status,"status":first.status,"cacheStatus":second.status,"events":first.events!.map(\.wire),"plaintextDefaults":leaked]]
            } else {
                let saved = try await connection.snapshot(); guard saved.1?.urls.count == 1 else { throw CalendarICS.Failure.invalid }
                let first = await provider.snapshot(); guard first.status == "fresh" else { throw CalendarICS.Failure.invalid }
                try await connection.disconnect()
                guard provider.events(first) == nil else { throw CalendarICS.Failure.invalid }
                let off = await provider.snapshot()
                guard off.status == "disabled", try storage.load() == nil else { throw CalendarICS.Failure.invalid }
                results = [["restored":true,"status":first.status,"events":first.events!.map(\.wire),"afterDisconnect":off.status,"keychainRemoved":true]]
            }
        } else if CommandLine.arguments.contains("--urls") {
            results = input.map { CalendarConfiguration.validURL($0["value"] as! String) }
        } else if CommandLine.arguments.contains("--cache") {
            for v in input {
                let memory = CalendarMemory(), connection = CalendarConnection(storage: memory.storage), mode = ReplyMode(v["body"] as! String)
                let provider = CalendarProvider(connection: connection, transport: .init(request: { _ in try await mode.request() }))
                var previous = "", rows: [[String: Any]] = []
                let base = (v["nowMs"] as! NSNumber).doubleValue
                for step in v["steps"] as! [[String: Any]] {
                    let source = step["source"] as? String ?? "a"
                    if step["disabled"] as? Bool == true { try await connection.disconnect() }
                    else if source != previous { try await connection.connect(urls: ["https://calendar.invalid/" + source], consent: true); previous = source }
                    await mode.configure(step["fail"] as? Bool == true)
                    let snapshot = await provider.snapshot(nowMs: base + (step["delta"] as! NSNumber).doubleValue, zone: "UTC")
                    var row: [String: Any] = ["status": snapshot.status, "requests": await mode.requests]
                    if let events = snapshot.events { row["events"] = events.map(\.wire) }
                    if let at = snapshot.fetchedAt { row["fetchedAt"] = at }
                    rows.append(row)
                }
                provider.stop(); results.append(rows)
            }
        } else {
            results = input.map { v in
                do {
                    return try CalendarICS.build(CalendarICS.parse(v["ics"] as! String), nowMs: (v["nowMs"] as! NSNumber).doubleValue, zone: v["zone"] as! String).map(\.wire)
                } catch { return ["error": true] }
            }
        }
        print(String(data: try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
