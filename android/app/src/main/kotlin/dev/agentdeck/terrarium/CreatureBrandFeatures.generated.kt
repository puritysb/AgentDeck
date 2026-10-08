// Generated from shared/src/brand-features.ts + unchanged canonical SVGs. Do not edit.
package dev.agentdeck.terrarium

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.toArgb

internal object CreatureBrandFeatures {
    const val MONOCHROME_MINIMUM_SIZE = 24f
    const val MONOCHROME_OUTLINE_WIDTH = 0.4f
    val monochromeLightBodyAgents = setOf("claudecode", "openclaw")
    class Layer(val role: String, val hole: Boolean, val monochrome: String, val creatureMonochrome: String, val color: Color?, paths: List<String>) {
        val composePaths by lazy { paths.map { androidx.compose.ui.graphics.vector.PathParser().parsePathString(normalizeSvgArcFlags(it)).toPath() } }
        val nativePaths by lazy { paths.map { androidx.core.graphics.PathParser.createPathFromPathData(normalizeSvgArcFlags(it)) } }
    }
    val layers = mapOf(
        "claudecode" to listOf(
            Layer("eyes", false, "paper", "ink", Color(0f, 0f, 0f), listOf("M6 10.949h1.488V8.102H6v2.847z", "M16.51 10.949H18V8.102h-1.49v2.847z"))
        ),
        "codex" to listOf(
            Layer("prompt", false, "paper", "paper", Color(1f, 1f, 1f), listOf("M7.282 8.307a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393z", "M12.728 14.547a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"))
        ),
        "openclaw" to listOf(
            Layer("eyes", false, "paper", "ink", Color(0.0196078431372549f, 0.03137254901960784f, 0.06274509803921569f), listOf("M8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532z", "M15.165 6.577a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z")),
            Layer("eye-highlight", false, "ink", "paper", Color(0f, 0.8980392156862745f, 0.8f), listOf("M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z")),
            Layer("eye-highlight", false, "ink", "paper", Color(0f, 0.8980392156862745f, 0.8f), listOf("M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z"))
        ),
        "opencode" to listOf(
            Layer("center", true, "hole", "hole", null, listOf("M16 6H8v12h8V6z"))
        )
    )
    fun canonical(agent: String?) = when (agent) {
        "claude", "claude-code", "claude_code" -> "claudecode"
        "codex-cli", "codex-app" -> "codex"
        "crayfish" -> "openclaw"
        else -> agent ?: ""
    }
    fun draw(scope: DrawScope, agent: String?, compactInkMonochrome: Boolean = false, monochromeCreature: Boolean = false) {
        for (layer in layers[canonical(agent)].orEmpty()) {
            if (layer.hole) continue
            val color = layer.color ?: continue
            val shade = if (compactInkMonochrome) { if (layer.monochrome == "ink") Color.Black else Color.White } else if (monochromeCreature) { if (layer.creatureMonochrome == "paper") Color.White else Color.Black } else color
            for (path in layer.composePaths) scope.drawPath(path, shade)
        }
    }
    fun drawNative(canvas: android.graphics.Canvas, paint: android.graphics.Paint, agent: String?, matrix: android.graphics.Matrix? = null, monochromeCreature: Boolean = false) {
        val previousColor = paint.color
        val previousAlpha = paint.alpha
        val previousShader = paint.shader
        val previousStyle = paint.style
        paint.shader = null
        paint.style = android.graphics.Paint.Style.FILL
        for (layer in layers[canonical(agent)].orEmpty()) {
            if (layer.hole) continue
            val color = layer.color ?: continue
            paint.color = (if (monochromeCreature) { if (layer.creatureMonochrome == "paper") Color.White else Color.Black } else color).toArgb()
            paint.alpha = 255
            for (source in layer.nativePaths) {
                val path = android.graphics.Path(source)
                if (matrix != null) path.transform(matrix)
                canvas.drawPath(path, paint)
            }
        }
        paint.color = previousColor
        paint.alpha = previousAlpha
        paint.shader = previousShader
        paint.style = previousStyle
    }
}
