package dev.agentdeck.terrarium

import dev.agentdeck.net.AgentState
import dev.agentdeck.state.DashboardState
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import android.content.Context
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONObject

@RunWith(RobolectricTestRunner::class)
class AquariumResidentsTest {
    @Test fun `Kiro gets its own model while unknown types never borrow another mark`() {
        for (kind in listOf("kiro-cli", "kiro-ide")) {
            val state = DashboardState(agentState = AgentState.PROCESSING, agentType = kind,
                sessionId = "self").toTerrariumState()
            assertEquals("kiro", aquariumResidents(state).single().kind)
        }
        val unknown = DashboardState(agentState = AgentState.PROCESSING, agentType = "future-agent",
            sessionId = "self").toTerrariumState()
        assertTrue(aquariumResidents(unknown).isEmpty())
    }

    @Test fun `crowds remain bounded but focus and waiting sessions stay reachable`() {
        val idle = (0..47).map { AquariumResident("s$it", "codex", "Same project", OctopusVisualState.FLOATING) }
        val waiting = idle[20].copy(state = OctopusVisualState.ASKING)
        val items = idle.map { if (it.id == waiting.id) waiting else it }
        val visible = visibleAquariumResidents(items, "s47")
        assertEquals(TerrariumRules.NATIVE_RESIDENT_LIMIT, visible.size)
        assertEquals("s47", visible.first().id)
        assertEquals(waiting, visible[1])
        assertEquals(visible, visibleAquariumResidents(items.reversed(), "s47"))
        assertEquals(48, items.size) // no project-name merging of independent sessions
    }

    @Test fun `Antigravity packages a sampled rainbow and texture coordinates`() {
        val bytes = RuntimeEnvironment.getApplication().assets.open("residents/antigravity.glb").use { it.readBytes() }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val length = buffer.getInt(12)
        val json = JSONObject(String(bytes, 20, length, Charsets.UTF_8))
        val pbr = json.getJSONArray("materials").getJSONObject(0).getJSONObject("pbrMetallicRoughness")
        val texture = json.getJSONArray("textures").getJSONObject(pbr.getJSONObject("baseColorTexture").getInt("index"))
        val image = json.getJSONArray("images").getJSONObject(texture.getInt("source"))
        val view = json.getJSONArray("bufferViews").getJSONObject(image.getInt("bufferView"))
        val offset = 20 + length + 8 + view.optInt("byteOffset")
        // Official press PNG, captured 2026-09-23. Reject generated approximations.
        val imageBytes = bytes.copyOfRange(offset, offset + view.getInt("byteLength"))
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(imageBytes).joinToString("") { "%02x".format(it) }
        assertEquals("e0cd08ccd10cd8d08ccf0ba449823ee88495825c0841619618100d3ab089f51e", sha)
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, offset, view.getInt("byteLength"))
        assertNotNull(bitmap)
        val colors = (0 until bitmap.width step 4).flatMap { x ->
            (0 until bitmap.height step 4).map { y -> bitmap.getPixel(x, y) }
        }.filter { android.graphics.Color.alpha(it) > 250 }
        assertTrue("Rainbow must not collapse to the gray brand chip", colors.distinct().size > 100)
        assertTrue(colors.any { android.graphics.Color.green(it) > android.graphics.Color.red(it) * 1.5 })
        assertTrue(colors.any { android.graphics.Color.blue(it) > android.graphics.Color.red(it) * 1.5 })
        assertTrue(colors.any { android.graphics.Color.red(it) > android.graphics.Color.green(it) * 1.5 })
        val attributes = json.getJSONArray("meshes").getJSONObject(0).getJSONArray("primitives").getJSONObject(0).getJSONObject("attributes")
        assertTrue(attributes.has("TEXCOORD_0"))
    }

    @Test fun `exported templates contain only their original character hierarchy`() {
        val context = RuntimeEnvironment.getApplication()
        for (kind in listOf("claudecode", "codex", "openclaw", "opencode", "antigravity", "kiro")) {
            val bytes = context.assets.open("residents/$kind.glb").use { it.readBytes() }
            val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            assertEquals(0x46546C67, buffer.int)
            buffer.position(12)
            val length = buffer.int
            assertEquals(0x4E4F534A, buffer.int)
            val json = JSONObject(String(bytes, 20, length, Charsets.UTF_8))
            val nodes = json.getJSONArray("nodes")
            val names = (0 until nodes.length()).map { nodes.getJSONObject(it).optString("name") }
            assertTrue(names.contains("resident_$kind"))
            assertFalse("Blender default scene leaked into $kind", names.contains("Cube"))
            assertEquals(1, json.getJSONArray("scenes").getJSONObject(0).getJSONArray("nodes").length())
            assertTrue(json.getJSONArray("meshes").length() > 0)
        }
    }

    @Test fun `Claude arm meshes exclude the fixed torso edges`() {
        val bytes = RuntimeEnvironment.getApplication().assets.open("residents/claudecode.glb").use { it.readBytes() }
        val jsonLength = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getInt(12)
        val json = JSONObject(String(bytes, 20, jsonLength, Charsets.UTF_8))
        val nodes = json.getJSONArray("nodes")
        for (side in 0..1) {
            val joint = (0 until nodes.length()).map { nodes.getJSONObject(it) }
                .single { it.optString("name") == "joint_arm_$side" }
            val arm = nodes.getJSONObject(joint.getJSONArray("children").getInt(0))
            val primitive = json.getJSONArray("meshes").getJSONObject(arm.getInt("mesh"))
                .getJSONArray("primitives").getJSONObject(0)
            val positions = json.getJSONArray("accessors").getJSONObject(
                primitive.getJSONObject("attributes").getInt("POSITION"))
            val low = positions.getJSONArray("min")
            val high = positions.getJSONArray("max")
            assertTrue("Arm $side must be a narrow horizontal strip, not a full-height torso edge",
                high.getDouble(2) - low.getDouble(2) < 0.20)
        }
        val flanks = (0 until nodes.length()).map { nodes.getJSONObject(it) }
            .filter { it.optString("name").startsWith("claudecode_canonical_flank_") }
        assertEquals(4, flanks.size)
        for (flank in flanks) {
            val primitive = json.getJSONArray("meshes").getJSONObject(flank.getInt("mesh"))
                .getJSONArray("primitives").getJSONObject(0)
            val positions = json.getJSONArray("accessors").getJSONObject(
                primitive.getJSONObject("attributes").getInt("POSITION"))
            assertTrue("Fixed bevel must not leave a shelf reaching to the arm tip",
                positions.getJSONArray("max").getDouble(0) - positions.getJSONArray("min").getDouble(0) < 0.015)
        }
    }
}
