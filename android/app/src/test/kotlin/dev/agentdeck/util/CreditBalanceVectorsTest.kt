package dev.agentdeck.util

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/** Replays shared/credit-balance-vectors.json — the same file the TS suite and
 *  every other generated mirror replay — against the generated
 *  [UsagePresentation.formatCreditBalance] / [UsagePresentation.creditsActive]. */
@RunWith(RobolectricTestRunner::class)
class CreditBalanceVectorsTest {
    private val vectors: JSONObject by lazy {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null && !File(dir, "shared/credit-balance-vectors.json").exists()) dir = dir.parentFile
        JSONObject(File(requireNotNull(dir), "shared/credit-balance-vectors.json").readText())
    }

    private fun num(a: JSONArray, i: Int): Double =
        if (a.get(i) == "inf") Double.POSITIVE_INFINITY else a.getDouble(i)

    @Test fun `formatCreditBalance matches every shared vector`() {
        val format = vectors.getJSONArray("format")
        for (i in 0 until format.length()) {
            val v = format.getJSONArray(i)
            assertEquals("balance ${v.get(0)}", v.getString(1), UsagePresentation.formatCreditBalance(num(v, 0)))
        }
    }

    @Test fun `creditsActive matches every shared vector`() {
        val active = vectors.getJSONArray("active")
        for (i in 0 until active.length()) {
            val v = active.getJSONArray(i)
            assertEquals("vector $v", v.getBoolean(3), UsagePresentation.creditsActive(num(v, 0), num(v, 1), num(v, 2)))
        }
    }
}
