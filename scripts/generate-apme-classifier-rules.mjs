#!/usr/bin/env node
// Generate the Swift mirror of the APME classifier LLM-assist SSOT:
//   shared/src/apme-classifier-rules.ts
//     → apple/AgentDeck/Daemon/Apme/ApmeClassifierRules.generated.swift
//
//   pnpm generate-apme-classifier-rules            regenerate the mirror
//   pnpm generate-apme-classifier-rules --check    exit 1 if it drifted
//
// Requires shared to be built first (`pnpm build`), since the CLI reads the
// constants from shared/dist. The vitest sync test
// (shared/src/__tests__/apme-classifier-rules-sync.test.ts) imports the
// emitter against the TS source, so drift is caught in CI even when this CLI
// is never run.
//
// Why this is generated rather than hand-mirrored: `task_category` SELECTS
// THE JUDGE RUBRIC downstream, so a category that differs between the two
// daemons for the same task is a score difference, not a cosmetic one — and
// that is exactly what had happened. Node's LLM-assist classifier called MLX
// only, with a ~20-token cap and a 15s timeout, never a paid backend. Swift's
// routed through `callConfiguredJudge` — WHATEVER judge backend the user
// configured, including the paid `api`/`openai` leg — with the judge's own
// 800-token/60s budget and a separately hand-typed prompt. A user who set
// `judge.backend: "api"` was billed per classification on Swift only. This
// file is the single place the prompt text, the label vocabulary, the output
// cap, the timeout, and the backend try-order live; both daemons read it
// instead of restating it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function header() {
  return (
    `// GENERATED FILE — DO NOT EDIT.\n` +
    `// Source of truth: shared/src/apme-classifier-rules.ts\n` +
    `// Regenerate: pnpm generate-apme-classifier-rules (drift gated by shared/src/__tests__/apme-classifier-rules-sync.test.ts)`
  );
}

/** Pull the parts of the SSOT the mirror must embed verbatim. */
export function rulesFrom(mod) {
  return {
    labels: [...mod.APME_CLASSIFIER_LABELS],
    backendOrder: [...mod.APME_CLASSIFIER_BACKEND_ORDER],
    maxTokens: mod.APME_CLASSIFIER_MAX_TOKENS,
    timeoutMs: mod.APME_CLASSIFIER_TIMEOUT_MS,
    systemPrompt: mod.APME_CLASSIFIER_SYSTEM_PROMPT,
  };
}

function swiftStringList(values, indent = '        ') {
  return values.map((v) => `${indent}${JSON.stringify(v)},`).join('\n');
}

function swiftMultilineString(text) {
  // Swift triple-quoted strings don't need internal escaping for our prompt
  // text (no embedded `"""`), but guard against it regressing silently.
  if (text.includes('"""')) {
    throw new Error('APME_CLASSIFIER_SYSTEM_PROMPT contains a `"""` — cannot emit as a Swift multiline literal verbatim');
  }
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : `        ${line}`))
    .join('\n');
}

export function emitSwift(rules) {
  return `${header()}

import Foundation

#if os(macOS)

/// Prompt, backend try-order, and label-validation rules shared with the
/// Node classifier (bridge/src/apme/classifier.ts). Both daemons must reach
/// the same category for the same task.
enum ApmeClassifierRules {
    /// Every label the classifier prompt advertises and label validation
    /// accepts. Matches \`ApmeClassifier.TaskCategory\` — kept as a plain
    /// string list here (rather than sharing that enum) so this file has no
    /// dependency on the hand-written rule-based classifier's type.
    static let labels: [String] = [
${swiftStringList(rules.labels)}
    ]

    /// Backends the LLM-assist classifier may call, in try-order. \`"rules"\`
    /// is not a network call — it means "give up and return the rule-based
    /// \`unknown\`" — and is always last so a fully offline daemon still
    /// classifies. \`api\`/\`openai\` are never members: classification runs on
    /// every closed task with \`unknown\` rules, so routing it through a paid
    /// backend would bill the user for a call the eval pipeline makes
    /// silently, on every session, whatever judge backend they picked for
    /// actual eval scoring.
    static let backendOrder: [String] = [
${swiftStringList(rules.backendOrder)}
    ]

    /// Output cap. One word from a ten-item vocabulary; a latency bound, not
    /// a cost control — deliberately far below the eval judge's 800-token
    /// cap, which is a DIFFERENT call with a different purpose.
    static let maxTokens = ${rules.maxTokens}

    /// Per-call timeout in milliseconds (bridged to \`TimeInterval\` at the
    /// call site). Classification runs synchronously in the task-close path,
    /// so it must fail fast into the rule fallback.
    static let timeoutMs: Double = ${rules.timeoutMs}

    static var timeoutSeconds: TimeInterval { timeoutMs / 1000 }

    static let systemPrompt = """
${swiftMultilineString(rules.systemPrompt)}
        """

    /// Normalize a raw model response into one of \`labels\`, or nil when the
    /// response names no known category — callers must fall back to the
    /// rule-based result on nil, never guess. Exact match first (the
    /// instructed shape), then substring (models routinely wrap the answer
    /// in prose despite being told not to). Mirrors
    /// \`normalizeClassifierLabel\` in shared/src/apme-classifier-rules.ts.
    static func normalizeLabel(_ raw: String) -> String? {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz_")
        let cleaned = String(raw.lowercased().unicodeScalars.filter { allowed.contains($0) })
        if labels.contains(cleaned) { return cleaned }
        return labels.first(where: { cleaned.contains($0) })
    }

    /// The exact user-message shape both daemons send. \`taskPrompt\` is
    /// clipped to 500 chars by the caller (matches existing behavior).
    static func buildUserMessage(
        taskPrompt: String,
        toolSummary: String,
        totalToolCalls: Int,
        filesModified: Int,
        filesCreated: Int,
        sessionDurationSec: Int,
        turnCount: Int
    ) -> String {
        """
        Prompt: "\\(taskPrompt)"
        Tools used: \\(toolSummary.isEmpty ? "none" : toolSummary) (\\(totalToolCalls) total)
        Files modified: \\(filesModified), created: \\(filesCreated)
        Duration: \\(sessionDurationSec)s, turns: \\(turnCount)
        """
    }
}

#endif
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Apme/ApmeClassifierRules.generated.swift', emitSwift],
];

async function main() {
  const check = process.argv.includes('--check');
  const mod = await import(path.join(projectDir, 'shared/dist/apme-classifier-rules.js'));
  const rules = rulesFrom(mod);
  let drifted = false;
  for (const [rel, emit] of OUTPUTS) {
    const target = path.join(projectDir, rel);
    const next = emit(rules);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === next) continue;
    if (check) {
      console.error(`drift: ${rel}`);
      drifted = true;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next);
    console.log(`wrote ${rel}`);
  }
  if (drifted) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
