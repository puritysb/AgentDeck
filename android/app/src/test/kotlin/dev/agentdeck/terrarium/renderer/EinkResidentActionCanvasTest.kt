package dev.agentdeck.terrarium.renderer

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import dev.agentdeck.terrarium.AquariumResident
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.OctopusVisualState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode
import kotlin.math.PI
import kotlin.math.abs

/** Pixel tests hold the body center still: whole-mark wobble cannot satisfy these assertions. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EinkResidentActionCanvasTest {
    private val side = 600

    private fun pose(kind: String): EinkResidentPose {
        val resident = AquariumResident("articulation", kind, "", OctopusVisualState.WORKING)
        return EinkResidentMotion().advance(listOf(resident), 0.0, side, side).single()
            .copy(phase = 0f, workPhase = 0f, locomotionAmount = 0f, workAmount = 0f)
    }

    private fun draw(kind: String, pose: EinkResidentPose, background: Int = Color.WHITE): Bitmap {
        val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(background)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK }
        when (kind) {
            "claudecode" -> drawEinkOctopus(canvas, paint, side, side, OctopusVisualState.WORKING,
                centerXFraction = .5f, centerYFraction = .5f, scaleFactor = 4f, pose = pose)
            "openclaw" -> drawEinkCrayfish(canvas, paint, side, side, CrayfishVisualState.ROUTING,
                centerXFraction = .5f, centerYFraction = .5f, scaleFactor = 4f, pose = pose)
            "codex" -> drawEinkCloud(canvas, paint, side, side, OctopusVisualState.WORKING,
                centerXFraction = .5f, centerYFraction = .5f, scaleFactor = 4f, pose = pose)
            "kiro-cli" -> drawEinkOpenCode(canvas, paint, side, side, OctopusVisualState.WORKING,
                centerXFraction = .5f, centerYFraction = .5f, scaleFactor = 4f, agentType = kind, pose = pose)
            "hermes" -> {
                canvas.translate(130f, 100f)
                canvas.scale(10f, 10f)
                drawEinkHermesMermaid(canvas, paint, OctopusVisualState.WORKING, pose)
            }
            else -> error("Unsupported articulation fixture")
        }
        return bitmap
    }

    private fun changed(a: Bitmap, b: Bitmap, left: Int, top: Int, right: Int, bottom: Int): Int {
        val width = right - left
        val height = bottom - top
        val first = IntArray(width * height)
        val second = IntArray(width * height)
        a.getPixels(first, 0, width, left, top, width, height)
        b.getPixels(second, 0, width, left, top, width, height)
        return first.indices.count { first[it] != second[it] }
    }

    private fun looking(kind: String, direction: Float) = pose(kind).copy(
        lookX = direction, lookY = 0f, facing = direction,
        headingRadians = if (direction < 0f) PI.toFloat() else 0f,
    )

    private fun pixels(bitmap: Bitmap): IntArray = IntArray(side * side).also {
        bitmap.getPixels(it, 0, side, 0, 0, side, side)
    }

    private fun darkCenterX(bitmap: Bitmap, left: Int, top: Int, right: Int, bottom: Int): Double {
        val image = pixels(bitmap)
        val xs = (top until bottom).flatMap { y ->
            (left until right).filter { x -> Color.red(image[y * side + x]) < 32 }
        }
        assertTrue("The canonical eyes must remain visible", xs.size > 50)
        return xs.average()
    }

    private fun assertNoCutouts(bitmap: Bitmap, left: Int, top: Int, right: Int, bottom: Int) {
        val image = pixels(bitmap)
        val oldHoles = (top until bottom).sumOf { y ->
            (left until right).count { x -> image[y * side + x] == Color.MAGENTA }
        }
        assertEquals("Moving the features must close their original transparent cutouts", 0, oldHoles)
    }

    /** Isolate white glyphs/eyes from the white background without a golden-image dependency. */
    private fun whiteComponents(bitmap: Bitmap, left: Int, top: Int, right: Int, bottom: Int): List<List<Pair<Int, Int>>> {
        val image = pixels(bitmap)
        val seen = BooleanArray(image.size)
        val queue = IntArray(image.size)
        val components = mutableListOf<List<Pair<Int, Int>>>()
        fun white(index: Int) = Color.red(image[index]) >= 250 &&
            Color.green(image[index]) >= 250 && Color.blue(image[index]) >= 250
        for (y in top until bottom) for (x in left until right) {
            val first = y * side + x
            if (seen[first] || !white(first)) continue
            var head = 0
            var tail = 1
            queue[0] = first
            seen[first] = true
            var touchesBoundary = false
            val component = mutableListOf<Pair<Int, Int>>()
            while (head < tail) {
                val index = queue[head++]
                val px = index % side
                val py = index / side
                component.add(px to py)
                if (px == left || px == right - 1 || py == top || py == bottom - 1) touchesBoundary = true
                for (next in intArrayOf(index - 1, index + 1, index - side, index + side)) {
                    val nx = next % side
                    val ny = next / side
                    if (nx !in left until right || ny !in top until bottom || seen[next] || !white(next)) continue
                    seen[next] = true
                    queue[tail++] = next
                }
            }
            if (!touchesBoundary && component.size > 20) components.add(component)
        }
        return components
    }

    private fun shadeDifference(a: Bitmap, b: Bitmap): Long {
        val first = pixels(a)
        val second = pixels(b)
        return first.indices.sumOf { abs(Color.red(first[it]) - Color.red(second[it])).toLong() }
    }

    @Test fun `Claude walks with alternating canonical feet while torso and eyes stay anchored`() {
        val base = pose("claudecode").copy(locomotionAmount = 1f)
        val a = draw("claudecode", base.copy(phase = (PI / 2).toFloat()))
        val b = draw("claudecode", base.copy(phase = (PI * 1.5).toFloat()))
        assertTrue("Foot silhouette must change without moving the body", changed(a, b, 220, 340, 380, 395) > 50)
        assertEquals("The canonical torso and eyes do not bob with the gait", 0, changed(a, b, 220, 235, 380, 330))
        a.recycle(); b.recycle()
    }

    @Test fun `stationary Claude works with arms while feet and torso remain planted`() {
        val base = pose("claudecode").copy(workAmount = 1f)
        val a = draw("claudecode", base)
        val b = draw("claudecode", base.copy(workPhase = (PI / 2).toFloat()))
        val arms = changed(a, b, 170, 265, 212, 335) + changed(a, b, 388, 265, 430, 335)
        assertTrue("Work is a hand action, not a whole-body offset", arms > 50)
        assertEquals(0, changed(a, b, 220, 235, 380, 395))
        a.recycle(); b.recycle()
    }

    @Test fun `stationary OpenClaw works with independent claws while face remains anchored`() {
        val base = pose("openclaw").copy(workAmount = 1f)
        val a = draw("openclaw", base)
        val b = draw("openclaw", base.copy(workPhase = (PI / 2).toFloat()))
        val claws = changed(a, b, 135, 245, 245, 340) + changed(a, b, 355, 245, 465, 340)
        assertTrue("Claws must act even when locomotion is zero", claws > 50)
        assertEquals("Source eyes and central body are not dragged with the claws", 0, changed(a, b, 250, 200, 350, 400))
        a.recycle(); b.recycle()
    }

    @Test fun `Hermes swims with a hinged tail while original head remains upright`() {
        val base = pose("hermes").copy(locomotionAmount = 1f)
        val a = draw("hermes", base.copy(phase = (PI / 2).toFloat()))
        val b = draw("hermes", base.copy(phase = (PI * 1.5).toFloat()))
        assertTrue("Tail and fluke must stroke independently", changed(a, b, 180, 290, 440, 500) > 100)
        assertEquals("The original head must remain intact and upright", 0, changed(a, b, 140, 100, 390, 270))
        a.recycle(); b.recycle()
    }

    @Test fun `held residents do not articulate merely because an unrelated animation clock advances`() {
        for (kind in listOf("claudecode", "openclaw", "hermes", "codex", "kiro-cli")) {
            val base = pose(kind)
            val a = draw(kind, base)
            val b = draw(kind, base.copy(phase = 1.7f, workPhase = 3.1f))
            assertEquals("$kind requires locomotion or work effort to move its limbs", 0, changed(a, b, 0, 0, side, side))
            a.recycle(); b.recycle()
        }
    }

    @Test fun `canonical eyes look toward travel without leaving duplicate source holes`() {
        for (kind in listOf("claudecode", "openclaw")) {
            val left = draw(kind, looking(kind, -1f), Color.MAGENTA)
            val right = draw(kind, looking(kind, 1f), Color.MAGENTA)
            val eyeTop = if (kind == "claudecode") 250 else 235
            val eyeBottom = if (kind == "claudecode") 300 else 275
            assertTrue("$kind eyes must look right when traveling right",
                darkCenterX(right, 220, eyeTop, 380, eyeBottom) >
                    darkCenterX(left, 220, eyeTop, 380, eyeBottom) + 15)
            for (bitmap in listOf(left, right)) {
                if (kind == "claudecode") assertNoCutouts(bitmap, 242, 262, 358, 288)
                else assertNoCutouts(bitmap, 250, 245, 350, 272)
                bitmap.recycle()
            }
        }
    }

    @Test fun `Codex looks both ways while its terminal prompt remains a readable greater-than underscore`() {
        val promptCenters = mutableListOf<Double>()
        for (direction in listOf(-1f, 1f)) {
            val bitmap = draw("codex", looking("codex", direction), Color.MAGENTA)
            val prompt = whiteComponents(bitmap, 220, 240, 385, 360)
            assertEquals("The source prompt has exactly two separate glyphs", 2, prompt.size)
            val chevron = prompt.minBy { points -> points.map { it.first }.average() }
            val underscore = prompt.maxBy { points -> points.map { it.first }.average() }
            val top = chevron.minOf { it.second }
            val height = chevron.maxOf { it.second } - top + 1
            val middle = chevron.filter { it.second - top in height / 3..height * 2 / 3 }
            val ends = chevron.filter { it.second - top < height / 3 || it.second - top > height * 2 / 3 }
            assertTrue("The chevron must remain > even when looking left",
                middle.map { it.first }.average() > ends.map { it.first }.average() + 3)
            val lineWidth = underscore.maxOf { it.first } - underscore.minOf { it.first }
            val lineHeight = underscore.maxOf { it.second } - underscore.minOf { it.second }
            assertTrue("The underscore remains horizontal", lineWidth > lineHeight * 2)
            promptCenters.add(prompt.flatten().map { it.first }.average())
            assertNoCutouts(bitmap, 245, 275, 355, 330)
            bitmap.recycle()
        }
        assertTrue("The unmirrored prompt still tracks the heading", promptCenters[1] > promptCenters[0] + 15)
    }

    @Test fun `Kiro eyes and Hermes silhouette face the chosen horizontal side`() {
        val kiroLeft = draw("kiro-cli", looking("kiro-cli", -1f))
        val kiroRight = draw("kiro-cli", looking("kiro-cli", 1f))
        val leftEyes = whiteComponents(kiroLeft, 170, 170, 430, 430)
        val rightEyes = whiteComponents(kiroRight, 170, 170, 430, 430)
        assertEquals(2, leftEyes.size)
        assertEquals(2, rightEyes.size)
        assertTrue(leftEyes.flatten().map { it.first }.average() < 290)
        assertTrue(rightEyes.flatten().map { it.first }.average() > 310)
        kiroLeft.recycle(); kiroRight.recycle()

        val hermesLeft = draw("hermes", looking("hermes", -1f))
        val hermesRight = draw("hermes", looking("hermes", 1f))
        val leftPixels = pixels(hermesLeft)
        val rightPixels = pixels(hermesRight)
        val mirrorMismatch = (0 until side).sumOf { y ->
            (0 until 540).count { x ->
                (Color.red(leftPixels[y * side + x]) < 245) !=
                    (Color.red(rightPixels[y * side + 539 - x]) < 245)
            }
        }
        assertTrue("Hermes must turn her complete canonical figure", changed(hermesLeft, hermesRight, 0, 0, side, side) > 1000)
        assertTrue("Her native left-facing figure mirrors around the same body center", mirrorMismatch < 100)
        hermesLeft.recycle(); hermesRight.recycle()
    }

    @Test fun `side-facing swimmers turn through the middle without a sign-change flip`() {
        for (kind in listOf("kiro-cli", "hermes")) {
            val middle = looking(kind, 1f).copy(lookX = 0f, lookY = 1f, headingRadians = (PI / 2).toFloat())
            val before = draw(kind, middle.copy(facing = -.001f))
            val after = draw(kind, middle.copy(facing = .001f))
            val left = draw(kind, looking(kind, -1f))
            val right = draw(kind, looking(kind, 1f))
            assertTrue("$kind must retain a visible edge-on body", pixels(before).count { Color.red(it) < 245 } > 100)
            assertTrue("$kind must blend the narrow middle instead of instantly reflecting it",
                shadeDifference(before, after) * 20 < shadeDifference(left, right))
            before.recycle(); after.recycle(); left.recycle(); right.recycle()
        }
    }
}
