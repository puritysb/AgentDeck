#!/usr/bin/env node
// Generate the Swift mirrors of the APME work-display SSOTs:
//   shared/src/task-title.ts   → apple/.../TaskTitleRules.generated.swift
//   shared/src/action-fold.ts  → apple/.../ActionFoldRules.generated.swift
//   bridge/src/apme/task-gradeability.ts
//                              → apple/.../TaskGradeabilityRules.generated.swift
//
//   pnpm generate-apme-display-rules            regenerate the mirrors
//   pnpm generate-apme-display-rules --check    exit 1 if any mirror drifted
//
// Requires shared and bridge to be built first (`pnpm build` is sufficient),
// since the CLI reads the constants from their dist outputs. The vitest sync test
// (shared/src/__tests__/apme-display-rules-sync.test.ts) imports the emitters
// below against the TS source, so drift is caught in CI even when this CLI is
// never run.
//
// Why the logic is emitted and not just the numbers: both daemons NAME tasks —
// the timeline task_start header and the /apme/tasks Work-board rows must read
// identically whichever daemon owns port 9120, and the title/fold rules are
// string algorithms (code-point index math, fence state, tie ordering) that
// two hand-written copies drift on in exactly the places a constants gate
// cannot see. This replaces the recorded hand-mirror debt for
// ApmeCollector.deriveTaskTitle (AGENTS.md: "fold into a generator when next
// touched"). Behavior stays pinned by the shared vector files
// (shared/task-title-vectors.json, shared/action-fold-vectors.json,
// shared/task-gradeability-vectors.json), which both test suites replay.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function header(source) {
  return (
    `// GENERATED FILE — DO NOT EDIT.\n` +
    `// Source of truth: ${source}\n` +
    `// Regenerate: pnpm generate-apme-display-rules (drift gated by shared/src/__tests__/apme-display-rules-sync.test.ts)`
  );
}

