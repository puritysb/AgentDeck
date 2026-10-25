package dev.agentdeck.terrarium.renderer

import dev.agentdeck.net.CiWaitStatus
import dev.agentdeck.terrarium.AquariumResident
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.TerrariumRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

class EinkResidentLayoutTest {
    private val mixedKinds = listOf("claudecode", "codex", "openclaw", "hermes", "opencode", "kiro", "antigravity", "claudecode")

    private fun residents(kinds: List<String> = mixedKinds) =
        List(TerrariumRules.NATIVE_RESIDENT_LIMIT) { i ->
            AquariumResident("resident-$i", kinds[i % kinds.size], "Workspace $i", OctopusVisualState.WORKING)
        }

    private fun track(items: List<AquariumResident>, seconds: Int, hz: Int = 10,
                      width: Int = 1448, height: Int = 970): List<List<EinkResidentPose>> {
        val motion = EinkResidentMotion()
        return (0..seconds * hz).map { motion.advance(items, it.toDouble() / hz, width, height) }
    }

    private fun distance(a: EinkResidentPose, b: EinkResidentPose): Float =
        hypot(a.home.x - b.home.x, a.home.y - b.home.y)

    private fun pathLength(poses: List<EinkResidentPose>): Double =
        poses.zipWithNext().sumOf { (a, b) -> distance(a, b).toDouble() }

    @Test fun `working residents cross more than their own body width instead of wobbling around a home`() {
        for (kind in listOf("claudecode", "codex", "openclaw", "hermes")) {
            val item = residents(listOf(kind)).first()
            val path = track(listOf(item), 60).map { it.single() }
            val body = path.first().home.body
            // Actual displacement from the spawn, not accumulated back-and-forth distance.
            assertTrue("$kind must visibly leave its initial patch within 15 seconds",
                path.take(151).maxOf { distance(path.first(), it) } > body)
            assertTrue("$kind must cover a broad habitat range over one minute",
                path.maxOf { it.home.x } - path.minOf { it.home.x } > 970f * .30f)
            assertTrue("$kind must stop to work as well as travel", path.any { it.behavior == EinkResidentBehavior.WORKING })
            assertTrue("$kind needs a visible travelling action", path.any { it.locomotionAmount > .5f })
            assertTrue("$kind needs an independent stationary work action",
                path.any { it.workAmount > .8f && it.locomotionAmount < .03f })
        }
    }

    @Test fun `crowded mixed and homogeneous populations remain readable separated and wholly in view`() {
        for ((width, height) in listOf(1448 to 970, 1072 to 1325, 1448 to 750)) {
            for (kinds in listOf(mixedKinds, listOf("claudecode"), listOf("codex"), listOf("hermes"))) {
                val items = residents(kinds)
                val motion = EinkResidentMotion()
                val first = motion.advance(items, 0.0, width, height)
                assertEquals(8, first.size)
                assertTrue("Six-inch scenes need readable bodies", first.all { it.home.body >= 100f })
                val travelled = BooleanArray(items.size)
                for (frame in 1..600) {
                    val poses = motion.advance(items, frame * .1, width, height)
                    for (pose in poses) {
                        val x = pose.home.x
                        val y = pose.home.y
                        val body = pose.home.body
                        assertTrue("Finite resident pose", listOf(x, y, body, pose.phase, pose.workPhase,
                            pose.velocityX, pose.velocityY, pose.facing).all { it.isFinite() })
                        assertEquals(x, pose.slot.centerXFraction * width, .01f)
                        assertEquals(y, pose.slot.centerYFraction * height, .01f)
                        assertTrue("${pose.home.id} body crossed horizontal bounds", x - body * .70f >= 0 && x + body * .70f <= width)
                        assertTrue("${pose.home.id} body or name crossed vertical bounds", y - body * .94f >= 0 && y + body * .66f <= height)
                        val bubbleX = einkQuestionBubbleX(x, body, width)
                        assertTrue("Question bubble clipped", bubbleX - body * .18f >= 0 && bubbleX + body * .18f <= width)
                        val companion = einkCompanionPosition(pose, width, height)
                        val half = minOf(width, height) * TerrariumRules.CI_COMPANION_SIZE_FRAC / 2
                        val cx = companion.first * width
                        val cy = companion.second * height
                        assertTrue("CI companion clipped", cx - half >= 0 && cx + half <= width && cy - half >= 0 && cy + half <= height)
                        assertTrue("CI companion painted over its owner", hypot(cx - x, cy - y) >= body * .70f + half)
                    }
                    if (frame >= 20) {
                        for (a in poses.indices) for (b in 0 until a) {
                            assertTrue("${kinds.joinToString()} in ${width}x$height: resident silhouettes overlap at ${frame / 10.0}s",
                                distance(poses[a], poses[b]) >= (poses[a].home.body + poses[b].home.body) * .64f)
                        }
                    }
                    if (frame <= 150) poses.indices.forEach {
                        travelled[it] = travelled[it] || distance(first[it], poses[it]) > first[it].home.body
                    }
                }
                assertTrue("Crowded residents must still roam instead of forming an immobilized icon array", travelled.count { it } >= 4)
            }
        }
    }

