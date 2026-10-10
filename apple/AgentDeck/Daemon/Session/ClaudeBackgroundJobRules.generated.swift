// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/claude-background-jobs.ts
// Regenerate: pnpm generate-claude-background-jobs (drift gated by shared/src/__tests__/claude-background-jobs-sync.test.ts)
#if os(macOS)
import Foundation

/// Claude Code background jobs as the process table shows them: a spare
/// (pre-warmed pool process, no conversation), a PTY host (terminal relay),
/// or a job (forked from `<OLD>` when a window's conversation moved to the
/// background). The sandboxed daemon cannot read `~/.claude/sessions/<pid>.json`
/// where Claude records `spare` / `parkedJobId`, so the hook path classifies
/// the hook's process from argv. Behaviour is pinned by
/// `shared/claude-background-job-vectors.json` (`ClaudeBackgroundJobRulesTests`).
enum ClaudeBackgroundJobRules {
    enum Role: Equatable {
        case spare
        case ptyHost
        /// A background job; `forkedFrom` is the conversation it continues, lowercased.
        case job(forkedFrom: String?)
        case other
    }

    static let ptyHostFlag = "--bg-pty-host"
    static let spareFlag = "--bg-spare"
    static let forkSessionFlag = "--fork-session"
    static let spareStartupSources: Set<String> = ["", "startup"]

    private static let flagPrefix = #"(?:^|\s)"#
    private static let flagSuffix = #"(?=\s|=|$)"#
    private static let resumeRegex = try! NSRegularExpression(
        pattern: #"(?:^|\s)--resume(?:=|\s+)(?:.*?[\\/])??([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\.jsonl)?(?=\s|$)"#
    )

    private static func hasFlag(_ command: String, _ flag: String) -> Bool {
        command.range(of: flagPrefix + flag + flagSuffix, options: .regularExpression) != nil
    }

    /// `parentCommand == nil` means the parent is unknown — a fork is then not
    /// provably a background job and stays `.other`.
    static func role(command: String, parentCommand: String?) -> Role {
        if hasFlag(command, ptyHostFlag) { return .ptyHost }
        if hasFlag(command, spareFlag) { return .spare }
        guard let parentCommand, hasFlag(parentCommand, ptyHostFlag) else { return .other }
        guard hasFlag(command, forkSessionFlag) else { return .job(forkedFrom: nil) }
        let range = NSRange(command.startIndex..., in: command)
        guard let match = resumeRegex.firstMatch(in: command, range: range),
              let idRange = Range(match.range(at: 1), in: command) else { return .job(forkedFrom: nil) }
        return .job(forkedFrom: command[idRange].lowercased())
    }

    /// A `SessionStart` that only announces a spare warming up. A claimed spare
    /// keeps its argv, and its later `compact`/`clear`/`resume` starts belong
    /// to a real conversation.
    static func isSpareStartup(source: Any?, role: Role) -> Bool {
        guard role == .spare else { return false }
        guard let source, !(source is NSNull) else { return true }
        guard let text = source as? String else { return false }
        return spareStartupSources.contains(text)
    }

    /// Role of the process `pid` in `table`, or nil when the table lacks it
    /// (unknown — never a reason to drop or retire anything).
    static func role(pid: Int, in table: [ProcessEnumerator.ProcessRow]) -> Role? {
        guard let row = table.first(where: { $0.pid == pid }) else { return nil }
        let parent = table.first(where: { $0.pid == row.ppid })
        return role(command: row.command, parentCommand: parent?.command)
    }
}
#endif
