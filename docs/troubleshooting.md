# Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Plugin shows DISCONNECTED | Daemon not running | Run `agentdeck daemon status`; start with `agentdeck daemon start` or install autostart with `agentdeck daemon install` |
| Plugin reconnects every 3s | Daemon restarting or unreachable | Run `agentdeck daemon restart`, then check `agentdeck daemon status` |
| A session disappears | Agent exited or its lifecycle channel stopped | Confirm the agent is running normally, then refresh hooks with `agentdeck daemon install` |
| State tracking not working | Hook/event channel cannot reach the daemon | Verify `agentdeck daemon status`, then refresh with `agentdeck daemon install` |
| Stream Deck buttons inactive | Hardware not connected | Reconnect + restart app |
| Stuck in PROCESSING > 5 min | Agent stalled | STOP button or Ctrl+C in terminal |
| Voice transcription returns empty | Speech recognition permission denied, or OS dictation model still downloading | macOS Settings → Privacy & Security → Speech Recognition → enable AgentDeck. First-time recognition may wait ~30s while the OS finishes the on-device model download |
| Plugin not in Stream Deck app | Plugin not linked | Restart Stream Deck app, then `cd plugin && streamdeck link bound.serendipity.agentdeck.sdPlugin` |
| Hooks not firing | Hooks not installed or stale | Run `agentdeck daemon install` (idempotently refreshes Claude/Codex/OpenCode integrations) |
| Need to remove hooks | Uninstalling AgentDeck | `node hooks/dist/install.js uninstall` |
| Plugin loads but buttons blank | Plugin needs rebuild | `pnpm build && pnpm generate-icons`, restart Stream Deck app |
| Android app can't find bridge | mDNS blocked on network | Use QR pairing (`agentdeck qr`) or enter IP manually in Settings |
| Android shows "Not Connected" | Bridge not reachable | Verify same LAN; for USB: `adb reverse tcp:9120 tcp:9120` then connect to 127.0.0.1:9120 |
| E-ink ghosting on Crema | Missing full GC16 refresh | State transitions trigger full refresh automatically; force refresh by toggling bridge connection |
| `posix_spawnp failed` | On macOS, old installs may have a non-executable node-pty `spawn-helper`; otherwise the native prebuild may be incompatible | Current AgentDeck repairs the helper mode on first use. Reinstall with `npx @agentdeck/setup`; only if it still fails, run `cd $(npm root -g)/@agentdeck/bridge/node_modules/node-pty && npx node-gyp rebuild` |

## tmux -CC Compatibility

Normal hook-observed sessions need no special handling under iTerm2 `tmux -CC`.
Users who deliberately retain the legacy
managed-terminal path must run `agentdeck claude` inside a tmux window; the
bridge owns only its child PTY. This is a legacy compatibility note, not the
migration path. New and migrated sessions run `claude` directly after
`agentdeck daemon install`.

Signal chain: `tmux → iTerm2 → agentdeck → bridge PTY → claude`

---
