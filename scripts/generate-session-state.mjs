#!/usr/bin/env node
// Emits the native mirrors of shared/src/session-state-presentation.ts and,
// for ESP32 (which has no hand token binding), the product-UI colour tokens.
// `--check` fails on drift; shared/src/__tests__/session-state-presentation.test.ts
// runs the same comparison under vitest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const header = '// GENERATED from shared/src/session-state-presentation.ts and design/tokens.css bindings. DO NOT EDIT.\n// Regenerate with `pnpm generate-session-state`.\n';

/** Wire state order shared by every platform enum. */
const STATES = ['disconnected', 'idle', 'processing', 'awaiting_permission', 'awaiting_option', 'awaiting_diff'];
const TONES = ['idle', 'working', 'awaiting', 'offline'];

const upperSnake = (s) => s.toUpperCase();
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^./, (c) => c.toUpperCase());
const hex = (color) => '0x' + color.slice(1).toUpperCase();
const argb = (color) => '0xFF' + color.slice(1).toUpperCase();
const q = (s) => JSON.stringify(s);

export function emitCpp(src) {
  const { ui, brand, colors, paper } = src;
  const palette = [
    ...Object.entries(ui).map(([k, v]) => `constexpr uint32_t Ui${pascal(k)} = ${hex(v)};`),
    ...Object.entries(brand).map(([k, v]) => `constexpr uint32_t Brand${pascal(k)} = ${hex(v)};`),
    ...TONES.map((t) => `constexpr uint32_t Session${pascal(t)} = ${hex(colors[t])};`),
    ...TONES.map((t) => `constexpr uint32_t Session${pascal(t)}Paper = ${hex(paper[t])};`),
  ].join('\n');
  return `${header}#pragma once
#include <cstdint>

// Product-UI colour tokens (design/tokens.css --ui-* / --brand-* / --session-*), RGB888.
// Dependency-free so theme.h, native tests and the simulator can include it.
namespace ProductPalette {
${palette}
}  // namespace ProductPalette
`;
}

export function emitCppSession(src) {
  const { toneOf, colors, paper, words } = src;
  const toneCases = STATES.map((s) => `        case AgentState::${upperSnake(s)}: return ${pascal(toneOf[s])};`).join('\n');
  const wireCases = STATES.map((s) => `    if (std::strcmp(wire, ${q(s)}) == 0) return AgentState::${upperSnake(s)};`).join('\n');
  const wordTable = (field) => STATES.map((s) => `        case AgentState::${upperSnake(s)}: return ${q(words[s][field])};`).join('\n');
  return `${header}#pragma once
#include <cstdint>
#include <cstring>
#include "../state/agent_state.h"

// Session state presentation — DESIGN.md §2.7. One tone, colour and word set
// per wire state on every surface. Only Awaiting may animate.
namespace SessionState {
enum Tone : uint8_t { ${TONES.map(pascal).join(', ')} };

inline Tone tone(AgentState state) {
    switch (state) {
${toneCases}
    }
    return Idle;
}

/** Missing → Offline; unknown non-empty → Idle (a live, quiet session). */
inline bool fromWire(const char* wire, AgentState& out) {
${wireCases.replace(/return AgentState::(\w+);/g, '{ out = AgentState::$1; return true; }')}
    return false;
}
inline Tone tone(const char* wire) {
    if (wire == nullptr || *wire == '\\0') return Offline;
    AgentState state;
    return fromWire(wire, state) ? tone(state) : Idle;
}

inline uint32_t color(Tone t, bool onPaper = false) {
    static constexpr uint32_t bright[] = {${TONES.map((t) => hex(colors[t])).join(', ')}};
    static constexpr uint32_t paper[] = {${TONES.map((t) => hex(paper[t])).join(', ')}};
    return (onPaper ? paper : bright)[t];
}
inline uint32_t color(AgentState state, bool onPaper = false) { return color(tone(state), onPaper); }
inline uint32_t color(const char* wire, bool onPaper = false) { return color(tone(wire), onPaper); }
inline bool pulses(Tone t) { return t == Awaiting; }

/** Sentence case, for rows with room to speak. */
inline const char* label(AgentState state) {
    switch (state) {
${wordTable('label')}
    }
    return ${q(words.idle.label)};
}
/** Uppercase pill text, at most 7 characters. */
inline const char* shortLabel(AgentState state) {
    switch (state) {
${wordTable('short')}
    }
    return ${q(words.idle.short)};
}
/** At most 4 characters. */
inline const char* tinyLabel(AgentState state) {
    switch (state) {
${wordTable('tiny')}
    }
    return ${q(words.idle.tiny)};
}
inline AgentState stateOrIdle(const char* wire) {
    if (wire == nullptr || *wire == '\\0') return AgentState::DISCONNECTED;
    AgentState state;
    return fromWire(wire, state) ? state : AgentState::IDLE;
}
inline const char* label(const char* wire) { return label(stateOrIdle(wire)); }
inline const char* shortLabel(const char* wire) { return shortLabel(stateOrIdle(wire)); }
inline const char* tinyLabel(const char* wire) { return tinyLabel(stateOrIdle(wire)); }
}  // namespace SessionState
`;
}

