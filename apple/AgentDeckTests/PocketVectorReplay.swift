#if os(macOS)
import Foundation
#if !POCKET_STANDALONE
@testable import AgentDeck
#endif

/// Shared test driver: XCTest and the direct Node/Swift parity executable use
/// this same sequence, including actual atomic state-file reloads.
enum PocketVectorReplay {
    @DaemonActor
    static func run(_ testcase: [String: Any], root: URL) throws -> [[String: Any]] {
        let path = root.appendingPathComponent("pocket-autonomy.json")
        if let initial = testcase["initialState"] as? [String: Any] {
            try JSONSerialization.data(withJSONObject: initial).write(to: path)
        }
        var config = testcase["config"] as? [String: Any] ?? [:]
        let zone = TimeZone(identifier: testcase["timeZone"] as? String ?? "UTC")!
        var engine = PocketAutonomy(stateURL: path, config: config, timeZone: zone)
        var cards: [[String: Any]] = []
        var output: [[String: Any]] = []
        for step in testcase["steps"] as? [[String: Any]] ?? [] {
            let now = (step["now"] as! NSNumber).doubleValue
            var result: Any?
            switch step["op"] as? String {
            case "build":
                cards = engine.cards(sessions: step["sessions"] as? [[String: Any]] ?? testcase["sessions"] as? [[String: Any]] ?? [],
                                     glance: step["glance"] as? [String: Any] ?? testcase["glance"] as? [String: Any] ?? [:], now: now)
                result = cards
                if step["delivered"] as? Bool == true { engine.observeDelivery(cards, now: now, board: "xteink_x3") }
            case "observe": engine.observeDelivery([], now: now, board: "xteink_x3")
            case "answer":
                let kind = step["kind"] as? String ?? ""
                let id = step["cardId"] as? String ?? cards.first { ($0["cardId"] as? String)?.contains(":auto:\(kind):") == true }?["cardId"] as? String
                guard let id else { throw NSError(domain: "PocketFixtureMissingCard", code: 1) }
                result = engine.apply(["cardId": id, "choiceId": step["choiceId"] as Any], now: now)
            case "configure": config = step["config"] as? [String: Any] ?? [:]; engine.configure(config)
            case "reload": engine.flush(); engine = PocketAutonomy(stateURL: path, config: config, timeZone: zone)
            default: break
            }
            engine.flush()
            var row: [String: Any] = ["diagnostics": engine.diagnostics(), "state": engine.snapshot()]
            if let result { row["result"] = result }
            output.append(row)
        }
        return output
    }
}
#endif
