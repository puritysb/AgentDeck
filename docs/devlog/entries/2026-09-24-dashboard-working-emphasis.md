# 2026-09-24 — Make working dashboard agents easier to identify

The macOS/iOS roster now gives processing sessions a tinted background, visible border, bold name and WORKING label. Idle indicators use the neutral product token. Selection remains independently visible; row ordering and the existing 3D habitat remain unchanged. No minimum busy hold or artificial post-completion activity was added.

The user report also exposed a separate personal-voice dispatch gap on the local voice-development branch: it waited for the first assistant delta before marking OpenClaw busy. That branch now owns a bounded activity lease through matched completion/refusal/timeout, tested for overlapping requests and unrelated completions. This upstream change contains only the dashboard styling; it does not claim to publish the separate voice feature.

Validation on the 1.5.0 source: JavaScript build/typecheck and 4,693 tests pass (two skipped); protocol generation leaves no drift; signed macOS Debug and iOS Simulator builds pass. Token mirrors pass; design lint retains 92 existing built-checkout findings. Installed app identity is 1.5.0 (4), signature verified. A synthetic Korean request through the running personal-voice endpoint showed OpenClaw WORKING in the live roster and 3D habitat, then idle after completion. The Node voice-development daemon remained on 9120. iOS was built, not device-installed or released.

The first local UI build used the older voice-development Apple baseline (1.3.2). It was replaced by this 1.5.0-based build; the previous 1.5.0 app is retained locally for rollback. No store artifact was replaced or published.
