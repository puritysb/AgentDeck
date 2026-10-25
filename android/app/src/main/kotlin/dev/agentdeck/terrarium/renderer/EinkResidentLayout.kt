package dev.agentdeck.terrarium.renderer

import dev.agentdeck.terrarium.AquariumResident
import dev.agentdeck.terrarium.CreatureSlot
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.TerrariumRules
import dev.agentdeck.terrarium.ciCompanionPosition
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** Projected body geometry. x/y follow the resident, not a fixed decorative pedestal. */
internal data class EinkResidentHome(val id: String, val x: Float, val y: Float, val body: Float, val grounded: Boolean)

internal enum class EinkResidentBehavior { TRAVELLING, WORKING, EXPLORING, RESTING, WAITING, SLEEPING }

internal data class EinkResidentPose(
    val home: EinkResidentHome,
    val slot: CreatureSlot,
    val rollDegrees: Float,
    val widthScale: Float,
    val heightScale: Float,
    /** Gait phase advances only with distance travelled. */
    val phase: Float,
    val behavior: EinkResidentBehavior,
    /** Velocity in normalized viewport coordinates per second. */
    val velocityX: Float,
    val velocityY: Float,
    val headingRadians: Float,
    /** Continuous full-side yaw: +1 faces right, -1 left, 0 is midway through a turn. */
    val facing: Float,
    val locomotionAmount: Float,
    val workAmount: Float,
    /** Independent task phase for hands/claws while stopped at a work site. */
    val workPhase: Float,
    /** Stable unit look vector; retained after movement stops. */
    val lookX: Float = cos(headingRadians),
    val lookY: Float = sin(headingRadians),
    /** Eased signed turn rate, useful for swimming bank without rotating the face away. */
    val turnAmount: Float = 0f,
)

private fun seedOf(id: String): Int {
    var mixed = id.hashCode()
    mixed = (mixed xor (mixed ushr 16)) * 73244475
    mixed = (mixed xor (mixed ushr 16)) * 73244475
    return (mixed xor (mixed ushr 16)) and Int.MAX_VALUE
}
private fun unitSeed(id: String): Float = seedOf(id).toFloat() / Int.MAX_VALUE.toFloat()
private fun phaseOf(id: String): Float = unitSeed(id) * (2 * PI).toFloat()
private fun grounded(item: AquariumResident): Boolean = item.kind == "claudecode" || item.kind == "openclaw"
private fun length(x: Float, y: Float): Float = sqrt(x * x + y * y)
private fun radicalInverse(value: Int, base: Int): Float {
    var remaining = value
    var fraction = 1f / base
    var result = 0f
    while (remaining > 0) {
        result += (remaining % base) * fraction
        remaining /= base
        fraction /= base
    }
    return result
}

/** Android paper geometry/locomotion, separate from shared state and species semantics. */
private object PaperHabitat {
    const val TICK = 1.0 / 120.0
    const val WORK_SPEED = .10f // short viewport sides / second
    const val EXPLORE_SPEED = .035f
    const val ACCELERATION = .26f
    const val GROUND_TURN_RATE = 4.2f // radians / second
    const val SWIM_TURN_RATE = 3.4f
    const val STOP_SPEED = .001f
    const val FACING_DEADBAND = .16f
    const val SIDE_TURN_SECONDS = .55f
    const val BODY_CLEARANCE = .70f // worst color silhouette, before text collision resolution
    const val GROUND_TOP = .56f
    const val GROUND_BOTTOM = .91f
    const val WATER_TOP = .16f
    const val WATER_BOTTOM = .82f
}

/** Horizontal sprite yaw is independent of a swimmer's vertical look component. */
internal class EinkResidentFacing(initialSide: Float) {
    private var side = if (initialSide < 0f) -1f else 1f
    private var yaw = if (side < 0f) PI.toFloat() else 0f
    var value = side
        private set

    fun advance(horizontalLook: Float, dt: Float): Float {
        if (horizontalLook <= -PaperHabitat.FACING_DEADBAND) side = -1f
        else if (horizontalLook >= PaperHabitat.FACING_DEADBAND) side = 1f
        val target = if (side < 0f) PI.toFloat() else 0f
        val maximum = PI.toFloat() / PaperHabitat.SIDE_TURN_SECONDS * dt.coerceAtLeast(0f)
        yaw += (target - yaw).coerceIn(-maximum, maximum)
        // Cosine gives a gentle start/end while passing continuously through the
        // narrow quarter-turn. A vertical heading retains the selected full side.
        value = when (yaw) { 0f -> 1f; PI.toFloat() -> -1f; else -> cos(yaw) }
        return value
    }
}

