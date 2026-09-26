package dev.agentdeck.terrarium

import android.content.Context
import android.graphics.Canvas
import android.opengl.Matrix
import com.google.android.filament.EntityManager
import com.google.android.filament.gltfio.AssetLoader
import com.google.android.filament.gltfio.FilamentAsset
import com.google.android.filament.gltfio.ResourceLoader
import com.google.android.filament.gltfio.UbershaderProvider
import com.google.android.filament.utils.ModelViewer
import java.nio.ByteBuffer
import kotlin.math.*

/** Uses the canonical state projection, including its observed child census. */
internal data class AquariumResident(val id: String, val kind: String, val title: String,
    val state: OctopusVisualState, val helpers: Int = 0)

internal fun aquariumResidents(state: TerrariumState): List<AquariumResident> {
    fun project(item: AgentCreatureState, kind: String) = AquariumResident(
        item.sessionId, kind, item.displayName ?: kind, item.visualState, item.subagentActivity.activeCount)
    val result = state.agents.mapNotNull { item ->
        val kind = when (item.agentType) {
            "claude-code" -> "claudecode"
            "kiro", "kiro-cli", "kiro-ide" -> "kiro"
            else -> null
        }
        kind?.let { project(item, it) }
    } + state.cloudCreatures.map { project(it, "codex") } +
        state.openCodeCreatures.mapNotNull { item ->
            when (item.agentType) {
                "opencode" -> project(item, "opencode")
                "kiro-cli", "kiro-ide" -> project(item, "kiro")
                else -> null
            }
        } +
        state.antigravityCreatures.map { project(it, "antigravity") }
    val claw = if (state.crayfish == CrayfishVisualState.DORMANT) emptyList() else listOf(
        AquariumResident("openclaw-gateway", "openclaw", "OpenClaw", when (state.crayfish) {
            CrayfishVisualState.ROUTING -> OctopusVisualState.WORKING
            CrayfishVisualState.WAITING -> OctopusVisualState.ASKING
            else -> OctopusVisualState.FLOATING
        }, state.workerCrayfishCount))
    return (result + claw).distinctBy { it.id }
}

/** Keep readable models bounded; every session remains accessible in the roster. */
internal fun visibleAquariumResidents(items: List<AquariumResident>, focusedId: String?): List<AquariumResident> =
    items.sortedWith(compareBy<AquariumResident> {
        when { it.id == focusedId -> 0; it.state == OctopusVisualState.ASKING -> 1
            it.state == OctopusVisualState.WORKING -> 2; else -> 3 }
    }.thenBy { it.id }).take(TerrariumRules.NATIVE_RESIDENT_LIMIT)

/** Filament resources live and die with the surface's engine, never with recomposition. */
internal class AquariumResidents(private val context: Context, private val viewer: ModelViewer) {
    private val materials = UbershaderProvider(viewer.engine)
    private val loader = AssetLoader(viewer.engine, materials, EntityManager.get())
    private val resources = ResourceLoader(viewer.engine)
    private val transforms = viewer.engine.transformManager
    // Animation transactions sort TransformManager storage. Only entity IDs are
    // stable across frames, asset additions and removals; resolve instances at use.
    private data class Joint(val entity: Int, val name: String, val rest: FloatArray)
    private data class Body(val asset: FilamentAsset, val support: FilamentAsset?, val joints: List<Joint>,
        var item: AquariumResident, var phase: Float, var effort: Float = 0f,
        var attention: Float = 0f, var size: Float = .78f, val footHeight: Float = 0f, var x: Float = 0f, var y: Float = 0f, var z: Float = 0f)
    private val bodies = linkedMapOf<String, Body>()
    private var all = emptyList<AquariumResident>()
    private var focusedId: String? = null
    private val matrix = FloatArray(16)
    private val pose = FloatArray(16)
    private val viewProjection = FloatArray(16)
    private val cameraView = FloatArray(16)
    private val cameraProjection = DoubleArray(16)
    private val floatProjection = FloatArray(16)
    private val point = FloatArray(4)
    private val projected = FloatArray(4)
    private val overlay = AquariumResidentOverlay(context)
    private var screenX = 0f
    private var screenY = 0f
    private var snailTime = 0.0
    private val snailEntity = viewer.asset?.getFirstEntityByName("Fauna snail") ?: 0

