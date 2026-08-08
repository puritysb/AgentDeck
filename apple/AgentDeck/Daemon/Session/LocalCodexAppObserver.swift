#if os(macOS)
// LocalCodexAppObserver.swift — passive Codex Desktop detection.
//
// Codex Desktop does not always emit lifecycle hooks before the first turn.
// Treat only kernel processes with durable session metadata as observed
// sessions; the top-level Codex.app process alone is integration presence,
// not an agent session.

import Foundation
import SQLite3

struct CodexGoalSnapshot: Equatable, Sendable {
    let threadId: String
    let goalId: String
    let title: String
    let objective: String
    let status: String
    let cwd: String
    let projectName: String
    let activeWorkers: Int
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

/// Reads Codex's persisted goal ledger without launching a helper process.
/// The App Store build reaches these files only through the same user-granted
/// ~/.codex bookmark already used for Codex quota data.
enum LocalCodexGoalObserver {
    static func collect(now: Date = Date()) -> [CodexGoalSnapshot] {
        let read: (URL) -> [CodexGoalSnapshot]? = { baseURL in
            collect(from: baseURL, now: now)
        }
        if AppPreferences.shared.hasCodexUsageBookmark,
           let bookmarked = AppPreferences.shared.withCodexDirectoryAccess(read) {
            return bookmarked
        }
        let direct = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
        return read(direct) ?? []
    }

    static func collect(from baseURL: URL, now: Date = Date()) -> [CodexGoalSnapshot]? {
        let goalsURL = baseURL.appendingPathComponent("goals_1.sqlite")
        let stateURL = baseURL.appendingPathComponent("state_5.sqlite")
        guard FileManager.default.fileExists(atPath: goalsURL.path),
              FileManager.default.fileExists(atPath: stateURL.path),
              let goals = readGoals(at: goalsURL), !goals.isEmpty else { return [] }

        let names = readThreadNames(at: baseURL.appendingPathComponent("session_index.jsonl"))
        let states = readThreadStates(at: stateURL, threadIds: goals.map(\.threadId), now: now)

        return goals.compactMap { goal in
            guard let status = normalizedGoalStatus(goal.status),
                  let thread = states[goal.threadId], !thread.cwd.isEmpty else { return nil }
            let projectName = ProjectNameResolver.resolve(cwd: thread.cwd)
            let indexedTitle = names[goal.threadId]?.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallbackTitle = thread.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let title = indexedTitle?.isEmpty == false
                ? indexedTitle!
                : (fallbackTitle.isEmpty ? goal.objective : fallbackTitle)
            return CodexGoalSnapshot(
                threadId: goal.threadId,
                goalId: goal.goalId,
                title: title,
                objective: goal.objective,
                status: status,
                cwd: thread.cwd,
                projectName: projectName,
                activeWorkers: thread.activeWorkers,
                createdAtMs: goal.createdAtMs,
                updatedAtMs: goal.updatedAtMs
            )
        }
    }

    private struct GoalRow {
        let threadId: String
        let goalId: String
        let objective: String
        let status: String
        let createdAtMs: Int64
        let updatedAtMs: Int64
    }

    private struct ThreadState {
        let cwd: String
        let title: String
        let activeWorkers: Int
    }

    private static func normalizedGoalStatus(_ raw: String) -> String? {
        switch raw {
        case "active", "paused", "blocked", "usage_limited", "budget_limited": raw
        default: nil
        }
    }

    private static func readGoals(at url: URL) -> [GoalRow]? {
        withReadOnlyDatabase(url) { db in
            var statement: OpaquePointer?
            let sql = """
                SELECT thread_id, goal_id, objective, status,
                       COALESCE(created_at_ms, 0), COALESCE(updated_at_ms, 0)
                FROM thread_goals
                WHERE status <> 'complete'
                ORDER BY updated_at_ms DESC
                """
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
                  let statement else { return [] }
            defer { sqlite3_finalize(statement) }
            var rows: [GoalRow] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                rows.append(GoalRow(
                    threadId: text(statement, 0),
                    goalId: text(statement, 1),
                    objective: text(statement, 2),
                    status: text(statement, 3),
                    createdAtMs: sqlite3_column_int64(statement, 4),
                    updatedAtMs: sqlite3_column_int64(statement, 5)
                ))
            }
            return rows
        }
    }

