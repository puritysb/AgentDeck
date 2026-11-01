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
    @Test fun `Dot shares the resident budget without inventing a working session`() {
        val now=1800000000000L
        val ready=dev.agentdeck.net.DotSurfaceSnapshot(configured=true,hosting=true)
        val peer=dotAquariumResident(ready,now)
        assertEquals("dot",peer.kind)
        assertEquals(OctopusVisualState.FLOATING,peer.state)
        assertEquals(true,peer.habitatActive)
        val work=dotAquariumResident(ready.copy(reportState="working",reportedAt=now,expiresAt=now+10000),now)
        assertEquals(OctopusVisualState.WORKING,work.state)
        assertEquals(false,dotAquariumResident(ready.copy(hosting=false),now).habitatActive)
        val peers=(0..TerrariumRules.NATIVE_RESIDENT_LIMIT).map { peer.copy(id="peer-$it") }+work
        assertEquals(TerrariumRules.NATIVE_RESIDENT_LIMIT,visibleAquariumResidents(peers,null).size)
        assertTrue(visibleAquariumResidents(peers,null).any { it.id==work.id })
    }

    @Test fun `Hermes wears a real headset without painted white bang glyphs`() {
        val bytes=RuntimeEnvironment.getApplication().assets.open("residents/hermes.glb").use { it.readBytes() }
        val length=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getInt(12)
        val nodes=JSONObject(String(bytes,20,length,Charsets.UTF_8)).getJSONArray("nodes")
        val names=(0 until nodes.length()).map { nodes.getJSONObject(it).optString("name") }
        assertTrue(names.any { it.contains("headset-earcup-left") })
        assertTrue(names.any { it.contains("headset-earcup-right") })
        assertFalse(names.any { it.startsWith("hair_shine") })
    }

    @Test fun `instanced buddy materials have unique immutable names`() {
        for (kind in listOf("buddy", "pearl", "bubble")) {
            val bytes = RuntimeEnvironment.getApplication().assets.open("residents/background-$kind.glb").use { it.readBytes() }
            val length = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getInt(12)
            val gltf = JSONObject(String(bytes, 20, length, Charsets.UTF_8))
            val materials = gltf.getJSONArray("materials")
            val names = (0 until materials.length()).map { materials.getJSONObject(it).getString("name") }
            assertTrue("$kind must retain named materials for shared rendering", names.all { it.isNotBlank() })
            assertEquals("Different buddy materials must not alias during instancing", names.size, names.toSet().size)
            assertEquals("Materials are immutable; motion is applied to nodes", 0, gltf.optJSONArray("animations")?.length() ?: 0)
        }
    }

    @Test fun `shared habitat keeps a closed rock foraging clip and moving feelers`() {
        val bytes = RuntimeEnvironment.getApplication().assets.open("living-aquarium.glb").use { it.readBytes() }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val jsonLength = buffer.getInt(12)
        val json = JSONObject(String(bytes, 20, jsonLength, Charsets.UTF_8))
        val nodes = json.getJSONArray("nodes")
        val snail = (0 until nodes.length()).single { nodes.getJSONObject(it).optString("name") == "Fauna snail" }
        val feelers = (0 until nodes.length()).filter { nodes.getJSONObject(it).optString("name").startsWith("Snail feeler") }
        val tracks = mutableMapOf<Pair<Int, String>, List<FloatArray>>()
        val animations = json.getJSONArray("animations")
        for (i in 0 until animations.length()) {
            val animation = animations.getJSONObject(i)
            val channels = animation.getJSONArray("channels")
            for (c in 0 until channels.length()) {
                val channel = channels.getJSONObject(c)
                val target = channel.getJSONObject("target")
                if (target.getInt("node") != snail && target.getInt("node") !in feelers) continue
                val sampler = animation.getJSONArray("samplers").getJSONObject(channel.getInt("sampler"))
                val accessor = json.getJSONArray("accessors").getJSONObject(sampler.getInt("output"))
                val view = json.getJSONArray("bufferViews").getJSONObject(accessor.getInt("bufferView"))
                val width = if (accessor.getString("type") == "VEC3") 3 else 4
                val start = 20 + jsonLength + 8 + view.optInt("byteOffset") + accessor.optInt("byteOffset")
                tracks[target.getInt("node") to target.getString("path")] = (0 until accessor.getInt("count")).map { frame ->
                    FloatArray(width) { axis -> buffer.getFloat(start + frame * width * 4 + axis * 4) }
                }
            }
        }
        val positions = tracks.getValue(snail to "translation")
        assertTrue(positions.size > 2)
        assertTrue("Foraging moves instead of freezing", positions.any { !it.contentEquals(positions.first()) })
        assertArrayEquals(positions.first(), positions.last(), 0.0001f)
        assertTrue("The authored animal stays near its rock, not across the aquarium", positions.all { p ->
            kotlin.math.abs(p[0] - positions.first()[0]) < 1f && kotlin.math.abs(p[2] - positions.first()[2]) < 1f
        })
        assertArrayEquals(tracks.getValue(snail to "rotation").first(), tracks.getValue(snail to "rotation").last(), 0.0001f)
        assertEquals(2, feelers.size)
        for (feeler in feelers) {
            val rotation = tracks.getValue(feeler to "rotation")
            assertTrue(rotation.any { !it.contentEquals(rotation.first()) })
            assertArrayEquals(rotation.first(), rotation.last(), 0.0001f)
        }
    }

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

    @Test fun `Hermes swims as its own mermaid resident in its own band`() {
        val state = DashboardState(agentState = AgentState.PROCESSING, agentType = "hermes",
            sessionId = "observed:hermes:self").toTerrariumState()
        assertEquals("hermes", aquariumResidents(state).single().kind)
        val context = RuntimeEnvironment.getApplication() as Context
        val bytes = context.assets.open("residents/hermes.glb").use { it.readBytes() }
        assertEquals(0x46546C67, ByteBuffer.wrap(bytes, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int) // "glTF"
        assertTrue("resident template stays small", bytes.size < 2_500_000)
        val hermes = state.openCodeCreatures.single()
        val slot = vectorMarkSlots(listOf(hermes)).single()
        assertEquals(layoutHermesCreatures(1).single(), slot)
    }

    @Test fun `Hermes keeps its skin and shell lid hinge in the shipped assets`() {
        val assets=RuntimeEnvironment.getApplication().assets
        fun gltf(name: String): JSONObject {
            val bytes=assets.open("residents/$name.glb").use { it.readBytes() }
            val length=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getInt(12)
            return JSONObject(String(bytes,20,length,Charsets.UTF_8))
        }
        val mermaid=gltf("hermes")
        assertEquals(1,mermaid.getJSONArray("skins").length())
        val nodes=mermaid.getJSONArray("nodes")
        val names=(0 until nodes.length()).map { nodes.getJSONObject(it).optString("name") }
        for(name in listOf("resident_hermes","tail_base","tail_mid","tail_tip","fin_left","fin_right")) assertTrue(name,names.contains(name))
        val shell=gltf("hermes-shell").getJSONArray("nodes")
        assertTrue((0 until shell.length()).any { shell.getJSONObject(it).optString("name")=="shell_bedding" })
        val lid=(0 until shell.length()).map { shell.getJSONObject(it) }.single { it.optString("name")=="shell_lid" }
        assertEquals("The hinge origin must survive export",-.4,lid.getJSONArray("translation").getDouble(2),.0001)
    }

    @Test fun `shared doorway keeps OpenClaw and bottom dwellers in clear side lanes`() {
        for(aspect in listOf(.6f,1.6f,2.4f)) {
            val one=shellNeighbour(0,1,aspect)
            val left=shellNeighbour(0,2,aspect)
            val right=shellNeighbour(1,2,aspect)
            assertTrue(one.x>1.7f)
            assertTrue(left.x < -1.7f)
            assertEquals(-left.x,right.x,.0001f)
            val shellReach=1.27f*TerrariumRules.HERMES_HOME_SHARED_SIZE
            val stoneReach=1.18f*TerrariumRules.HERMES_HOME_NEIGHBOUR_SIZE*TerrariumRules.HERMES_HOME_NEIGHBOUR_ROCK_WIDTH
            assertTrue(one.x>shellReach+stoneReach)
        }
    }

    @Test fun `shell swimmers use lateral berths independent of bottom dwellers`() {
        for(aspect in listOf(.6f,1.6f,2.4f)) {
            assertTrue(shellBerth(0,2,aspect).x < -1.3f)
            assertTrue(shellBerth(1,2,aspect).x > 1.3f)
            assertEquals(shellBerth(0,2,aspect).y,shellBerth(1,2,aspect).y,.0001f)
            val motion=HermesHomeMotion()
            val berth=shellBerth(1,2,aspect)
            repeat(3000) { frame ->
                motion.step(1f/60,true,false,0f,.5f,1.35f,.8f,aspect,berthX=berth.x,berthY=berth.y,berthZ=berth.z)
                if(frame>600) assertTrue("Swim stays out of the central cloud corridor",motion.x>1.15f)
            }
        }
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
        for (kind in listOf("claudecode", "codex", "openclaw", "opencode", "antigravity", "kiro", "hermes")) {
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
