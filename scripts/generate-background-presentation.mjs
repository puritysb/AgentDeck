#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root,'shared/src/background-work-presentation.ts'),'utf8');
const p = JSON.parse(source.match(/BACKGROUND_PRESENTATION = (\{[\s\S]*?\}) as const/)[1]);
const header = '// GENERATED from shared/src/background-work-presentation.ts. DO NOT EDIT.\n';
export const outputs = {
 'android/app/src/main/kotlin/dev/agentdeck/terrarium/BackgroundWorkPolicy.generated.kt': `${header}package dev.agentdeck.terrarium

object BackgroundWorkPolicy {
    const val MAX_COUNT = ${p.maxCount}
    const val MAX_DOTS = ${p.maxDots}
    const val ORBIT_MS = ${p.orbitMs}L
    const val FINISH_MS = ${p.finishMs}L
    fun count(value: Int?): Int? = value?.takeIf { it in 0..MAX_COUNT }
    fun label(value: Int?, standby: Int? = null): String? {
        val active = count(value); val waiting = count(standby) ?: 0
        if ((active == null || active == 0) && waiting > 0) return "$waiting ${p.standby}"
        return active?.let { if (it == 0) "${p.complete}" else "$it ${p.running}" }
    }
    fun compact(value: Int?, standby: Int? = null): String? {
        val active = count(value); val waiting = count(standby) ?: 0
        if ((active == null || active == 0) && waiting > 0) return "${p.standbyCompact} $waiting"
        return active?.let { if (it == 0) "${p.done}" else "${p.compact} $it" }
    }
}
`,
 'esp32/src/util/background_work.generated.h': `${header}#pragma once
#include <stdio.h>
namespace BackgroundWork {
static constexpr int MaxCount = ${p.maxCount};
static constexpr int MaxDots = ${p.maxDots};
static constexpr int OrbitMs = ${p.orbitMs};
static constexpr int FinishMs = ${p.finishMs};
inline int count(int value) { return value >= 0 && value <= MaxCount ? value : -1; }
inline void label(int value, int standby, char* out, size_t size) {
    if (count(value) <= 0 && count(standby) > 0) snprintf(out, size, "${p.standbyCompact} %d", standby);
    else if (count(value) < 0) { if(size) out[0] = 0; }
    else if(value == 0) snprintf(out, size, "${p.done}");
    else snprintf(out, size, "${p.compact} %d", value);
}
inline void label(int value, char* out, size_t size) { label(value, -1, out, size); }
}
`,
 'apple/AgentDeck/Model/BackgroundDevicePolicy.generated.swift': `${header}import Foundation
enum BackgroundDevicePolicy {
    static let maxCount = ${p.maxCount}
    static let maxDots = ${p.maxDots}
    static let pixelRadiusFraction = ${p.pixelRadiusFraction}
    static let pixelOrbitAspect = ${p.pixelOrbitAspect}
    static let pixelMinRadius: Double = ${p.pixelMinRadius}
    static let orbitMs = ${p.orbitMs}
    static let finishMs = ${p.finishMs}
    static func count(_ value: Int?) -> Int? {
        guard let value, value >= 0, value <= maxCount else { return nil }
        return value
    }
    static func decode(_ raw: Any?) -> Int? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite, n.doubleValue.rounded(.down) == n.doubleValue,
              n.doubleValue >= 0, n.doubleValue <= Double(maxCount) else { return nil }
        return n.intValue
    }
    static func compact(_ value: Int?, standby: Int? = nil) -> String? {
        let waiting = count(standby) ?? 0
        if (count(value) ?? 0) == 0, waiting > 0 { return "${p.standbyCompact} \\(waiting)" }
        guard let value = count(value) else { return nil }
        return value == 0 ? "${p.done}" : "${p.compact} \\(value)"
    }
}
`
};
// Apple owns the established jar language. Export its measured dimensions and
// cached artwork rather than inventing another Android appearance.
const apple = fs.readFileSync(path.join(root, 'apple/AgentDeck/Terrarium/AquariumResidents.swift'), 'utf8');
const constants = [...apple.slice(apple.indexOf('enum BackgroundWorkPresentation'), apple.indexOf('enum Axis')).matchAll(/static let (\w+)(?:: Float)? = ([^\n]+)/g)]
 .filter(([,name]) => name !== 'pearlBody' && name !== 'pearlShade')
 .map(([,name,value]) => `    const val ${name} = ${value.replace(/\b(\d+\.\d+)\b/g, '$1f')}${/^(?:\d+)$/.test(value) && ['radiansPerSecond','lapSeconds','finishSeconds','followRate','settleRate'].includes(name) ? 'f' : ''}`);
