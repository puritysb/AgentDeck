// Generate the Swift hook snapshot reducer from the Node policy. The executable
// parity test replays identical event sequences through both implementations.
import fs from 'node:fs';
import crypto from 'node:crypto';
const source = fs.readFileSync(new URL('./src/claude-background-tasks.ts', import.meta.url), 'utf8');
const policy = JSON.parse(source.match(/CLAUDE_BACKGROUND_POLICY = (\{[\s\S]*?\}) as const/)[1]);
const literals = values => values.map(JSON.stringify).join(', ');
const body = `// BEGIN GENERATED CLAUDE BACKGROUND — bridge/generate-claude-background.mjs
// Source SHA256: ${crypto.createHash('sha256').update(source).digest('hex')}
// Parent turns remain idle; only the session-work projection stays working.
struct ClaudeBackgroundTasks {
    private var counts: [String: Int] = [:]
    private var order: [String] = []

    static func taskCount(_ payload: [String: Any], excluding: String? = nil) -> Int? {
        guard let tasks = payload["background_tasks"] as? [Any], tasks.count <= ${policy.maxTasks} else { return nil }
        let finished: Set<String> = [${literals(policy.finished)}]
        var ids: Set<String> = []
        for value in tasks {
            guard let task = value as? [String: Any], let id = task["id"] as? String, !id.isEmpty,
                  let status = task["status"] as? String else { return nil }
            if id == excluding || finished.contains(status) { continue }
            guard status == "running" else { return nil }
            ids.insert(id)
        }
        return ids.count
    }

    @discardableResult
    mutating func note(_ event: String, payload: [String: Any]) -> Bool {
        guard let sid = payload["session_id"] as? String,
              !sid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if event != "SubagentStop", let child = payload["agent_id"] as? String, !child.isEmpty { return false }
        if event == "SessionStart" || event == "SessionEnd" {
            order.removeAll { $0 == sid }
            return counts.removeValue(forKey: sid) != nil
        }
        guard [${literals(policy.snapshots)}].contains(event) else { return false }
        if event == "Notification" && payload["notification_type"] as? String != "idle_prompt" { return false }
        guard let count = Self.taskCount(payload, excluding: event == "SubagentStop" ? payload["agent_id"] as? String : nil) else { return false }
        let changed = counts[sid] != count
        order.removeAll { $0 == sid }
        order.append(sid)
        counts[sid] = count
        if order.count > ${policy.maxSessions} { counts.removeValue(forKey: order.removeFirst()) }
        return changed
    }

    func project(_ sid: String, session: [String: Any]) -> [String: Any] {
        guard session["state"] as? String == "idle", let count = counts[sid], count > 0 else { return session }
        var result = session
        let activity = "Waiting for \\(count) background task" + (count == 1 ? "" : "s")
        result["state"] = "processing"
        result["currentTool"] = ${JSON.stringify(policy.tool)}
        result["currentTask"] = activity
        result["activity"] = activity
        return result
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