private data class HabitatBounds(val left: Float, val top: Float, val right: Float, val bottom: Float)
private enum class ResidentIntent { WORK, IDLE, WAIT, SLEEP }
private fun intent(item: AquariumResident): ResidentIntent = when {
    item.state == OctopusVisualState.SLEEPING -> ResidentIntent.SLEEP
    item.state == OctopusVisualState.ASKING || item.ciWait?.agentWaiting == true -> ResidentIntent.WAIT
    item.state == OctopusVisualState.WORKING -> ResidentIntent.WORK
    else -> ResidentIntent.IDLE
}

/**
 * Persistent locomotion with deterministic destinations, steering and explicit pauses.
 * Positions are normalized, so resize/state updates do not recreate residents at spawn points.
 * Fixed integration steps make 10 Hz EPD and LCD presentation follow the same paths.
 */
internal class EinkResidentMotion {
    private class Body(var item: AquariumResident, var x: Float, var y: Float, var size: Float) {
        var vx = 0f // physical velocity measured in short viewport sides / second
        var vy = 0f
        var previousX = x
        var previousY = y
        var reportedVx = 0f
        var reportedVy = 0f
        var targetX = x
        var targetY = y
        var sequence = 0
        var intent = intent(item)
        var behavior = EinkResidentBehavior.RESTING
        var remaining = 0f
        var blocked = 0f
        var phase = phaseOf(item.id)
        var workPhase = phaseOf(item.id)
        val facingMotion = EinkResidentFacing(if (unitSeed(item.id) < .5f) -1f else 1f)
        val facing get() = facingMotion.value
        var heading = if (facing < 0f) PI.toFloat() else 0f
        var turnAmount = 0f
        var locomotionAmount = 0f
        var workAmount = 0f
    }

    private val bodies = linkedMapOf<String, Body>()
    private var lastTime: Double? = null
    private var remainder = 0.0
    private var viewportWidth = 0
    private var viewportHeight = 0
    private var short = 1f
    private var aspectX = 1f
    private var aspectY = 1f
    private var targetSize = .15f

    fun advance(items: List<AquariumResident>, timeSeconds: Double, width: Int, height: Int): List<EinkResidentPose> {
        if (width <= 0 || height <= 0) return emptyList()
        val now = if (timeSeconds.isFinite()) timeSeconds else lastTime ?: 0.0
        val elapsed = (now - (lastTime ?: now)).coerceIn(0.0, .6)
        lastTime = maxOf(lastTime ?: now, now)
        val resized = viewportWidth != width || viewportHeight != height
        val ids = items.map { it.id }.toSet()
        val geometryChanged = resized || bodies.keys != ids || items.any {
            bodies[it.id]?.item?.kind != it.kind
        }
        viewportWidth = width
        viewportHeight = height
        short = min(width, height).toFloat()
        aspectX = width / short
        aspectY = height / short
        targetSize = min(short * .28f, sqrt(width.toFloat() * height / items.size.coerceAtLeast(1)) * .33f) / short
        bodies.keys.retainAll(ids)
        // Input order is a presentation priority, never a locomotion identity.
        for (item in items.sortedWith(compareBy<AquariumResident> { !grounded(it) }.thenBy { it.id })) {
            val existing = bodies[item.id]
            if (existing == null) {
                val body = Body(item, .5f, .5f, targetSize)
                val start = spawn(body)
                body.x = start.first
                body.y = start.second
                body.targetX = body.x
                body.targetY = body.y
                bodies[item.id] = body
                enterIntent(body, intent(item))
            } else {
                existing.item = item
                // Added residents get room immediately; only traveling bodies grow into freed space.
                existing.size = min(existing.size, targetSize)
                if (geometryChanged) constrain(existing)
                val next = intent(item)
                if (existing.intent != next) enterIntent(existing, next)
            }
        }
        val ordered = bodies.values.sortedBy { it.item.id }
        // A sleeping scene has no running animation clock. Resolve a changed viewport
        // or roster on this very frame, without turning the reflow into a walking gait.
        if (geometryChanged) settleGeometry(ordered)
        remainder += elapsed
        while (remainder + 1e-10 >= PaperHabitat.TICK) {
            step(ordered, PaperHabitat.TICK.toFloat())
            remainder -= PaperHabitat.TICK
        }
        return items.map { project(bodies.getValue(it.id)) }
    }

