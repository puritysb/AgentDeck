#!/usr/bin/env node
// Generate the Swift mirror of the agent-agnostic background-work tracker:
//   shared/src/background-work.ts
//     → `BackgroundWorkTracker` block in apple/AgentDeck/Daemon/Apme/CoordinationTracker.swift
//
//   pnpm generate-background-work            regenerate the block
//   pnpm generate-background-work --check    exit 1 if it drifted
//
// The CLI reads the policy from shared/dist (run `pnpm build` first). The
// vitest gate (bridge/src/__tests__/background-work.test.ts) calls
// `emitBackgroundWorkSwift` with the TS source's policy, so drift is caught in
// CI without running this CLI, and replays shared/background-work-vectors.json
// through both implementations.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKGROUND_WORK_SOURCE = path.join(projectDir, 'shared/src/background-work.ts');
export const BACKGROUND_WORK_TARGET = path.join(projectDir, 'apple/AgentDeck/Daemon/Apme/CoordinationTracker.swift');
export const BACKGROUND_WORK_BLOCK = /\/\/ BEGIN GENERATED BACKGROUND WORK[\s\S]*?\/\/ END GENERATED BACKGROUND WORK/;

export function emitBackgroundWorkSwift(policy, sourceText, hooks) {
  const nouns = Object.entries(policy.nouns)
    .map(([kind, [one, many]]) => `        case ${JSON.stringify(kind)}: return count == 1 ? ${JSON.stringify(one)} : ${JSON.stringify(many)}`).join('\n');
  const rules = Object.entries(hooks).map(([agent, r]) =>
    `        Rule(agent: ${JSON.stringify(agent)}, noun: ${JSON.stringify(r.noun)}, staleMs: ${r.staleMs === null ? 'nil' : r.staleMs}, `
    + `resets: [${r.resets.map(x => JSON.stringify(x)).join(', ')}], childStop: ${r.childStop === null ? 'nil' : JSON.stringify(r.childStop)}, `
    + `events: [${r.events.map(x => JSON.stringify(x)).join(', ')}]),`).join('\n');
  return `// BEGIN GENERATED BACKGROUND WORK — scripts/generate-background-work.mjs
// Source SHA256: ${crypto.createHash('sha256').update(sourceText).digest('hex')}
// Agent-agnostic background work per session; adapters translate each agent's
// signal into snapshot/start/finish/reset. Absent = unknown, explicit 0 = done.
struct BackgroundWorkTracker {
    static let maxSessions = ${policy.maxSessions}
    static let maxItems = ${policy.maxItems}
    static let tool = ${JSON.stringify(policy.tool)}

    static func noun(_ kind: String, count: Int) -> String {
        switch kind {
${nouns}
        default: return count == 1 ? ${JSON.stringify(policy.nouns.task[0])} : ${JSON.stringify(policy.nouns.task[1])}
        }
    }

    private struct Work {
        var items: [String: Double] = [:]
        var noun = "task"
        var staleMs: Double?
    }
    private var sessions: [String: Work] = [:]
    private var order: [String] = []

    func count(_ sid: String) -> Int? { sessions[sid]?.items.count }

    /// noun/staleMs: nil leaves the session's current value; staleMs .some(nil) clears the bound.
    @discardableResult
    mutating func snapshot(_ sid: String, items: [String], now: Double, noun: String? = nil, staleMs: Double?? = nil) -> Bool {
        guard !sid.isEmpty, items.count <= Self.maxItems else { return false }
        let before = count(sid)
        var work = touch(sid, noun: noun, staleMs: staleMs)
        work.items = [:]
        for item in items where !item.isEmpty { work.items[item] = now }
        sessions[sid] = work
        evict()
        return before != work.items.count
    }

    @discardableResult
    mutating func start(_ sid: String, item: String, now: Double, noun: String? = nil, staleMs: Double?? = nil) -> Bool {
        guard !sid.isEmpty, !item.isEmpty else { return false }
        let before = count(sid)
        var work = touch(sid, noun: noun, staleMs: staleMs)
        if work.items[item] == nil, work.items.count >= Self.maxItems { sessions[sid] = work; return false }
        work.items[item] = now
        sessions[sid] = work
        evict()
        return before != work.items.count
    }

    @discardableResult
    mutating func finish(_ sid: String, item: String) -> Bool {
        guard var work = sessions[sid], work.items.removeValue(forKey: item) != nil else { return false }
        sessions[sid] = work
        return true
    }

    @discardableResult
    mutating func reset(_ sid: String) -> Bool {
        order.removeAll { $0 == sid }
        return sessions.removeValue(forKey: sid) != nil
    }

    /// Sessions whose count changed because an item outlived its stale bound.
    mutating func reap(now: Double) -> [String] {
        var changed: [String] = []
        for sid in order {
            guard var work = sessions[sid], let stale = work.staleMs else { continue }
            let before = work.items.count
            work.items = work.items.filter { now - $0.value <= stale }
            if work.items.count != before { sessions[sid] = work; changed.append(sid) }
        }
        return changed
    }

    func project(_ sid: String, session: [String: Any]) -> [String: Any] {
        guard let work = sessions[sid] else { return session }
        let count = work.items.count
        var result = session
        result["backgroundTaskCount"] = count
        guard session["state"] as? String == "idle", count > 0 else { return result }
        let activity = "Waiting for \\(count) \\(Self.noun(work.noun, count: count))"
        result["state"] = "processing"
        result["currentTool"] = Self.tool
        result["currentTask"] = activity
        result["activity"] = activity
        return result
    }

    private mutating func touch(_ sid: String, noun: String?, staleMs: Double??) -> Work {
        var work = sessions[sid] ?? Work()
        if let noun { work.noun = noun }
        if let staleMs { work.staleMs = staleMs }
        order.removeAll { $0 == sid }
        order.append(sid)
        return work
    }

    private mutating func evict() {
        while order.count > Self.maxSessions { sessions.removeValue(forKey: order.removeFirst()) }
    }
}

/// The generic \`<agent>_background_start|finish|snapshot\` hook vocabulary.
enum BackgroundWorkHooks {
    struct Rule { let agent: String; let noun: String; let staleMs: Double?; let resets: [String]; let childStop: String?; let events: [String] }
    static let rules: [Rule] = [
${rules}
    ]
    static let maxItemId = 256

    enum Op: Equatable {
        case start(sessionId: String, item: String, noun: String, staleMs: Double?)
        case finish(sessionId: String, item: String)
        case snapshot(sessionId: String, items: [String], noun: String, staleMs: Double?)
        case reset(sessionId: String)
    }

    private static func itemId(_ value: Any?) -> String? {
        guard let s = value as? String, !s.isEmpty, s.utf16.count <= maxItemId else { return nil }
        return s
    }

    static func isEvent(_ event: String) -> Bool {
        for suffix in ["_background_start", "_background_finish", "_background_snapshot"] where event.hasSuffix(suffix) {
            let agent = event.dropLast(suffix.count)
            return !agent.isEmpty && agent.utf8.allSatisfy { $0 >= 97 && $0 <= 122 }
        }
        return false
    }

    static func op(_ event: String, payload: [String: Any]) -> Op? {
        guard let sid = payload["session_id"] as? String,
              !sid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        for rule in rules {
            if rule.resets.contains(event) { return .reset(sessionId: sid) }
            if let childStop = rule.childStop, event == childStop {
                guard let item = itemId(payload["agent_id"]) else { return nil }
                return .finish(sessionId: sid, item: item)
            }
            if (event == rule.agent + "_background_start" && rule.events.contains("start"))
                || (event == rule.agent + "_background_finish" && rule.events.contains("finish")) {
                guard let item = itemId(payload["item_id"]) else { return nil }
                return event.hasSuffix("_start")
                    ? .start(sessionId: sid, item: item, noun: rule.noun, staleMs: rule.staleMs)
                    : .finish(sessionId: sid, item: item)
            }
            if event == rule.agent + "_background_snapshot" && rule.events.contains("snapshot") {
                guard let raw = payload["items"] as? [Any], raw.count <= BackgroundWorkTracker.maxItems else { return nil }
                var items: [String] = []
                for value in raw {
                    guard let item = itemId(value) else { return nil }
                    if !items.contains(item) { items.append(item) }
                }
                return .snapshot(sessionId: sid, items: items, noun: rule.noun, staleMs: rule.staleMs)
            }
        }
        return nil
    }

    @discardableResult
    static func apply(_ op: Op, to work: inout BackgroundWorkTracker, now: Double) -> Bool {
        switch op {
        case .reset(let sid): return work.reset(sid)
        case .finish(let sid, let item): return work.finish(sid, item: item)
        case .start(let sid, let item, let noun, let staleMs):
            return work.start(sid, item: item, now: now, noun: noun, staleMs: .some(staleMs))
        case .snapshot(let sid, let items, let noun, let staleMs):
            return work.snapshot(sid, items: items, now: now, noun: noun, staleMs: .some(staleMs))
        }
    }
}
// END GENERATED BACKGROUND WORK`;
}

export function applyBackgroundWorkBlock(swiftText, block) {
  if (BACKGROUND_WORK_BLOCK.test(swiftText)) return swiftText.replace(BACKGROUND_WORK_BLOCK, () => block);
  return swiftText.replace(/#endif\s*$/, `${block}\n#endif\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const mod = await import(pathToFileURL(path.join(projectDir, 'shared/dist/background-work.js')).href);
  const block = emitBackgroundWorkSwift(mod.BACKGROUND_WORK_POLICY, fs.readFileSync(BACKGROUND_WORK_SOURCE, 'utf8'), mod.BACKGROUND_WORK_HOOKS);
  const old = fs.readFileSync(BACKGROUND_WORK_TARGET, 'utf8');
  const updated = applyBackgroundWorkBlock(old, block);
  if (process.argv.includes('--check')) {
    if (old !== updated) { console.error('Background work Swift tracker drift: run pnpm generate-background-work'); process.exit(1); }
  } else fs.writeFileSync(BACKGROUND_WORK_TARGET, updated);
}
