#!/usr/bin/env node
// Generate the Swift/Kotlin mirrors of two observed-agent lists:
//   - shared/src/session-utils.ts  OBSERVED_SESSION_AGENT_KEYS
//   - shared/src/timeline.ts       TOOL_EXEC_SUPPRESSED_AGENTS
//
//   pnpm generate-observed-agent-rules            regenerate the mirrors
//   pnpm generate-observed-agent-rules --check    exit 1 if any mirror drifted
//
// Both lists were hand-mirrored, and both drifted the same way: Kiro was added
// to the TypeScript source and to nothing else. The consequences were not
// cosmetic — a Kiro session's id keeps its `observed:kiro:` prefix, so the
// mobile canonicalizers matched it against nothing and the session's timeline
// came up empty; and its per-tool rows were never suppressed, so a Kiro turn
// drowned its own prompt/response rows.
//
// The lists are small enough that hand-mirroring looks free. It is not: what
// they cost is one silent surface per agent added.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/session-utils.ts (OBSERVED_SESSION_AGENT_KEYS)\n' +
  '                 shared/src/timeline.ts      (TOOL_EXEC_SUPPRESSED_AGENTS)\n' +
  'Regenerate: pnpm generate-observed-agent-rules (drift gated by shared/src/__tests__/observed-agent-rules.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

export function emitSwift(rules) {
  const prefixes = rules.prefixes.map((p) => `        "${p}",`).join('\n');
  const suppressed = rules.suppressed.map((a) => `        "${a}",`).join('\n');
  return `${comment('//')}

import Foundation

/// Observed-session id prefixes and the agents whose observed tool rows stay
/// out of the timeline. See the TypeScript sources for why these are generated
/// rather than written twice.
enum ObservedAgentRules {
    /// A passively-observed session is keyed \`observed:<agent>:<uuid>\` in
    /// \`sessions_list\` and on devices, while timeline rows, hook payloads and
    /// transcripts use the bare uuid — so anything comparing one against the
    /// other must strip this first.
    static let sessionPrefixes: [String] = [
${prefixes}
    ]

    /// Agents whose observed per-tool rows would drown their own prompt and
    /// response rows in the bounded timeline buffer.
    static let toolExecSuppressed: Set<String> = [
${suppressed}
    ]

    /// Bare id form — unchanged when the id carries no observed prefix.
    static func rawSessionId(_ value: String) -> String {
        for prefix in sessionPrefixes where value.hasPrefix(prefix) {
            return String(value.dropFirst(prefix.count))
        }
        return value
    }
}
`;
}

export function emitKotlin(rules) {
  const prefixes = rules.prefixes.map((p) => `        "${p}",`).join('\n');
  const suppressed = rules.suppressed.map((a) => `        "${a}",`).join('\n');
  return `${comment('//')}
package dev.agentdeck.state

/**
 * Observed-session id prefixes and the agents whose observed tool rows stay out
 * of the timeline. See the TypeScript sources for why these are generated
 * rather than written twice.
 */
object ObservedAgentRules {
    /** A passively-observed session is keyed \`observed:<agent>:<uuid>\` in
     *  \`sessions_list\` and on devices, while timeline rows, hook payloads and
     *  transcripts use the bare uuid. */
    val SESSION_PREFIXES: List<String> = listOf(
${prefixes}
    )

    /** Agents whose observed per-tool rows would drown their own prompt and
     *  response rows in the bounded timeline buffer. */
    val TOOL_EXEC_SUPPRESSED: Set<String> = setOf(
${suppressed}
    )

    /** Bare id form — unchanged when the id carries no observed prefix. */
    fun rawSessionId(value: String): String {
        val prefix = SESSION_PREFIXES.firstOrNull { value.startsWith(it) } ?: return value
        return value.removePrefix(prefix)
    }
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Model/ObservedAgentRules.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/state/ObservedAgentRules.generated.kt', emitKotlin],
];

async function main() {
  let rules;
  try {
    const sessionUtils = await import('../shared/dist/session-utils.js');
    const timeline = await import('../shared/dist/timeline.js');
    rules = {
      prefixes: [...sessionUtils.OBSERVED_SESSION_PREFIXES],
      suppressed: [...timeline.TOOL_EXEC_SUPPRESSED_AGENTS],
    };
  } catch {
    console.error('shared/dist not found — run `pnpm --filter @agentdeck/shared build` first');
    process.exit(1);
  }
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
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, next);
      console.log(`wrote ${rel}`);
    } else {
      console.log(`up-to-date ${rel}`);
    }
  }
  if (check) {
    console.log(drifted ? 'observed agent rule mirrors DRIFTED' : 'observed agent rule mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