    @Test fun `idle explores and rests while permission CI waiting and sleeping hold their positions`() {
        val item = residents(listOf("codex")).first()
        val working = track(listOf(item), 60).map { it.single() }
        val idle = track(listOf(item.copy(state = OctopusVisualState.FLOATING)), 60).map { it.single() }
        assertTrue(idle.any { it.behavior == EinkResidentBehavior.EXPLORING })
        assertTrue(idle.any { it.behavior == EinkResidentBehavior.RESTING && it.locomotionAmount < .02f })
        assertTrue("Quiet exploration is clearly calmer than active work", pathLength(working) > pathLength(idle) * 1.6)
        assertTrue("Idle is not presented as task work", idle.all { it.workAmount == 0f })
        val held = listOf(
            item.copy(state = OctopusVisualState.ASKING),
            item.copy(ciWait = CiWaitStatus(phase = "running", agentWaiting = true)),
            item.copy(state = OctopusVisualState.SLEEPING),
            item.copy(kind = "hermes", state = OctopusVisualState.FLOATING),
        )
        for (resident in held) {
            val path = track(listOf(resident), 30).map { it.single() }
            assertEquals("${resident.kind}/${resident.state} must hold after settling", 0.0, pathLength(path.drop(30)), .001)
            assertTrue(path.drop(30).all { it.locomotionAmount == 0f && it.workAmount == 0f })
            if (resident.state == OctopusVisualState.SLEEPING) {
                assertEquals(path.first().phase, path.last().phase, 0f)
                assertEquals(path.first().workPhase, path.last().workPhase, 0f)
            }
        }
    }

    @Test fun `state changes brake smoothly without resetting place gait or task phase`() {
        val item = residents(listOf("codex")).first()
        val motion = EinkResidentMotion()
        var previous = motion.advance(listOf(item), 0.0, 1448, 970).single()
        for (frame in 1..40) previous = motion.advance(listOf(item), frame * .1, 1448, 970).single()
        val waiting = item.copy(state = OctopusVisualState.ASKING)
        val switched = motion.advance(listOf(waiting), 4.0, 1448, 970).single()
        assertEquals(previous.home, switched.home)
        assertEquals(previous.phase, switched.phase, 0f)
        assertEquals(previous.workPhase, switched.workPhase, 0f)
        val braking = (41..140).map { motion.advance(listOf(waiting), it * .1, 1448, 970).single() }
        for (pose in braking) {
            assertTrue("State update teleported a resident", distance(previous, pose) < 970 * .015f)
            previous = pose
        }
        assertEquals(0.0, pathLength(braking.drop(30)), .001)
        val resumed = motion.advance(listOf(item), 14.0, 1448, 970).single()
        assertEquals(previous.home, resumed.home)
        assertEquals(previous.phase, resumed.phase, 0f)
        assertEquals(previous.workPhase, resumed.workPhase, 0f)
        val later = (141..240).map { motion.advance(listOf(item), it * .1, 1448, 970).single() }
        assertTrue("Work resumes from the held location", later.maxOf { distance(resumed, it) } > resumed.home.body)
    }

    @Test fun `gait follows distance and stationary work uses its own continuing phase`() {
        val path = track(listOf(residents(listOf("claudecode")).first()), 60).map { it.single() }
        val stationaryWork = path.zipWithNext().filter { (a, b) ->
            a.workAmount > .8f && b.workAmount > .8f && a.locomotionAmount == 0f && b.locomotionAmount == 0f
        }
        assertTrue("At least one settled work interval is required", stationaryWork.isNotEmpty())
        stationaryWork.forEach { (a, b) ->
            assertEquals("Feet stop advancing at a work site", a.phase, b.phase, .00001f)
            assertTrue("Hands/claws continue the task while feet are planted", b.workPhase > a.workPhase)
        }
    }

