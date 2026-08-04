package dev.agentdeck.service

/**
 * Orders a live panel-policy replacement as one transition.
 *
 * The old policy must release brightness/stay-on effects before the new
 * controller observes persistent settings. Reapplying the latest bridge state
 * afterwards prevents the service from waiting for another StateFlow emission.
 */
internal class PanelPolicyTransitionManager(
    private val restoreCurrent: () -> Unit,
    private val applyNext: (isEink: Boolean) -> Unit,
    private val reapplyLatestState: () -> Unit,
) {
    private var currentIsEink: Boolean? = null

    fun install(isEink: Boolean): Boolean {
        if (currentIsEink == isEink) return false

        val replacing = currentIsEink != null
        if (replacing) restoreCurrent()
        applyNext(isEink)
        currentIsEink = isEink
        if (replacing) reapplyLatestState()
        return true
    }
}
