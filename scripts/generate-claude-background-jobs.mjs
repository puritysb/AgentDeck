#!/usr/bin/env node
// Generate the Swift mirror of the Claude Code background-job process rule:
//   shared/src/claude-background-jobs.ts
//     → apple/AgentDeck/Daemon/Session/ClaudeBackgroundJobRules.generated.swift
//
//   pnpm generate-claude-background-jobs            regenerate the mirror
//   pnpm generate-claude-background-jobs --check    exit 1 if it drifted
//
// Requires shared to be built first (`pnpm build`), since the CLI reads the
// constants from shared/dist. The vitest sync test
// (shared/src/__tests__/claude-background-jobs-sync.test.ts) imports the
// emitter against the TS source, so drift is caught in CI even when this CLI
// is never run. Behaviour is pinned by shared/claude-background-job-vectors.json,
// which both suites replay.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Swift raw string literal; every pattern here is free of `"#`. */
function raw(value) {
  if (value.includes('"#')) throw new Error(`cannot embed ${value} in a raw Swift string`);
  return `#"${value}"#`;
}

export function rulesFrom(mod) {
  return {
    flags: mod.CLAUDE_BG_FLAGS,
    resumePattern: mod.CLAUDE_BG_RESUME_PATTERN,
    flagPrefix: mod.CLAUDE_BG_FLAG_PATTERN_PREFIX,
    flagSuffix: mod.CLAUDE_BG_FLAG_PATTERN_SUFFIX,
    spareSources: mod.CLAUDE_SPARE_STARTUP_SOURCES,
  };
}

export function emitSwift(rules) {
  return `// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/claude-background-jobs.ts
// Regenerate: pnpm generate-claude-background-jobs (drift gated by shared/src/__tests__/claude-background-jobs-sync.test.ts)
#if os(macOS)
import Foundation

/// Claude Code background jobs as the process table shows them: a spare
/// (pre-warmed pool process, no conversation), a PTY host (terminal relay),
/// or a job (forked from \`<OLD>\` when a window's conversation moved to the
/// background). The sandboxed daemon cannot read \`~/.claude/sessions/<pid>.json\`
/// where Claude records \`spare\` / \`parkedJobId\`, so the hook path classifies
/// the hook's process from argv. Behaviour is pinned by
/// \`shared/claude-background-job-vectors.json\` (\`ClaudeBackgroundJobRulesTests\`).
enum ClaudeBackgroundJobRules {
    enum Role: Equatable {
        case spare
        case ptyHost
        /// A background job; \`forkedFrom\` is the conversation it continues, lowercased.
        case job(forkedFrom: String?)
        case other
    }

    static let ptyHostFlag = ${JSON.stringify(rules.flags.ptyHost)}
    static let spareFlag = ${JSON.stringify(rules.flags.spare)}
    static let forkSessionFlag = ${JSON.stringify(rules.flags.forkSession)}
    static let spareStartupSources: Set<String> = [${rules.spareSources.map((v) => JSON.stringify(v)).join(', ')}]

    private static let flagPrefix = ${raw(rules.flagPrefix)}
    private static let flagSuffix = ${raw(rules.flagSuffix)}
    private static let resumeRegex = try! NSRegularExpression(
        pattern: ${raw(rules.resumePattern)}
    )

    private static func hasFlag(_ command: String, _ flag: String) -> Bool {
        command.range(of: flagPrefix + flag + flagSuffix, options: .regularExpression) != nil
    }

    /// \`parentCommand == nil\` means the parent is unknown — a fork is then not
    /// provably a background job and stays \`.other\`.
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

    /// A \`SessionStart\` that only announces a spare warming up. A claimed spare
    /// keeps its argv, and its later \`compact\`/\`clear\`/\`resume\` starts belong
    /// to a real conversation.
    static func isSpareStartup(source: Any?, role: Role) -> Bool {
        guard role == .spare else { return false }
        guard let source, !(source is NSNull) else { return true }
        guard let text = source as? String else { return false }
        return spareStartupSources.contains(text)
    }

    /// Role of the process \`pid\` in \`table\`, or nil when the table lacks it
    /// (unknown — never a reason to drop or retire anything).
    static func role(pid: Int, in table: [ProcessEnumerator.ProcessRow]) -> Role? {
        guard let row = table.first(where: { $0.pid == pid }) else { return nil }
        let parent = table.first(where: { $0.pid == row.ppid })
        return role(command: row.command, parentCommand: parent?.command)
    }
}
#endif
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Session/ClaudeBackgroundJobRules.generated.swift', emitSwift],
];

async function main() {
  let mod;
  try {
    mod = await import(path.join(projectDir, 'shared/dist/claude-background-jobs.js'));
  } catch (err) {
    console.error(`shared/dist is missing — run \`pnpm build\` first (${err.message})`);
    process.exit(1);
  }
  const rules = rulesFrom(mod);
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
    console.log(drifted ? 'claude background-job rules mirror DRIFTED' : 'claude background-job rules mirror in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