    @Test fun `orientation changes retain normalized places and identity reorder does not respawn residents`() {
        val items = residents()
        val motion = EinkResidentMotion()
        var before = motion.advance(items, 0.0, 1448, 970)
        for (frame in 1..100) before = motion.advance(items, frame * .1, 1448, 970)
        val reordered = motion.advance(items.reversed(), 10.0, 1448, 970)
        assertEquals(before.associateBy { it.home.id }, reordered.associateBy { it.home.id })
        val portrait = motion.advance(items, 10.0, 1072, 1325)
        for ((a, b) in before.zip(portrait)) {
            val moved = hypot((a.slot.centerXFraction - b.slot.centerXFraction) * 1072,
                (a.slot.centerYFraction - b.slot.centerYFraction) * 1325)
            assertTrue("Rotation may clamp an edge, but must not choose a new habitat place", moved < b.home.body * .35f)
            assertEquals(a.phase, b.phase, 0f)
            assertEquals(a.workPhase, b.workPhase, 0f)
        }
        val retained = motion.advance(items.take(6), 10.0, 1072, 1325)
        assertEquals(portrait.take(6), retained)
        assertTrue(motion.advance(emptyList(), 10.0, 1072, 1325).isEmpty())
        assertTrue(motion.advance(items, 10.0, 0, 1325).isEmpty())
    }

    @Test fun `held residents gain room when a crowd leaves without overlapping or patrolling afterward`() {
        for (state in listOf(OctopusVisualState.ASKING, OctopusVisualState.FLOATING)) {
            val items = residents(listOf(if (state == OctopusVisualState.FLOATING) "hermes" else "claudecode"))
                .map { it.copy(state = state) }
            val motion = EinkResidentMotion()
            var crowded = motion.advance(items, 0.0, 1448, 970)
            for (frame in 1..100) crowded = motion.advance(items, frame * .1, 1448, 970)
            val nearest = crowded.indices.flatMap { a -> (0 until a).map { b -> a to b } }
                .minBy { (a, b) -> distance(crowded[a], crowded[b]) }
            val retained = listOf(items[nearest.first], items[nearest.second])
            val settled = (101..400).map { motion.advance(retained, it * .1, 1448, 970) }
            for (pair in settled.takeLast(50)) {
                assertTrue("Held bodies must not grow into one another after neighboring sessions leave",
                    distance(pair[0], pair[1]) >= (pair[0].home.body + pair[1].home.body) * .64f)
            }
            for (index in retained.indices) {
                assertEquals("Necessary layout recovery must finish, not become a new patrol", 0.0,
                    pathLength(settled.takeLast(50).map { it[index] }), .1)
                assertTrue(settled.last()[index].home.body >= crowded[nearest.first].home.body)
            }
        }
    }

    @Test fun `sleeping resize resolves visible bounds and separation without waiting for another animation tick`() {
        // Freeze different points of a real crowded patrol, including close passing encounters.
        // The all-sleeping renderer does not schedule another tick after this static resize.
        for (kinds in listOf(mixedKinds, listOf("claudecode"), listOf("codex"))) {
            for (freezeAt in listOf(5, 15, 30)) {
                val active = residents(kinds)
                val sleeping = active.map { it.copy(state = OctopusVisualState.SLEEPING) }
                val motion = EinkResidentMotion()
                for (frame in 0..freezeAt * 10) motion.advance(active, frame * .1, 1448, 970)
                motion.advance(sleeping, freezeAt.toDouble(), 1448, 970)
                val portrait = motion.advance(sleeping, freezeAt.toDouble(), 1072, 1325)
                for (pose in portrait) {
                    assertEquals(EinkResidentBehavior.SLEEPING, pose.behavior)
                    assertEquals(0f, pose.locomotionAmount, 0f)
                    assertTrue("Static geometry recovery must preserve readable six-inch bodies", pose.home.body >= 100f)
                    assertTrue("Sleeping body/name must fit the first portrait frame",
                        pose.home.x - pose.home.body * .70f >= 0 &&
                            pose.home.x + pose.home.body * .70f <= 1072 &&
                            pose.home.y - pose.home.body * .94f >= 0 &&
                            pose.home.y + pose.home.body * .66f <= 1325)
                }
                for (a in portrait.indices) for (b in 0 until a) {
                    assertTrue("A static portrait must not retain overlapping sleeping residents",
                        distance(portrait[a], portrait[b]) >= (portrait[a].home.body + portrait[b].home.body) * .64f)
                }
                val repeated = motion.advance(sleeping, freezeAt.toDouble(), 1072, 1325)
                assertEquals("A completed static resize remains still", portrait, repeated)
            }
        }
    }