    /** A slow continuous circuit in the substrate plane, with heading from its tangent. */
    private fun stepSnail(dt: Float) {
        val snailInstance = transforms.getInstance(snailEntity)
        if (snailInstance == 0) return
        snailTime += dt
        val angle = (snailTime / 400.0 * 2.0 * PI).toFloat()
        val x = 5.2f * cos(angle)
        val z = 2.8f * sin(angle)
        val dx = -5.2f * sin(angle)
        val dz = 2.8f * cos(angle)
        // The rear bowl rises behind the planted islands; the foreground is flat.
        val y = max(0f, -z - 2f).pow(2) * .16f - .09f
        Matrix.setIdentityM(pose, 0)
        Matrix.translateM(pose, 0, x, y, z)
        Matrix.rotateM(pose, 0, atan2(-dz, dx) * 180f / PI.toFloat(), 0f, 1f, 0f)
        Matrix.scaleM(pose, 0, .6f, .6f, .6f)
        transforms.setTransform(snailInstance, pose)
    }
    private data class Fish(val entity: Int, var dx: Float = 0f, var dy: Float = 0f, var dz: Float = 0f)
    private val fish = viewer.asset?.entities?.map { entity ->
        if (viewer.asset?.getName(entity)?.startsWith("Fish yaw") == true)
            Fish(entity) else null
    }?.filterNotNull().orEmpty()

    /** Add a damped disturbance after authored swimming, so work strokes part the school. */
    private fun disturbSchool(dt: Float) {
        val blend = 1f - exp(-dt * 4f)
        for (f in fish) {
            transforms.getTransform(transforms.getInstance(f.entity), pose)
            var dx = 0f; var dy = 0f; var dz = 0f
            for (body in bodies.values) {
                val x = pose[12] - body.x
                val y = (pose[13] - body.y) * .5f
                val z = pose[14] - body.z
                val distance = sqrt(x*x + y*y + z*z).coerceAtLeast(.1f)
                val stroke = max(0f, sin(body.phase)).pow(4) * body.effort
                val influence = max(0f, 1f - distance / 2.8f) * (.12f + stroke)
                dx += x / distance * influence
                dy += y / distance * influence
                dz += z / distance * influence
            }
            f.dx += (dx.coerceIn(-.7f, .7f) - f.dx) * blend
            f.dy += (dy.coerceIn(-.3f, .3f) - f.dy) * blend
            f.dz += (dz.coerceIn(-.7f, .7f) - f.dz) * blend
            pose[12] += f.dx; pose[13] += f.dy; pose[14] += f.dz
            transforms.setTransform(transforms.getInstance(f.entity), pose)
        }
    }

