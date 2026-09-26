package dev.agentdeck.net

import org.junit.Assert.*
import org.junit.Test

class GatewaySetupStatusTest {
    @Test fun reachabilityAndTransportProgressDoNotRequestApproval() {
        for (status in listOf(null, "gateway_not_found", "future_status", "reconnecting", "gateway_reachable", "connect_timeout")) {
            assertFalse("$status", GatewaySetupStatus.evaluate(status, false, true).needsAttention)
        }
        assertEquals("connected", GatewaySetupStatus.evaluate(null, true, true).kind)
    }

    @Test fun wireAuthenticationFailuresReachTheGuidance() {
        for (status in listOf("approval_pending", "pairing_required", "gateway_token_missing", "token_mismatch", "device_auth_invalid", "auth_failed", "unsupported_protocol")) {
            val event = parseBridgeMessage("""{"type":"state_update","state":"idle","gatewayAvailable":true,"gatewayConnected":false,"gatewayAuthStatus":"$status"}""") as BridgeEvent.State
            assertTrue(status, GatewaySetupStatus.evaluate(event.data.gatewayAuthStatus, event.data.gatewayConnected, event.data.gatewayAvailable).needsAttention)
        }
    }
}