    @Test fun `horizontal reflection crosses a continuous yaw instead of a sign switch`() {
        for (side in listOf(-1f, 1f)) {
            val facing = EinkResidentFacing(side)
            val values = (1..36).map { facing.advance(-side, 1f / 60f) }
            assertEquals("A completed turn reaches the opposite full side", -side, values.last(), 0f)
            assertTrue("A turn cannot finish as a one-frame mirror", abs(values[11]) < 1f && values[11] * side > 0f)
            assertTrue("The midpoint must pass through the edge-on pose", values.any { abs(it) < .12f })
            values.zipWithNext().forEach { (a, b) ->
                assertTrue("Yaw must progress monotonically", (b - a) * side <= 0f)
                assertTrue("No abrupt reflection at the central crossing", abs(b - a) < .10f)
            }
        }
    }

    @Test fun `vertical swimming retains the horizontal side and completes an already selected turn`() {
        val right = EinkResidentFacing(1f)
        repeat(120) { frame ->
            assertEquals("Tiny horizontal drift must not collapse or mirror a vertical swimmer",
                1f, right.advance(if (frame % 2 == 0) .10f else -.10f, 1f / 60f), 0f)
        }
        right.advance(-1f, .10f)
        repeat(60) { right.advance(0f, 1f / 60f) }
        assertEquals("A vertical heading retains the new side selected before the turn", -1f, right.value, 0f)
        repeat(120) { frame ->
            assertEquals(-1f, right.advance(if (frame % 2 == 0) -.10f else .10f, 1f / 60f), 0f)
        }
    }

    private fun headingChange(a: EinkResidentPose, b: EinkResidentPose): Float =
        abs(atan2(sin(b.headingRadians - a.headingRadians), cos(b.headingRadians - a.headingRadians)))

    private fun physicalSpeed(pose: EinkResidentPose, width: Int = 1448, height: Int = 970): Float {
        val short = minOf(width, height).toFloat()
        return hypot(pose.velocityX * width / short, pose.velocityY * height / short)
    }

    @Test fun `walking and swimming turn continuously and face their actual path in both directions`() {
        for (kind in listOf("claudecode", "codex", "hermes")) {
            val path = track(listOf(residents(listOf(kind)).first()), 90, hz = 20).map { it.single() }
            assertTrue("$kind needs a visible right-facing interval", path.any { it.lookX > .7f && it.locomotionAmount > .3f })
            assertTrue("$kind needs a visible left-facing interval", path.any { it.lookX < -.7f && it.locomotionAmount > .3f })
            for ((a, b) in path.zipWithNext()) {
                assertEquals("Look must remain a unit direction", 1f, hypot(b.lookX, b.lookY), .0001f)
                assertTrue("$kind cannot snap through a turn", headingChange(a, b) <= 4.2f / 20f + .001f)
                assertTrue("A gait envelope cannot switch on or off in one frame", abs(b.locomotionAmount - a.locomotionAmount) < .28f)
                val vx = b.velocityX * 1448f / 970f
                val vy = b.velocityY
                val speed = hypot(vx, vy)
                if (speed > .03f) {
                    assertTrue("$kind is traveling against the direction of its face",
                        (b.lookX * vx + b.lookY * vy) / speed > .65f)
                }
            }
        }
    }

    @Test fun `neighbor avoidance still looks along net travel rather than the original target`() {
        val path = track(residents(), 60).flatten()
        val alignment = path.filter { physicalSpeed(it) > .04f }.map {
            val vx = it.velocityX * 1448f / 970f
            (it.lookX * vx + it.lookY * it.velocityY) / physicalSpeed(it)
        }
        assertTrue("Crowded paths need enough sustained movement to inspect", alignment.size > 500)
        assertTrue("Avoidance must not become sideways skating", alignment.count { it > .7f } > alignment.size * .85)
        assertTrue("Backward contact corrections must remain exceptional", alignment.count { it < 0f } < alignment.size * .03)
    }

