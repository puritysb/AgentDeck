#!/usr/bin/env node
// Generate Swift/Kotlin mirrors of the session-weight range SSOT
// (shared/src/session-utils.ts: SESSION_WEIGHT_MIN / SESSION_WEIGHT_MAX).
//
//   pnpm generate-session-weight-rules            regenerate the mirrors
//   pnpm generate-session-weight-rules --check    exit 1 if any mirror drifted
//
// Requires shared to be built first (`pnpm --filter @agentdeck/shared build`
// or `pnpm build`) — the CLI imports the constants from shared/dist. The
// vitest sync test imports the emitters below directly with the TS source, so
// drift is caught in CI even if this CLI is never run.
//
// The quicktype protocol pipeline cannot carry constants, so these two
// integers ride their own emitter — same shape as generate-terrarium-rules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/session-utils.ts (SESSION_WEIGHT_MIN/MAX)\n' +
  'Regenerate: pnpm generate-session-weight-rules (drift gated by shared/src/__tests__/session-weight-rules.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

export function emitSwift(rules) {
  return `${comment('//')}

/// Documented cross-platform \`--weight\` range. A session weight on the wire
/// is always an integer inside [min, max]; \`clamp\` is the shared normalize
/// step every Swift consumer applies before comparing or emitting.
enum SessionWeightRules {
    static let min = ${rules.min}
    static let max = ${rules.max}

    static func clamp(_ weight: Int) -> Int {
        if weight < min { return min }
        if weight > max { return max }
        return weight
    }
}
`;
}

export function emitKotlin(rules) {
  return `${comment('//')}
package dev.agentdeck.net

/**
 * Documented cross-platform \`--weight\` range. A session weight on the wire
 * is always an integer inside [MIN, MAX]; [clamp] is the shared normalize
 * step every Kotlin consumer applies before comparing.
 */
object SessionWeightRules {
    const val MIN = ${rules.min}
    const val MAX = ${rules.max}

    fun clamp(weight: Int): Int = weight.coerceIn(MIN, MAX)
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Model/SessionWeightRules.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/net/SessionWeightRules.generated.kt', emitKotlin],
];

async function main() {
  let min, max;
  try {
    ({ SESSION_WEIGHT_MIN: min, SESSION_WEIGHT_MAX: max } = await import('../shared/dist/session-utils.js'));
  } catch {
    console.error('shared/dist not found — run `pnpm --filter @agentdeck/shared build` first');
    process.exit(1);
  }
  const rules = { min, max };
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
    console.log(drifted ? 'session weight rules mirrors DRIFTED' : 'session weight rules mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
