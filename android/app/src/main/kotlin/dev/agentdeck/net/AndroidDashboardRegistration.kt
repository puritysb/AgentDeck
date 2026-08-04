package dev.agentdeck.net

import dev.agentdeck.util.DeviceProfile

internal data class AndroidDashboardIdentity(
    val id: String,
    val name: String,
    val kind: String,
) {
    fun payload(): String = PluginCommands.clientRegisterAndroidDashboard(id, name, kind)
}

internal fun androidDashboardIdentity(model: String, profile: DeviceProfile): AndroidDashboardIdentity =
    AndroidDashboardIdentity(
        id = model,
        name = profile.displayName,
        kind = profile.wireKind,
    )

/**
 * Publishes topology identity on socket open and on live profile changes.
 * Successful identity is remembered so duplicate installs do not create
 * registration churn; failed/disconnected sends remain retryable.
 */
internal class AndroidDashboardRegistrationCoordinator(
    private val sendIfConnected: (payload: String) -> Boolean,
) {
    private var lastSent: AndroidDashboardIdentity? = null

    @Synchronized
    fun socketOpened(identity: AndroidDashboardIdentity): Boolean = publish(identity)

    @Synchronized
    fun socketClosed() {
        lastSent = null
    }

    @Synchronized
    fun profileChanged(identity: AndroidDashboardIdentity): Boolean = publish(identity)

    private fun publish(identity: AndroidDashboardIdentity): Boolean {
        if (identity == lastSent) return false
        if (!sendIfConnected(identity.payload())) return false
        lastSent = identity
        return true
    }
}