export function emitTaskTitleSwift(rules) {
  return `${header('shared/src/task-title.ts')}

import Foundation

/// Derive a task's display title from its first user prompt — the Swift half
/// of the task-naming SSOT. See shared/src/task-title.ts for the full rule
/// rationale (intent title fills the one-line slot until the judge summary
/// exists; the \`Task N\` fallback stays the display SSOT's "meaningless"
/// shape, so callers keep it on nil and must NOT pass nil through as "").
///
/// Parity is pinned by shared/task-title-vectors.json, replayed by BOTH
/// suites (vitest task-title.test.ts / ApmeTaskBoundaryTests) — a rule change
/// that edits only one implementation goes red on the other. All index math
/// is in CODE POINTS (unicode scalars), never UTF-16 units or grapheme
/// clusters, matching the TS side's \`Array.from(line)\`.
enum TaskTitleRules {

    /// Max title length in code points — one Work-board row beside its chips.
    static let maxChars = ${rules.taskTitleMaxChars}

    /// Minimum meaningful length in code points — anything shorter ("ok",
    /// "ㅇㅇ") names nothing, so callers keep the \`Task N\` fallback.
    static let minChars = ${rules.taskTitleMinChars}

    static func deriveTaskTitle(_ firstPrompt: String?) -> String? {
        guard let prompt = firstPrompt?.trimmingCharacters(in: .whitespacesAndNewlines),
              !prompt.isEmpty else { return nil }

        // JS \`trim()\`/\`\\s\` also strip U+FEFF and \\v; CharacterSet's
        // whitespace classes do not, so widen to match — a BOM-prefixed
        // prompt must derive the same title on both daemons.
        let jsWhitespace = CharacterSet.whitespacesAndNewlines
            .union(CharacterSet(charactersIn: "\\u{FEFF}\\u{000B}\\u{000C}"))
        var line = ""
        var sawAnyLine = false
        var inFence = false
        for rawLine in prompt.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\\n" || $0 == "\\r\\n" }) {
            let candidate = rawLine.trimmingCharacters(in: jsWhitespace)
            if candidate.isEmpty { continue }
            // A fence swallows its whole BODY, not just the marker lines — a
            // paste-code-then-ask prompt must be titled by the ask, never by
            // the first line of the pasted code.
            if candidate.hasPrefix("\`\`\`") { inFence.toggle(); sawAnyLine = true; continue }
            if inFence { sawAnyLine = true; continue }
            // A prompt STARTING with markup (<task-notification>, a pasted
            // reminder) is machine plumbing — never promote its inner body.
            if !sawAnyLine, candidate.hasPrefix("<") { return nil }
            sawAnyLine = true
            // A slash COMMAND, not a slash PATH: one ASCII-word token after
            // the slash, then whitespace or end-of-line ('/task close', not
            // '/Users/x/cli.ts crashes'). ASCII on purpose — slash commands
            // are ASCII by construction, so '/작업 정리해줘' stays a title.
            if candidate.range(of: "^/[a-zA-Z][a-zA-Z0-9_-]*(\\\\s|$)", options: .regularExpression) != nil { continue }
            // Markup after a real first line is skipped.
            if candidate.hasPrefix("<") { continue }
            line = candidate
            break
        }
        if line.isEmpty { return nil }

        // Markdown furniture: heading #, list -/*, quote >.
        if let range = line.range(of: "^#{1,6}\\\\s+", options: .regularExpression) { line.removeSubrange(range) }
        if let range = line.range(of: "^[-*]\\\\s+", options: .regularExpression) { line.removeSubrange(range) }
        if let range = line.range(of: "^>\\\\s+", options: .regularExpression) { line.removeSubrange(range) }
        line = line.replacingOccurrences(of: "\\\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)

        let points = Array(line.unicodeScalars)
        if points.count < minChars { return nil }
        if points.count <= maxChars { return line }

        // All index math is in CODE POINTS (unicode scalars) — never
        // Character distance, which counts grapheme clusters and would put
        // the word-boundary threshold in a different place than the TS side.
        let window = Array(points.prefix(maxChars))
        let lastSpace = window.lastIndex(of: " " as Unicode.Scalar)
        let cutLen = (lastSpace != nil && lastSpace! >= maxChars / 2) ? lastSpace! : maxChars
        var cut = String(String.UnicodeScalarView(window.prefix(cutLen)))
        while cut.hasSuffix(" ") { cut.removeLast() }
        return cut + "…"
    }
}
`;
}

