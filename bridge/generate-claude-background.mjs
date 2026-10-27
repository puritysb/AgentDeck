// Generate the Swift Claude background adapter from the Node policy. It feeds
// the generated agent-agnostic `BackgroundWorkTracker` (scripts/
// generate-background-work.mjs); the executable parity test replays identical
// event sequences through both implementations.
import fs from 'node:fs';
import crypto from 'node:crypto';
const source = fs.readFileSync(new URL('./src/claude-background-tasks.ts', import.meta.url), 'utf8');
const policy = JSON.parse(source.match(/CLAUDE_BACKGROUND_POLICY = (\{[\s\S]*?\}) as const/)[1]);
const literals = values => values.map(JSON.stringify).join(', ');
const body = `// BEGIN GENERATED CLAUDE BACKGROUND — bridge/generate-claude-background.mjs
// Source SHA256: ${crypto.createHash('sha256').update(source).digest('hex')}
// Parent turns remain idle; only the session-work projection stays working.
enum ClaudeBackgroundTasks {
    /// Running tasks in order with their tracker kind; nil when absent or malformed.
    static func tasks(_ payload: [String: Any], excluding: String? = nil) -> [(id: String, kind: String)]? {
        guard let tasks = payload["background_tasks"] as? [Any], tasks.count <= ${policy.maxTasks} else { return nil }
        let finished: Set<String> = [${literals(policy.finished)}]
        let processTypes: Set<String> = [${literals(policy.processTypes)}]
        var found: [(id: String, kind: String)] = []
        for value in tasks {
            guard let task = value as? [String: Any], let id = task["id"] as? String, !id.isEmpty,
                  let status = task["status"] as? String else { return nil }
            if id == excluding || finished.contains(status) { continue }
            guard status == "running" else { return nil }
            let kind = (task["type"] as? String).map { processTypes.contains($0) ? "process" : "job" } ?? "job"
            if !found.contains(where: { $0.id == id }) { found.append((id, kind)) }
        }
        return found
    }

    static func taskIds(_ payload: [String: Any], excluding: String? = nil) -> [String]? {
        tasks(payload, excluding: excluding)?.map { $0.id }
    }

    static func taskCount(_ payload: [String: Any], excluding: String? = nil) -> Int? {
        taskIds(payload, excluding: excluding)?.count
    }

    /// Feed one Claude hook into the daemon's shared tracker.
    @discardableResult
    static func note(_ event: String, payload: [String: Any], into work: inout BackgroundWorkTracker,
                     now: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
        guard let sid = payload["session_id"] as? String,
              !sid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if event != "SubagentStop", let child = payload["agent_id"] as? String, !child.isEmpty { return false }
        if event == "SessionStart" || event == "SessionEnd" { return work.reset(sid) }
        guard [${literals(policy.snapshots)}].contains(event) else { return false }
        if event == "Notification" && payload["notification_type"] as? String != "idle_prompt" { return false }
        guard let tasks = Self.tasks(payload, excluding: event == "SubagentStop" ? payload["agent_id"] as? String : nil) else { return false }
        return work.snapshot(sid, items: tasks.map { $0.id }, now: now, noun: "task", staleMs: .some(nil),
                             kinds: Dictionary(tasks.map { ($0.id, $0.kind) }, uniquingKeysWith: { first, _ in first }))
    }
}
// END GENERATED CLAUDE BACKGROUND`;
const target = new URL('../apple/AgentDeck/Daemon/Apme/CoordinationTracker.swift', import.meta.url);
const old = fs.readFileSync(target, 'utf8');
const pattern = /\/\/ BEGIN GENERATED CLAUDE BACKGROUND[\s\S]*?\/\/ END GENERATED CLAUDE BACKGROUND/;
const updated = pattern.test(old) ? old.replace(pattern, () => body) : old.replace(/#endif\s*$/, body + '\n#endif\n');
if (process.argv.includes('--check')) {
  if (old !== updated) throw Error('Claude background Swift reducer drift');
} else fs.writeFileSync(target, updated);
