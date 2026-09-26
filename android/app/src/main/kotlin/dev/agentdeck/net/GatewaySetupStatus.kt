// GENERATED from shared/gateway-setup-status.json; DO NOT EDIT.
// Regenerate: node scripts/generate-gateway-setup-status.mjs
package dev.agentdeck.net

data class GatewaySetupStatus(val kind: String, val detail: String) {
    val needsAttention: Boolean get() = kind in setOf("awaiting", "failed", "unsupported")
    companion object {
        fun evaluate(authStatus: String?, connected: Boolean?, available: Boolean?): GatewaySetupStatus = when (authStatus) {
            "connected" -> GatewaySetupStatus("connected", "Paired through Gateway")
            "reconnecting" -> GatewaySetupStatus("awaitingData", "Reconnecting to Gateway…")
            "gateway_reachable" -> GatewaySetupStatus("awaitingData", "Connecting to Gateway…")
            "approval_pending" -> GatewaySetupStatus("awaiting", "Approve the AgentDeck host in OpenClaw’s Web UI.")
            "pairing_required" -> GatewaySetupStatus("awaiting", "Approve the AgentDeck host in OpenClaw’s Web UI.")
            "gateway_token_missing" -> GatewaySetupStatus("awaiting", "A shared token is required. Configure the Gateway token on the AgentDeck host.")
            "token_mismatch" -> GatewaySetupStatus("failed", "The shared token was rejected. Check the Gateway token on the AgentDeck host.")
            "connect_timeout" -> GatewaySetupStatus("awaitingData", "Gateway did not answer the connection attempt. Waiting to reconnect.")
            "device_auth_invalid" -> GatewaySetupStatus("failed", "Gateway rejected the host’s pairing identity. Check its approved device entry in OpenClaw.")
            "auth_failed" -> GatewaySetupStatus("failed", "Gateway authentication failed. Check OpenClaw settings on the AgentDeck host.")
            "unsupported_protocol" -> GatewaySetupStatus("unsupported", "Gateway protocol is unsupported. Check compatibility on the AgentDeck host.")
            else -> when {
                connected == true -> GatewaySetupStatus("connected", "Paired through Gateway")
                available == true -> GatewaySetupStatus("awaitingData", "Gateway reachable; connection status unavailable.")
                else -> GatewaySetupStatus("notConfigured", "No OpenClaw Gateway connection.")
            }
        }
    }
}