    private fun bounds(body: Body): HabitatBounds {
        val marginX = body.size * .72f / aspectX
        val top = max(body.size * .98f / aspectY + .04f / aspectY,
            if (grounded(body.item)) PaperHabitat.GROUND_TOP else PaperHabitat.WATER_TOP)
        val bottom = min(1f - (body.size * .68f + .02f) / aspectY,
            if (grounded(body.item)) PaperHabitat.GROUND_BOTTOM else PaperHabitat.WATER_BOTTOM)
        return HabitatBounds(marginX, min(top, bottom), 1f - marginX, max(top, bottom))
    }

    private fun constrain(body: Body) {
        val area = bounds(body)
        body.x = body.x.coerceIn(area.left, area.right)
        body.y = body.y.coerceIn(area.top, area.bottom)
        body.targetX = body.targetX.coerceIn(area.left, area.right)
        body.targetY = body.targetY.coerceIn(area.top, area.bottom)
    }

    private fun settleGeometry(ordered: List<Body>) {
        val anchors = ordered.map { it.x to it.y }
        val limits = ordered.map { it.size * .9f }
        fun boundedMove(index: Int) {
            val body = ordered[index]
            constrain(body)
            val (x, y) = anchors[index]
            val dx = (body.x - x) * aspectX
            val dy = (body.y - y) * aspectY
            val distance = length(dx, dy)
            if (distance > limits[index]) {
                body.x = x + dx / distance * limits[index] / aspectX
                body.y = y + dy / distance * limits[index] / aspectY
                constrain(body)
            }
        }
        // Reflow is limited to less than one body width from the retained position.
        // Pair projection handles the aspect-ratio squeeze without respawning agents.
        repeat(64) {
            for (a in ordered.indices) for (b in 0 until a) {
                val first = ordered[a]; val second = ordered[b]
                var dx = (first.x - second.x) * aspectX
                var dy = (first.y - second.y) * aspectY
                var distance = length(dx, dy)
                val safe = (first.size + second.size) * PaperHabitat.BODY_CLEARANCE
                if (distance >= safe) continue
                if (distance < .0001f) {
                    val phase = phaseOf(first.item.id + second.item.id)
                    dx = cos(phase) * .0001f; dy = sin(phase) * .0001f; distance = .0001f
                }
                val correction = (safe - distance) * .5f
                first.x += dx / distance * correction / aspectX
                first.y += dy / distance * correction / aspectY
                second.x -= dx / distance * correction / aspectX
                second.y -= dy / distance * correction / aspectY
                boundedMove(a); boundedMove(b)
            }
        }
        // If a constrained corner cannot provide enough room within that movement
        // budget, retain a smaller footprint instead of overlapping a resting neighbor.
        // Shrinking cannot create another pair collision; no time or gait advances here.
        for (a in ordered.indices) for (b in 0 until a) {
            val first = ordered[a]; val second = ordered[b]
            val distance = length((first.x - second.x) * aspectX, (first.y - second.y) * aspectY)
            val safe = (first.size + second.size) * PaperHabitat.BODY_CLEARANCE
            if (distance < safe) {
                val fit = (distance / safe * .999f).coerceIn(.01f, 1f)
                first.size *= fit; second.size *= fit
            }
        }
    }

    private fun spawn(body: Body): Pair<Float, Float> {
        val area = bounds(body)
        val offset = seedOf(body.item.id) % 997
        var best = .5f to (area.top + area.bottom) / 2
        var bestScore = Float.NEGATIVE_INFINITY
        for (i in 1..384) {
            val index = i + offset
            val x = area.left + radicalInverse(index, 2) * (area.right - area.left)
            val y = area.top + radicalInverse(index, 3) * (area.bottom - area.top)
            val nearest = bodies.values.minOfOrNull {
                length((x - it.x) * aspectX, (y - it.y) * aspectY) / (body.size + it.size)
            } ?: 2f
            val preferredX = .18f + .64f * unitSeed(body.item.id + ":spawn")
            val score = min(nearest, 2f) - abs(x - preferredX) * .16f
            if (score > bestScore) { bestScore = score; best = x to y }
        }
        return best
    }

