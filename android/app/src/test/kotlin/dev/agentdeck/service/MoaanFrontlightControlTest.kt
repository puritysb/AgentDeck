package dev.agentdeck.service

import org.junit.Assert.*
import org.junit.Test

class MoaanFrontlightControlTest {
    private class Device {
        val values = mutableMapOf("light_current_mode" to "4", "bed_mode_light_key" to "18",
            "bed_mode_warm_key" to "8", "custom_mode_light_key" to "29", "custom_mode_light_status" to "1")
        var journal: MoaanFrontlightControl.Snapshot? = null
        var failSave = false
        var failWrite: String? = null
        val writes = mutableListOf<String>()
        fun controller() = MoaanFrontlightControl(
            read = { values[it] }, write = { key, value ->
                assertNotNull("Snapshot must precede setting changes", journal)
                if (key == failWrite) false else {
                    writes.add(key)
                    if (value == null) values.remove(key) else values[key] = value
                    true
                }
            }, save = { value -> if (failSave) false else { journal = value; true } }, restored = journal,
        )
    }

    @Test fun `off uses vendor mode and restores presets including absent keys`() {
        val d = Device(); val before = d.values.toMap(); val c = d.controller()
        assertTrue(c.dim("off", 10))
        assertEquals("1", d.values[MoaanFrontlightControl.MODE])
        assertEquals("0", d.values["close_mode_light_key"])
        assertEquals("0", d.values["close_mode_warm_key"])
        assertEquals(MoaanFrontlightControl.MODE, d.writes.last())
        assertTrue(c.restore()); assertEquals(before, d.values); assertNull(d.journal)
    }

    @Test fun `minimum scales original brightness while retaining color temperature`() {
        val d = Device(); val before = d.values.toMap(); val c = d.controller()
        assertTrue(c.dim("off", 10)); assertTrue(c.dim("min", 10))
        assertEquals("0", d.values[MoaanFrontlightControl.MODE])
        assertEquals("1", d.values["custom_mode_light_key"])
        assertEquals("8", d.values["custom_mode_warm_key"])
        assertTrue(c.dim("min", 50)); assertEquals("9", d.values["custom_mode_light_key"])
        assertTrue(c.restore()); assertEquals(before, d.values)
    }

    @Test fun `recreated process restores exact original mode and presets`() {
        val d = Device(); val before = d.values.toMap()
        assertTrue(d.controller().dim("min", 10))
        val restarted = d.controller(); assertTrue(restarted.pending)
        assertTrue(restarted.restore()); assertEquals(before, d.values); assertNull(d.journal)
    }

    @Test fun `failed durable save cannot change a setting`() {
        val d = Device(); d.failSave = true
        assertFalse(d.controller().dim("off", 10)); assertTrue(d.writes.isEmpty())
    }

    @Test fun `failed application and restoration retain journal for retry`() {
        val d = Device(); val before = d.values.toMap(); val c = d.controller()
        d.failWrite = MoaanFrontlightControl.MODE
        assertFalse(c.dim("off", 10)); assertNotNull(d.journal)
        assertFalse(c.restore()); assertNotNull(d.journal)
        d.failWrite = null; assertTrue(c.restore()); assertEquals(before, d.values)
    }

    @Test fun `unknown vendor state cannot authorize settings writes`() {
        val d = Device(); d.values.remove(MoaanFrontlightControl.MODE)
        val c = d.controller(); assertFalse(c.available); assertFalse(c.dim("off", 10))
        assertTrue(d.writes.isEmpty()); assertNull(d.journal)
    }
}
