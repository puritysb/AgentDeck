# Offline device voice evaluation

Build the workspace, then run:

```sh
node bridge/tools/evaluate-device-voice.mjs manifest.json variants.json report.json speech-gated
```

The optional final argument names the acceptance gate: exit status 2 means any false command acceptance, rejected positive case or operational error in that variant. Reports are written even on a failed gate. Character error rate is reported separately; passing the command-presence gate is **not** an accuracy claim. No case is dispatched to an agent.

Manifest paths resolve relative to the manifest. Keep private recordings and reports in ignored `diagnostics/`, not in git. Include current-device human recordings before drawing conclusions about user accuracy. Label synthetic speech, acoustic speaker-to-device captures and human speech separately.

```json
{
  "label": "Controlled evaluation, not a population accuracy estimate",
  "cases": [
    { "id": "quiet", "audio": "silence.wav", "kind": "nonspeech", "commandExpected": false },
    { "id": "wake", "audio": "wake-only.wav", "kind": "invocation", "commandExpected": false },
    { "id": "command", "audio": "command.wav", "kind": "human", "commandExpected": true, "expectedText": "오늘 날짜를 알려줘." }
  ]
}
```

`variants.json` contains a `variants` object mapping names to settings accepted by [device-transcription.ts](../src/device-transcription.ts). Reuse identical ASR settings for baseline and speech-gated variants, adding `whisperVadCli` and `whisperVadModel` only to the gated variant. These must be absolute paths to `whisper-vad-speech-segments` and a compatible Silero model. Model/executable installation is explicit; the application never downloads them implicitly. The default Apple backend remains unchanged.

Production configuration uses those same two optional keys under `voice` in AgentDeck settings. Both must be present. The gate runs locally with a five-second deadline before either the warm Whisper server or its CLI fallback. It checks speech presence and preserves the complete original WAV. Missing executables/models, timeout and unrecognized tool output are errors, not permission to bypass the gate. The parser expects the tool's `Detected N speech segments:` report and matching segment lines; verify that contract when upgrading whisper.cpp.

Include silence, tones, keyboard/fan noise, wake-only, short commands, pauses, soft speech and longer speech. Compare the same files across variants. The report records individual errors, command acceptance, normalized character edits and latency, so faster rejection of silence does not disguise slower speech recognition. Keep cold CLI and warm-server latency comparisons clearly labeled. Wake-only rejection uses the same [command extraction](../src/personal-voice-turn.ts) as live dispatch; VAD alone cannot distinguish an invocation from a command.

For agent latency, `voice.openclawThinking` can request `low` or `off` per turn; omit it to inherit the agent's policy. Verify model support: GLM-5.3 rejects `off` and supports `low`. A fast settings-error response is not a successful latency result. The `voice latency` log measures send-to-final time for the matching run.

`voice.openclawSessionKey` defaults to `agent:main:main`. An explicit `agent:main:voice` (or the same suffix on another personal agent) uses a separate ongoing voice conversation with that agent, avoiding a large desktop conversation on every short command. Agent workspace configuration remains the same, but the main conversation's complete history is not copied. This is an opt-in context tradeoff, not transparent context compression; set the key back to `agent:main:main` to restore the previous route.