    private static func readThreadStates(
        at url: URL,
        threadIds: [String],
        now: Date
    ) -> [String: ThreadState] {
        withReadOnlyDatabase(url) { db in
            var threadStatement: OpaquePointer?
            var workerStatement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "SELECT cwd, COALESCE(title, '') FROM threads WHERE id = ? LIMIT 1", -1, &threadStatement, nil) == SQLITE_OK,
                  sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id WHERE e.parent_thread_id = ? AND t.updated_at_ms >= ?", -1, &workerStatement, nil) == SQLITE_OK,
                  let threadStatement, let workerStatement else {
                if let threadStatement { sqlite3_finalize(threadStatement) }
                if let workerStatement { sqlite3_finalize(workerStatement) }
                return [:]
            }
            defer {
                sqlite3_finalize(threadStatement)
                sqlite3_finalize(workerStatement)
            }

            let freshAfterMs = Int64(now.timeIntervalSince1970 * 1000) - 90_000
            var result: [String: ThreadState] = [:]
            for id in threadIds {
                sqlite3_reset(threadStatement)
                sqlite3_clear_bindings(threadStatement)
                bind(id, to: threadStatement, at: 1)
                guard sqlite3_step(threadStatement) == SQLITE_ROW else { continue }
                let cwd = text(threadStatement, 0)
                let title = text(threadStatement, 1)

                sqlite3_reset(workerStatement)
                sqlite3_clear_bindings(workerStatement)
                bind(id, to: workerStatement, at: 1)
                sqlite3_bind_int64(workerStatement, 2, freshAfterMs)
                let workers = sqlite3_step(workerStatement) == SQLITE_ROW
                    ? Int(sqlite3_column_int(workerStatement, 0))
                    : 0
                result[id] = ThreadState(cwd: cwd, title: title, activeWorkers: workers)
            }
            return result
        } ?? [:]
    }

    private static func readThreadNames(at url: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: url),
              let contents = String(data: data, encoding: .utf8) else { return [:] }
        var names: [String: String] = [:]
        for line in contents.split(separator: "\n") {
            guard let rowData = line.data(using: .utf8),
                  let row = try? JSONSerialization.jsonObject(with: rowData) as? [String: Any],
                  let id = row["id"] as? String,
                  let name = row["thread_name"] as? String else { continue }
            names[id] = name
        }
        return names
    }

    private static func withReadOnlyDatabase<T>(_ url: URL, body: (OpaquePointer) -> T) -> T? {
        var database: OpaquePointer?
        guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK,
              let database else {
            if let database { sqlite3_close(database) }
            return nil
        }
        defer { sqlite3_close(database) }
        return body(database)
    }

    private static func text(_ statement: OpaquePointer, _ column: Int32) -> String {
        guard let value = sqlite3_column_text(statement, column) else { return "" }
        return String(cString: value)
    }

    private static func bind(_ value: String, to statement: OpaquePointer, at index: Int32) {
        value.withCString { pointer in
            _ = sqlite3_bind_text(
                statement,
                index,
                pointer,
                -1,
                unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            )
        }
    }
}

enum LocalCodexAppObserver {
    private static let fallbackProjectName = "Codex App"

    static func collect() -> [DaemonSessionEntry] {
        ProcessEnumerator.processSnapshots().compactMap(observedKernelSession)
    }

    private static func observedKernelSession(_ snapshot: ProcessEnumerator.ProcessSnapshot) -> DaemonSessionEntry? {
        let args = snapshot.arguments
        guard args.contains(where: { $0.hasSuffix("/kernel.js") || $0 == "kernel.js" }) else { return nil }
        guard args.contains(where: { $0.contains("Codex.app/Contents/Resources") }) else { return nil }

        let sessionId = ProcessEnumerator.value(after: "--session-id", in: args) ?? String(snapshot.pid)
        let cwd = ProcessEnumerator.value(after: "--working-dir", in: args)
        let projectName = cwd
            .flatMap { ProjectNameResolver.resolve(cwd: $0).nilIfBlank }
            ?? fallbackProjectName

        var entry = DaemonSessionEntry(
            id: "observed:codex-app:\(sessionId)",
            port: 0,
            pid: Int(snapshot.pid),
            projectName: projectName,
            agentType: "codex-app",
            tmuxSession: nil,
            tty: nil,
            parentTty: nil,
            startedAt: ISO8601DateFormatter().string(from: snapshot.startedAt)
        )
        entry.state = "idle"
        return entry
    }
}

private extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
#endif
