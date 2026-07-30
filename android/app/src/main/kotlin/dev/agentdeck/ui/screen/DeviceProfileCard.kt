package dev.agentdeck.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.agentdeck.util.DeviceCaveat
import dev.agentdeck.util.DeviceProfile
import dev.agentdeck.util.PanelOverride
import dev.agentdeck.util.SupportLevel

/**
 * Settings card that states the resolved device class, lists any caveats, and
 * exposes the panel override.
 *
 * This is where a [SupportLevel.Limited] device is explained. Limited devices
 * still render the dashboard immediately — a TV on a wall is a legitimate way
 * to use this app — so the caveat lives in a surface the user can consult
 * rather than an interstitial they would have to dismiss with a remote.
 */
@Composable
fun DeviceProfileCard(
    profile: DeviceProfile,
    override: PanelOverride,
    onOverrideChange: (PanelOverride) -> Unit,
) {
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
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Device",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = profile.describe(),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            profile.caveats.forEach { caveat ->
                Text(
                    text = "· ${deviceCaveatCopy(caveat)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Text(
                text = "Display panel",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PanelOverride.entries.forEach { option ->
                    FilterChip(
                        selected = override == option,
                        onClick = { onOverrideChange(option) },
                        label = { Text(panelOverrideLabel(option)) },
                    )
                }
            }
            Text(
                text = PANEL_OVERRIDE_HELP,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

internal fun panelOverrideLabel(option: PanelOverride): String = when (option) {
    PanelOverride.Auto -> "Auto"
    PanelOverride.Eink -> "E-ink"
    PanelOverride.Lcd -> "LCD"
}

/**
 * Shared with the e-ink settings overlay so both surfaces explain the control
 * the same way.
 */
internal const val PANEL_OVERRIDE_HELP =
    "Auto detects e-ink from the vendor refresh API, system properties and a " +
        "device table. Override it if this device got the wrong dashboard — the " +
        "app restarts to apply it."

internal fun deviceCaveatCopy(caveat: DeviceCaveat): String = when (caveat) {
    DeviceCaveat.NoTouchInput ->
        "No touchscreen reported — panels render, but prompts and settings need " +
            "a D-pad or a pointer."

    DeviceCaveat.TightWidth ->
        "Narrow screen — the timeline uses its single-column layout and side " +
            "rails are dropped in portrait."

    DeviceCaveat.UnverifiedEinkPanel ->
        "E-ink was inferred from a build string only. Set Display panel " +
            "explicitly if the dashboard looks wrong."

    DeviceCaveat.AutomotiveUnverified ->
        "Automotive head unit — untested, and the platform may restrict the " +
            "dashboard while driving."
}
