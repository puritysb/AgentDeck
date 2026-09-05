import Foundation

@main
struct AttentionModelChecks {
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message)
            checks += 1
        }
        let a = AttentionContextRow(id: "a", projectName: "Same project", state: "processing")
        let b = AttentionContextRow(id: "b", projectName: "Same project", state: "idle")
        var model = AttentionContextSelection()
        model.ingest(.init(rows: [b, a], connected: true, receivedAt: Date()))
        check(model.selected == nil, "Do not auto-select on connect")
        check(model.rows.map(\.id) == ["a", "b"], "Stable initial ordering")
        model.select("b")
        var waiting = a
        waiting.state = "awaiting_permission"
        waiting.question = "A real observed request"
        model.ingest(.init(rows: [b, waiting], connected: true))
        check(model.selectedID == "b", "A wait never steals selection")
        check(model.rows.map(\.id) == ["a", "b"], "Wait never reorders existing sessions")
        check(model.awaiting.count == 1, "Observed wait is visible")
        model.select("a")
        model.ingest(.init(rows: [], connected: false))
        check(model.selected?.question == waiting.question, "Disconnect keeps context")
        check(model.rows.count == 2, "Disconnect keeps last roster")
        check(!model.selectionIsCurrent, "Offline never claims current")
        model.ingest(.init(rows: [b], connected: true))
        check(model.selectedID == "a", "Removal must not select a different target")
        check(!model.selectionIsCurrent, "Missing selected target is last-known")
        check(model.awaiting.isEmpty, "Removed request no longer counted live")
        model.select("b")
        check(model.selectionIsCurrent, "Explicit selection restores current context")
        model.ingest(.init(rows: [a, b, b], connected: true))
        check(model.rows.map(\.id) == ["b", "a"], "Newly seen target appends; duplicate IDs deduplicate")
        check(model.rows.count == 2, "Duplicate titles are distinct sessions")
        model.select("missing")
        check(model.selectedID == "b", "Unknown selection is ignored")
        model.clearSelection()
        check(model.selected == nil, "Clear works")
        let future = AttentionContextRow(id: "future", state: "future_state")
        check(future.stateLabel == "상태 미확인" && !future.needsAttention, "Unknown is not idle or awaiting")
        var ended = waiting
        ended.alive = false
        check(!ended.needsAttention, "Ended session is not a current wait")
        let decoded = try JSONDecoder().decode(AttentionContextRow.self, from: Data(#"{"id":"future","unexpected":1}"#.utf8))
        check(decoded.stateLabel == "상태 미확인" && decoded.liveAnswerable == nil, "Optional capability absence stays unknown")
        print("Attention native model: \(checks) checks passed")
    }
}
