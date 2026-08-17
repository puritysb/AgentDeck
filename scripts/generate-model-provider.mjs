#!/usr/bin/env node
// Generate the Swift/Kotlin mirrors of the model-provider rules.
//
//   Source of truth: shared/src/model-provider.ts
//   pnpm generate-model-provider            regenerate the mirrors
//   pnpm generate-model-provider --check    exit 1 if any mirror drifted
//
// This is the third identity axis — harness (`agentType`), model (`modelName`),
// and *provider*, the company whose endpoint actually answered. It has to be
// generated rather than written three times for the usual reason: the whole
// value of the answer is that every surface computes it the same way. A Claude
// Code session pointed at z.ai must read as "Claude Code · glm-5.3 · z.ai" on
// macOS, on Android and in the TUI, or the badge means nothing.
//
// The marker tables are ALLOW-lists by construction. A model nobody predates
// resolves to `unknown`, which renders as no badge — never as some other
// company's name. That polarity is the point; see the unknown-agent rule in
// CLAUDE.md for the same lesson learned the expensive way.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/model-provider.ts\n' +
  'Regenerate: pnpm generate-model-provider (drift gated by shared/src/__tests__/model-provider.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

function swiftList(values, indent) {
  return values.map((v) => `${indent}"${v}",`).join('\n');
}

export function emitSwift(rules) {
  const cases = rules.providers.map((p) => `    case ${p} = "${p}"`).join('\n');
  const labels = rules.providers
    .map((p) => `        case .${p}: return "${rules.labels[p]}"`)
    .join('\n');
  const markers = rules.markers
    .map(([provider, list]) => `        (.${provider}, [\n${swiftList(list, '            ')}\n        ]),`)
    .join('\n');
  const vendors = Object.entries(rules.vendorPrefixes)
    .map(([prefix, provider]) => `        "${prefix}": .${provider},`)
    .join('\n');
  const natives = Object.entries(rules.harnessNative)
    .map(([agent, provider]) => `        "${agent}": .${provider},`)
    .join('\n');

  return `${comment('//')}

import Foundation

/// Which company's endpoint served the model on a session row.
///
/// Third axis, next to the harness (\`agentType\`) and the model (\`modelName\`).
/// A \`claude-glm\` session is Claude Code — same binary, same hooks, same
/// transcript — pointed at z.ai by an env var, so the harness identity is
/// unchanged and only this axis moved.
enum ADModelProvider: String, Equatable {
${cases}

    /// Display name; empty for \`.unknown\`, which must render as nothing.
    var label: String {
        switch self {
${labels}
        }
    }
}

enum ModelProviderRules {
    /// Substrings identifying a provider from a model id, most specific first.
    static let markers: [(ADModelProvider, [String])] = [
${markers}
    ]

    /// Vendor halves of \`vendor/model\` ids.
    static let vendorPrefixes: [String: ADModelProvider] = [
${vendors}
    ]

    /// The provider a harness talks to when nobody redirected it. Absent for
    /// the multi-provider harnesses (OpenClaw, OpenCode, Antigravity, Kiro) —
    /// they have no native provider, which is what keeps them from wearing a
    /// permanent "off-harness" badge for doing exactly what they are for.
    static let harnessNative: [String: ADModelProvider] = [
${natives}
    ]

    /// Name the provider behind a model id, or \`.unknown\`.
    static func provider(model: String?) -> ADModelProvider {
        let raw = (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if raw.isEmpty { return .unknown }

        var id = raw
        if let slash = raw.firstIndex(of: "/"), slash != raw.startIndex {
            if let vendor = vendorPrefixes[String(raw[raw.startIndex..<slash])] { return vendor }
            id = String(raw[raw.index(after: slash)...])
        }
        for (provider, markers) in markers {
            for marker in markers where id.contains(marker) { return provider }
        }
        return .unknown
    }

    static func harnessNativeProvider(agentType: String?) -> ADModelProvider {
        let key = (agentType ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return harnessNative[key] ?? .unknown
    }

    /// The provider to badge, or nil for "say nothing".
    ///
    /// Non-nil only when BOTH sides are known and disagree. Two unknowns must
    /// never combine into a claim: absence of evidence is not evidence of
    /// redirection.
    static func offHarnessProvider(agentType: String?, model: String?) -> ADModelProvider? {
        let native = harnessNativeProvider(agentType: agentType)
        if native == .unknown { return nil }
        let actual = provider(model: model)
        if actual == .unknown || actual == native { return nil }
        return actual
    }

    /// Badge text for a session row — empty when there is nothing to say.
    static func offHarnessProviderLabel(agentType: String?, model: String?) -> String {
        offHarnessProvider(agentType: agentType, model: model)?.label ?? ""
    }
}
`;
}