    fun sync(state: TerrariumState, focus: String?) {
        val next = aquariumResidents(state)
        if (all == next && focusedId == focus) return
        all = next
        focusedId = focus
        val visible = visibleAquariumResidents(all, focus)
        val ids = visible.map { it.id }.toSet()
        for (id in bodies.keys.toList()) if (id !in ids) {
            val old = bodies.remove(id)!!
            viewer.scene.removeEntities(old.asset.entities)
            loader.destroyAsset(old.asset)
            old.support?.let { viewer.scene.removeEntities(it.entities); loader.destroyAsset(it) }
        }
        for (item in visible) {
            val existing = bodies[item.id]
            if (existing != null) { existing.item = item; continue }
            fun load(kind: String): FilamentAsset {
                val bytes = context.assets.open("residents/$kind.glb").use { it.readBytes() }
                val buffer = ByteBuffer.allocateDirect(bytes.size).apply { put(bytes); flip() }
                val asset = requireNotNull(loader.createAsset(buffer)) { "Invalid resident $kind" }
                resources.loadResources(asset)
                return asset
            }
            val asset = load(item.kind)
            val support = if (item.kind == "claudecode" || item.kind == "openclaw") load("substrate") else null
            support?.let { viewer.scene.addEntities(it.entities); it.releaseSourceData() }
            val joints = asset.entities.toList().mapNotNull { entity ->
                val name = asset.getName(entity) ?: ""
                if (!name.startsWith("joint_")) null else {
                    val instance = transforms.getInstance(entity)
                    Joint(entity, name, transforms.getTransform(instance, FloatArray(16)))
                }
            }
            viewer.scene.addEntities(asset.entities)
            asset.releaseSourceData()
            bodies[item.id] = Body(asset, support, joints, item, (item.id.hashCode().toLong() and 65535L) / 65535f * 6.28f,
                footHeight = asset.boundingBox.halfExtent[1] - asset.boundingBox.center[1])
        }
    }

    fun step(delta: Float, aspect: Float) {
        val dt = delta.coerceIn(0f, .05f)
        val blend = 1f - exp(-dt * 3f)
        val columns = if (aspect < 1f) 2 else 4
        val width = min(6f, max(2f, aspect * 4f))
        val baseScale = if (aspect < 1f) .60f else .78f
        val groundedCount = bodies.values.count { it.item.kind == "claudecode" || it.item.kind == "openclaw" }
        var groundIndex = 0
        var waterIndex = 0
        bodies.values.forEach { body ->
            body.effort += ((if (body.item.state == OctopusVisualState.WORKING) 1f else 0f) - body.effort) * blend
            body.attention += ((if (body.item.state == OctopusVisualState.ASKING) 1f else 0f) - body.attention) * blend
            body.phase += dt * (TerrariumRules.NATIVE_ACTIVITY_IDLE_RATE + body.effort * TerrariumRules.NATIVE_ACTIVITY_WORK_RATE)
            val grounded = body.item.kind == "claudecode" || body.item.kind == "openclaw"
            val scale = if (grounded) min(baseScale, 1.8f / sqrt(groundedCount.toFloat())) else baseScale
            body.size = scale
            val index = if (grounded) groundIndex++ else waterIndex++
            val row = index / columns
            val count = min(columns, (if (grounded) groundedCount else bodies.size - groundedCount) - row * columns)
            val spacing = width / (if (grounded) min(columns, groundedCount) else columns).coerceAtLeast(1)
            val homeX = (index % columns - (count - 1) / 2f) * spacing
            val swing = sin(body.phase) * body.effort
            body.x = homeX + scale * if (grounded) sin(body.phase * .5f) * body.effort * TerrariumRules.NATIVE_ACTIVITY_GROUND_TRAVEL
                else sin(body.phase * .5f) * .18f + swing * TerrariumRules.NATIVE_ACTIVITY_WATER_TRAVEL
            val waterRows = (bodies.size - groundedCount + columns - 1) / columns
            body.y = if (grounded) body.footHeight * scale + .95f + row * .48f
                else (if (waterRows <= 1) 2.8f else 4.0f - row * 1.6f) + sin(body.phase * .7f) * .06f
            body.z = if (grounded) 1.8f - row * 1.1f else .9f - row * .65f
            body.support?.let { shelf ->
                Matrix.setIdentityM(matrix, 0)
                Matrix.translateM(matrix, 0, homeX, 0f, body.z)
                Matrix.scaleM(matrix, 0, max(.65f, scale * 1.35f), .95f + row * .48f, max(.55f, scale))
                transforms.setTransform(transforms.getInstance(shelf.root), matrix)
            }
            Matrix.setIdentityM(matrix, 0)
            Matrix.translateM(matrix, 0, body.x, body.y, body.z)
            val yaw = sin(body.phase * .5f) * if (grounded) body.effort * TerrariumRules.NATIVE_ACTIVITY_GROUND_YAW
                else .20f + body.effort * TerrariumRules.NATIVE_ACTIVITY_WORK_YAW
            Matrix.rotateM(matrix, 0, Math.toDegrees(yaw.toDouble()).toFloat(), 0f, 1f, 0f)
            if (!grounded) {
                Matrix.rotateM(matrix, 0, Math.toDegrees((swing * TerrariumRules.NATIVE_ACTIVITY_WORK_YAW).toDouble()).toFloat(), 1f, 0f, 0f)
                Matrix.rotateM(matrix, 0, Math.toDegrees((-swing * TerrariumRules.NATIVE_ACTIVITY_WORK_ROLL).toDouble()).toFloat(), 0f, 0f, 1f)
            }
            val breath = if (grounded) 0f else sin(body.phase * 1.3f) * .009f + swing * TerrariumRules.NATIVE_ACTIVITY_WORK_BREATH
            Matrix.scaleM(matrix, 0, scale * (1f + breath), scale * (1f - breath * .6f), scale * (1f + breath))
            transforms.setTransform(transforms.getInstance(body.asset.root), matrix)
            for ((i, joint) in body.joints.withIndex()) {
                joint.rest.copyInto(pose)
                if (joint.name.startsWith("joint_foot")) {
                    Matrix.translateM(pose, 0, 0f, 0f, -max(0f, sin(body.phase * 2f + i * PI.toFloat())) * body.effort * TerrariumRules.NATIVE_ACTIVITY_FOOT_LIFT)
                } else {
                    val side = if (joint.name.endsWith("_0")) -1f else 1f
                    Matrix.rotateM(pose, 0, side * (body.attention * 24f + body.effort * (12f + sin(body.phase) * 33f)), 0f, 1f, 0f)
                }
                transforms.setTransform(transforms.getInstance(joint.entity), pose)
            }
        }
        disturbSchool(dt)
        stepSnail(dt)
    }