export function emitSwift(src) {
  const { toneOf, colors, paper, words } = src;
  const swiftCase = (s) => camel(s);
  const toneCases = STATES.map((s) => `        case .${swiftCase(s)}: .${toneOf[s]}`).join('\n');
  const wordCases = STATES.map((s) => `        case .${swiftCase(s)}: SessionStateWords(label: ${q(words[s].label)}, short: ${q(words[s].short)}, tiny: ${q(words[s].tiny)})`).join('\n');
  return `${header}import Foundation

/// Session state presentation — DESIGN.md §2.7. Only \`.awaiting\` may animate.
enum SessionTone: Int, CaseIterable, Sendable {
    case ${TONES.join(', ')}

    static let bright: [UInt32] = [${TONES.map((t) => hex(colors[t])).join(', ')}]
    static let paper: [UInt32] = [${TONES.map((t) => hex(paper[t])).join(', ')}]

    func colorHex(onPaper: Bool = false) -> UInt32 {
        (onPaper ? Self.paper : Self.bright)[rawValue]
    }
    var pulses: Bool { self == .awaiting }
    /// RGB888 for pixel renderers (Pixoo, Timebox, iDotMatrix).
    func rgb(onPaper: Bool = false) -> (UInt8, UInt8, UInt8) {
        let v = colorHex(onPaper: onPaper)
        return (UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF))
    }

    /// Missing → offline; unknown non-empty → idle (a live, quiet session).
    init(wire: String?) {
        guard let wire, !wire.isEmpty else { self = .offline; return }
        self = AgentConnectionState(rawValue: wire)?.sessionTone ?? .idle
    }
}

struct SessionStateWords: Equatable, Sendable {
    /// Sentence case, for rows with room to speak.
    let label: String
    /// Uppercase pill text, at most 7 characters.
    let short: String
    /// At most 4 characters.
    let tiny: String
}

extension AgentConnectionState {
    var sessionTone: SessionTone {
        switch self {
${toneCases}
        }
    }

    var sessionWords: SessionStateWords {
        switch self {
${wordCases}
        }
    }
}
`;
}

export function emitKotlin(src) {
  const { toneOf, colors, paper, words } = src;
  const toneCases = STATES.map((s) => `        AgentState.${upperSnake(s)} -> SessionTone.${upperSnake(toneOf[s])}`).join('\n');
  const wordCases = STATES.map((s) => `        AgentState.${upperSnake(s)} -> SessionStateWords(${q(words[s].label)}, ${q(words[s].short)}, ${q(words[s].tiny)})`).join('\n');
  return `${header}package dev.agentdeck.util

import dev.agentdeck.net.AgentState

/** Session state presentation — DESIGN.md §2.7. Only [SessionTone.AWAITING] may animate. */
enum class SessionTone(val bright: Long, val paper: Long) {
${TONES.map((t, i) => `    ${upperSnake(t)}(${argb(colors[t])}, ${argb(paper[t])})${i === TONES.length - 1 ? ';' : ','}`).join('\n')}

    fun color(onPaper: Boolean = false): Long = if (onPaper) paper else bright
    val pulses: Boolean get() = this == AWAITING
}

/** [label] sentence case; [short] uppercase pill, at most 7 characters; [tiny] at most 4. */
data class SessionStateWords(val label: String, val short: String, val tiny: String)

val AgentState.sessionTone: SessionTone
    get() = when (this) {
${toneCases}
    }

val AgentState.sessionWords: SessionStateWords
    get() = when (this) {
${wordCases}
    }
`;
}

export const outputs = [
  ['esp32/src/ui/product_palette.generated.h', emitCpp],
  ['esp32/src/ui/session_state.generated.h', emitCppSession],
  ['apple/AgentDeck/Model/SessionStatePresentation.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/util/SessionStatePresentation.kt', emitKotlin],
];

/** Collects the generator input from the built shared package. */
export function sourceFrom(shared) {
  const words = Object.fromEntries(STATES.map((s) => [s, shared.SESSION_STATE_WORDS[s]]));
  return {
    ui: shared.UI,
    brand: shared.Brand,
    toneOf: shared.SESSION_STATE_TONES,
    colors: shared.SESSION_TONE_COLORS,
    paper: shared.SESSION_TONE_PAPER_COLORS,
    words,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const shared = await import('../shared/dist/index.js');
  const src = sourceFrom(shared);
  for (const [target, emit] of outputs) {
    const value = emit(src);
    if (process.argv.includes('--check')) {
      if (fs.readFileSync(path.join(root, target), 'utf8') !== value) throw Error('Session state mirror drift: ' + target);
    } else fs.writeFileSync(path.join(root, target), value);
  }
}