export function emitKotlin(rules) {
  const entries = rules.providers
    .map((p) => `    ${p.toUpperCase()}("${p}", "${rules.labels[p]}"),`)
    .join('\n');
  const markers = rules.markers
    .map(([provider, list]) => `        ModelProvider.${provider.toUpperCase()} to listOf(\n${list.map((v) => `            "${v}",`).join('\n')}\n        ),`)
    .join('\n');
  const vendors = Object.entries(rules.vendorPrefixes)
    .map(([prefix, provider]) => `        "${prefix}" to ModelProvider.${provider.toUpperCase()},`)
    .join('\n');
  const natives = Object.entries(rules.harnessNative)
    .map(([agent, provider]) => `        "${agent}" to ModelProvider.${provider.toUpperCase()},`)
    .join('\n');

  return `${comment('//')}
package dev.agentdeck.state

/**
 * Which company's endpoint served the model on a session row.
 *
 * Third axis, next to the harness (\`agentType\`) and the model (\`modelName\`).
 * A \`claude-glm\` session is Claude Code pointed at z.ai by an env var: the
 * harness identity is unchanged and only this axis moved.
 */
enum class ModelProvider(val id: String, val label: String) {
${entries}
}

object ModelProviderRules {
    /** Substrings identifying a provider from a model id, most specific first. */
    val MARKERS: List<Pair<ModelProvider, List<String>>> = listOf(
${markers}
    )

    /** Vendor halves of \`vendor/model\` ids. */
    val VENDOR_PREFIXES: Map<String, ModelProvider> = mapOf(
${vendors}
    )

    /** The provider a harness talks to when nobody redirected it. Absent for
     *  the multi-provider harnesses, which have no native provider. */
    val HARNESS_NATIVE: Map<String, ModelProvider> = mapOf(
${natives}
    )

    /** Name the provider behind a model id, or UNKNOWN. */
    fun provider(model: String?): ModelProvider {
        val raw = (model ?: "").trim().lowercase()
        if (raw.isEmpty()) return ModelProvider.UNKNOWN

        var id = raw
        val slash = raw.indexOf('/')
        if (slash > 0) {
            VENDOR_PREFIXES[raw.substring(0, slash)]?.let { return it }
            id = raw.substring(slash + 1)
        }
        for ((provider, markers) in MARKERS) {
            if (markers.any { id.contains(it) }) return provider
        }
        return ModelProvider.UNKNOWN
    }

    fun harnessNativeProvider(agentType: String?): ModelProvider =
        HARNESS_NATIVE[(agentType ?: "").trim().lowercase()] ?: ModelProvider.UNKNOWN

    /**
     * The provider to badge, or null for "say nothing".
     *
     * Non-null only when BOTH sides are known and disagree. Two unknowns must
     * never combine into a claim.
     */
    fun offHarnessProvider(agentType: String?, model: String?): ModelProvider? {
        val native = harnessNativeProvider(agentType)
        if (native == ModelProvider.UNKNOWN) return null
        val actual = provider(model)
        if (actual == ModelProvider.UNKNOWN || actual == native) return null
        return actual
    }

    /** Badge text for a session row — empty when there is nothing to say. */
    fun offHarnessProviderLabel(agentType: String?, model: String?): String =
        offHarnessProvider(agentType, model)?.label ?: ""
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Model/ModelProviderRules.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/state/ModelProviderRules.generated.kt', emitKotlin],
];

export async function loadRules() {
  const mod = await import('../shared/dist/model-provider.js');
  return {
    providers: Object.keys(mod.MODEL_PROVIDER_LABELS),
    labels: mod.MODEL_PROVIDER_LABELS,
    markers: mod.MODEL_MARKERS.map(([p, list]) => [p, [...list]]),
    vendorPrefixes: mod.VENDOR_PREFIXES,
    harnessNative: mod.HARNESS_NATIVE_PROVIDERS,
  };
}

async function main() {
  let rules;
  try {
    rules = await loadRules();
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
    console.log(drifted ? 'model provider mirrors DRIFTED' : 'model provider mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
