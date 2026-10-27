// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/apme-review.ts
// Regenerate: pnpm generate-apme-display-rules (drift gated by shared/src/__tests__/apme-display-rules-sync.test.ts)
import Foundation

enum ApmeReviewRules {
    static let strategy = "first-latest-validation-v1"
    static let turnCap = 10
    static let eventCap = 30
    static let promptCap = 1500
    static let responseCap = 2500
    static let outputCap = 600
    static let clipMarker = " … [middle omitted] … "
    static let noteBytes = 4096
    static let verdicts = ["completed","partial","incorrect","clear"]
    static let validationPattern = "(^|[^a-z0-9_])(test|tests|pytest|vitest|xcodebuild|gradle|build|lint|typecheck|verify|passed|failed)([^a-z0-9_]|$)"
    static let ddl = #"""

CREATE TABLE IF NOT EXISTS task_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK(verdict IN ('completed','partial','incorrect','clear')),
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_feedback_latest ON task_feedback(task_id,id DESC);
CREATE TABLE IF NOT EXISTS task_judge_attempts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at INTEGER NOT NULL
);

"""#
    static func evidenceIndices(_ count: Int, cap: Int, preferred: [Int] = []) -> [Int] {
        guard cap > 0, count > 0 else { return [] }
        var picked = Set<Int>()
        func add(_ i: Int) { if picked.count < cap && i >= 0 && i < count { picked.insert(i) } }
        add(0); add(count - 1)
        for i in preferred.reversed() { add(i) }
        if count > 2 { for i in stride(from: count - 2, through: 1, by: -1) { add(i) } }
        return picked.sorted()
    }
    static func turnIndices(_ turns: [[String: Any]], cap: Int = turnCap) -> [Int] {
        let last = turns.lastIndex { ($0["response"] as? String)?.isEmpty == false }
        return evidenceIndices(turns.count, cap: cap, preferred: last.map { [$0] } ?? [])
    }
    static func clipText(_ text: String, cap: Int) -> String {
        let points = text.unicodeScalars.map(String.init)
        let marker = clipMarker.unicodeScalars.count
        if points.count <= cap { return text }
        if cap <= marker { return points.prefix(max(0, cap)).joined() }
        let head = (cap - marker) / 2, tail = cap - marker - head
        return points.prefix(head).joined() + clipMarker + points.suffix(tail).joined()
    }
    static func validationEvent(_ event: [String: Any]) -> Bool {
        guard event["kind"] as? String == "tool" else { return false }
        if event["status"] as? String == "error" || ((event["error"] as? String)?.isEmpty == false) { return true }
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event),
              let text = String(data: data, encoding: .utf8) else { return false }
        return text.range(of: validationPattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
}
