// GENERATED FILE — DO NOT EDIT. Source: shared/src/device-controller.ts
// Regenerate: node scripts/generate-device-controller-rules.mjs
package dev.agentdeck.state

object DeviceControllerRules {
    data class PermissionChoice(val index: Int, val label: String, val decision: String)
    val permissionChoices = listOf(
        PermissionChoice(0, "Allow once", "allow"),
        PermissionChoice(1, "Deny", "deny"),
    )
    fun heldReplyable(requestId: String?, liveAnswerable: Boolean?): Boolean =
        !requestId.isNullOrBlank() && (!requestId.startsWith("ocperm:") || liveAnswerable == true)
}
