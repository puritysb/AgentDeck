package dev.agentdeck.data

import org.junit.Assert.*
import org.junit.Test

class DashboardTypeTest {
    @Test fun oldAndFutureSettingsKeepTheExistingDashboard() {
        assertEquals(DashboardType.Default, DashboardType.fromStored(null))
        assertEquals(DashboardType.Default, DashboardType.fromStored("future-type"))
        for (type in DashboardType.entries) assertEquals(type, DashboardType.fromStored(type.storageId))
    }

    @Test fun readerNeverSelectsAnUnsupportedNativeRenderer() {
        for (type in DashboardType.entries) {
            assertEquals(DashboardType.Default, DashboardType.resolve(type, isEink = true))
            assertEquals(type, DashboardType.resolve(type, isEink = false))
        }
        assertFalse(DashboardType.available(true).contains(DashboardType.Aquarium3D))
    }
}
