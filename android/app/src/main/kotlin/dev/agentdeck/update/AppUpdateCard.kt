package dev.agentdeck.update

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import dev.agentdeck.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File

/** Shared by tablet and e-ink settings; user-initiated, with no background polling. */
@Composable
internal fun AppUpdateCard() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var release by remember { mutableStateOf<ApkRelease?>(null) }
    var downloaded by remember { mutableStateOf<File?>(null) }
    var message by remember { mutableStateOf("Installed: ${BuildConfig.VERSION_NAME}") }
    Column {
        Text("App updates", style = MaterialTheme.typography.titleSmall)
        Text(message, style = MaterialTheme.typography.bodySmall)
        if (BuildConfig.APK_UPDATES) {
            Text("Download over Wi-Fi. Android asks you to confirm installation.", style = MaterialTheme.typography.bodySmall)
        }
        Button(enabled = !busy, onClick = {
            if (!BuildConfig.APK_UPDATES) {
                try {
                    context.startActivity(Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://play.google.com/store/apps/details?id=dev.agentdeck")))
                } catch (_: Exception) { message = "Google Play could not be opened on this device." }
            } else scope.launch {
                busy = true
                try {
                    val file = downloaded
                    val update = release
                    if (file != null && file.exists()) {
                        message = if (ApkUpdates.install(context, file)) "Confirm the update in Android's installer."
                            else "Allow updates from AgentDeck, return here, then tap Install update."
                    } else if (update != null) {
                        message = "Downloading ${update.version}…"
                        downloaded = ApkUpdates.download(context.applicationContext, update)
                        message = "${update.version} is verified and ready to install."
                    } else {
                        message = "Checking for updates…"
                        release = ApkUpdates.check()
                        message = release?.let { "${it.version} is available (installed: ${BuildConfig.VERSION_NAME})." }
                            ?: "No newer Android release is available."
                    }
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { message = e.message ?: "Update failed. Please try again." }
                finally { busy = false }
            }
        }) {
            Text(when {
                !BuildConfig.APK_UPDATES -> "Open Google Play"
                busy -> "Please wait…"
                downloaded != null -> "Install update"
                release != null -> "Download update"
                else -> "Check for updates"
            })
        }
    }
}
