#if os(macOS)
// Observed task comparisons. Eligibility and SQL are generated from shared/.
// A minimum sample count is a display gate, not statistical confidence.
import Foundation

struct ApmeRecommendInput {
    var taskKind: String?
    var budgetUsd: Double?
    var latencyBudgetMs: Double?
    var preferLocal: Bool = false
    var availableModels: [String]?
}

struct ApmeRecommendCandidate {
    let modelId: String
    let agentType: String
    let provider: String?
    let expectedScore: Double
    let expectedCostUsd: Double?
    /// Legacy sample-support heuristic; not a probability of correctness.
    let confidence: Double
    let samples: Int
    let taskCategory: String?
    let rationale: String
}

enum ApmeRecommender {
    struct Point {
        /// Preserve the older Swift HTTP projection's snake_case fields.
        let scorecard: [String: Any]
        let agentType: String
        let modelId: String
        let provider: String?
        let taskCategory: String?
        let quality: Double
        let costPerSample: Double?
        let avgLatencyMs: Double?
        let samples: Int

        var dictionary: [String: Any] {
            var result = scorecard
            result.merge(["agentType": agentType, "modelId": modelId, "provider": provider ?? NSNull(),
             "taskCategory": taskCategory ?? NSNull(), "quality": quality,
             "costPerSample": costPerSample ?? NSNull(),
             "avgLatencyMs": avgLatencyMs ?? NSNull(), "samples": samples]) { _, new in new }
            return result
        }
    }

    static func pareto(rows: [[String: Any]], category: String? = nil) -> (frontier: [Point], dominated: [Point]) {
        let points: [Point] = rows.compactMap { r in
            let samples = (r["samples"] as? Int) ?? 0
            let model = (r["model_id"] as? String) ?? "unknown"
            let taskCategory = r["task_category"] as? String
            guard category == nil || taskCategory == category,
                  ApmeComparisonRules.eligible(modelId: model, category: taskCategory, samples: samples),
                  let quality = r["avg_quality"] as? Double,
                  quality.isFinite, quality > 0, quality <= 1 else { return nil }
            let cost = (r["cost_known"] as? Int) == 1 ? (r["total_cost"] as? Double).map { $0 / Double(samples) } : nil
            return Point(scorecard: r, agentType: (r["agent_type"] as? String) ?? "unknown", modelId: model,
                         provider: r["provider"] as? String, taskCategory: taskCategory,
                         quality: quality, costPerSample: cost,
                         avgLatencyMs: r["avg_latency_ms"] as? Double, samples: samples)
        }
        func dominates(_ b: Point, _ a: Point) -> Bool {
            guard b.taskCategory == a.taskCategory,
                  let bc = b.costPerSample, let ac = a.costPerSample else { return false }
            return b.quality >= a.quality && bc <= ac && (b.quality > a.quality || bc < ac)
        }
        var frontier: [Point] = [], dominated: [Point] = []
        for a in points {
            if points.contains(where: { dominates($0, a) }) { dominated.append(a) }
            else { frontier.append(a) }
        }
        frontier.sort {
            let ac = $0.costPerSample ?? .infinity, bc = $1.costPerSample ?? .infinity
            return ac < bc || (ac == bc && $0.quality > $1.quality)
        }
        return (frontier, dominated)
    }

    static func recommend(store: ApmeStore, input: ApmeRecommendInput = ApmeRecommendInput()) -> [ApmeRecommendCandidate] {
        guard store.isOpen else { return [] }
        // Apply constraints before dominance. No cross-category/run fallback.
        let rows = store.sampleScorecard().filter { r in
            let model = (r["model_id"] as? String) ?? "unknown"
            if let available = input.availableModels, !available.contains(model) { return false }
            let samples = (r["samples"] as? Int) ?? 0
            let cost = (r["cost_known"] as? Int) == 1 && samples > 0
                ? (r["total_cost"] as? Double).map { $0 / Double(samples) } : nil
            if let budget = input.budgetUsd, cost == nil || cost! > budget { return false }
            if let budget = input.latencyBudgetMs {
                guard let latency = r["avg_latency_ms"] as? Double, latency > 0, latency <= budget else { return false }
            }
            return true
        }
        var candidates = pareto(rows: rows, category: input.taskKind).frontier
        candidates.sort { a, b in
            let ac = a.costPerSample ?? .infinity, bc = b.costPerSample ?? .infinity
            if input.preferLocal || (input.budgetUsd != nil && input.budgetUsd! < 5) {
                return ac < bc || (ac == bc && a.quality > b.quality)
            }
            return a.quality > b.quality || (a.quality == b.quality && ac < bc)
        }
        return candidates.prefix(3).map { p in
            let cost = p.costPerSample.map { "$\(String(format: "%.4f", $0))/sample" } ?? "cost unpriced"
            var rationale = "\(p.samples) samples, avg \(Int((p.quality * 100).rounded()))%, \(cost)"
            if let latency = p.avgLatencyMs { rationale += ", \(Int(latency.rounded()))ms" }
            rationale += " — observed AI estimates; not a success probability"
            return ApmeRecommendCandidate(modelId: p.modelId, agentType: p.agentType, provider: p.provider,
                                          expectedScore: p.quality, expectedCostUsd: p.costPerSample,
                                          confidence: min(1, Double(p.samples) / 20), samples: p.samples,
                                          taskCategory: p.taskCategory, rationale: rationale)
        }
    }
}
#endif
