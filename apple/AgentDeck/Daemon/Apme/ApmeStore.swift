#if os(macOS)
// ApmeStore.swift — SQLite3 C API wrapper for APME data.
// Shares the same DDL as bridge/src/apme/store.ts. Path resolves via
// AuthManager.agentDeckDir → AgentDeckPaths (App Store sandbox container on
// signed App Store builds, ~/.agentdeck/apme.sqlite fallback otherwise). The Node
// bridge still writes to ~/.agentdeck/apme.sqlite; the two only coexist on
// unsigned dev builds — WAL + busy_timeout keeps that case safe.

import Foundation
import SQLite3

final class ApmeStore: @unchecked Sendable {
    private var db: OpaquePointer?
    let dbPath: String
    private(set) var isOpen = false
    private static let openQueue = DispatchQueue(label: "dev.agentdeck.apme.open", qos: .utility)

    init() {
        dbPath = AuthManager.agentDeckDir
            .appendingPathComponent("apme.sqlite").path
    }

    deinit {
        close()
    }

    // MARK: - Open / Close

    func openWithTimeout(seconds: TimeInterval = 2) async -> Bool {
        await withCheckedContinuation { continuation in
            let gate = ApmeOpenContinuationGate()
            Self.openQueue.async {
                gate.resume(continuation, self.open())
            }
            let dbPath = self.dbPath
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + seconds) {
                if gate.resume(continuation, false) {
                    DaemonLogger.shared.error("APME store open timed out: \(dbPath)")
                }
            }
        }
    }

    func open() -> Bool {
        guard db == nil else { return true }
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(dbPath, &handle, flags, nil) == SQLITE_OK else {
            DaemonLogger.shared.error("APME store open failed: \(dbPath)")
            return false
        }
        db = handle
        exec("PRAGMA journal_mode = WAL")
        exec("PRAGMA foreign_keys = ON")
        // Dual-writer safety: Node.js bridge (better-sqlite3) and this Swift daemon
        // may both open the same ~/.agentdeck/apme.sqlite. Both honor the native
        // SQLite lock protocol under WAL; busy_timeout prevents "database is locked"
        // errors when writes overlap. Matches bridge/src/apme/store.ts contract.
        exec("PRAGMA busy_timeout = 5000")
        exec(Self.ddl)
        migrateSchema()
        seedDefaultRubric()
        isOpen = true
        DaemonLogger.shared.info("APME store ready at \(dbPath)")
        return true
    }

    func close() {
        if let db { sqlite3_close_v2(db) }
        db = nil; isOpen = false
    }

    // MARK: - Runs

    func insertRun(_ run: ApmeRun) {
        guard let db else { return }
        let sql = """
        INSERT INTO runs
          (id, session_id, agent_type, model_id, project_name, project_path,
           task_prompt, started_at, ended_at, input_tokens, output_tokens,
           cost_usd, exit_code, git_before, git_after, hw_profile,
           task_signals, task_category, task_category_source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, run.id)
        bindText(stmt, 2, run.sessionId)
        bindText(stmt, 3, run.agentType)
        bindTextOrNull(stmt, 4, run.modelId)
        bindTextOrNull(stmt, 5, run.projectName)
        bindTextOrNull(stmt, 6, run.projectPath)
        bindTextOrNull(stmt, 7, run.taskPrompt)
        sqlite3_bind_int64(stmt, 8, Int64(run.startedAt))
        if let e = run.endedAt { sqlite3_bind_int64(stmt, 9, Int64(e)) } else { sqlite3_bind_null(stmt, 9) }
        if let v = run.inputTokens { sqlite3_bind_int(stmt, 10, Int32(v)) } else { sqlite3_bind_null(stmt, 10) }
        if let v = run.outputTokens { sqlite3_bind_int(stmt, 11, Int32(v)) } else { sqlite3_bind_null(stmt, 11) }
        if let v = run.costUsd { sqlite3_bind_double(stmt, 12, v) } else { sqlite3_bind_null(stmt, 12) }
        if let v = run.exitCode { sqlite3_bind_int(stmt, 13, Int32(v)) } else { sqlite3_bind_null(stmt, 13) }
        bindTextOrNull(stmt, 14, run.gitBefore)
        bindTextOrNull(stmt, 15, run.gitAfter)
        bindTextOrNull(stmt, 16, run.hwProfile)
        bindTextOrNull(stmt, 17, run.taskSignals)
        bindTextOrNull(stmt, 18, run.taskCategory)
        bindTextOrNull(stmt, 19, run.taskCategorySource)
        sqlite3_step(stmt)
    }

    func updateRun(id: String, fields: [String: Any?]) {
        guard let db, !fields.isEmpty else { return }
        // CRITICAL: every `runs` column that any caller can pass through
        // `fields` must be listed here. Keys missing from `colMap` are
        // silently dropped at the `guard let col = colMap[key]` below,
        // so an omission produces an UPDATE with zero SET clauses (early
        // return at `setClauses.isEmpty`) and the caller's write is lost
        // without an error. Previous regression: outcome / outcome_confidence
        // / efficiency_json / composite_score were missing here, so every
        // `ApmeOutcomeEngine.evaluateOutcome → store.updateRun` call was a
        // no-op and the same runs got re-evaluated every 30 s in
        // `apmeEvalTick` forever (issue surfaced 2026-05-15: 6 stuck
        // run IDs cycling 217×). Mirror the columns in `readRun` and
        // `turns` / `tasks` colMaps when extending.
        let colMap: [String: String] = [
            "modelId": "model_id", "projectName": "project_name", "projectPath": "project_path",
            "taskPrompt": "task_prompt", "endedAt": "ended_at",
            "inputTokens": "input_tokens", "outputTokens": "output_tokens",
            "costUsd": "cost_usd", "exitCode": "exit_code",
            "gitBefore": "git_before", "gitAfter": "git_after", "hwProfile": "hw_profile",
            "taskSignals": "task_signals", "taskCategory": "task_category",
            "taskCategorySource": "task_category_source",
            "outcome": "outcome", "outcomeConfidence": "outcome_confidence",
            "efficiencyJson": "efficiency_json", "compositeScore": "composite_score",
        ]
        var setClauses: [String] = []
        var values: [Any?] = []
        for (key, val) in fields {
            guard let col = colMap[key] else { continue }
            setClauses.append("\(col) = ?")
            values.append(val)
        }
        guard !setClauses.isEmpty else { return }
        values.append(id)
        let sql = "UPDATE runs SET \(setClauses.joined(separator: ", ")) WHERE id = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        for (i, val) in values.enumerated() {
            let idx = Int32(i + 1)
            switch val {
            case let s as String: sqlite3_bind_text(stmt, idx, (s as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let n as Int: sqlite3_bind_int64(stmt, idx, Int64(n))
            case let d as Double: sqlite3_bind_double(stmt, idx, d)
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        let result = sqlite3_step(stmt)
        if result != SQLITE_OK && result != SQLITE_DONE {
            DaemonLogger.shared.error("[APME] updateRun failed: \(result) for id=\(id)")
            return
        }
        DaemonLogger.shared.debug("APME", "updateRun: \(setClauses.count) fields for id=\(id.prefix(8))")
    }

    func getRun(id: String) -> ApmeRun? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT * FROM runs WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return readRun(stmt)
    }

    func listRuns(limit: Int = 50, agentType: String? = nil) -> [ApmeRun] {
        guard let db else { return [] }
        var sql = "SELECT * FROM runs"
        var args: [String] = []
        if let a = agentType { sql += " WHERE agent_type = ?"; args.append(a) }
        sql += " ORDER BY started_at DESC LIMIT \(min(max(limit, 1), 500))"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        for (i, arg) in args.enumerated() { bindText(stmt, Int32(i + 1), arg) }
        var result: [ApmeRun] = []
        while sqlite3_step(stmt) == SQLITE_ROW { result.append(readRun(stmt)) }
        return result
    }

    func listUnevaluatedRuns(limit: Int = 20) -> [(id: String, projectPath: String?)] {
        guard let db else { return [] }
        let sql = """
        SELECT r.id, r.project_path FROM runs r
        WHERE r.ended_at IS NOT NULL
          AND (r.task_category IS NULL OR r.task_category != '_empty')
          AND NOT EXISTS (SELECT 1 FROM evals e WHERE e.run_id = r.id)
        ORDER BY r.ended_at DESC LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))
        var result: [(String, String?)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let path = sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 1))
            result.append((id, path))
        }
        return result
    }

    /// Runs that have ended but have no category — candidates for daemon re-classification.
    func listUnclassifiedRuns(limit: Int = 5) -> [(id: String, projectPath: String?)] {
        guard let db else { return [] }
        let sql = """
        SELECT r.id, r.project_path FROM runs r
        WHERE r.ended_at IS NOT NULL AND r.task_category IS NULL
        ORDER BY r.ended_at DESC LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))
        var result: [(String, String?)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let path = sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 1))
            result.append((id, path))
        }
        return result
    }

    /// Abandoned runs: real work that was never closed. The daemon restarted
    /// (or crashed) mid-session, so the in-memory session→run map `closeRun`
    /// depends on is gone and nothing will ever finalize these rows.
    ///
    /// Distinct from `listOrphanedRuns`, which by design matches only empty
    /// shells (`task_prompt IS NULL` + no turns) and therefore steps over the
    /// case that actually costs data: a run carrying prompts, turns and a whole
    /// tool trajectory stays open forever, its task never closes, and a task
    /// that never closes is never evaluated.
    ///
    /// Staleness is measured from the LAST recorded activity, never
    /// `started_at` — a live multi-hour session must not be reaped out from
    /// under the process that owns it. `lastActivity` is returned so the caller
    /// closes the rows AT that instant rather than `now`, keeping durations
    /// honest. Mirrors bridge/src/apme/store.ts listAbandonedRuns.
    func listAbandonedRuns(staleSec: Int = 7200, limit: Int = 20) -> [(id: String, lastActivity: Int)] {
        guard let db else { return [] }
        let cutoff = Int(Date().timeIntervalSince1970 * 1000) - staleSec * 1000
        let sql = """
        SELECT id, last_activity FROM (
          SELECT r.id AS id,
            MAX(
              r.started_at,
              COALESCE((SELECT MAX(MAX(t.started_at, COALESCE(t.ended_at, 0))) FROM turns t WHERE t.run_id = r.id), 0),
              COALESCE((SELECT MAX(s.ts) FROM steps s WHERE s.run_id = r.id), 0),
              COALESCE((SELECT MAX(se.ts) FROM sample_events se WHERE se.run_id = r.id), 0)
            ) AS last_activity
          FROM runs r
          WHERE r.ended_at IS NULL
            AND EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.id)
        )
        WHERE last_activity < ?
        ORDER BY last_activity ASC
        LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, Int64(cutoff))
        sqlite3_bind_int64(stmt, 2, Int64(limit))
        var result: [(id: String, lastActivity: Int)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append((String(cString: sqlite3_column_text(stmt, 0)),
                           Int(sqlite3_column_int64(stmt, 1))))
        }
        return result
    }

    /// Finalize an abandoned run: close its dangling turns, close its tasks with
    /// `boundary_signal='orphaned'`, then close the run — all stamped at
    /// `endedAt` (the run's last activity), so a run abandoned last night does
    /// not report a twelve-hour turn. The run is closed LAST: any partial
    /// failure leaves `ended_at` NULL so the next sweep retries, instead of
    /// stranding an open task behind a closed run where nothing would find it.
    ///
    /// Returns the closed task ids so the caller can enqueue task-level evals —
    /// the reason for closing them. Mirrors bridge/src/apme/store.ts.
    @discardableResult
    func reapAbandonedRun(runId: String, endedAt: Int) -> [(id: String, category: String?)] {
        guard let db else { return [] }
        var bounds: (lo: Int, hi: Int)?
        var bstmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT MIN(turn_index), MAX(turn_index) FROM turns WHERE run_id = ?", -1, &bstmt, nil) == SQLITE_OK {
            sqlite3_bind_text(bstmt, 1, (runId as NSString).utf8String, -1, nil)
            if sqlite3_step(bstmt) == SQLITE_ROW, sqlite3_column_type(bstmt, 0) != SQLITE_NULL {
                bounds = (Int(sqlite3_column_int64(bstmt, 0)), Int(sqlite3_column_int64(bstmt, 1)))
            }
        }
        sqlite3_finalize(bstmt)

        var tasks: [(id: String, category: String?)] = []
        var tstmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT id, task_category FROM tasks WHERE run_id = ? AND ended_at IS NULL", -1, &tstmt, nil) == SQLITE_OK {
            sqlite3_bind_text(tstmt, 1, (runId as NSString).utf8String, -1, nil)
            while sqlite3_step(tstmt) == SQLITE_ROW {
                let id = String(cString: sqlite3_column_text(tstmt, 0))
                let cat = sqlite3_column_type(tstmt, 1) == SQLITE_NULL
                    ? nil : String(cString: sqlite3_column_text(tstmt, 1))
                tasks.append((id, cat))
            }
        }
        sqlite3_finalize(tstmt)

        func exec(_ sql: String, _ binds: [Any?]) {
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }
            for (i, b) in binds.enumerated() {
                let idx = Int32(i + 1)
                switch b {
                case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
                case let v as String: sqlite3_bind_text(stmt, idx, (v as NSString).utf8String, -1, nil)
                default: sqlite3_bind_null(stmt, idx)
                }
            }
            _ = sqlite3_step(stmt)
        }
        exec("UPDATE turns SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL", [endedAt, runId])
        exec("""
        UPDATE tasks SET ended_at = ?, boundary_signal = 'orphaned',
          first_turn_index = COALESCE(first_turn_index, ?),
          last_turn_index  = COALESCE(last_turn_index, ?)
        WHERE run_id = ? AND ended_at IS NULL
        """, [endedAt, bounds?.lo, bounds?.hi, runId])
        exec("UPDATE runs SET ended_at = ? WHERE id = ? AND ended_at IS NULL", [endedAt, runId])
        return tasks
    }

    /// Orphaned runs: started long ago, never closed, no turns.
    /// Typically from session bridges that crashed without cleanup.
    func listOrphanedRuns(staleSec: Int = 1800) -> [String] {
        guard let db else { return [] }
        let cutoff = Int(Date().timeIntervalSince1970 * 1000) - staleSec * 1000
        let sql = """
        SELECT r.id FROM runs r
        WHERE r.ended_at IS NULL
          AND r.started_at < ?
          AND r.task_prompt IS NULL
          AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.id)
        LIMIT 20
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, Int64(cutoff))
        var result: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(String(cString: sqlite3_column_text(stmt, 0)))
        }
        return result
    }

    /// Turns with response captured but no outcome yet — backfill candidates.
    /// Mirrors bridge/src/apme/store.ts listTurnsNeedingOutcome (commit e76325f7).
    func listTurnsNeedingOutcome(limit: Int = 20) -> [(id: String, runId: String)] {
        guard let db else { return [] }
        let sql = """
        SELECT id, run_id FROM turns
        WHERE response IS NOT NULL AND response != ''
          AND outcome IS NULL
        ORDER BY started_at DESC LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))
        var result: [(String, String)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append((
                String(cString: sqlite3_column_text(stmt, 0)),
                String(cString: sqlite3_column_text(stmt, 1))
            ))
        }
        return result
    }

    // MARK: - Turns

    func insertTurn(id: String, runId: String, turnIndex: Int, prompt: String?, startedAt: Int, taskId: String? = nil) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO turns (id, run_id, task_id, turn_index, prompt, started_at) VALUES (?,?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, id)
        bindText(stmt, 2, runId)
        bindTextOrNull(stmt, 3, taskId)
        sqlite3_bind_int(stmt, 4, Int32(turnIndex))
        bindTextOrNull(stmt, 5, prompt)
        sqlite3_bind_int64(stmt, 6, Int64(startedAt))
        sqlite3_step(stmt)
    }

    func updateTurn(id: String, fields: [String: Any?]) {
        guard let db, !fields.isEmpty else { return }
        let colMap: [String: String] = [
            "endedAt": "ended_at", "toolCalls": "tool_calls",
            "filesModified": "files_modified", "filesCreated": "files_created",
            "gitAfter": "git_after", "taskCategory": "task_category",
            "outcome": "outcome", "compositeScore": "composite_score",
            "efficiencyJson": "efficiency_json",
            "prompt": "prompt", "response": "response",
            "taskId": "task_id",
        ]
        var sets: [String] = []
        var vals: [Any?] = []
        for (key, val) in fields {
            guard let col = colMap[key] else { continue }
            sets.append("\(col) = ?")
            vals.append(val)
        }
        guard !sets.isEmpty else { return }
        vals.append(id)
        let sql = "UPDATE turns SET \(sets.joined(separator: ", ")) WHERE id = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        for (i, val) in vals.enumerated() {
            let idx = Int32(i + 1)
            switch val {
            case let s as String: sqlite3_bind_text(stmt, idx, (s as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let n as Int: sqlite3_bind_int64(stmt, idx, Int64(n))
            case let d as Double: sqlite3_bind_double(stmt, idx, d)
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        let result = sqlite3_step(stmt)
        if result != SQLITE_OK && result != SQLITE_DONE {
            DaemonLogger.shared.error("[APME] updateTurn failed: \(result) for id=\(id)")
            return
        }
        DaemonLogger.shared.debug("APME", "updateTurn: \(sets.count) fields for id=\(id.prefix(8))")
    }

    func listTurns(runId: String) -> [[String: Any]] {
        return query("SELECT * FROM turns WHERE run_id = '\(runId.replacingOccurrences(of: "'", with: "''"))' ORDER BY turn_index ASC")
    }

    func getTurn(id: String) -> [String: Any]? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT * FROM turns WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return rowToDict(stmt)
    }

    // MARK: - Tasks

    /// Insert a new task row. `boundary_signal` starts as "open" and is
    /// updated to the final boundary ("todo_complete" / "clear" / "session_end")
    /// when the task closes. Mirrors bridge/src/apme/store.ts insertTask.
    func insertTask(_ task: ApmeTask) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO tasks (id, run_id, task_index, boundary_signal, started_at, first_turn_index) VALUES (?,?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, task.id)
        bindText(stmt, 2, task.runId)
        sqlite3_bind_int(stmt, 3, Int32(task.taskIndex))
        bindText(stmt, 4, task.boundarySignal)
        sqlite3_bind_int64(stmt, 5, Int64(task.startedAt))
        if let v = task.firstTurnIndex { sqlite3_bind_int(stmt, 6, Int32(v)) } else { sqlite3_bind_null(stmt, 6) }
        sqlite3_step(stmt)
    }

    func updateTask(id: String, fields: [String: Any?]) {
        guard let db, !fields.isEmpty else { return }
        let colMap: [String: String] = [
            "endedAt": "ended_at",
            "firstTurnIndex": "first_turn_index",
            "lastTurnIndex": "last_turn_index",
            "summary": "summary",
            "outcome": "outcome",
            "compositeScore": "composite_score",
            "taskCategory": "task_category",
            "notesJson": "notes_json",
            "boundarySignal": "boundary_signal",
            "modelId": "model_id",
            "modelConfig": "model_config",
            "inputTokens": "input_tokens",
            "outputTokens": "output_tokens",
            "costUsd": "cost_usd",
            "latencyMs": "latency_ms",
        ]
        var sets: [String] = []
        var vals: [Any?] = []
        for (key, val) in fields {
            guard let col = colMap[key] else { continue }
            sets.append("\(col) = ?")
            vals.append(val)
        }
        guard !sets.isEmpty else { return }
        vals.append(id)
        let sql = "UPDATE tasks SET \(sets.joined(separator: ", ")) WHERE id = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        for (i, val) in vals.enumerated() {
            let idx = Int32(i + 1)
            switch val {
            case let s as String: sqlite3_bind_text(stmt, idx, (s as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let n as Int: sqlite3_bind_int64(stmt, idx, Int64(n))
            case let d as Double: sqlite3_bind_double(stmt, idx, d)
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        let result = sqlite3_step(stmt)
        if result != SQLITE_OK && result != SQLITE_DONE {
            DaemonLogger.shared.error("[APME] updateTask failed: \(result) for id=\(id)")
            return
        }
        DaemonLogger.shared.debug("APME", "updateTask: \(sets.count) fields for id=\(id.prefix(8))")
    }

    func getTask(id: String) -> ApmeTask? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT * FROM tasks WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return Self.rowToTask(rowToDict(stmt))
    }

    func listTasksForRun(_ runId: String) -> [ApmeTask] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT * FROM tasks WHERE run_id = ? ORDER BY task_index ASC",
            -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        var result: [ApmeTask] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(Self.rowToTask(rowToDict(stmt)))
        }
        return result
    }

    func listTurnsForTask(_ taskId: String) -> [[String: Any]] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT * FROM turns WHERE task_id = ? ORDER BY turn_index ASC",
            -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, taskId)
        var result: [[String: Any]] = []
        while sqlite3_step(stmt) == SQLITE_ROW { result.append(rowToDict(stmt)) }
        return result
    }

    /// Drop a task row. Used for empty tasks (no turns attached) so the
    /// dashboard doesn't show phantom entries from back-to-back boundary
    /// signals. Mirrors the empty-task drop path in bridge/src/apme/collector.ts.
    func deleteTask(id: String) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "DELETE FROM tasks WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, id)
        sqlite3_step(stmt)
    }

    func insertEvalForTask(_ eval: ApmeEval, taskId: String) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO evals (run_id, task_id, layer, metric, score, raw, rubric_ver, judge_model, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, eval.runId)
        bindText(stmt, 2, taskId)
        bindText(stmt, 3, eval.layer)
        bindText(stmt, 4, eval.metric)
        sqlite3_bind_double(stmt, 5, eval.score)
        bindTextOrNull(stmt, 6, eval.raw)
        if let v = eval.rubricVer { sqlite3_bind_int(stmt, 7, Int32(v)) } else { sqlite3_bind_null(stmt, 7) }
        bindTextOrNull(stmt, 8, eval.judgeModel)
        sqlite3_bind_int64(stmt, 9, Int64(eval.createdAt))
        sqlite3_step(stmt)
    }

    func listEvalsForTask(_ taskId: String) -> [ApmeEval] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT id, run_id, layer, metric, score, raw, rubric_ver, judge_model, created_at FROM evals WHERE task_id = ? ORDER BY created_at ASC",
            -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, taskId)
        var result: [ApmeEval] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(ApmeEval(
                id: Int(sqlite3_column_int(stmt, 0)),
                runId: String(cString: sqlite3_column_text(stmt, 1)),
                layer: String(cString: sqlite3_column_text(stmt, 2)),
                metric: String(cString: sqlite3_column_text(stmt, 3)),
                score: sqlite3_column_double(stmt, 4),
                raw: sqlite3_column_type(stmt, 5) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 5)),
                rubricVer: sqlite3_column_type(stmt, 6) == SQLITE_NULL ? nil : Int(sqlite3_column_int(stmt, 6)),
                judgeModel: sqlite3_column_type(stmt, 7) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 7)),
                createdAt: Int(sqlite3_column_int64(stmt, 8))
            ))
        }
        return result
    }

    // MARK: - Sample events (typed trajectory)

    /// Append one typed trajectory event. INSERT OR IGNORE on the UNIQUE
    /// (task_id, dedup_key) index makes storage-time dedup atomic. Returns true
    /// if a row was actually inserted. Mirrors bridge/src/apme/store.ts.
    @discardableResult
    func insertSampleEvent(taskId: String, runId: String, turnIndex: Int?, seq: Int, ts: Int,
                           kind: String, model: String?, inputTokens: Int?, outputTokens: Int?,
                           costUsd: Double?, latencyMs: Int?, toolName: String?, toolStatus: String?,
                           toolError: String?, payload: String?, dedupKey: String?) -> Bool {
        guard let db else { return false }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            """
            INSERT OR IGNORE INTO sample_events
              (task_id, run_id, turn_index, seq, ts, kind, model, input_tokens, output_tokens,
               cost_usd, latency_ms, tool_name, tool_status, tool_error, payload, dedup_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, -1, &stmt, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, taskId)
        bindText(stmt, 2, runId)
        if let v = turnIndex { sqlite3_bind_int(stmt, 3, Int32(v)) } else { sqlite3_bind_null(stmt, 3) }
        sqlite3_bind_int(stmt, 4, Int32(seq))
        sqlite3_bind_int64(stmt, 5, Int64(ts))
        bindText(stmt, 6, kind)
        bindTextOrNull(stmt, 7, model)
        if let v = inputTokens { sqlite3_bind_int64(stmt, 8, Int64(v)) } else { sqlite3_bind_null(stmt, 8) }
        if let v = outputTokens { sqlite3_bind_int64(stmt, 9, Int64(v)) } else { sqlite3_bind_null(stmt, 9) }
        if let v = costUsd { sqlite3_bind_double(stmt, 10, v) } else { sqlite3_bind_null(stmt, 10) }
        if let v = latencyMs { sqlite3_bind_int64(stmt, 11, Int64(v)) } else { sqlite3_bind_null(stmt, 11) }
        bindTextOrNull(stmt, 12, toolName)
        bindTextOrNull(stmt, 13, toolStatus)
        bindTextOrNull(stmt, 14, toolError)
        bindTextOrNull(stmt, 15, payload)
        bindTextOrNull(stmt, 16, dedupKey)
        sqlite3_step(stmt)
        return sqlite3_changes(db) > 0
    }

    /// Next monotonic seq within a task.
    func nextSampleSeq(_ taskId: String) -> Int {
        guard let db else { return 0 }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COALESCE(MAX(seq),-1)+1 FROM sample_events WHERE task_id = ?", -1, &stmt, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, taskId)
        return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
    }

    /// All trajectory event rows for a task (snake_case column dicts), ordered.
    func listSampleEventRows(_ taskId: String) -> [[String: Any]] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT * FROM sample_events WHERE task_id = ? ORDER BY seq ASC", -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, taskId)
        var result: [[String: Any]] = []
        while sqlite3_step(stmt) == SQLITE_ROW { result.append(rowToDict(stmt)) }
        return result
    }

    /// Find a tool event still pending for (task, turn, toolName), to resolve it.
    func findPendingToolEvent(taskId: String, turnIndex: Int, toolName: String) -> [String: Any]? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            """
            SELECT * FROM sample_events
            WHERE task_id = ? AND turn_index = ? AND kind = 'tool' AND tool_name = ?
              AND (tool_status IS NULL OR tool_status = 'pending')
            ORDER BY seq DESC LIMIT 1
            """, -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, taskId)
        sqlite3_bind_int(stmt, 2, Int32(turnIndex))
        bindText(stmt, 3, toolName)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return rowToDict(stmt)
    }

    /// Update a previously-inserted event (tool pending→resolved) by id.
    func updateSampleEvent(id: Int, fields: [String: Any?]) {
        guard let db, !fields.isEmpty else { return }
        let colMap: [String: String] = [
            "toolStatus": "tool_status", "toolError": "tool_error", "payload": "payload",
            "costUsd": "cost_usd", "latencyMs": "latency_ms", "model": "model",
            "inputTokens": "input_tokens", "outputTokens": "output_tokens", "ts": "ts",
        ]
        var sets: [String] = []
        var vals: [Any?] = []
        for (key, val) in fields {
            guard let col = colMap[key] else { continue }
            sets.append("\(col) = ?")
            vals.append(val)
        }
        guard !sets.isEmpty else { return }
        vals.append(id)
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "UPDATE sample_events SET \(sets.joined(separator: ", ")) WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        for (i, val) in vals.enumerated() {
            let idx = Int32(i + 1)
            switch val {
            case let s as String: sqlite3_bind_text(stmt, idx, (s as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let n as Int: sqlite3_bind_int64(stmt, idx, Int64(n))
            case let d as Double: sqlite3_bind_double(stmt, idx, d)
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        sqlite3_step(stmt)
    }

    /// Recompute the task's cost aggregate by summing its ModelEvents.
    func recomputeSampleCost(_ taskId: String) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            """
            SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                   COALESCE(SUM(cost_usd),0), COALESCE(SUM(latency_ms),0)
            FROM sample_events WHERE task_id = ? AND kind = 'model'
            """, -1, &stmt, nil) == SQLITE_OK else { return }
        var it = 0, ot = 0, lm = 0
        var cu = 0.0
        if sqlite3_step(stmt) == SQLITE_ROW {
            it = Int(sqlite3_column_int64(stmt, 0)); ot = Int(sqlite3_column_int64(stmt, 1))
            cu = sqlite3_column_double(stmt, 2); lm = Int(sqlite3_column_int64(stmt, 3))
        }
        sqlite3_finalize(stmt)
        updateTask(id: taskId, fields: ["inputTokens": it, "outputTokens": ot, "costUsd": cu, "latencyMs": lm])
    }

    /// Sample-granularity scorecard (quality vs cost) — the recommender + Pareto input.
    func sampleScorecard() -> [[String: Any]] {
        return query("SELECT * FROM v_sample_scorecard")
    }

    /// Assemble the SessionSample as a JSON-ready dict (header + cost + events).
    /// Used by the HTTP /apme/run/:id route and the runner's judge prompt.
    func getSampleDict(_ taskId: String) -> [String: Any]? {
        guard let task = getTask(id: taskId) else { return nil }
        let run = getRun(id: task.runId)
        let events = listSampleEventRows(taskId).map { Self.sampleEventRowToDict($0) }
        var modelConfig: [String: Any]? = nil
        if let mc = task.modelConfig, let data = mc.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            modelConfig = obj
        }
        let modelId = task.modelId ?? run?.modelId ?? (modelConfig?["modelId"] as? String) ?? "unknown"
        return [
            "id": task.id,
            "runId": task.runId,
            "sessionId": run?.sessionId ?? "",
            "agentType": run?.agentType ?? "claude-code",
            "index": task.taskIndex,
            "boundarySignal": task.boundarySignal,
            "startedAt": task.startedAt,
            "endedAt": task.endedAt as Any,
            "model": modelConfig ?? ["modelId": modelId],
            "projectName": run?.projectName as Any,
            "projectPath": run?.projectPath as Any,
            "events": events,
            "cost": [
                "inputTokens": task.inputTokens ?? 0,
                "outputTokens": task.outputTokens ?? 0,
                "costUsd": task.costUsd ?? 0,
                "latencyMs": task.latencyMs ?? 0,
            ],
            "summary": task.summary as Any,
            "outcome": task.outcome as Any,
            "compositeScore": task.compositeScore as Any,
            "taskCategory": task.taskCategory as Any,
        ]
    }

    /// Decode a stored sample_events row into a JSON-ready typed event dict.
    static func sampleEventRowToDict(_ r: [String: Any]) -> [String: Any] {
        let kind = r["kind"] as? String ?? "info"
        let turnIndex = r["turn_index"] as? Int ?? 0
        let ts = r["ts"] as? Int ?? 0
        var p: [String: Any] = [:]
        if let s = r["payload"] as? String, let data = s.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { p = obj }
        var out: [String: Any] = ["kind": kind, "turnIndex": turnIndex, "ts": ts]
        switch kind {
        case "user_message": out["text"] = p["text"] as? String ?? ""
        case "assistant_message":
            out["text"] = p["text"] as? String ?? ""
            out["responseKind"] = p["responseKind"] as? String ?? "text"
        case "model":
            out["model"] = r["model"] as? String ?? "unknown"
            out["inputTokens"] = r["input_tokens"] as? Int ?? 0
            out["outputTokens"] = r["output_tokens"] as? Int ?? 0
            out["costUsd"] = r["cost_usd"] as? Double ?? 0
            out["latencyMs"] = r["latency_ms"] as? Int ?? 0
        case "tool":
            out["name"] = r["tool_name"] as? String ?? "tool"
            if let input = p["input"] { out["input"] = input }
            if let output = p["output"] { out["output"] = output }
            if let status = r["tool_status"] as? String { out["status"] = status }
            if let err = r["tool_error"] as? String { out["error"] = err }
        case "state":
            out["from"] = p["from"]
            out["to"] = p["to"] as? String ?? "unknown"
        default:
            out["label"] = p["label"] as? String ?? "info"
            out["detail"] = p["detail"]
        }
        return out
    }

    private static func rowToTask(_ d: [String: Any]) -> ApmeTask {
        return ApmeTask(
            id: d["id"] as? String ?? "",
            runId: d["run_id"] as? String ?? "",
            taskIndex: d["task_index"] as? Int ?? 0,
            boundarySignal: d["boundary_signal"] as? String ?? "open",
            startedAt: d["started_at"] as? Int ?? 0,
            endedAt: d["ended_at"] as? Int,
            firstTurnIndex: d["first_turn_index"] as? Int,
            lastTurnIndex: d["last_turn_index"] as? Int,
            summary: d["summary"] as? String,
            outcome: d["outcome"] as? String,
            compositeScore: d["composite_score"] as? Double,
            taskCategory: d["task_category"] as? String,
            notesJson: d["notes_json"] as? String,
            modelId: d["model_id"] as? String,
            modelConfig: d["model_config"] as? String,
            inputTokens: d["input_tokens"] as? Int,
            outputTokens: d["output_tokens"] as? Int,
            costUsd: d["cost_usd"] as? Double,
            latencyMs: d["latency_ms"] as? Int
        )
    }

    // MARK: - Steps

    func insertStep(runId: String, ts: Int, kind: String, toolName: String?, payload: String) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO steps (run_id, ts, kind, tool_name, payload) VALUES (?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        sqlite3_bind_int64(stmt, 2, Int64(ts))
        bindText(stmt, 3, kind)
        bindTextOrNull(stmt, 4, toolName)
        bindText(stmt, 5, payload)
        sqlite3_step(stmt)
    }

    func listSteps(runId: String) -> [ApmeStep] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT * FROM steps WHERE run_id = ? ORDER BY ts ASC",
            -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        var result: [ApmeStep] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(ApmeStep(
                id: Int(sqlite3_column_int(stmt, 0)),
                runId: String(cString: sqlite3_column_text(stmt, 1)),
                ts: Int(sqlite3_column_int64(stmt, 2)),
                kind: String(cString: sqlite3_column_text(stmt, 3)),
                toolName: sqlite3_column_type(stmt, 4) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 4)),
                payload: sqlite3_column_type(stmt, 5) == SQLITE_NULL ? "{}" : String(cString: sqlite3_column_text(stmt, 5))
            ))
        }
        return result
    }

    // MARK: - Evals

    func insertEval(_ eval: ApmeEval) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO evals (run_id, layer, metric, score, raw, rubric_ver, judge_model, created_at) VALUES (?,?,?,?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, eval.runId)
        bindText(stmt, 2, eval.layer)
        bindText(stmt, 3, eval.metric)
        sqlite3_bind_double(stmt, 4, eval.score)
        bindTextOrNull(stmt, 5, eval.raw)
        if let v = eval.rubricVer { sqlite3_bind_int(stmt, 6, Int32(v)) } else { sqlite3_bind_null(stmt, 6) }
        bindTextOrNull(stmt, 7, eval.judgeModel)
        sqlite3_bind_int64(stmt, 8, Int64(eval.createdAt))
        sqlite3_step(stmt)
    }

    /// Insert an eval row associated with both a run and a turn (turn_judge layer).
    /// Mirrors bridge/src/apme/store.ts insertEvalForTurn.
    func insertEvalForTurn(_ eval: ApmeEval, turnId: String) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO evals (run_id, turn_id, layer, metric, score, raw, rubric_ver, judge_model, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, eval.runId)
        bindText(stmt, 2, turnId)
        bindText(stmt, 3, eval.layer)
        bindText(stmt, 4, eval.metric)
        sqlite3_bind_double(stmt, 5, eval.score)
        bindTextOrNull(stmt, 6, eval.raw)
        if let v = eval.rubricVer { sqlite3_bind_int(stmt, 7, Int32(v)) } else { sqlite3_bind_null(stmt, 7) }
        bindTextOrNull(stmt, 8, eval.judgeModel)
        sqlite3_bind_int64(stmt, 9, Int64(eval.createdAt))
        sqlite3_step(stmt)
    }

    func listEvalsForTurn(_ turnId: String) -> [ApmeEval] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT id, run_id, layer, metric, score, raw, rubric_ver, judge_model, created_at FROM evals WHERE turn_id = ? ORDER BY created_at ASC",
            -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, turnId)
        var result: [ApmeEval] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(ApmeEval(
                id: Int(sqlite3_column_int(stmt, 0)),
                runId: String(cString: sqlite3_column_text(stmt, 1)),
                layer: String(cString: sqlite3_column_text(stmt, 2)),
                metric: String(cString: sqlite3_column_text(stmt, 3)),
                score: sqlite3_column_double(stmt, 4),
                raw: sqlite3_column_type(stmt, 5) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 5)),
                rubricVer: sqlite3_column_type(stmt, 6) == SQLITE_NULL ? nil : Int(sqlite3_column_int(stmt, 6)),
                judgeModel: sqlite3_column_type(stmt, 7) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 7)),
                createdAt: Int(sqlite3_column_int64(stmt, 8))
            ))
        }
        return result
    }

    func listEvalsForRun(_ runId: String) -> [ApmeEval] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        // Explicit column list — evals schema now includes turn_id. SELECT *
        // returns columns in table-creation order, which differs between freshly
        // DDL'd databases (turn_id at col 2) and migrated databases (turn_id appended
        // at the end). Using an explicit list makes reads position-stable.
        guard sqlite3_prepare_v2(db,
            "SELECT id, run_id, layer, metric, score, raw, rubric_ver, judge_model, created_at FROM evals WHERE run_id = ? ORDER BY created_at ASC",
            -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        var result: [ApmeEval] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(ApmeEval(
                id: Int(sqlite3_column_int(stmt, 0)),
                runId: String(cString: sqlite3_column_text(stmt, 1)),
                layer: String(cString: sqlite3_column_text(stmt, 2)),
                metric: String(cString: sqlite3_column_text(stmt, 3)),
                score: sqlite3_column_double(stmt, 4),
                raw: sqlite3_column_type(stmt, 5) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 5)),
                rubricVer: sqlite3_column_type(stmt, 6) == SQLITE_NULL ? nil : Int(sqlite3_column_int(stmt, 6)),
                judgeModel: sqlite3_column_type(stmt, 7) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 7)),
                createdAt: Int(sqlite3_column_int64(stmt, 8))
            ))
        }
        return result
    }

    // MARK: - Vibe

    func insertVibe(runId: String, verdict: String, note: String?) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO vibe_feedback (run_id, verdict, note, ts) VALUES (?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        bindText(stmt, 2, verdict)
        bindTextOrNull(stmt, 3, note)
        sqlite3_bind_int64(stmt, 4, Int64(Date().timeIntervalSince1970 * 1000))
        sqlite3_step(stmt)
    }

    /// Most recent vibe verdict for a run, or nil if none.
    /// Mirrors bridge/src/apme/store.ts latestVibeForRun (used by computeComposite).
    func latestVibeForRun(_ runId: String) -> (verdict: String, note: String?, ts: Int)? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT verdict, note, ts FROM vibe_feedback WHERE run_id = ? ORDER BY ts DESC LIMIT 1",
            -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return (
            String(cString: sqlite3_column_text(stmt, 0)),
            sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 1)),
            Int(sqlite3_column_int64(stmt, 2))
        )
    }

    // MARK: - Scorecard

    func scorecard() -> [[String: Any]] {
        return query("SELECT * FROM v_model_scorecard")
    }

    func categoryScorecard() -> [[String: Any]] {
        return query("SELECT * FROM v_category_scorecard")
    }

    // MARK: - Rubric

    /// Append a new rubric version and return the assigned version number.
    /// Used by the tuner when it auto-proposes an improved rubric — the new
    /// row's `parent_ver` points at the version it was derived from.
    /// Mirrors bridge/src/apme/store.ts `appendRubric`.
    @discardableResult
    func appendRubric(purpose: String, prompt: String, weights: String, parentVer: Int?, notes: String?) -> Int {
        guard let db else { return 0 }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COALESCE(MAX(version), 0) + 1 FROM rubrics", -1, &stmt, nil) == SQLITE_OK else { return 0 }
        var next: Int = 1
        if sqlite3_step(stmt) == SQLITE_ROW { next = Int(sqlite3_column_int(stmt, 0)) }
        sqlite3_finalize(stmt); stmt = nil

        guard sqlite3_prepare_v2(db,
            "INSERT INTO rubrics (version, purpose, prompt, weights, created_at, parent_ver, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
            -1, &stmt, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(next))
        bindText(stmt, 2, purpose)
        bindText(stmt, 3, prompt)
        bindText(stmt, 4, weights)
        sqlite3_bind_int64(stmt, 5, Int64(Date().timeIntervalSince1970 * 1000))
        if let p = parentVer { sqlite3_bind_int(stmt, 6, Int32(p)) } else { sqlite3_bind_null(stmt, 6) }
        bindTextOrNull(stmt, 7, notes)
        sqlite3_step(stmt)
        return next
    }

    /// Fetch the most recent rubric for a given purpose.
    /// When `purpose` is a category name (e.g. "conversation", "research"), this
    /// returns that category's rubric with its domain-specific axes. Callers
    /// should fall back to `getCurrentRubric(purpose: "general")` if nil.
    func getCurrentRubric(purpose: String = "general") -> [String: Any]? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT * FROM rubrics WHERE purpose = ? ORDER BY version DESC LIMIT 1",
            -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, purpose)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return rowToDict(stmt)
    }

    // MARK: - Private helpers

    private func exec(_ sql: String) {
        guard let db else { return }
        sqlite3_exec(db, sql, nil, nil, nil)
    }

    private func migrateSchema() {
        guard db != nil else { return }
        // runs table
        let runsCols = query("PRAGMA table_info(runs)").compactMap { $0["name"] as? String }
        let runsMigrations: [(String, String)] = [
            ("task_signals",         "ALTER TABLE runs ADD COLUMN task_signals TEXT"),
            ("task_category",        "ALTER TABLE runs ADD COLUMN task_category TEXT"),
            ("task_category_source", "ALTER TABLE runs ADD COLUMN task_category_source TEXT DEFAULT 'auto'"),
            ("outcome",              "ALTER TABLE runs ADD COLUMN outcome TEXT"),
            ("outcome_confidence",   "ALTER TABLE runs ADD COLUMN outcome_confidence TEXT"),
            ("efficiency_json",      "ALTER TABLE runs ADD COLUMN efficiency_json TEXT"),
            ("composite_score",      "ALTER TABLE runs ADD COLUMN composite_score REAL"),
        ]
        for (col, sql) in runsMigrations where !runsCols.contains(col) { exec(sql) }

        // turns table — schema added turn-level category/outcome/composite in commit e76325f7
        let turnsCols = query("PRAGMA table_info(turns)").compactMap { $0["name"] as? String }
        let turnsMigrations: [(String, String)] = [
            ("response",        "ALTER TABLE turns ADD COLUMN response TEXT"),
            ("task_category",   "ALTER TABLE turns ADD COLUMN task_category TEXT"),
            ("outcome",         "ALTER TABLE turns ADD COLUMN outcome TEXT"),
            ("composite_score", "ALTER TABLE turns ADD COLUMN composite_score REAL"),
            ("efficiency_json", "ALTER TABLE turns ADD COLUMN efficiency_json TEXT"),
        ]
        for (col, sql) in turnsMigrations where !turnsCols.contains(col) { exec(sql) }

        // evals table — turn_id FK for turn_judge rows, task_id FK for task_judge rows
        let evalsCols = query("PRAGMA table_info(evals)").compactMap { $0["name"] as? String }
        if !evalsCols.contains("turn_id") {
            exec("ALTER TABLE evals ADD COLUMN turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE")
        }
        if !evalsCols.contains("task_id") {
            exec("ALTER TABLE evals ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE")
        }

        // tasks table — created via CREATE TABLE IF NOT EXISTS above; older
        // DBs need the turns.task_id column backfilled via ALTER.
        if !turnsCols.contains("task_id") {
            exec("ALTER TABLE turns ADD COLUMN task_id TEXT")
            exec("CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id)")
        }

        // tasks sample-header columns (model identity + cost) — SessionSample rebuild.
        let tasksCols = query("PRAGMA table_info(tasks)").compactMap { $0["name"] as? String }
        let tasksMigrations: [(String, String)] = [
            ("model_id",      "ALTER TABLE tasks ADD COLUMN model_id TEXT"),
            ("model_config",  "ALTER TABLE tasks ADD COLUMN model_config TEXT"),
            ("input_tokens",  "ALTER TABLE tasks ADD COLUMN input_tokens INTEGER"),
            ("output_tokens", "ALTER TABLE tasks ADD COLUMN output_tokens INTEGER"),
            ("cost_usd",      "ALTER TABLE tasks ADD COLUMN cost_usd REAL"),
            ("latency_ms",    "ALTER TABLE tasks ADD COLUMN latency_ms INTEGER"),
        ]
        for (col, sql) in tasksMigrations where !tasksCols.contains(col) { exec(sql) }

        // ── Graph-integrity columns (mirrors bridge/src/apme/store.ts) ──
        // Both daemons write the same sqlite layout, so a DB created by either
        // must carry these or the other's graph projection silently loses edges.
        //  1. sample_events addressed its turn by `turn_index`, unique only
        //     within a run — there was no event→turn edge at all.
        //  2. `/clear` opens a fresh run with no pointer to the one it
        //     continues, so one conversation appeared as N disconnected runs.
        let sevCols = query("PRAGMA table_info(sample_events)").compactMap { $0["name"] as? String }
        if !sevCols.contains("turn_id") {
            exec("ALTER TABLE sample_events ADD COLUMN turn_id TEXT")
            exec("CREATE INDEX IF NOT EXISTS idx_sevents_turn ON sample_events(turn_id)")
            // One-shot backfill from the compound key the column replaces.
            exec("""
            UPDATE sample_events SET turn_id = (
              SELECT t.id FROM turns t
              WHERE t.run_id = sample_events.run_id AND t.turn_index = sample_events.turn_index
            ) WHERE turn_id IS NULL AND turn_index IS NOT NULL
            """)
        }
        if !runsCols.contains("parent_run_id") {
            exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT")
            exec("CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id)")
        }

        // ── Covering indexes for the per-run/per-task rollups ──
        // `MAX(ts)` over a run's steps was reading full rows to reach one
        // integer, and `steps.payload` holds entire hook bodies — the
        // abandoned-run sweep touched hundreds of megabytes and took 22s on a
        // real store. (run_id, ts) answers it from the index alone.
        for sql in [
            "CREATE INDEX IF NOT EXISTS idx_steps_run_ts ON steps(run_id, ts)",
            "CREATE INDEX IF NOT EXISTS idx_sevents_run_ts ON sample_events(run_id, ts)",
            "CREATE INDEX IF NOT EXISTS idx_turns_run_started ON turns(run_id, started_at)",
            "CREATE INDEX IF NOT EXISTS idx_evals_task ON evals(task_id)",
            "CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks(started_at)",
        ] { exec(sql) }
    }

    private func seedDefaultRubric() {
        guard let db else { return }
        // Mirrors bridge/src/apme/store.ts CATEGORY_RUBRICS — idempotent:
        // seeds any rubric whose `purpose` doesn't already exist. This lets
        // the Swift daemon and Node bridge coexist on the same sqlite without
        // colliding and ensures category-aware turn_judge has the right axes.
        let now = Int(Date().timeIntervalSince1970 * 1000)

        func existsRubric(_ purpose: String) -> Bool {
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM rubrics WHERE purpose = ?", -1, &stmt, nil) == SQLITE_OK else { return false }
            sqlite3_bind_text(stmt, 1, (purpose as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            return sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_int(stmt, 0) > 0
        }

        func insertRubric(version: Int?, purpose: String, prompt: String, weights: String, notes: String) {
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            if let v = version {
                guard sqlite3_prepare_v2(db,
                    "INSERT INTO rubrics (version, purpose, prompt, weights, created_at, parent_ver, notes) VALUES (?,?,?,?,?,NULL,?)",
                    -1, &stmt, nil) == SQLITE_OK else { return }
                sqlite3_bind_int(stmt, 1, Int32(v))
                sqlite3_bind_text(stmt, 2, (purpose as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                sqlite3_bind_text(stmt, 3, (prompt as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                sqlite3_bind_text(stmt, 4, (weights as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                sqlite3_bind_int64(stmt, 5, Int64(now))
                sqlite3_bind_text(stmt, 6, (notes as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            } else {
                guard sqlite3_prepare_v2(db,
                    "INSERT INTO rubrics (purpose, prompt, weights, created_at, parent_ver, notes) VALUES (?,?,?,?,NULL,?)",
                    -1, &stmt, nil) == SQLITE_OK else { return }
                sqlite3_bind_text(stmt, 1, (purpose as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                sqlite3_bind_text(stmt, 2, (prompt as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                sqlite3_bind_text(stmt, 3, (weights as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                sqlite3_bind_int64(stmt, 4, Int64(now))
                sqlite3_bind_text(stmt, 5, (notes as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            }
            sqlite3_step(stmt)
        }

        // 1. General rubric (v1) — seeded only if no 'general' rubric exists.
        if !existsRubric("general") {
            insertRubric(
                version: 1,
                purpose: "general",
                prompt: """
                You are a senior engineer evaluating whether an AI coding agent completed the user's task.

                Given the task prompt and the git diff produced, evaluate the agent's contribution.
                Score each axis as a float in [0,1] where 0=failed and 1=excellent.

                Axes:
                - task_completion: Did the agent actually do what the user asked? A perfect score means the task prompt's request was fully addressed in the diff. A zero means nothing relevant was done.
                - code_quality: Is the code correct, safe, and maintainable? Check for bugs, missing error handling, security issues, and dead code.
                - efficiency: Did the agent make minimal, focused changes? Penalize unrelated modifications, unnecessary refactoring, or verbose solutions to simple problems.
                - overall: Your holistic judgment. Weight task_completion most heavily — a session that completes the task with decent quality is better than a perfect-style session that misses the point.

                Important: Explain your reasoning with specific references to what was done and what was missed. List concrete items with checkmarks (done) and crosses (missed). This reasoning will be shown to the user for verification.

                Return strict JSON: {"task_completion":N,"code_quality":N,"efficiency":N,"overall":N,"reasoning":"...", "done":["item1","item2"], "missed":["item1"]}.
                """,
                weights: #"{"task_completion":0.5,"code_quality":0.3,"efficiency":0.2}"#,
                notes: "seeded default"
            )
        }

        // 2. Category-specific rubrics — each matches TS store.ts CATEGORY_RUBRICS.
        struct CategoryRubric { let purpose: String; let prompt: String; let weights: String; let notes: String }
        let categoryRubrics: [CategoryRubric] = [
            CategoryRubric(purpose: "conversation", prompt: """
                You are evaluating an AI assistant's response to a conversational query or question.
                The user asked a question and the agent responded. Evaluate the quality of the response.

                Score each axis as a float in [0,1] where 0=failed and 1=excellent.

                Axes:
                - accuracy: Is the answer factually correct? For math/logic questions, is the result right?
                - helpfulness: Does the response address what the user actually wanted? Is it complete?
                - conciseness: Is the response appropriately sized? Not too verbose, not too terse.
                - overall: Holistic judgment. An accurate, helpful response scores high even if brief.

                Return strict JSON: {"accuracy":N,"helpfulness":N,"conciseness":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.
                """,
                weights: #"{"accuracy":0.5,"helpfulness":0.3,"conciseness":0.2}"#,
                notes: "conversation/Q&A evaluation"),
            CategoryRubric(purpose: "planning", prompt: """
                You are evaluating an AI agent's planning session. The user asked the agent to plan an approach for a task.

                Score each axis as a float in [0,1] where 0=failed and 1=excellent.

                Axes:
                - completeness: Does the plan cover all aspects of the request? Are edge cases considered?
                - feasibility: Is the plan technically sound and implementable? Are the proposed steps realistic?
                - clarity: Is the plan well-structured, easy to follow, with clear priorities?
                - overall: Holistic judgment. A thorough, actionable plan scores high.

                Return strict JSON: {"completeness":N,"feasibility":N,"clarity":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.
                """,
                weights: #"{"completeness":0.4,"feasibility":0.35,"clarity":0.25}"#,
                notes: "planning/architecture evaluation"),
            CategoryRubric(purpose: "research", prompt: """
                You are evaluating an AI agent's research session. The user asked the agent to investigate, search, or gather information.

                Score each axis as a float in [0,1] where 0=failed and 1=excellent.

                Axes:
                - thoroughness: Did the agent search broadly enough? Were relevant files, docs, or sources explored?
                - relevance: Is the information found actually relevant to the user's question?
                - synthesis: Did the agent synthesize findings into a clear answer or summary?
                - overall: Holistic judgment. Research that finds the right answer efficiently scores high.

                Return strict JSON: {"thoroughness":N,"relevance":N,"synthesis":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.
                """,
                weights: #"{"thoroughness":0.3,"relevance":0.4,"synthesis":0.3}"#,
                notes: "research/investigation evaluation"),
            CategoryRubric(purpose: "debugging", prompt: """
                You are evaluating an AI agent's debugging session. The user reported a bug and the agent investigated and attempted to fix it.

                Given the task prompt and the git diff produced, evaluate the debugging effort.
                Score each axis as a float in [0,1] where 0=failed and 1=excellent.

                Axes:
                - diagnosis: Did the agent correctly identify the root cause? Not just symptoms but the actual bug?
                - fix_quality: Is the fix correct, minimal, and safe? Does it avoid introducing new bugs?
                - verification: Did the agent verify the fix (run tests, check edge cases)?
                - overall: Holistic judgment. A correct diagnosis + clean fix scores high.

                Return strict JSON: {"diagnosis":N,"fix_quality":N,"verification":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.
                """,
                weights: #"{"diagnosis":0.35,"fix_quality":0.4,"verification":0.25}"#,
                notes: "debugging evaluation"),
            CategoryRubric(purpose: "refactoring", prompt: """
                You are evaluating an AI agent's refactoring session. The user asked the agent to restructure or improve existing code.

                Given the task prompt and the git diff produced, evaluate the refactoring.
                Score each axis as a float in [0,1] where 0=failed and 1=excellent.

                Axes:
                - safety: Does the refactoring preserve existing behavior? No regressions introduced?
                - improvement: Is the resulting code genuinely better? Cleaner, more maintainable, less duplication?
                - scope: Was the refactoring appropriately scoped? Not too aggressive, not too timid?
                - overall: Holistic judgment. Safe refactoring that clearly improves the code scores high.

                Return strict JSON: {"safety":N,"improvement":N,"scope":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.
                """,
                weights: #"{"safety":0.4,"improvement":0.35,"scope":0.25}"#,
                notes: "refactoring evaluation"),
            CategoryRubric(purpose: "review", prompt: """
                You are evaluating an AI agent's code review session. The user asked the agent to review code for issues.

                Score each axis as a float in [0,1] where 0=failed and 1=excellent.

                Axes:
                - coverage: Did the review examine all relevant areas? Were critical paths checked?
                - insight: Did the review catch real issues (not just style nits)? Were suggestions actionable?
                - accuracy: Are the identified issues real problems? Low false positive rate?
                - overall: Holistic judgment. A review that catches important bugs/issues scores high.

                Return strict JSON: {"coverage":N,"insight":N,"accuracy":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.
                """,
                weights: #"{"coverage":0.3,"insight":0.4,"accuracy":0.3}"#,
                notes: "code review evaluation"),
            CategoryRubric(purpose: "ops", prompt: """
                You are evaluating an AI agent's ops/DevOps session. The user asked the agent to perform operational tasks (git, CI/CD, deployment, configuration).

                Score each axis as a float in [0,1] where 0=failed and 1=excellent.

                Axes:
                - correctness: Did the operations complete successfully? Were commands appropriate?
                - safety: Were destructive operations handled carefully? Were backups/confirmations used?
                - completeness: Were all requested steps performed? Nothing left half-done?
                - overall: Holistic judgment. Correct, safe ops that complete the task score high.

                Return strict JSON: {"correctness":N,"safety":N,"completeness":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.
                """,
                weights: #"{"correctness":0.4,"safety":0.35,"completeness":0.25}"#,
                notes: "ops/DevOps evaluation"),
            CategoryRubric(purpose: "task_rollup", prompt: """
                You are evaluating a multi-turn AI agent task that has just ended.
                The boundary signal that closed the task tells you HOW it ended:
                  - todo_complete : the agent itself marked every TodoWrite item as completed (self-declared done)
                  - clear         : the user typed /clear to reset context (often: user gave up or moved on)
                  - session_end   : the agent process exited (could be done, could be interrupted)
                  - manual        : a human marked the boundary explicitly

                You receive: the task's category (coding/planning/research/…), the number of turns,
                the boundary signal, and the full Turn 0..N transcript (user prompt → agent response).

                Your job is a one-sentence rollup PLUS axis scores in [0,1].

                Identify FIRST: what was the user actually trying to accomplish? Read Turn 0's prompt and any
                later prompts that pivot or refine. The task's success is measured against THAT goal — not
                against how busy the turns look.

                Axes (each in [0,1], 0=failed, 1=excellent):
                - completion: Did the agent actually deliver against the user's identified goal? High = goal
                  reached with evidence in the final turns. Low = goal half-done, abandoned, or only declared
                  done (e.g. "I've completed all the items" with nothing visible). For boundary=clear, completion
                  is usually low — the user reset before satisfaction.
                - coherence: Did the turns build on each other toward the goal? Penalize incoherent jumps,
                  redundant re-planning, lost context, or the agent forgetting earlier decisions.
                - efficiency: Were the turns appropriately scoped? Penalize repeated tool calls with the same
                  inputs, long discovery loops the agent could have shortcut, or churn. Reward focused progress.
                - overall: Holistic judgment. Weight completion most heavily — an efficient coherent task
                  that never finishes is worse than a slightly messier task that delivered.

                Summary guidance: one sentence, ≤ 280 characters, past tense, describing what the task ACCOMPLISHED
                (not what the agent attempted). Start with a verb: "Added", "Fixed", "Investigated", "Refactored",
                "Failed to". Be specific about the artefact when possible. No hedging, no "the agent…" preamble.

                reasoning: 1-3 sentences explaining the key evidence behind the overall score. Cite turn numbers.
                done: list the concrete deliverables visible in the turns (≤5 short items).
                missed: list what the user asked for but the agent did NOT deliver (≤5 items, empty array if none).

                Return strict JSON exactly, no prose before or after:
                {"summary":"<one sentence>","completion":N,"coherence":N,"efficiency":N,"overall":N,"reasoning":"...","done":["…"],"missed":["…"]}

                Examples of well-calibrated overall scores:
                  0.9 — User asked to add a feature; final turns show the feature implemented + test passing.
                  0.6 — User asked for a feature; agent built most of it but left a TODO they self-declared "done".
                  0.3 — User asked a question; agent rambled across 5 turns without ever answering.
                  0.1 — User asked to fix a bug; agent introduced two more bugs and called /clear.
                """,
                weights: #"{"completion":0.5,"coherence":0.25,"efficiency":0.25}"#,
                notes: "task-unit rollup (TodoWrite all-completed / /clear / session_end)"),
        ]
        for r in categoryRubrics where !existsRubric(r.purpose) {
            insertRubric(version: nil, purpose: r.purpose, prompt: r.prompt, weights: r.weights, notes: r.notes)
        }
    }

    private func query(_ sql: String) -> [[String: Any]] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        var rows: [[String: Any]] = []
        while sqlite3_step(stmt) == SQLITE_ROW { rows.append(rowToDict(stmt)) }
        return rows
    }

    private func rowToDict(_ stmt: OpaquePointer?) -> [String: Any] {
        guard let stmt else { return [:] }
        var dict: [String: Any] = [:]
        let count = sqlite3_column_count(stmt)
        for i in 0..<count {
            let name = String(cString: sqlite3_column_name(stmt, i))
            switch sqlite3_column_type(stmt, i) {
            case SQLITE_INTEGER: dict[name] = Int(sqlite3_column_int64(stmt, i))
            case SQLITE_FLOAT:   dict[name] = sqlite3_column_double(stmt, i)
            case SQLITE_TEXT:    dict[name] = String(cString: sqlite3_column_text(stmt, i))
            case SQLITE_NULL:    dict[name] = NSNull()
            default: break
            }
        }
        return dict
    }

    private func readRun(_ stmt: OpaquePointer?) -> ApmeRun {
        let d = rowToDict(stmt)
        return ApmeRun(
            id: d["id"] as? String ?? "",
            sessionId: d["session_id"] as? String ?? "",
            agentType: d["agent_type"] as? String ?? "",
            modelId: d["model_id"] as? String,
            projectName: d["project_name"] as? String,
            projectPath: d["project_path"] as? String,
            taskPrompt: d["task_prompt"] as? String,
            startedAt: d["started_at"] as? Int ?? 0,
            endedAt: d["ended_at"] as? Int,
            inputTokens: d["input_tokens"] as? Int,
            outputTokens: d["output_tokens"] as? Int,
            costUsd: d["cost_usd"] as? Double,
            exitCode: d["exit_code"] as? Int,
            gitBefore: d["git_before"] as? String,
            gitAfter: d["git_after"] as? String,
            hwProfile: d["hw_profile"] as? String,
            taskSignals: d["task_signals"] as? String,
            taskCategory: d["task_category"] as? String,
            taskCategorySource: d["task_category_source"] as? String,
            outcome: d["outcome"] as? String,
            outcomeConfidence: d["outcome_confidence"] as? String,
            efficiencyJson: d["efficiency_json"] as? String,
            compositeScore: d["composite_score"] as? Double
        )
    }

    private func bindText(_ stmt: OpaquePointer?, _ idx: Int32, _ val: String) {
        sqlite3_bind_text(stmt, idx, (val as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    }

    private func bindTextOrNull(_ stmt: OpaquePointer?, _ idx: Int32, _ val: String?) {
        if let v = val { bindText(stmt, idx, v) } else { sqlite3_bind_null(stmt, idx) }
    }

    // MARK: - DDL (identical to Node.js store.ts)

    private static let ddl = """
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT NOT NULL,
      model_id TEXT, project_name TEXT, project_path TEXT, task_prompt TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
      exit_code INTEGER, git_before TEXT, git_after TEXT, hw_profile TEXT,
      task_signals TEXT, task_category TEXT, task_category_source TEXT DEFAULT 'auto',
      outcome TEXT, outcome_confidence TEXT, efficiency_json TEXT, composite_score REAL
    );
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL, kind TEXT NOT NULL, tool_name TEXT, payload TEXT
    );
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      task_id TEXT,
      turn_index INTEGER NOT NULL, prompt TEXT, response TEXT, started_at INTEGER NOT NULL,
      ended_at INTEGER, tool_calls INTEGER DEFAULT 0,
      files_modified INTEGER DEFAULT 0, files_created INTEGER DEFAULT 0,
      git_before TEXT, git_after TEXT, task_category TEXT,
      outcome TEXT, composite_score REAL, efficiency_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id);
    CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      task_index INTEGER NOT NULL,
      boundary_signal TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      first_turn_index INTEGER,
      last_turn_index INTEGER,
      summary TEXT,
      outcome TEXT,
      composite_score REAL,
      task_category TEXT,
      notes_json TEXT,
      model_id TEXT,
      model_config TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      latency_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
    -- Typed trajectory events — the SessionSample.events projection (the single
    -- source of truth for both timeline + eval). Storage-time dedup via the
    -- UNIQUE index + INSERT OR IGNORE. Mirrors bridge/src/apme/store.ts.
    CREATE TABLE IF NOT EXISTS sample_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      turn_index INTEGER, seq INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, latency_ms INTEGER,
      tool_name TEXT, tool_status TEXT, tool_error TEXT, payload TEXT, dedup_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sevents_task ON sample_events(task_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sevents_dedup ON sample_events(task_id, dedup_key);
    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT, bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS evals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      layer TEXT NOT NULL, metric TEXT NOT NULL, score REAL,
      raw TEXT, rubric_ver INTEGER, judge_model TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rubrics (
      version INTEGER PRIMARY KEY, purpose TEXT NOT NULL, prompt TEXT NOT NULL,
      weights TEXT NOT NULL, created_at INTEGER NOT NULL, parent_ver INTEGER, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS vibe_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL, note TEXT, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model_id);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_type);
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_evals_run ON evals(run_id);
    CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
    CREATE VIEW IF NOT EXISTS v_run_metrics AS
    SELECT run_id,
      MAX(CASE WHEN metric='overall' AND layer='llm_judge' THEN score END) AS overall,
      MAX(CASE WHEN metric='tests_pass' AND layer='deterministic' THEN score END) AS tests_pass
    FROM evals GROUP BY run_id;
    CREATE VIEW IF NOT EXISTS v_model_scorecard AS
    SELECT r.agent_type, COALESCE(r.model_id,'unknown') AS model_id,
      COUNT(*) AS runs, AVG(m.overall) AS avg_overall, AVG(m.tests_pass) AS avg_tests_pass,
      SUM(r.cost_usd) AS total_cost,
      CASE WHEN AVG(m.overall)>0 THEN SUM(r.cost_usd)/AVG(m.overall) ELSE NULL END AS cost_per_quality
    FROM runs r LEFT JOIN v_run_metrics m ON m.run_id=r.id GROUP BY r.agent_type, r.model_id;
    CREATE VIEW IF NOT EXISTS v_category_scorecard AS
    SELECT r.task_category, COALESCE(r.model_id,'unknown') AS model_id,
      COUNT(*) AS runs, AVG(m.overall) AS avg_overall, AVG(m.tests_pass) AS avg_tests_pass,
      SUM(r.cost_usd) AS total_cost
    FROM runs r LEFT JOIN v_run_metrics m ON m.run_id=r.id
    WHERE r.task_category IS NOT NULL AND r.task_category != 'unknown'
    GROUP BY r.task_category, r.model_id;
    CREATE VIEW IF NOT EXISTS v_sample_scorecard AS
    SELECT r.agent_type, COALESCE(t.model_id, r.model_id, 'unknown') AS model_id,
      t.task_category, COUNT(*) AS samples, AVG(t.composite_score) AS avg_quality,
      SUM(t.cost_usd) AS total_cost, AVG(t.latency_ms) AS avg_latency_ms,
      CASE WHEN AVG(t.composite_score)>0 THEN SUM(t.cost_usd)/AVG(t.composite_score) ELSE NULL END AS cost_per_quality
    FROM tasks t JOIN runs r ON r.id=t.run_id
    WHERE t.ended_at IS NOT NULL AND t.composite_score IS NOT NULL
    GROUP BY r.agent_type, COALESCE(t.model_id, r.model_id, 'unknown'), t.task_category;
    """
}

// MARK: - Data models

struct ApmeRun {
    let id: String
    let sessionId: String
    let agentType: String
    var modelId: String?
    var projectName: String?
    var projectPath: String?
    var taskPrompt: String?
    let startedAt: Int
    var endedAt: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var costUsd: Double?
    var exitCode: Int?
    var gitBefore: String?
    var gitAfter: String?
    var hwProfile: String?
    var taskSignals: String?
    var taskCategory: String?
    var taskCategorySource: String?
    var outcome: String?
    var outcomeConfidence: String?
    var efficiencyJson: String?
    var compositeScore: Double?
}

struct ApmeStep {
    let id: Int
    let runId: String
    let ts: Int
    let kind: String
    let toolName: String?
    let payload: String
}

struct ApmeEval {
    var id: Int = 0
    let runId: String
    let layer: String
    let metric: String
    let score: Double
    var raw: String?
    var rubricVer: Int?
    var judgeModel: String?
    let createdAt: Int
}

/// A `task` groups consecutive turns within a run, bounded by automatic
/// signals (TodoWrite all-completed / /clear / session_end). Mirrors
/// bridge/src/apme/types.ts ApmeTaskRow. A task-level judge writes a
/// one-line summary + composite_score here; axis scores land in `evals`
/// with `layer='task_judge'` and `task_id` set.
struct ApmeTask {
    let id: String
    let runId: String
    let taskIndex: Int
    var boundarySignal: String     // 'open' | 'todo_complete' | 'clear' | 'session_end' | 'manual'
    let startedAt: Int
    var endedAt: Int?
    var firstTurnIndex: Int?
    var lastTurnIndex: Int?
    var summary: String?
    var outcome: String?
    var compositeScore: Double?
    var taskCategory: String?
    var notesJson: String?
    // Sample header: agent identity + cost (req #2 / #7).
    var modelId: String?
    var modelConfig: String?
    var inputTokens: Int?
    var outputTokens: Int?
    var costUsd: Double?
    var latencyMs: Int?
}

private final class ApmeOpenContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false

    @discardableResult
    func resume(_ continuation: CheckedContinuation<Bool, Never>, _ value: Bool) -> Bool {
        lock.lock()
        guard !didResume else {
            lock.unlock()
            return false
        }
        didResume = true
        lock.unlock()
        continuation.resume(returning: value)
        return true
    }
}
#endif
