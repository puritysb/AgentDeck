# Crema S captures — Android 1.6.1

Captured on the physical Crema S (CREMA_0680S, Android 10) on 2026-09-28
after an in-place update from 1.6.0/code 22 to the official 1.6.1/code 23 APK.
Both PNGs are unmodified 1072×1448 framebuffer screenshots from the real release
app. They show fictional sessions from `scripts/appstore-demo-orchestrator.mjs`,
not private workspaces or conversations.

- `crema-01-working.png`: working and idle sessions, usage, and habitat.
- `crema-02-attention.png`: an approval request, other working sessions, and a completed response.

The existing demo feed ran on loopback port 19220. Only Crema's temporary ADB
reverse route changed from device port 9120 to that feed. After capture it was
restored to host port 9120, the app relaunched, and the temporary feed stopped.
No data clear, uninstall, system rotation override, image scaling, or image
retouching was used. Framebuffer captures do not measure physical e-ink ghosting
or refresh behavior. The app logged its native Onyx regional-refresh route.
