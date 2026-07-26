// Generate Swift/Kotlin/C++ mirrors of the terrarium rules SSOT
// (shared/src/terrarium-rules.ts).
//
// No shebang: the drift gate imports this module for its emitters, and Vitest's
// transform does not strip one the way node does — it reports the `#` as
// "SyntaxError: Invalid or unexpected token" and the whole suite fails to load.
// Always invoked as `node scripts/generate-terrarium-rules.mjs`, so nothing
// needed the shebang. Same reason release-version.mjs and version-policy.mjs
// (also imported by tests) have none.
//
//   pnpm generate-terrarium-rules            regenerate the three mirrors
//   pnpm generate-terrarium-rules --check    exit 1 if any mirror drifted
//
// Requires shared to be built first (`pnpm --filter @agentdeck/shared build`
// or `pnpm build`) — the CLI imports the rules from shared/dist. The vitest
// sync test imports the emitters below directly with the TS source, so drift
// is caught in CI even if this CLI is never run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/terrarium-rules.ts\n' +
  'Regenerate: pnpm generate-terrarium-rules (drift gated by shared/src/__tests__/terrarium-rules.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

// Emit a float literal that survives Float/constexpr parsing in all three
// languages (JS prints 0.78 as "0.78", integers get a trailing ".0").
function f(value) {
  const s = String(value);
  return s.includes('.') ? s : `${s}.0`;
}

export function emitSwift(rules) {
  const c = rules.crayfish;
  return `${comment('//')}

/// Cross-platform terrarium rules. See shared/src/terrarium-rules.ts for
/// what each value means and the clearance invariant they encode.
enum TerrariumRules {
    static let crayfishHomeX: Float = ${f(c.homeX)}
    static let crayfishSittingY: Float = ${f(c.sittingY)}
    static let crayfishWidthFraction: Float = ${f(c.widthFrac)}
    static let crayfishClearMaxX: Float = ${f(c.clearMaxX)}
    static let floorRestYMin: Float = ${f(rules.floorRestStrip.yMin)}
    static let floorRestYMax: Float = ${f(rules.floorRestStrip.yMax)}
    static let antigravityHoverYMin: Float = ${f(rules.antigravityHoverStrip.yMin)}
    static let antigravityHoverYMax: Float = ${f(rules.antigravityHoverStrip.yMax)}
    static let resterMaxWidthFraction: Float = ${f(rules.resterMaxWidthFrac)}
}
`;
}

export function emitKotlin(rules) {
  const c = rules.crayfish;
  return `${comment('//')}
package dev.agentdeck.terrarium

/**
 * Cross-platform terrarium rules. See shared/src/terrarium-rules.ts for
 * what each value means and the clearance invariant they encode.
 */
object TerrariumRules {
    const val CRAYFISH_HOME_X = ${f(c.homeX)}f
    const val CRAYFISH_SITTING_Y = ${f(c.sittingY)}f
    const val CRAYFISH_WIDTH_FRACTION = ${f(c.widthFrac)}f
    const val CRAYFISH_CLEAR_MAX_X = ${f(c.clearMaxX)}f
    const val FLOOR_REST_Y_MIN = ${f(rules.floorRestStrip.yMin)}f
    const val FLOOR_REST_Y_MAX = ${f(rules.floorRestStrip.yMax)}f
    const val ANTIGRAVITY_HOVER_Y_MIN = ${f(rules.antigravityHoverStrip.yMin)}f
    const val ANTIGRAVITY_HOVER_Y_MAX = ${f(rules.antigravityHoverStrip.yMax)}f
    const val RESTER_MAX_WIDTH_FRACTION = ${f(rules.resterMaxWidthFrac)}f
}
`;
}

export function emitCpp(rules) {
  const c = rules.crayfish;
  return `${comment('//')}
#pragma once

// Cross-platform terrarium rules. See shared/src/terrarium-rules.ts for
// what each value means and the clearance invariant they encode.
// C++11-safe (util/-grade): plain constexpr floats, no dependencies.
namespace TerrariumRules {
constexpr float CrayfishHomeX = ${f(c.homeX)}f;
constexpr float CrayfishSittingY = ${f(c.sittingY)}f;
constexpr float CrayfishWidthFraction = ${f(c.widthFrac)}f;
constexpr float CrayfishClearMaxX = ${f(c.clearMaxX)}f;
constexpr float FloorRestYMin = ${f(rules.floorRestStrip.yMin)}f;
constexpr float FloorRestYMax = ${f(rules.floorRestStrip.yMax)}f;
constexpr float AntigravityHoverYMin = ${f(rules.antigravityHoverStrip.yMin)}f;
constexpr float AntigravityHoverYMax = ${f(rules.antigravityHoverStrip.yMax)}f;
constexpr float ResterMaxWidthFraction = ${f(rules.resterMaxWidthFrac)}f;
}  // namespace TerrariumRules
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Terrarium/TerrariumRules.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/terrarium/TerrariumRules.generated.kt', emitKotlin],
  ['esp32/src/ui/terrarium/terrarium_rules_generated.h', emitCpp],
];

async function main() {
  let rules;
  try {
    ({ TERRARIUM_RULES: rules } = await import('../shared/dist/terrarium-rules.js'));
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
      fs.writeFileSync(abs, next);
      console.log(`wrote ${rel}`);
    } else {
      console.log(`up-to-date ${rel}`);
    }
  }
  if (check) {
    console.log(drifted ? 'terrarium rules mirrors DRIFTED' : 'terrarium rules mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
