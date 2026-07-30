package dev.agentdeck.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.agentdeck.BuildConfig
import dev.agentdeck.util.DeviceCaveat
import dev.agentdeck.util.DeviceProfile
import dev.agentdeck.util.UnsupportedReason

/**
 * Shown instead of a dashboard when [DeviceProfile.support] is
 * [dev.agentdeck.util.SupportLevel.Unsupported].
 *
 * The point is to be unambiguous rather than apologetic: name the device, name
 * the requirement it misses, say what still works, and offer the escape hatch.
 * The escape hatch matters — coverage is deliberately wide, and the size floor
 * is a heuristic, so a user who knows better must be able to overrule it
 * without sideloading a different build.
 *
 * Styled through `MaterialTheme` only, so it renders correctly under the
 * monochrome e-ink scheme as well as the dark LCD one.
 */
@Composable
fun UnsupportedDeviceScreen(
    profile: DeviceProfile,
    onShowAnyway: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 520.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "This device can't show the dashboard",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onBackground,
            )

            Text(
                text = reasonCopy(profile),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Text(
                text = "Your agents are still being monitored. The daemon on your " +
                    "computer keeps running, and every other paired surface — Stream " +
                    "Deck, the macOS and iOS apps, ESP32 panels — is unaffected. " +
                    "Install this app on an e-ink reader, a tablet or a phone to get " +
                    "a dashboard here too.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Card(
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = "Detected",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = profile.describe(),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = "AgentDeck Android · v${BuildConfig.VERSION_NAME}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (profile.caveats.contains(DeviceCaveat.UnverifiedEinkPanel)) {
                Text(
                    text = "The panel was classified as e-ink from a build-string " +
                        "match only. If that is wrong, open the dashboard below and " +
                        "set Display panel to LCD in Settings.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            OutlinedButton(onClick = onShowAnyway) {
                Text("Show the dashboard anyway")
            }

            Text(
                text = "Layouts are not tested at this size, so panels may overlap " +
                    "or clip. The choice is remembered.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun reasonCopy(profile: DeviceProfile): String = when (profile.unsupportedReason) {
    UnsupportedReason.WatchFormFactor ->
        "${profile.displayName} reports itself as a watch. The dashboard puts a " +
            "session list, a terrarium and a timeline on screen at once, which " +
            "needs a reader, tablet or phone-sized display."

    UnsupportedReason.ScreenTooSmall ->
        "${profile.displayName} reports ${profile.shortestWidthDp}dp on its shortest " +
            "edge. The dashboard needs at least " +
            "${DeviceProfile.MIN_SUPPORTED_WIDTH_DP}dp — below that the timeline " +
            "loses its labels and the session rows have nowhere to go."

    null ->
        "${profile.displayName} is outside the supported device classes."
}
