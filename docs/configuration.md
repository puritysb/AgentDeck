# Configuration

What you can change, and where the file lives.

## Dashboard appearance

The native apps store appearance choices on each device, independently of the
daemon settings below. Use **Settings → Dashboard** on Apple, or
**Settings → Display → Dashboard type** on Android LCD devices, and choose
**Default** or **3D aquarium · Preview**. Existing
choices survive updates; changing one device does not change another.

On mobile, tap empty water to hide the information panels and smoothly move
closer to the aquarium. Tap again to return. The full session roster remains
available in normal mode, even when the scene limits foreground residents.
E-ink and compact hardware keep their own display-specific layouts.
See the [Apple](apple-app.md#choose-your-dashboard) and
[Android](android.md#choose-a-view-for-your-screen) guides.

## Settings

Settings live in `~/.agentdeck/settings.json` (the App Store macOS app uses its
container path — see AGENTS.md → User data dir). **The file is optional**: every
loader merges its own built-in defaults, so a missing file is the normal case.
Commands such as `agentdeck weather set` and `agentdeck daemon port` create it
only when the user explicitly saves a setting. `config/default-settings.json` is
a reference copy of those built-in
defaults — it is never copied anywhere, and a test
(`bridge/src/__tests__/default-settings-drift.test.ts`) fails the build if it
stops matching the code or grows a key no loader reads.

| Key | Default | Effect |
|-----|---------|--------|
| `llm.mlx.endpoint` · `llm.mlx.model` | `http://127.0.0.1:8800` · `null` | Local MLX server used by the APME judge and the timeline summarizer. `null` model = take whatever the server advertises. |
| `apme.*` | enabled, on-device judge | Evaluation module — schema and semantics in [APME](apme.md). `apme.judge.backend` defaults to `foundationModels` with `fallbackToMlx`. |
| `wakeWord` | *(unset)* | `true` starts the Porcupine listener with the daemon (same as `--wake-word`). |
| `wakeWordMic` · `wakeWordSensitivity` | *(unset)* · `0.5` | Mic name substring and detection sensitivity. See [Wake word](wake-word.md). |
| `voice.locale` | *(system locale)* | BCP-47 tag (e.g. `"en-US"`) for on-device transcription. See [Voice setup](voice-setup.md). |
| `weather.lat` · `weather.lon` · `weather.place` · `weather.timeZone` | *(unset)* | Provider-attributed Glance weather. Use `agentdeck weather set`; coordinates are stored at two decimals. No config → no weather card, never an IP-geolocation guess. |
| `calendar.ics` | *(unset)* | Secret-address ICS URL, or a list of them, for the glance schedule. |
| `peripheralMappings` | `[]` | NFC tag uid → steering action mapping. |
| `idotmatrixNamePrefixes` | *(built-in list)* | Widens BLE discovery for iDotMatrix-family displays. |

Keys not in this table are not read. `bridgePort`, `autoRestart`,
`stuckTimeoutMs`, `reconnectIntervalMs`, `voiceLanguage`, `voiceAutoSend`,
`whisperModel` and `apme.autoTune` all appeared in older copies of this page
and of `config/default-settings.json`, but no loader has ever read them from
settings.json — the port comes from the CLI/daemon allocator, the timeouts are
compile-time constants, and `whisperModel` outlived the whisper.cpp path that
was removed in favour of Apple's on-device recognizer.

The Node/CLI daemon uses keyless MET Norway by default and keeps its attributed
forecast in `weather-cache-v1.json`, alongside `settings.json`, so a temporary
upstream failure does not blank a portable reader. The cache may remain usable up
to its forecast `validUntil` (normally seven days); `agentdeck weather clear`
removes both the saved location and that persisted cache. `weather.provider:
"open-meteo"`, `weather.endpoint`, and `weather.apiKey` remain an explicit custom
provider compatibility path for existing installations, not the zero-setup
default. See [Surface Protocol → Seven-day offline weather](surface-protocol.md#seven-day-offline-weather).

## Stream Deck Property Inspector

Only the **Launcher encoder (E4)** carries per-instance settings:
`claudeTarget`, `codexTarget`, `openclawTarget` — the working directory each
agent opens in.

The keypad has no per-button configuration. Every key is a `session-slot` whose
content is derived from live session state, and the detail-view quick actions
(GO ON / REVIEW / COMMIT / CLEAR) are defined by the shared layout engine in
`shared/src/d200h-layout.ts`, not by user settings. The earlier configurable
slots 3-6 belonged to the retired mode-dial keypad — see
[Retired and Experimental Surfaces](retired-surfaces.md).

## Prompt templates

`config/prompt-templates.json` holds labelled prompts:

```json
{
  "templates": [
    { "label": "Fix Bug", "prompt": "Please fix the bug described above" },
    { "label": "Test", "prompt": "Write tests for the changes made" }
  ]
}
```

The bridge resolves `send_prompt` commands of the form `__template:<index>`
against this file. **Nothing in the shipped UI emits that command today** — the
encoder that cycled templates was retired with the multi-mode dials, so editing
this file currently has no visible effect. It is documented because the file and
the bridge handler both still exist.