    private fun enterIntent(body: Body, next: ResidentIntent) {
        body.intent = next
        body.blocked = 0f
        when (next) {
            ResidentIntent.SLEEP -> {
                body.behavior = EinkResidentBehavior.SLEEPING
                body.vx = 0f; body.vy = 0f
                body.reportedVx = 0f; body.reportedVy = 0f
                body.workAmount = 0f
                body.locomotionAmount = 0f
                body.turnAmount = 0f
            }
            ResidentIntent.WAIT -> {
                body.behavior = EinkResidentBehavior.WAITING
                // Damping below brakes at the current observation position; no new patrol target.
                body.targetX = body.x; body.targetY = body.y
            }
            ResidentIntent.WORK -> {
                body.behavior = EinkResidentBehavior.TRAVELLING
                destination(body)
                body.remaining = 12f
            }
            ResidentIntent.IDLE -> {
                if (body.item.kind == "hermes") {
                    body.behavior = EinkResidentBehavior.RESTING
                    body.remaining = Float.POSITIVE_INFINITY
                } else {
                    body.behavior = EinkResidentBehavior.EXPLORING
                    destination(body)
                    body.remaining = 4f + unitSeed(body.item.id + ":explore") * 3f
                }
            }
        }
    }

    private fun destination(body: Body) {
        body.sequence++
        val area = bounds(body)
        val offset = (seedOf(body.item.id) % 997) + body.sequence * 37
        var best = body.x to body.y
        var bestScore = Float.NEGATIVE_INFINITY
        for (i in 1..48) {
            val x = area.left + radicalInverse(offset + i, 2) * (area.right - area.left)
            val y = area.top + radicalInverse(offset + i, 3) * (area.bottom - area.top)
            val distance = length((x - body.x) * aspectX, (y - body.y) * aspectY)
            val clearance = bodies.values.filter { it !== body }.minOfOrNull {
                length((x - it.x) * aspectX, (y - it.y) * aspectY) - (body.size + it.size) * PaperHabitat.BODY_CLEARANCE
            } ?: 1f
            // Broad destinations, never a tiny orbit around the spawn point. Alternate
            // crossings emerge from distance preference; occupied goals are penalized.
            val score = min(distance, .85f) + min(clearance, .18f) * 2f +
                unitSeed(body.item.id + ":${body.sequence}:$i") * .16f
            if (score > bestScore) { bestScore = score; best = x to y }
        }
        body.targetX = best.first
        body.targetY = best.second
    }

    private fun moving(body: Body) = body.behavior == EinkResidentBehavior.TRAVELLING ||
        body.behavior == EinkResidentBehavior.EXPLORING
    private fun pinned(body: Body) = !moving(body) && length(body.vx, body.vy) < .002f

    private fun settled(body: Body) = length(body.vx, body.vy) < PaperHabitat.STOP_SPEED && body.locomotionAmount < .03f

    private fun turnToward(body: Body, target: Float?, dt: Float) {
        val rate = if (grounded(body.item)) PaperHabitat.GROUND_TURN_RATE else PaperHabitat.SWIM_TURN_RATE
        val difference = target?.let { atan2(sin(it - body.heading), cos(it - body.heading)) } ?: 0f
        val step = difference.coerceIn(-rate * dt, rate * dt)
        if (step != 0f) body.heading = atan2(sin(body.heading + step), cos(body.heading + step))
        body.turnAmount += (step / (rate * dt) - body.turnAmount) * (1f - exp(-dt * 9f))
        if (abs(body.turnAmount) < .001f) body.turnAmount = 0f
        body.facingMotion.advance(cos(body.heading), dt)
    }