outputs['android/app/src/main/kotlin/dev/agentdeck/terrarium/BackgroundBuddyStyle.generated.kt'] =
 `// GENERATED from Apple BackgroundWorkPresentation by generate-background-presentation.mjs.\npackage dev.agentdeck.terrarium\n\ninternal object BackgroundBuddyStyle {\n${constants.join('\n')}\n}\n`;

const renderer = fs.readFileSync(path.join(root, 'apple/AgentDeck/Terrarium/TerrariumRenderer.swift'), 'utf8');
const artwork = renderer.slice(renderer.indexOf('private enum BuddyPaths'), renderer.indexOf('/// Jar buddies (see'));
const f = n => `${Number(Number(n).toFixed(6))}f`;
const rect = r => {
 const v = [...r.matchAll(/(?:x|y|width|height): (-?[\d.]+)/g)].map(x => Number(x[1]));
 if(v.length !== 4) throw Error(`Cannot translate buddy rectangle: ${r}`);
 return [v[0],v[1],v[0]+v[2],v[1]+v[3]].map(f).join(', ');
};
const point = p => p.includes('.zero') ? '0f, 0f' : [...p.matchAll(/[xy]: (-?[\d.]+)/g)].map(x => f(x[1])).join(', ');
const paths = [];
for(const m of artwork.matchAll(/static let (\w+)(?:: Path)? = (Path\([^\n]+\)|\{[\s\S]*?\}\(\))/g)) {
 const [,name,body] = m;
 if(name === 'sparkle') { paths.push('    val sparkle = Path().apply { for (k in 0 until 6) { val a = k * kotlin.math.PI.toFloat() / 3; moveTo(kotlin.math.cos(a)*.55f,kotlin.math.sin(a)*.55f); lineTo(kotlin.math.cos(a),kotlin.math.sin(a)) } }'); continue; }
 const cmds = [];
 for(const line of body.split('\n')) {
  if(/ellipseIn:|addEllipse/.test(line)) cmds.push(`addOval(${rect(line)}, Path.Direction.CW)`);
  else if(/roundedRect:/.test(line)) cmds.push(`addRoundRect(${rect(line)}, ${f(line.match(/cornerRadius: ([\d.]+)/)[1])}, ${f(line.match(/cornerRadius: ([\d.]+)/)[1])}, Path.Direction.CW)`);
  else if(/addRect/.test(line)) cmds.push(`addRect(${rect(line)}, Path.Direction.CW)`);
  else if(/p.move/.test(line)) cmds.push(`moveTo(${point(line)})`);
  else if(/addLine/.test(line)) cmds.push(`lineTo(${point(line)})`);
  else if(/addQuadCurve/.test(line)) { const [end,control] = line.split(', control:'); cmds.push(`quadTo(${point(control)}, ${point(end)})`); }
  else if(/closeSubpath/.test(line)) cmds.push('close()');
 }
 if(!cmds.length) throw Error(`Untranslated jar path ${name}`);
 paths.push(`    val ${name} = Path().apply { ${cmds.join('; ')} }`);
}
outputs['android/app/src/main/kotlin/dev/agentdeck/terrarium/BackgroundBuddyPaths.generated.kt'] =
 `// GENERATED from Apple BuddyPaths by generate-background-presentation.mjs.\npackage dev.agentdeck.terrarium\nimport android.graphics.Path\ninternal object BackgroundBuddyPaths {\n${paths.join('\n')}\n    const val lidSeat = ${f(artwork.match(/lidSeat: CGFloat = (-?[\d.]+)/)[1])}\n}\n`;
const meshReceipt = JSON.parse(fs.readFileSync(path.join(root,'assets/terrarium/background-buddies.json'),'utf8'));
const meshSource = apple.slice(apple.indexOf('    private func makeBuddy('),apple.indexOf('    private func makeBackgroundWork('));
const sha = value => createHash('sha256').update(value).digest('hex');
const motionSource = apple.slice(apple.indexOf('enum BackgroundWorkPresentation'),apple.indexOf('/// A presentation projection'));
if(sha(motionSource) !== meshReceipt.appleMotionSha256) throw Error('Apple jar motion changed: review BackgroundBrood.kt and refresh the export receipt');
if(sha(meshSource) !== meshReceipt.appleMeshSha256) throw Error('Apple jar meshes changed: update/re-export Android background buddies');
for(const [name,hash] of Object.entries(meshReceipt.assets)) {
 if(sha(fs.readFileSync(path.join(root,'android/app/src/main/assets/residents',name))) !== hash) throw Error(`jar asset drift: ${name}`);
}
for(const [target,body] of Object.entries(outputs)) {
 const file = path.join(root,target);
 if(process.argv.includes('--check')) { if(!fs.existsSync(file) || fs.readFileSync(file,'utf8')!==body) throw Error(`drift: ${target}`); }
 else fs.writeFileSync(file,body);
}