export function emitActionFoldSwift(rules) {
  const dispatchMembers = rules.dispatchToolNames.map((n) => JSON.stringify(n)).join(', ');
  const messagingMembers = rules.messagingToolNames.map((n) => JSON.stringify(n)).join(', ');
  return `${header('shared/src/action-fold.ts')}

import Foundation

/// Fold a task's tool activity into one summary line
/// (\`Edit×9 Read×24 Bash×11 +2 · 3 files\`) and count its coordination shape
/// (subagent dispatches / agent-to-agent messages). The Swift daemon's
/// GET /apme/tasks enriches Work-board rows with these, so both daemons must
/// fold identically whichever one owns port 9120.
///
/// Parity is pinned by shared/action-fold-vectors.json, replayed by BOTH
/// suites. The tie-break in the fold is a plain UTF-16 code-unit compare on
/// both sides (TS \`<\` on strings ≡ Swift comparing \`String.utf16\`
/// lexicographically) — NOT localeCompare, whose order is host-locale
/// dependent, and not Swift's default \`<\`, which compares canonically
/// composed characters and can disagree with TS on non-ASCII names.
enum ActionFoldRules {

    /// Named tools the fold shows before collapsing the rest to \`+N\`.
    static let maxTools = ${rules.actionFoldMaxTools}

    /// Tool names that DISPATCH another agent (fan-out). Exact raw names —
    /// matched BEFORE foldToolName, like the TS side.
    static let dispatchToolNames: Set<String> = [${dispatchMembers}]

    /// Tool names that MESSAGE another agent (peer/teammate traffic).
    static let messagingToolNames: Set<String> = [${messagingMembers}]

    /// \`mcp__claude-in-chrome__navigate\` → \`navigate\`: the server prefix is
    /// provenance, not shape. Non-MCP names pass through unchanged.
    static func foldToolName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("mcp__") else { return trimmed }
        let segments = trimmed.components(separatedBy: "__").filter { !$0.isEmpty }
        return segments.last ?? trimmed
    }

    /// TS \`a < b\` compares UTF-16 code units; mirror that exactly so a tie
    /// between non-ASCII tool names folds in the same order on both daemons.
    private static func utf16LessThan(_ a: String, _ b: String) -> Bool {
        var ai = a.utf16.makeIterator(), bi = b.utf16.makeIterator()
        while true {
            switch (ai.next(), bi.next()) {
            case (nil, nil): return false
            case (nil, _): return true
            case (_, nil): return false
            case let (x?, y?):
                if x != y { return x < y }
            }
        }
    }

    /// Count the coordination shape from per-tool counts. Returns nil when the
    /// task neither dispatched nor messaged, so a plain single-agent task
    /// renders no coordination chip at all.
    static func agentCoordinationSummary(
        _ tools: [(name: String, count: Int)]
    ) -> (dispatches: Int, messages: Int)? {
        var dispatches = 0
        var messages = 0
        for t in tools {
            guard t.count > 0 else { continue }
            let trimmed = t.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if dispatchToolNames.contains(trimmed) { dispatches += t.count }
            if messagingToolNames.contains(trimmed) { messages += t.count }
        }
        if dispatches == 0 && messages == 0 { return nil }
        return (dispatches, messages)
    }

    /// Fold tool counts into the summary line. Returns nil when there is
    /// nothing to say (no tools and no files) — callers render nothing rather
    /// than an empty string, matching the retain-on-absent display rules.
    static func foldActionCounts(
        tools: [(name: String, count: Int)], filesTouched: Int?
    ) -> String? {
        var merged: [String: Int] = [:]
        for t in tools {
            let name = foldToolName(t.name)
            guard !name.isEmpty, t.count > 0 else { continue }
            merged[name, default: 0] += t.count
        }
        let sorted = merged.sorted { a, b in
            a.value != b.value ? a.value > b.value : utf16LessThan(a.key, b.key)
        }
        var parts: [String] = []
        if !sorted.isEmpty {
            let shown = sorted.prefix(maxTools)
            let rest = sorted.count - shown.count
            parts.append(shown.map { "\\($0.key)×\\($0.value)" }.joined(separator: " ")
                + (rest > 0 ? " +\\(rest)" : ""))
        }
        let files = filesTouched ?? 0
        if files > 0 { parts.append("\\(files) file\\(files == 1 ? "" : "s")") }
        if parts.isEmpty { return nil }
        return parts.joined(separator: " · ")
    }
}
`;
}

