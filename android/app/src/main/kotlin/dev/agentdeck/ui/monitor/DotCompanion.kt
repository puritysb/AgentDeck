package dev.agentdeck.ui.monitor

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.DotSurfaceSnapshot
import dev.agentdeck.net.DotSurfaceRules
import dev.agentdeck.ui.theme.DesignTokens
import kotlinx.coroutines.delay

@Composable
fun DotCompanion(dot: DotSurfaceSnapshot, modifier: Modifier = Modifier) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(dot) { while (true) { now = System.currentTimeMillis(); delay(1000) } }
    val code = dot.effectiveCode(now)
    val tint = when (code) {
        2 -> DesignTokens.UI.cyan
        3 -> DesignTokens.UI.attn
        4 -> DesignTokens.UI.ok
        5 -> DesignTokens.UI.error
        else -> DesignTokens.Ink.s300
    }
    val image = remember(dot.appearance?.id) {
        runCatching {
            val a = dot.appearance ?: return@runCatching null
            if (!a.validGlyph()) return@runCatching null
            val png = a.png ?: return@runCatching null
            if (png.length > ((DotSurfaceRules.portraitBytes + 2) / 3) * 4) return@runCatching null
            val bytes = Base64.decode(png, Base64.DEFAULT)
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            if (opts.outWidth !in 1..DotSurfaceRules.portraitSize || opts.outHeight !in 1..DotSurfaceRules.portraitSize) return@runCatching null
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }
    Row(modifier.background(DesignTokens.Ink.s800).clickable { expanded = true }.padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (image != null) Image(image, contentDescription = "Dot character", modifier = Modifier.size(42.dp))
        else Canvas(Modifier.size(42.dp)) {
            drawCircle(tint, radius = size.minDimension / 2)
            for (x in listOf(0.37f, 0.63f)) drawLine(DesignTokens.Ink.s900, Offset(size.width * x, size.height * 0.35f), Offset(size.width * x, size.height * 0.6f), 3.dp.toPx())
        }
        Column(Modifier.widthIn(max = 200.dp)) {
            Text("Dot", color = DesignTokens.Tide.s50)
            Text(DotSurfaceRules.labels[code], color = tint)
            dot.relation?.takeIf { it.evidence == "dot_report" }?.let { Text(it.label, maxLines = 3, color = DesignTokens.Tide.s50) }
            Text(if (dot.reportState == null) "Integration" else "Dot report", color = DesignTokens.Ink.s300)
        }
    }
    if (expanded) AlertDialog(onDismissRequest = { expanded = false },
        title = { Text("Dot report") },
        text = { Column { Text(DotSurfaceRules.labels[code]); dot.reportedAt?.let { Text(java.util.Date(it).toString()) }; dot.relation?.takeIf { it.evidence == "dot_report" }?.let { Text(it.label) } } },
        confirmButton = { TextButton(onClick = { expanded = false }) { Text("Done") } })
}

/** Static 1-bit companion for paper chrome; no animation or periodic refresh. */
@Composable
fun DotPaperGlyph(dot: DotSurfaceSnapshot, modifier: Modifier = Modifier) {
    val pixels = remember(dot.appearance?.id) {
        runCatching {
            val text = dot.appearance?.takeIf { it.validGlyph() }?.rgba ?: DotSurfaceRules.defaultRgbaBase64
            Base64.decode(text, Base64.DEFAULT).takeIf { it.size == DotSurfaceRules.glyphBytes }
        }.getOrNull()
    }
    val ink = androidx.compose.material3.MaterialTheme.colorScheme.onSurface
    val paper = androidx.compose.material3.MaterialTheme.colorScheme.surface
    Canvas(modifier.size(24.dp)) {
        val p = pixels ?: return@Canvas
        val side = DotSurfaceRules.glyphSize
        for (y in 0 until side) for (x in 0 until side) {
            val i = (y * side + x) * 4
            if ((p[i+3].toInt() and 255) < 128) continue
            val edge = x == 0 || y == 0 || x == side-1 || y == side-1 ||
                (p[i-4+3].toInt() and 255) < 128 || (p[i+4+3].toInt() and 255) < 128 ||
                (p[i-side*4+3].toInt() and 255) < 128 || (p[i+side*4+3].toInt() and 255) < 128
            val dark = edge || (p[i].toInt() and 255) + (p[i+1].toInt() and 255) + (p[i+2].toInt() and 255) < 384
            drawRect(if (dark) ink else paper, topLeft = Offset(x * size.width / side, y * size.height / side),
                size = androidx.compose.ui.geometry.Size(size.width / side, size.height / side))
        }
    }
}
