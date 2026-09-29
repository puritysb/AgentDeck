package dev.agentdeck.terrarium.renderer

import android.util.Log
import android.view.View
import android.view.ViewGroup
import java.lang.reflect.Method

/** Firmware View extensions, verified on the IWG/Qualcomm Crema S framework. */
internal class NativeOnyxRefresh private constructor(
    private val setMode: Method,
    private val refreshScreen: Method,
) {
    private var failed = false
    private var announced = false

    fun refresh(view: View, mode: Int, full: Boolean = false): Boolean {
        if (failed) return false
        return try {
            // Compose invalidates descendants independently; their default mode must
            // agree with the zone. Never leave the FULL bit sticky or lock global policy.
            configure(view, mode)
            view.invalidate()
            if (full) {
                refreshScreen.invoke(view, 0, 0, view.width, view.height, onyxUpdateMode(mode, true))
            }
            if (!announced) {
                Log.i("EinkRefresh", "Using native Onyx View regional refresh")
                announced = true
            }
            true
        } catch (e: Exception) {
            failed = true
            Log.w("EinkRefresh", "Native Onyx refresh unavailable; using normal invalidation", e)
            false
        }
    }

    private fun configure(view: View, mode: Int) {
        setMode.invoke(view, mode)
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) configure(view.getChildAt(index), mode)
        }
    }

    companion object {
        fun probe(): NativeOnyxRefresh? = try {
            // Do not infer an ABI from a marketing name or assume the optional SDK exists.
            Class.forName("android.onyx.ViewUpdateHelper")
            NativeOnyxRefresh(
                View::class.java.getMethod("setDefaultUpdateMode", Int::class.javaPrimitiveType),
                View::class.java.getMethod("refreshScreen", Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType, Int::class.javaPrimitiveType,
                    Int::class.javaPrimitiveType, Int::class.javaPrimitiveType),
            )
        } catch (_: Exception) { null }
    }
}

// Firmware flags: PARTIAL=0, FULL=32, WAIT=64; GC16=2, DU=1, ANIM=4.
internal fun onyxUpdateMode(waveform: Int, full: Boolean): Int =
    waveform or if (full) (32 or 64) else 0
