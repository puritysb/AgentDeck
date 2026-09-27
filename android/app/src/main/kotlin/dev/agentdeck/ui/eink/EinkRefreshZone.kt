package dev.agentdeck.ui.eink

import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.viewinterop.AndroidView
import dev.agentdeck.terrarium.renderer.EinkRefreshHelper
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import kotlinx.coroutines.delay

/**
 * E-ink partial refresh mode — controls how a region is updated on screen.
 */
enum class RefreshMode {
    /** Full GC16 refresh — flash, no ghosting. For terrarium creatures. */
    FULL,
    /**
     * GC16 flash on [triggerKey] change for high-priority UI that must be
     * perfectly clean on appearance — permission / option prompts (the
     * ATTENTION zone). Same waveform call as [FULL]; the "one-shot per
     * prompt appearance" semantic is enforced at the CALL SITE: pass a
     * STABLE prompt identity (e.g. sessionId + question + options) so
     * cursor / navigation churn does not re-fire, but a queued next
     * prompt with different identity does fire its own clean flash.
     */
    FULL_ONCE,
    /** DU (direct update) — fast, slight ghosting. For usage gauges. */
    DU,
    /** A2 (animation mode) — fastest, binary. For state markers, timeline. */
    A2,
}

/**
 * Wraps Compose content in an AndroidView bridge that enables
 * vendor-specific partial refresh control on e-ink displays.
 *
 * When [triggerKey] changes, the zone requests a refresh with the given
 * [mode] after [debounceMs] milliseconds of stability.
 *
 * On non-e-ink devices or unsupported vendors, falls back to standard invalidation.
 *
 * [softTriggerKey] is an optional secondary trigger for sub-state churn
 * inside the zone (e.g. cursor / option-list navigation inside an ATTENTION
 * prompt) that needs the EPD to re-paint but does not warrant a primary
 * waveform burst. When non-null and changed, fires a cheap A2 partial
 * refresh after [softDebounceMs]. Suppressed when [triggerKey] just fired
 * within the recent window so primary always wins simultaneous-change
 * races (e.g. a new prompt appearing fires GC16 cleanly, not A2-then-GC16).
 */
@Composable
fun EinkRefreshZone(
    mode: RefreshMode,
    debounceMs: Long,
    triggerKey: Any,
    modifier: Modifier = Modifier,
    softTriggerKey: Any? = null,
    softDebounceMs: Long = 120L,
    sleepSnapshotMode: Boolean = false,
    sleepThrottleMs: Long = 60_000L,
    /** Size to the content's height instead of filling the offered height. */
    wrapContentHeight: Boolean = false,
    content: @Composable () -> Unit,
) {
    // Keep a snapshot-backed reference to the latest content lambda so
    // the inner ComposeView (created once in AndroidView.factory) always
    // recomposes with the current state instead of the stale capture.
    val currentContent by rememberUpdatedState(content)

    // Track the view reference for vendor API calls
    var viewRef by remember { mutableStateOf<View?>(null) }
    var lastTrigger by remember { mutableLongStateOf(0L) }
    // Race-protection state for the soft refresh path. Two gates so the
    // protection is ORDER-INDEPENDENT of debounceMs vs softDebounceMs and
    // robust to primary effect cancellation/relaunch:
    //   1. primaryActiveCount — number of currently alive primary effects
    //                            that have not yet completed (fired or
    //                            finished cancelling). A counter (not a
    //                            boolean) so a stale OLD effect's finally
    //                            running AFTER a NEW effect's start never
    //                            drops the gate to "not pending" while a
    //                            new primary is still in flight. Covers
    //                            "primary about to fire" races regardless
    //                            of debounce ordering.
    //   2. lastPrimaryFireMs   — wall-clock of the most recent primary
    //                            fire. Covers "primary just fired" race
    //                            when soft was already past its delay
    //                            when primary completed.
    var primaryActiveCount by remember { mutableIntStateOf(0) }
    var lastPrimaryFireMs by remember { mutableLongStateOf(0L) }
    var lastSleepFireMs by remember { mutableLongStateOf(0L) }

    // Debounced refresh on trigger change.
    //
    // FULL_ONCE shares the same vendor call as FULL — the "one-shot" semantic
    // is enforced at the CALL SITE by passing a STABLE prompt identity as
    // triggerKey (e.g. sessionId+question), so navigation / cursor churn
    // does not re-fire the GC16 flash, but a genuinely new queued prompt
    // (different sessionId or question) does. Adding a zone-lifetime gate
    // here would suppress the flash for the next queued prompt when the
    // composable instance is reused across the dismiss-less transition.
    LaunchedEffect(triggerKey, sleepSnapshotMode) {
        // Increment ON ENTRY so a relaunched effect's count contribution is
        // visible BEFORE the previous (cancelled) effect's finally decrements.
        // Net count stays >= 1 while ANY primary is in flight.
        primaryActiveCount++
        try {
            val now = System.currentTimeMillis()
            lastTrigger = now
            delay(debounceMs)

            // Only refresh if no newer trigger arrived during debounce
            if (lastTrigger == now) {
                val view = viewRef
                if (view != null) {
                    if (sleepSnapshotMode && mode != RefreshMode.FULL_ONCE) {
                        val fireNow = System.currentTimeMillis()
                        val elapsed = fireNow - lastSleepFireMs
                        if (lastSleepFireMs == 0L || elapsed >= sleepThrottleMs) {
                            EinkRefreshHelper.requestDURefresh(view)
                            lastSleepFireMs = fireNow
                        }
                    } else {
                        when (mode) {
                            RefreshMode.FULL -> EinkRefreshHelper.requestFullRefresh(view)
                            RefreshMode.FULL_ONCE -> EinkRefreshHelper.requestFullRefresh(view)
                            RefreshMode.DU -> EinkRefreshHelper.requestDURefresh(view)
                            RefreshMode.A2 -> EinkRefreshHelper.requestA2Refresh(view)
                        }
                        if (!sleepSnapshotMode) lastSleepFireMs = 0L
                    }
                    lastPrimaryFireMs = System.currentTimeMillis()
                }
            }
        } finally {
            // Each effect decrements its OWN contribution. A cancelled OLD
            // effect's finally only undoes ITS increment — it does not
            // affect the NEW effect's count.
            primaryActiveCount--
        }
    }

    // Soft refresh — A2 partial for sub-state churn (cursor / options) that
    // would otherwise leave the EPD stale (Onyx, Kobo) or trigger a full
    // flash (Rockchip with mode-2 sticky) on every keypress.
    //
    // Suppress when (a) any primary effect is alive and not yet fired, or
    // (b) primary fired within the last 250 ms — either way primary owns
    // the EPD right now and an A2 paint would either ghost stale content
    // before primary's GC16 (a flicker) or land redundantly on top of a
    // freshly cleaned panel.
    LaunchedEffect(softTriggerKey) {
        if (softTriggerKey == null) return@LaunchedEffect
        if (sleepSnapshotMode) return@LaunchedEffect
        delay(softDebounceMs)
        if (primaryActiveCount > 0) return@LaunchedEffect
        val sincePrimary = System.currentTimeMillis() - lastPrimaryFireMs
        if (sincePrimary in 0..250) return@LaunchedEffect
        viewRef?.let { EinkRefreshHelper.requestA2Refresh(it) }
    }

    // Use AndroidView as bridge to get a real View reference
    AndroidView(
        factory = { context ->
            FrameLayout(context).apply {
                // AndroidView turns a MATCH_PARENT height into an exact spec
                // whenever the height is bounded, so a wrapping zone must say so.
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    if (wrapContentHeight) ViewGroup.LayoutParams.WRAP_CONTENT
                    else ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                // Embed Compose content inside this View
                val composeView = ComposeView(context).apply {
                    setContent { currentContent() }
                }
                addView(composeView)
                viewRef = this
            }
        },
        modifier = modifier,
    )
}

