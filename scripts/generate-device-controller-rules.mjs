#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const output = 'apple/AgentDeck/Model/DeviceControllerRules.generated.swift';
export const cppOutput = 'esp32/src/state/device_controller_generated.h';
export const kotlinOutput = 'android/app/src/main/kotlin/dev/agentdeck/state/DeviceControllerRules.generated.kt';
export function emitKotlin(rules) {
  return `// GENERATED FILE — DO NOT EDIT. Source: shared/src/device-controller.ts
// Regenerate: node scripts/generate-device-controller-rules.mjs
package dev.agentdeck.state

object DeviceControllerRules {
    data class PermissionChoice(val index: Int, val label: String, val decision: String)
    val permissionChoices = listOf(
${rules.permissionChoices.map(c => `        PermissionChoice(${c.index}, ${JSON.stringify(c.label)}, ${JSON.stringify(c.decision)}),`).join('\n')}
    )
    fun heldReplyable(requestId: String?, liveAnswerable: Boolean?): Boolean =
        !requestId.isNullOrBlank() && (!requestId.startsWith("ocperm:") || liveAnswerable == true)
}
`;
}
export function emitCpp(rules) {
  return `// GENERATED FILE — DO NOT EDIT. Source: shared/src/device-controller.ts
// Regenerate: node scripts/generate-device-controller-rules.mjs
#pragma once
#include <cstring>
namespace DeviceController {
static constexpr unsigned questionBytes = ${rules.compact.questionBytes};
static constexpr unsigned requestBytes = ${rules.compact.requestBytes};
static constexpr unsigned maxOptions = ${rules.compact.options};
inline bool input(bool alive, bool managed, bool observed, const char* agent) {
    return alive && (managed || !std::strcmp(agent, "openclaw") || (observed && (${rules.observedInputAgents.map(a => `!std::strcmp(agent, "${a}")`).join(' || ')})));
}
inline bool answer(bool alive, bool awaiting, bool known, bool replyable, bool managed, unsigned options, bool request, bool requestNeedsChannel) {
    return alive && awaiting && ((request && (!requestNeedsChannel || replyable)) || ((known ? replyable : managed) && options > 0));
}
}
`;
}
export function emitSwift(rules) {
  return `// GENERATED FILE — DO NOT EDIT.
// Source: shared/src/device-controller.ts. Regenerate: node scripts/generate-device-controller-rules.mjs
// Drift gate: shared/src/__tests__/device-controller.test.ts
enum DeviceControllerRules {
    static let observedInputAgents = ${JSON.stringify(rules.observedInputAgents)}
    static let keyCanvas: Double = ${rules.key.canvas}
    static let optionFont: Double = ${rules.key.optionFont}
    static let optionLines = ${rules.key.optionLines}
    static let questionFont: Double = ${rules.key.questionFont}
    static func compactCapabilities(_ row: [String: Any]) -> [String: Bool] {
        let alive = row["alive"] as? Bool == true
        let mode = row["controlMode"] as? String ?? ""
        let agent = row["agentType"] as? String ?? ""
        let managed = mode == "managed" || (mode != "observed" && (row["port"] as? Int ?? 0) > 0)
        let input = alive && (managed || agent == "openclaw" || (mode == "observed" && observedInputAgents.contains(agent)))
        let request = row["requestId"] as? String ?? ""
        let question = row["question"] as? String ?? ""
        let options = (row["options"] as? [[String: Any]])?.count ?? 0
        let live = row["liveAnswerable"] as? Bool
        let held = !request.isEmpty && (!request.hasPrefix("ocperm:") || live == true)
        let awaiting = (row["state"] as? String ?? "").hasPrefix("awaiting_")
        let answer = alive && awaiting && (held || ((live ?? managed) && options > 0))
            && request.utf8.count <= ${rules.compact.requestBytes} && question.utf8.count <= ${rules.compact.questionBytes} && options <= ${rules.compact.options}
        return ["controllerInput": input, "controllerAnswerable": answer]
    }
}
`;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { DEVICE_CONTROLLER_RULES } = await import('../shared/dist/device-controller.js');
  for (const [name, emit] of [[output, emitSwift], [cppOutput, emitCpp], [kotlinOutput, emitKotlin]]) {
    const path = new URL('../' + name, import.meta.url);
    const expected = emit(DEVICE_CONTROLLER_RULES);
    if (process.argv.includes('--check')) {
      if (readFileSync(path, 'utf8') !== expected) throw new Error('Device controller rules drifted');
    } else writeFileSync(path, expected);
  }
}
