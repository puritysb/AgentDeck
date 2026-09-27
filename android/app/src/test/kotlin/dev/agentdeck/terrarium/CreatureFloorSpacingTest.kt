package dev.agentdeck.terrarium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/** Replays shared/floor-spacing-vectors.json — the same file the TS and Swift suites replay. */
@RunWith(RobolectricTestRunner::class)
class CreatureFloorSpacingTest {
    private fun vectorsFile(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null && !File(dir, "shared/floor-spacing-vectors.json").exists()) dir = dir.parentFile
        return File(requireNotNull(dir) { "shared/floor-spacing-vectors.json not found" }, "shared/floor-spacing-vectors.json")
    }

    @Test fun `every vector matches the TypeScript source`() {
        val vectors = JSONObject(vectorsFile().readText()).getJSONArray("vectors")
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val items = v.getJSONArray("items").let { arr ->
                (0 until arr.length()).map { arr.getJSONObject(it).let { o -> o.getDouble("x").toFloat() to o.getDouble("width").toFloat() } }
            }
            val expected = v.getJSONArray("expected").let { arr -> (0 until arr.length()).map { arr.getDouble(it).toFloat() } }
            val out = spreadFloorResidents(items, v.getDouble("minX").toFloat(), v.getDouble("maxX").toFloat(), v.getDouble("minGapRatio").toFloat())
            assertEquals(v.getString("name"), expected.size, out.size)
            expected.forEachIndexed { k, x -> assertEquals(v.getString("name"), x, out[k], 1e-4f) }
        }
    }
}