    private fun step(ordered: List<Body>, dt: Float) {
        for (body in ordered) { body.previousX = body.x; body.previousY = body.y }
        for (body in ordered) {
            // Waiting, sleeping and resting residents keep their readable footprint.
            // Population shrink must not inflate two stationary neighbors into overlap.
            if (moving(body)) body.size += (targetSize - body.size) * (1f - exp(-dt * 1.5f))
            if (body.intent != ResidentIntent.SLEEP) {
                body.workPhase += dt * (TerrariumRules.NATIVE_ACTIVITY_IDLE_RATE +
                    if (body.intent == ResidentIntent.WORK) TerrariumRules.NATIVE_ACTIVITY_WORK_RATE else 0f)
            }
            // A work dwell begins after braking, rather than consuming the gesture
            // interval while the body is still sliding toward its destination.
            if (body.behavior != EinkResidentBehavior.WORKING || settled(body)) body.remaining -= dt
            val targetDistance = length((body.targetX - body.x) * aspectX, (body.targetY - body.y) * aspectY)
            when (body.behavior) {
                EinkResidentBehavior.TRAVELLING -> if (targetDistance < body.size * .18f || body.remaining <= 0f) {
                    body.behavior = EinkResidentBehavior.WORKING
                    body.remaining = 1.3f + unitSeed(body.item.id + ":work:${body.sequence}") * 1.5f
                }
                EinkResidentBehavior.WORKING -> if (body.remaining <= 0f) {
                    body.behavior = EinkResidentBehavior.TRAVELLING
                    destination(body)
                    body.remaining = 12f
                }
                EinkResidentBehavior.EXPLORING -> if (body.remaining <= 0f || targetDistance < body.size * .15f) {
                    body.behavior = EinkResidentBehavior.RESTING
                    body.remaining = 4f + unitSeed(body.item.id + ":rest:${body.sequence}") * 3f
                }
                EinkResidentBehavior.RESTING -> if (body.remaining <= 0f && body.item.kind != "hermes") {
                    body.behavior = EinkResidentBehavior.EXPLORING
                    destination(body)
                    body.remaining = 4f + unitSeed(body.item.id + ":explore:${body.sequence}") * 3f
                }
                else -> Unit
            }
            var desiredX = 0f
            var desiredY = 0f
            val speed = if (body.behavior == EinkResidentBehavior.EXPLORING) PaperHabitat.EXPLORE_SPEED else PaperHabitat.WORK_SPEED
            if (moving(body)) {
                val dx = (body.targetX - body.x) * aspectX
                val dy = (body.targetY - body.y) * aspectY
                val distance = length(dx, dy).coerceAtLeast(.0001f)
                val approach = (distance / (body.size * .80f)).coerceIn(0f, 1f)
                val arrival = approach * approach * (3f - 2f * approach)
                desiredX = dx / distance * speed * arrival
                desiredY = dy / distance * speed * arrival
                for (other in ordered) {
                    if (other === body) continue
                    val awayX = (body.x - other.x) * aspectX
                    val awayY = (body.y - other.y) * aspectY
                    val separation = length(awayX, awayY).coerceAtLeast(.0001f)
                    val safe = (body.size + other.size) * PaperHabitat.BODY_CLEARANCE
                    val influence = ((safe * 1.8f - separation) / (safe * .8f)).coerceIn(0f, 1f)
                    if (influence <= 0f) continue
                    val nx = awayX / separation
                    val ny = awayY / separation
                    // A shared turning direction gives opposing travelers room to pass.
                    desiredX += (nx * 1.5f - ny * .65f) * speed * influence
                    desiredY += (ny * 1.5f + nx * .65f) * speed * influence
                }
                val magnitude = length(desiredX, desiredY)
                if (magnitude > speed) { desiredX *= speed / magnitude; desiredY *= speed / magnitude }
            }
            if (body.intent == ResidentIntent.SLEEP) {
                body.vx = 0f; body.vy = 0f
            } else {
                val desiredSpeed = length(desiredX, desiredY)
                val currentSpeed = length(body.vx, body.vy)
                val reverse = moving(body) && desiredSpeed > PaperHabitat.STOP_SPEED && currentSpeed > .02f &&
                    (body.vx * desiredX + body.vy * desiredY) / (currentSpeed * desiredSpeed) < -.15f
                val look = when {
                    // Finish braking in the old direction before turning around;
                    // a swimmer should not keep sliding backward through a flip.
                    currentSpeed > .02f -> {
                        val netX = body.reportedVx * aspectX
                        val netY = body.reportedVy * aspectY
                        if (length(netX, netY) > .02f) atan2(netY, netX) else atan2(body.vy, body.vx)
                    }
                    moving(body) && desiredSpeed > PaperHabitat.STOP_SPEED -> atan2(desiredY, desiredX)
                    currentSpeed > PaperHabitat.STOP_SPEED -> atan2(body.vy, body.vx)
                    else -> null
                }
                turnToward(body, look, dt)
                if (desiredSpeed > PaperHabitat.STOP_SPEED) {
                    val alignment = (cos(body.heading) * desiredX + sin(body.heading) * desiredY) / desiredSpeed
                    val ready = if (reverse || body.workAmount > .03f) 0f else
                        ((alignment - .15f) / .85f).coerceIn(0f, 1f)
                    desiredX *= ready * ready
                    desiredY *= ready * ready
                }
                val blend = 1f - exp(-dt * if (moving(body)) 4.5f else 7f)
                var ax = (desiredX - body.vx) * blend
                var ay = (desiredY - body.vy) * blend
                val acceleration = length(ax, ay)
                val limit = PaperHabitat.ACCELERATION * dt
                if (acceleration > limit) { ax *= limit / acceleration; ay *= limit / acceleration }
                body.vx += ax; body.vy += ay
                if (!moving(body) && length(body.vx, body.vy) < .0003f) { body.vx = 0f; body.vy = 0f }
                body.x += body.vx * dt / aspectX
                body.y += body.vy * dt / aspectY
            }
            constrain(body)
            val desiredWork = if (body.behavior == EinkResidentBehavior.WORKING && settled(body)) 1f else 0f
            body.workAmount += (desiredWork - body.workAmount) * (1f - exp(-dt * 5f))
            if (body.workAmount < .001f) body.workAmount = 0f
        }
        // A final bounded separation pass protects silhouettes even when several
        // residents meet. Held residents are obstacles; travelers yield around them.
        repeat(3) {
            for (a in ordered.indices) for (b in 0 until a) {
                val first = ordered[a]; val second = ordered[b]
                var dx = (first.x - second.x) * aspectX
                var dy = (first.y - second.y) * aspectY
                var distance = length(dx, dy)
                val safe = (first.size + second.size) * PaperHabitat.BODY_CLEARANCE
                if (distance >= safe) continue
                if (distance < .0001f) {
                    val phase = phaseOf(first.item.id + second.item.id)
                    dx = cos(phase) * .0001f; dy = sin(phase) * .0001f; distance = .0001f
                }
                val firstWeight = if (pinned(first)) 0f else 1f
                val secondWeight = if (pinned(second)) 0f else 1f
                if (firstWeight + secondWeight == 0f) continue
                val correction = min(safe - distance, .28f * dt)
                val total = firstWeight + secondWeight
                first.x += dx / distance * correction * firstWeight / total / aspectX
                first.y += dy / distance * correction * firstWeight / total / aspectY
                second.x -= dx / distance * correction * secondWeight / total / aspectX
                second.y -= dy / distance * correction * secondWeight / total / aspectY
                constrain(first); constrain(second)
            }
        }
        for (body in ordered) {
            val dx = (body.x - body.previousX) * aspectX
            val dy = (body.y - body.previousY) * aspectY
            val distance = length(dx, dy)
            body.reportedVx = dx / dt / aspectX
            body.reportedVy = dy / dt / aspectY
            val actualSpeed = distance / dt
            if (body.intent != ResidentIntent.SLEEP) {
                // Tiny contact corrections are not another step. The gait settles
                // into a planted pose as its amplitude fades, without a phase reset.
                if (actualSpeed > PaperHabitat.STOP_SPEED) body.phase += distance / body.size * (4 * PI).toFloat()
                val targetLocomotion = if (actualSpeed > PaperHabitat.STOP_SPEED)
                    (actualSpeed / PaperHabitat.WORK_SPEED).coerceIn(0f, 1f) else 0f
                val response = if (targetLocomotion > body.locomotionAmount) 6f else 9f
                body.locomotionAmount += (targetLocomotion - body.locomotionAmount) * (1f - exp(-dt * response))
                if (targetLocomotion == 0f && body.locomotionAmount < .001f) body.locomotionAmount = 0f
            }
            if (moving(body)) {
                body.blocked = if (distance / dt < PaperHabitat.EXPLORE_SPEED * .2f) body.blocked + dt else 0f
                if (body.blocked > 1.5f) { destination(body); body.blocked = 0f }
            }
        }
    }

