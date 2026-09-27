#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const header = '// GENERATED from shared/src/usage-severity.ts and design token bindings. DO NOT EDIT.\n';
const keys = ['unknown', 'normal', 'warning', 'critical'];
const hex = color => '0x' + color.slice(1);
export function emitCpp(rules, colors, paper) {
  return `${header}#pragma once
#include <cmath>
#include <cstdint>
namespace UsageSeverity {
enum Level { Unknown, Normal, Warning, Critical };
inline Level level(float used) {
    if (!std::isfinite(used) || used < 0) return Unknown;
    if (used >= ${rules.critical}) return Critical;
    if (used >= ${rules.warning}) return Warning;
    return Normal;
}
inline uint32_t color(float used, bool onPaper = false) {
    static constexpr uint32_t bright[] = {${keys.map(k=>hex(colors[k])).join(', ')}};
    static constexpr uint32_t paper[] = {${keys.map(k=>hex(paper[k])).join(', ')}};
    return (onPaper ? paper : bright)[level(used)];
}
}
`;
}
export function emitSwift(rules, colors, paper) {
  return `${header}import Foundation

enum UsageSeverity {
    enum Level: Int { case unknown, normal, warning, critical }
    static func level(_ used: Double) -> Level {
        if !used.isFinite || used < 0 { return .unknown }
        if used >= ${rules.critical} { return .critical }
        if used >= ${rules.warning} { return .warning }
        return .normal
    }
    static let bright: [UInt32] = [${keys.map(k=>hex(colors[k])).join(', ')}]
    static let paper: [UInt32] = [${keys.map(k=>hex(paper[k])).join(', ')}]
    static func colorHex(_ used: Double, onPaper: Bool = false) -> UInt32 {
        (onPaper ? paper : bright)[level(used).rawValue]
    }
}
`;
}
export function emitKotlin(rules, colors, paper, inactive) {
  return `${header}package dev.agentdeck.util
object UsageSeverity {
    enum class Level { UNKNOWN, NORMAL, WARNING, CRITICAL }
    fun level(used: Double): Level = when {
        !used.isFinite() || used < 0 -> Level.UNKNOWN
        used >= ${rules.critical} -> Level.CRITICAL
        used >= ${rules.warning} -> Level.WARNING
        else -> Level.NORMAL
    }
    private val bright = longArrayOf(${keys.map(k=>'0xFF'+colors[k].slice(1)).join(', ')})
    private val paper = longArrayOf(${keys.map(k=>'0xFF'+paper[k].slice(1)).join(', ')})
    fun inactiveColor(onPaper: Boolean = false): Long = if (onPaper) 0xFF${inactive.paper.slice(1)} else 0xFF${inactive.bright.slice(1)}
    fun color(used: Double, onPaper: Boolean = false): Long = (if (onPaper) paper else bright)[level(used).ordinal]
}
`;
}
export const outputs = [
  ['esp32/src/util/usage_severity.generated.h', emitCpp],
  ['apple/AgentDeck/Model/UsageSeverity.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/util/UsageSeverity.kt', emitKotlin],
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { USAGE_SEVERITY, USAGE_COLORS, USAGE_PAPER_COLORS, USAGE_INACTIVE_COLORS } = await import('../shared/dist/usage-severity.js');
  for (const [target, emit] of outputs) {
    const value = emit(USAGE_SEVERITY, USAGE_COLORS, USAGE_PAPER_COLORS, USAGE_INACTIVE_COLORS);
    if (process.argv.includes('--check')) {
      if (fs.readFileSync(path.join(root, target), 'utf8') !== value) throw Error('Usage severity mirror drift: ' + target);
    } else fs.writeFileSync(path.join(root, target), value);
  }
}