    private fun project(canvas: Canvas, x: Float, y: Float, z: Float): Boolean {
        point[0] = x; point[1] = y; point[2] = z; point[3] = 1f
        Matrix.multiplyMV(projected, 0, viewProjection, 0, point, 0)
        if (projected[3] <= 0f) return false
        screenX = (projected[0] / projected[3] + 1f) * canvas.width / 2f
        screenY = (1f - projected[1] / projected[3]) * canvas.height / 2f
        return true
    }

    fun drawLabels(canvas: Canvas, labelsVisible: Boolean = true) {
        viewer.camera.getViewMatrix(cameraView)
        viewer.camera.getProjectionMatrix(cameraProjection)
        for (i in 0..15) floatProjection[i] = cameraProjection[i].toFloat()
        Matrix.multiplyMM(viewProjection, 0, floatProjection, 0, cameraView, 0)
        for (body in bodies.values) {
            if (!project(canvas, body.x, body.y, body.z)) continue
            val bodyX = screenX; val bodyY = screenY
            if (!project(canvas, body.x + body.size, body.y, body.z)) continue
            val unit = abs(screenX - bodyX)
            if (!project(canvas, body.x, body.y + .75f, body.z)) continue
            overlay.draw(canvas, body.item, screenX, screenY, bodyX, bodyY, unit, body.phase,
                body.item.id == focusedId, labelsVisible)
        }
        if (labelsVisible && all.size > bodies.size) overlay.drawOverflow(canvas, all.size)
    }

    fun dispose() {
        for (body in bodies.values) {
            viewer.scene.removeEntities(body.asset.entities)
            loader.destroyAsset(body.asset)
            body.support?.let { viewer.scene.removeEntities(it.entities); loader.destroyAsset(it) }
        }
        bodies.clear()
        resources.destroy()
        loader.destroy()
        materials.destroyMaterials()
        materials.destroy()
    }
}
