package dev.agentdeck.ui.monitor

import android.graphics.BitmapFactory
import android.util.Base64
import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.agentdeck.net.DotHabitatRules
import dev.agentdeck.net.DotSurfaceRules
import dev.agentdeck.net.DotSurfaceSnapshot
import dev.agentdeck.terrarium.*
import dev.agentdeck.ui.theme.DesignTokens
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay

/** Same shell clock and name-tag renderer as the other inhabitants; no fixed HUD badge. */
@Composable
fun DotHabitat(dot: DotSurfaceSnapshot, labelsVisible: Boolean) {
    val latest by rememberUpdatedState(dot)
    val motion=remember { HermesHomeMotion(.8f) }
    var clock by remember { mutableLongStateOf(0L) }
    var expanded by remember { mutableStateOf(false) }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    val paint=remember { Paint(Paint.ANTI_ALIAS_FLAG) }
    val portrait=remember(dot.appearance?.id) {
        runCatching {
            val a=dot.appearance?.takeIf { it.validGlyph() } ?: return@runCatching null
            val png=a.png ?: return@runCatching null
            if(png.length > ((DotSurfaceRules.portraitBytes+2)/3)*4) return@runCatching null
            val data=Base64.decode(png,Base64.DEFAULT)
            val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true }
            BitmapFactory.decodeByteArray(data,0,data.size,bounds)
            if(bounds.outWidth !in 1..DotSurfaceRules.portraitSize || bounds.outHeight !in 1..DotSurfaceRules.portraitSize) return@runCatching null
            BitmapFactory.decodeByteArray(data,0,data.size)?.asImageBitmap()
        }.getOrNull()
    }
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            var previous=0L
            while(true) {
                val enabled=(currentCoroutineContext()[MotionDurationScale]?.scaleFactor ?: 1f)>0f
                val stamp=if(enabled) withFrameNanos { it } else System.nanoTime()
                val frame=latest; val now=System.currentTimeMillis()
                val dt=if(previous==0L) 0f else (stamp-previous)/1_000_000_000f
                motion.step(dt,frame.inhabitsHabitat(now),frame.effectiveCode(now)==3,
                    (TerrariumRules.HERMES_HOME_CANVAS_X-.5f)*8f,(.82f-TerrariumRules.HERMES_HOME_CANVAS_Y)*7f,0f,.5f,1.6f,enabled,
                    berthX=((DotHabitatRules.homeX-.5)*8).toFloat(),berthY=((.82-DotHabitatRules.homeY)*7).toFloat())
                previous=stamp;clock=stamp
                if(!enabled) delay(1000)
            }
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val frameClock=clock
        val side=(maxHeight.value*DotHabitatRules.sizeFraction).coerceIn(DotHabitatRules.minSize,DotHabitatRules.maxSize).toFloat()
        val density=androidx.compose.ui.platform.LocalDensity.current.density
        Canvas(Modifier.fillMaxSize()) {
            @Suppress("UNUSED_VARIABLE") val redraw=frameClock
            val r=side*density/2f
            val hx=size.width*DotHabitatRules.homeX.toFloat();val hy=size.height*DotHabitatRules.homeY.toFloat()
            val cx=(.5f+motion.x/8f)*size.width;val cy=(.82f-motion.y/7f)*size.height+(1f-motion.emergence)*r
            if(motion.visible) {
                drawCircle(Brush.radialGradient(listOf(DesignTokens.Tide.s50,DesignTokens.Tide.s100,DesignTokens.Tide.s300),
                    center=Offset(cx-r*.3f,cy-r*.4f),radius=r*1.6f),r,Offset(cx,cy),motion.emergence)
                if(portrait!=null) drawImage(portrait,dstOffset=IntOffset((cx-r).toInt(),(cy-r).toInt()),
                    dstSize=IntSize((r*2).toInt().coerceAtLeast(1),(r*2).toInt().coerceAtLeast(1)),alpha=motion.emergence)
                else for(x in listOf(-.3f,.3f)) drawLine(DesignTokens.Ink.s900,Offset(cx+x*r,cy-r*.12f),Offset(cx+x*r,cy+r*.2f),r*.12f,alpha=motion.emergence)
            }
            if(labelsVisible && dot.configured) {
                val metric=creatureNameTagMetric(size.width,1f)
                val top=if(motion.visible) cy-r else hy-r*.5f
                val layout=resolveCreatureNameTagLayout("Dot",top,metric,paint)
                val code=dot.effectiveCode(System.currentTimeMillis())
                submitCreatureNameTag(this,CreatureNameTagRequest(cx=cx,tagBottomY=layout.tagBottomY,
                    tagWidth=layout.tagWidth,tagHeight=layout.tagHeight,fontSize=layout.fontSize,lines=layout.lines,lineHeight=layout.lineHeight,
                    background=TerrariumColors.DeepSea,paint=paint,rank=labelRankOf(if(code==2) OctopusVisualState.WORKING else if(code==3 || code==5) OctopusVisualState.ASKING else OctopusVisualState.FLOATING),bodyTopY=top,bodyMetric=metric))
            }
        }
        val hitSide=(side*2).dp
        val hitX=maxWidth*(.5f+motion.x/8f)-hitSide/2
        val hitY=maxHeight*(.82f-motion.y/7f)-hitSide/2
        Box(Modifier.offset(hitX,hitY).size(hitSide).clickable { expanded=true })
    }
    if(expanded) DotReportDialog(dot) { expanded=false }
}
