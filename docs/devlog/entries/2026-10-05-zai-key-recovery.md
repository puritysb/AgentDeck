# 2026-10-05 — Recover rejected z.ai credentials from Integrations

The current provider key received HTTP 200 with an explicit authentication-failure envelope. The settings row previously showed only Awaiting data and hid the key editor while the Mac app followed a Node daemon.

Both quota producers now carry an explicit `authFailed` wire flag, preserve it when quota windows retire, and clear it after a credential replacement or successful reading. The provider error code belongs to the existing [z.ai quota SSOT](shared/src/zai-quota.ts) and generated Swift mirror.

The macOS settings editor can update the active same-Mac Node daemon through a bearer-authenticated, loopback-only endpoint. Keys are never returned or logged, redirect forwarding is refused, settings writes preserve unrelated fields and use private permissions, and environment-owned keys stay read-only. Remote connections edit credentials on their hosting Mac. The App Store native daemon retains its own Keychain store.

Regression coverage exercises authentication rejection versus transport failure, credential replacement, native state epochs, integration status, local URL restrictions and real-daemon credential custody. Source changes do not imply that the installed App Store app or published npm packages contain this fix. Restoring live quota requires a key accepted by z.ai.