    private fun project(body: Body): EinkResidentPose {
        val sleeping = body.intent == ResidentIntent.SLEEP
        val velocityX = body.reportedVx
        val velocityY = body.reportedVy
        val locomotion = body.locomotionAmount
        val isGrounded = grounded(body.item)
        val waitingLook = if (body.behavior == EinkResidentBehavior.WAITING) sin(body.workPhase * .6f) * .035f else 0f
        val travelLean = if (isGrounded) sin(body.phase) * locomotion * .025f else
            (velocityY * aspectY / PaperHabitat.WORK_SPEED).coerceIn(-1f, 1f) * .12f + sin(body.phase) * locomotion * .025f
        val workLean = sin(body.workPhase) * body.workAmount * TerrariumRules.NATIVE_ACTIVITY_WORK_ROLL * if (isGrounded) .15f else .25f
        val breath = if (sleeping || body.item.kind == "hermes" && body.intent == ResidentIntent.IDLE) 0f else
            sin(body.workPhase) * (if (body.behavior == EinkResidentBehavior.RESTING) .008f else .014f) +
                sin(body.workPhase) * body.workAmount * TerrariumRules.NATIVE_ACTIVITY_WORK_BREATH * .25f
        val turn = 1f - (1f - abs(body.facing)) * .10f * locomotion
        val pixelBody = body.size * short
        val home = EinkResidentHome(body.item.id, body.x * viewportWidth, body.y * viewportHeight, pixelBody, isGrounded)
        return EinkResidentPose(home, CreatureSlot(body.x, body.y, pixelBody / (viewportWidth * .10f)),
            if (sleeping) 0f else Math.toDegrees((travelLean + workLean + waitingLook).toDouble()).toFloat(),
            if (sleeping) 1f else turn * (1f + breath), if (sleeping) 1f else 1f - breath * .5f,
            body.phase, body.behavior, velocityX, velocityY, body.heading, body.facing,
            locomotion, body.workAmount, body.workPhase, cos(body.heading), sin(body.heading), body.turnAmount)
    }
}