export function emitTaskGradeabilitySwift(rules) {
  return `${header('bridge/src/apme/task-gradeability.ts')}

import Foundation

/// Decide whether a closed task contains agent work that an LLM may judge.
/// A nil return means gradeable; a non-nil value is the machine-readable
/// reason persisted in tasks.notes_json and shown on the Work board.
///
/// Parity is pinned by shared/task-gradeability-vectors.json, replayed by
/// both the TypeScript and Swift suites. String length intentionally uses
/// UTF-16 code units because the source rule uses JavaScript String.length.
enum TaskGradeabilityRules {

    static let workEvidenceMinToolCalls = ${rules.workEvidenceMinToolCalls}
    static let trivialPromptMaxChars = ${rules.trivialPromptMaxChars}
    static let trivialReplyMaxChars = ${rules.trivialReplyMaxChars}

    static func notGradeableReason(_ turns: [[String: Any]]) -> String? {
        if turns.isEmpty { return "no_reply" }
        let worked = turns.filter { text($0["end_source"]) != "aborted" }
        if worked.isEmpty { return "aborted_only" }

        if !worked.contains(where: hasTextReply) {
            let tools = worked.reduce(0) { $0 + int($1["tool_calls"]) }
            let files = worked.reduce(0) {
                $0 + int($1["files_modified"]) + int($1["files_created"])
            }
            if tools < workEvidenceMinToolCalls && files == 0 { return "no_reply" }
        }

        if worked.count == 1,
           int(worked[0]["tool_calls"]) == 0,
           text(worked[0]["prompt"]).utf16.count <= trivialPromptMaxChars,
           text(worked[0]["response"]).utf16.count <= trivialReplyMaxChars {
            return "trivial"
        }
        return nil
    }

    static func notGradeableNotes(_ reason: String) -> String {
        "{\\\"notGradeable\\\":\\\"\\(reason)\\\"}"
    }

    private static func text(_ value: Any?) -> String {
        (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func int(_ value: Any?) -> Int {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        return 0
    }

    /// response_kind as the collector tagged it, else derived from the row.
    private static func hasTextReply(_ turn: [String: Any]) -> Bool {
        if let raw = turn["efficiency_json"] as? String,
           !raw.isEmpty,
           let data = raw.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data),
           let dict = object as? [String: Any],
           let kind = dict["response_kind"] as? String {
            if kind == "tool_only" || kind == "empty" { return false }
            if kind == "text" { return !text(turn["response"]).isEmpty }
        }
        return !text(turn["response"]).isEmpty
    }
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Apme/TaskTitleRules.generated.swift', emitTaskTitleSwift],
  ['apple/AgentDeck/Daemon/Apme/ActionFoldRules.generated.swift', emitActionFoldSwift],
  ['apple/AgentDeck/Daemon/Apme/TaskGradeabilityRules.generated.swift', emitTaskGradeabilitySwift],
];

export function rulesFrom(taskTitleMod, actionFoldMod, taskGradeabilityMod) {
  return {
    taskTitleMaxChars: taskTitleMod.TASK_TITLE_MAX_CHARS,
    taskTitleMinChars: taskTitleMod.TASK_TITLE_MIN_CHARS,
    actionFoldMaxTools: actionFoldMod.ACTION_FOLD_MAX_TOOLS,
    // Sorted so the emitted Swift is stable however the TS Sets are declared.
    dispatchToolNames: [...actionFoldMod.DISPATCH_TOOL_NAMES].sort(),
    messagingToolNames: [...actionFoldMod.MESSAGING_TOOL_NAMES].sort(),
    workEvidenceMinToolCalls: taskGradeabilityMod.WORK_EVIDENCE_MIN_TOOL_CALLS,
    trivialPromptMaxChars: taskGradeabilityMod.TRIVIAL_PROMPT_MAX_CHARS,
    trivialReplyMaxChars: taskGradeabilityMod.TRIVIAL_REPLY_MAX_CHARS,
  };
}

async function main() {
  let taskTitle;
  let actionFold;
  let taskGradeability;
  try {
    taskTitle = await import('../shared/dist/task-title.js');
    actionFold = await import('../shared/dist/action-fold.js');
    taskGradeability = await import('../bridge/dist/apme/task-gradeability.js');
  } catch {
    console.error('generated-rule inputs not found — build shared and bridge first');
    process.exit(1);
  }
  const rules = rulesFrom(taskTitle, actionFold, taskGradeability);
  const check = process.argv.includes('--check');
  let drifted = false;
  for (const [rel, emit] of OUTPUTS) {
    const abs = path.join(projectDir, rel);
    const next = emit(rules);
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (check) {
      if (prev !== next) {
        console.error(`DRIFT: ${rel}`);
        drifted = true;
      }
    } else if (prev !== next) {
      fs.writeFileSync(abs, next);
      console.log(`wrote ${rel}`);
    } else {
      console.log(`up-to-date ${rel}`);
    }
  }
  if (check) {
    console.log(drifted ? 'apme display rules mirrors DRIFTED' : 'apme display rules mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