/**
 * E-ink refresh zone for animated content (terrarium aquarium).
 *
 * Unlike [EinkRefreshZone] which only refreshes on [stateKey] changes,
 * this zone receives per-frame callbacks from the animation loop and
 * triggers appropriate EPD refreshes:
 * - Animation frames → fast partial update
 * - State transitions → debounced regional grayscale cleanup, without a full flash
 *
 * The [content] lambda receives an `onFrameRendered` callback that the
 * child composable (e.g. [EinkAquariumFrame]) should invoke after each render.
 */
@Composable
fun EinkAnimatedRefreshZone(
    stateKey: Any,
    modifier: Modifier = Modifier,
    sleepSnapshotMode: Boolean = false,
    sleepThrottleMs: Long = 60_000L,
    content: @Composable (onFrameRendered: (isAnimationFrame: Boolean) -> Unit) -> Unit,
) {
    val currentContent by rememberUpdatedState(content)
    var viewRef by remember { mutableStateOf<View?>(null) }
    var lastSleepFireMs by remember { mutableLongStateOf(0L) }

    // Only the debounced state path requests grayscale cleanup. Frame callbacks
    // must not request another full flash for the same transition.
    LaunchedEffect(stateKey, sleepSnapshotMode) {
        delay(500)
        viewRef?.let { view ->
            if (sleepSnapshotMode) {
                val now = System.currentTimeMillis()
                if (lastSleepFireMs == 0L || now - lastSleepFireMs >= sleepThrottleMs) {
                    EinkRefreshHelper.requestDURefresh(view)
                    lastSleepFireMs = now
                }
            } else {
                EinkRefreshHelper.requestQualityRefresh(view)
                lastSleepFireMs = 0L
            }
        }
    }

    AndroidView(
        factory = { context ->
            FrameLayout(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                // B&W e-ink: software layer for EPD grayscale path.
                // Color e-ink keeps a GPU layer so RKCFA can sample the color framebuffer.
                if (!einkColorEnabled && EinkRefreshHelper.isPhysicalEink(this)) {
                    setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                }
                val composeView = ComposeView(context).apply {
                    setContent {
                        currentContent { isAnimationFrame ->
                            val view = viewRef ?: return@currentContent
                            if (sleepSnapshotMode) {
                                if (!isAnimationFrame) {
                                    val now = System.currentTimeMillis()
                                    if (lastSleepFireMs == 0L || now - lastSleepFireMs >= sleepThrottleMs) {
                                        EinkRefreshHelper.requestDURefresh(view)
                                        lastSleepFireMs = now
                                    }
                                }
                            } else if (isAnimationFrame) {
                                EinkRefreshHelper.requestAnimationRefresh(view)
                            }
                            // State frames are handled once by the debounced effect above.
                        }
                    }
                }
                addView(composeView)
                viewRef = this
            }
        },
        modifier = modifier,
    )
}
