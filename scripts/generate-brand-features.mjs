// Unchanged canonical SVGs + typed semantic SSOT -> Blender material selectors.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BRAND_FEATURES, creatureFeatureLayers } from '../shared/dist/brand-features.js';
export const OUTPUT = 'design/creatures/brand-features.generated.json';
const root = fileURLToPath(new URL('../', import.meta.url));
export function sourcePaths(svg) {
  return [...svg.replace(/<defs\b[\s\S]*?<\/defs>/g, '').matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match => match[1]);
}
export function emitBrandFeatures(read = relative => readFileSync(resolve(root, relative), 'utf8')) {
  for (const [agent, value] of Object.entries(BRAND_FEATURES.agents)) {
    const svg = read(value.sourcePath);
    if (createHash('sha256').update(svg).digest('hex') !== value.sourceHash) throw new Error(`${agent} canonical SVG changed: review feature contours first`);
    if (value.colorReference && createHash('sha256').update(read(value.colorReference.sourcePath)).digest('hex') !== value.colorReference.sourceHash) throw new Error(agent + ' upstream color reference drift');
    creatureFeatureLayers(agent, sourcePaths(svg));
  }
  return JSON.stringify(BRAND_FEATURES, null, 2) + '\n';
}
export const VECTOR_OUTPUTS = {
  swift: 'apple/AgentDeck/Rendering/CreatureBrandFeatures.generated.swift',
  kotlin: 'android/app/src/main/kotlin/dev/agentdeck/terrarium/CreatureBrandFeatures.generated.kt',
};
function vectorLayers(read) {
  return Object.entries(BRAND_FEATURES.agents).map(([agent, value]) => {
    const svg = read(value.sourcePath);
    if (createHash('sha256').update(svg).digest('hex') !== value.sourceHash) throw new Error(agent + ' canonical SVG drift');
    if (value.colorReference && createHash('sha256').update(read(value.colorReference.sourcePath)).digest('hex') !== value.colorReference.sourceHash) throw new Error(agent + ' upstream color reference drift');
    return [agent, creatureFeatureLayers(agent, sourcePaths(svg))];
  });
}
export function emitSwiftBrandFeatures(read = relative => readFileSync(resolve(root, relative), 'utf8')) {
  const entries = vectorLayers(read).map(([agent, features]) => `        ${JSON.stringify(agent)}: [\n${features.map(f => `            Layer(role: ${JSON.stringify(f.role)}, hole: ${f.mode === 'hole'}, monochrome: ${JSON.stringify(f.monochrome)}, creatureMonochrome: ${JSON.stringify(f.monochromeCreature)}, color: ${f.rgb ? `Color(red: ${f.rgb[0]/255}, green: ${f.rgb[1]/255}, blue: ${f.rgb[2]/255})` : 'nil'}, paths: [${f.paths.map(p => `CrayfishCreature.parseSvgPath(${JSON.stringify(p)})`).join(', ')}])`).join(',\n')}\n        ]`).join(',\n');
  return `// Generated from shared/src/brand-features.ts + unchanged canonical SVGs. Do not edit.\nimport SwiftUI\n\nenum CreatureBrandFeatures {\n    static let monochromeMinimumSize: CGFloat = ${BRAND_FEATURES.monochromeCreature.minSize}\n    static let monochromeOutlineWidth: CGFloat = ${BRAND_FEATURES.monochromeCreature.outlineWidth}\n    static let monochromeLightBodyAgents: Set<String> = [${BRAND_FEATURES.monochromeCreature.lightBodyAgents.map(x => JSON.stringify(x)).join(', ')}]\n    struct Layer {\n        let role: String\n        let hole: Bool\n        let monochrome: String\n        let creatureMonochrome: String\n        let color: Color?\n        let paths: [Path]\n    }\n    static let layers: [String: [Layer]] = [\n${entries}\n    ]\n    static func canonical(_ agent: String?) -> String {\n        switch agent {\n        case "claude", "claude-code", "claude_code": return "claudecode"\n        case "codex-cli", "codex-app": return "codex"\n        case "crayfish": return "openclaw"\n        default: return agent ?? ""\n        }\n    }\n    static func draw(_ agent: String?, context: GraphicsContext, transform: CGAffineTransform = .identity, compactInkMonochrome: Bool = false, monochromeCreature: Bool = false) {\n        for layer in layers[canonical(agent)] ?? [] where !layer.hole {\n            guard let featureColor = layer.color else { continue }\n            let color = compactInkMonochrome ? (layer.monochrome == "ink" ? Color.black : Color.white) : monochromeCreature ? (layer.creatureMonochrome == "paper" ? Color.white : Color.black) : featureColor\n            for path in layer.paths { context.fill(path.applying(transform), with: .color(color)) }\n        }\n    }\n}\n`;
}
export function emitKotlinBrandFeatures(read = relative => readFileSync(resolve(root, relative), 'utf8')) {
  const entries = vectorLayers(read).map(([agent, features]) => `        ${JSON.stringify(agent)} to listOf(\n${features.map(f => `            Layer(${JSON.stringify(f.role)}, ${f.mode === 'hole'}, ${JSON.stringify(f.monochrome)}, ${JSON.stringify(f.monochromeCreature)}, ${f.rgb ? `Color(${f.rgb[0]/255}f, ${f.rgb[1]/255}f, ${f.rgb[2]/255}f)` : 'null'}, listOf(${f.paths.map(p => JSON.stringify(p)).join(', ')}))`).join(',\n')}\n        )`).join(',\n');
  return `// Generated from shared/src/brand-features.ts + unchanged canonical SVGs. Do not edit.\npackage dev.agentdeck.terrarium\n\nimport androidx.compose.ui.graphics.Color\nimport androidx.compose.ui.graphics.drawscope.DrawScope\nimport androidx.compose.ui.graphics.toArgb\n\ninternal object CreatureBrandFeatures {\n    const val MONOCHROME_MINIMUM_SIZE = ${BRAND_FEATURES.monochromeCreature.minSize}f\n    const val MONOCHROME_OUTLINE_WIDTH = ${BRAND_FEATURES.monochromeCreature.outlineWidth}f\n    val monochromeLightBodyAgents = setOf(${BRAND_FEATURES.monochromeCreature.lightBodyAgents.map(x => JSON.stringify(x)).join(', ')})\n    class Layer(val role: String, val hole: Boolean, val monochrome: String, val creatureMonochrome: String, val color: Color?, paths: List<String>) {\n        val composePaths by lazy { paths.map { androidx.compose.ui.graphics.vector.PathParser().parsePathString(normalizeSvgArcFlags(it)).toPath() } }\n        val nativePaths by lazy { paths.map { androidx.core.graphics.PathParser.createPathFromPathData(normalizeSvgArcFlags(it)) } }\n    }\n    val layers = mapOf(\n${entries}\n    )\n    fun canonical(agent: String?) = when (agent) {\n        "claude", "claude-code", "claude_code" -> "claudecode"\n        "codex-cli", "codex-app" -> "codex"\n        "crayfish" -> "openclaw"\n        else -> agent ?: ""\n    }\n    fun draw(scope: DrawScope, agent: String?, compactInkMonochrome: Boolean = false, monochromeCreature: Boolean = false) {\n        for (layer in layers[canonical(agent)].orEmpty()) {\n            if (layer.hole) continue\n            val color = layer.color ?: continue\n            val shade = if (compactInkMonochrome) { if (layer.monochrome == "ink") Color.Black else Color.White } else if (monochromeCreature) { if (layer.creatureMonochrome == "paper") Color.White else Color.Black } else color\n            for (path in layer.composePaths) scope.drawPath(path, shade)\n        }\n    }\n    fun drawNative(canvas: android.graphics.Canvas, paint: android.graphics.Paint, agent: String?, matrix: android.graphics.Matrix? = null, monochromeCreature: Boolean = false) {\n        val previousColor = paint.color\n        val previousAlpha = paint.alpha\n        val previousShader = paint.shader\n        val previousStyle = paint.style\n        paint.shader = null\n        paint.style = android.graphics.Paint.Style.FILL\n        for (layer in layers[canonical(agent)].orEmpty()) {\n            if (layer.hole) continue\n            val color = layer.color ?: continue\n            paint.color = (if (monochromeCreature) { if (layer.creatureMonochrome == "paper") Color.White else Color.Black } else color).toArgb()\n            paint.alpha = 255\n            for (source in layer.nativePaths) {\n                val path = android.graphics.Path(source)\n                if (matrix != null) path.transform(matrix)\n                canvas.drawPath(path, paint)\n            }\n        }\n        paint.color = previousColor\n        paint.alpha = previousAlpha\n        paint.shader = previousShader\n        paint.style = previousStyle\n    }\n}\n`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputs = [[OUTPUT, emitBrandFeatures()], [VECTOR_OUTPUTS.swift, emitSwiftBrandFeatures()], [VECTOR_OUTPUTS.kotlin, emitKotlinBrandFeatures()]];
  for (const [relative, text] of outputs) {
    const output = resolve(root, relative);
    if (process.argv.includes('--check')) {
      if (readFileSync(output, 'utf8') !== text) throw new Error('Creature feature mirror drift: ' + relative);
    } else { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, text); }
  }
}