/** Deterministic initial placement for a still preview; live rendering retains its motion object. */
internal fun einkResidentHomes(items: List<AquariumResident>, width: Int, height: Int): List<EinkResidentHome> =
    EinkResidentMotion().advance(items, 0.0, width, height).map { it.home }

/** Keep the question beside the moving resident, including its first decelerating work frame. */
internal fun einkQuestionBubbleX(centerX: Float, body: Float, width: Int): Float {
    val radius = body * .18f
    val offset = body * .78f
    val side = if (centerX + offset + radius <= width - 2f) 1 else -1
    return (centerX + offset * side).coerceIn(radius + 2f, width - radius - 2f)
}

/** The canonical orbital angle projects outside the enlarged paper silhouette. */
internal fun einkCompanionPosition(pose: EinkResidentPose, width: Int, height: Int): Pair<Float, Float> {
    val center = pose.slot.centerXFraction to pose.slot.centerYFraction
    val canonical = ciCompanionPosition(center, TerrariumRules.CI_COMPANION_STATIC_ANGLE, width.toFloat(), height.toFloat())
    val dx = (canonical.first - center.first) * width
    val dy = (canonical.second - center.second) * height
    val distance = length(dx, dy).coerceAtLeast(1f)
    val half = minOf(width, height) * TerrariumRules.CI_COMPANION_SIZE_FRAC / 2
    val clearance = pose.home.body * .75f + half
    val expansion = maxOf(1f, clearance / distance)
    val margin = half + minOf(width, height) * .02f
    val centerX = center.first * width
    val centerY = center.second * height
    val offsetX = dx * expansion
    val offsetY = dy * expansion
    val x = if (centerX + offsetX in margin..(width - margin)) centerX + offsetX else centerX - offsetX
    val y = if (centerY + offsetY in margin..(height - margin)) centerY + offsetY else centerY - offsetY
    return x.coerceIn(margin, width - margin) / width to y.coerceIn(margin, height - margin) / height
}
