#if os(macOS)
import Foundation

/// Pure sample-trajectory scorers — Swift mirror of bridge/src/apme/scorers/index.ts.
///
/// Operate on the typed trajectory event dicts (as produced by
/// `ApmeStore.getSampleDict(_:)["events"]`): tool churn + error rate
/// (trajectory_quality) and tool success rate (tool_efficiency). These add
/// signal the LLM judge can miss and are stored under layer="trajectory".
enum ApmeScorers {
    struct Result { let scorer: String; let metric: String; let score: Double; let reasoning: String }

    private static func clamp01(_ n: Double) -> Double {
        return (max(0, min(1, n)) * 100).rounded() / 100
    }

    private static func toolKey(_ e: [String: Any]) -> String {
        let name = e["name"] as? String ?? "tool"
        var input = ""
        // `isValidJSONObject` first — NOT decoration. `data(withJSONObject:)`
        // raises an ObjC NSInvalidArgumentException for anything that is not a
        // valid top-level JSON container, and an ObjC exception is not a Swift
        // error: `try?` does not catch it, so it reaches the runtime as a
        // terminate. A tool event whose `input` is a bare String does exactly
        // that, and it aborted the whole app on 2026-08-06 — from a background
        // eval task, with the daemon and every device connection going down
        // with it. The `as? String` branch below shows a plain String was
        // always expected here; the throwing call just got to it first.
        // Same guard as `compactDebugValue` in DaemonServer.swift.
        if let inp = e["input"], JSONSerialization.isValidJSONObject(inp),
           let data = try? JSONSerialization.data(withJSONObject: inp, options: [.sortedKeys]) {
            input = String(data: data, encoding: .utf8) ?? ""
        } else if let s = e["input"] as? String {
            input = s
        }
        return "\(name)|\(input)"
    }

    /// Run all applicable scorers over the trajectory event dicts.
    static func run(events: [[String: Any]]) -> [Result] {
        let tools = events.filter { ($0["kind"] as? String) == "tool" }
        var out: [Result] = []

        // trajectory_quality — penalize consecutive identical tool calls + errors.
        if tools.count >= 2 {
            var dupes = 0
            for i in 1..<tools.count {
                // A row pruned by `agentdeck apme prune` (#302) has no
                // retained `input`, so two pruned calls to the same tool
                // name would otherwise key-match and count as a detected
                // repeat — a verdict built from absence, not evidence.
                if (tools[i]["pruned"] as? Bool == true) || (tools[i - 1]["pruned"] as? Bool == true) { continue }
                if toolKey(tools[i]) == toolKey(tools[i - 1]) { dupes += 1 }
            }
            let errors = tools.filter { ($0["status"] as? String) == "error" }.count
            let redundancy = Double(dupes) / Double(tools.count)
            let errorRate = Double(errors) / Double(tools.count)
            let score = clamp01(1 - 0.7 * redundancy - 0.5 * errorRate)
            out.append(Result(scorer: "trajectory_quality", metric: "trajectory_quality", score: score,
                              reasoning: "\(tools.count) tool calls, \(dupes) consecutive repeats, \(errors) errors"))
        }

        // tool_efficiency — success rate, lightly penalized for tool density.
        if tools.count >= 1 {
            let resolved = tools.filter { let s = $0["status"] as? String; return s == "success" || s == "error" }
            let ok = tools.filter { ($0["status"] as? String) == "success" }.count
            let successRate = resolved.isEmpty ? 1.0 : Double(ok) / Double(resolved.count)
            let assistantTurns = max(1, events.filter { ($0["kind"] as? String) == "assistant_message" }.count)
            let toolsPerTurn = Double(tools.count) / Double(assistantTurns)
            let densityPenalty = toolsPerTurn > 8 ? min(0.3, (toolsPerTurn - 8) * 0.03) : 0
            let score = clamp01(successRate - densityPenalty)
            let denom = resolved.isEmpty ? tools.count : resolved.count
            out.append(Result(scorer: "tool_efficiency", metric: "tool_efficiency", score: score,
                              reasoning: "\(ok)/\(denom) tools succeeded, \(String(format: "%.1f", toolsPerTurn)) tools/turn"))
        }

        return out
    }
}
#endif