    @Test fun `braking retains its final gaze plants the gait and starts again without a pose reset`() {
        for (kind in listOf("claudecode", "hermes")) {
            val item = residents(listOf(kind)).first()
            val motion = EinkResidentMotion()
            var frame = 0
            var cruising = motion.advance(listOf(item), 0.0, 1448, 970).single()
            while (cruising.locomotionAmount < .8f && frame < 150) {
                frame++
                cruising = motion.advance(listOf(item), frame * .1, 1448, 970).single()
            }
            assertTrue("Must begin the state change while moving", cruising.locomotionAmount > .8f)
            val waiting = item.copy(state = OctopusVisualState.ASKING)
            val switched = motion.advance(listOf(waiting), frame * .1, 1448, 970).single()
            assertEquals(cruising.headingRadians, switched.headingRadians, 0f)
            assertEquals(cruising.locomotionAmount, switched.locomotionAmount, 0f)
            assertEquals(cruising.phase, switched.phase, 0f)
            val stopped = (1..40).map { offset -> motion.advance(listOf(waiting), (frame + offset) * .1, 1448, 970).single() }
            assertTrue("The first braking frame should still walk/swim, not freeze", stopped.first().locomotionAmount > .3f)
            assertEquals("The planted pose must settle exactly", 0f, stopped.last().locomotionAmount, 0f)
            for ((a, b) in stopped.takeLast(10).zipWithNext()) {
                assertEquals("Tiny residual drift must not turn the face", a.headingRadians, b.headingRadians, 0f)
                assertEquals(a.lookX, b.lookX, 0f)
                assertEquals(a.lookY, b.lookY, 0f)
                assertEquals(a.phase, b.phase, 0f)
                assertEquals(0f, b.turnAmount, 0f)
            }
            val resumedAt = (frame + 40) * .1
            val resumed = motion.advance(listOf(item), resumedAt, 1448, 970).single()
            assertEquals(stopped.last().home, resumed.home)
            assertEquals(stopped.last().headingRadians, resumed.headingRadians, 0f)
            assertEquals(0f, resumed.locomotionAmount, 0f)
            val firstStep = motion.advance(listOf(item), resumedAt + .1, 1448, 970).single()
            assertTrue("Starting again must accelerate rather than jump to cruise", physicalSpeed(firstStep) <= .027f)
            assertTrue("The departure turn is bounded", headingChange(resumed, firstStep) <= .421f)
        }
    }

    @Test fun `work gestures wait for planted feet and relax before departure`() {
        for (kind in listOf("claudecode", "hermes")) {
            val path = track(listOf(residents(listOf(kind)).first()), 90).map { it.single() }
            assertTrue("A work stop still needs a substantial gesture", path.any { it.workAmount > .9f })
            for (pose in path) {
                if (pose.workAmount > .1f) {
                    assertTrue("Working hands should not accompany sliding feet", physicalSpeed(pose) < .0015f)
                    assertTrue("Walking/swimming must settle before work starts", pose.locomotionAmount < .04f)
                }
                if (pose.locomotionAmount > .15f) {
                    assertTrue("Hands/claws relax before the resident departs", pose.workAmount < .04f)
                }
            }
        }
    }

    @Test fun `deterministic paths match between ten and sixty hertz including state transitions`() {
        fun simulate(hz: Int): List<EinkResidentPose> {
            val motion = EinkResidentMotion()
            var poses = emptyList<EinkResidentPose>()
            for (frame in 0..30 * hz) {
                val items = residents().mapIndexed { index, resident ->
                    if (index % 3 == 0 && frame >= 10 * hz && frame < 20 * hz)
                        resident.copy(state = OctopusVisualState.ASKING) else resident
                }
                // Deliver state events at their exact timestamp, after integrating the previous state.
                // Otherwise a 10 Hz observation applies the event to a longer preceding interval.
                if (frame == 10 * hz) motion.advance(residents(), 10.0, 1448, 970)
                if (frame == 20 * hz) motion.advance(residents().mapIndexed { index, resident ->
                    if (index % 3 == 0) resident.copy(state = OctopusVisualState.ASKING) else resident
                }, 20.0, 1448, 970)
                poses = motion.advance(items, frame.toDouble() / hz, 1448, 970)
            }
            return poses
        }
        val slow = simulate(10)
        val repeat = simulate(10)
        val fast = simulate(60)
        assertEquals("Identical inputs must yield identical geometry", slow, repeat)
        slow.zip(fast).forEach { (a, b) ->
            assertTrue("Display cadence must not change roaming destinations", distance(a, b) < 2f)
            assertEquals(a.behavior, b.behavior)
            assertEquals(a.phase, b.phase, .10f)
            assertEquals(a.workPhase, b.workPhase, .10f)
        }
    }
}
