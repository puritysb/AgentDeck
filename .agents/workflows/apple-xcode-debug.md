---
description: Capture and analyze Apple/Xcode diagnostics
---
Use this workflow whenever a macOS/iOS AgentDeck issue was reproduced from Xcode or the user mentions Xcode console logs, a hang, startup failure, daemon behavior, OpenClaw pairing, D200H/Pixoo state, WebSocket state, or Swift daemon logs.

This is a repository-side developer workflow only. It must not add subprocesses, logging commands, terminal instructions, or companion-install prompts to the App Store app UI.

1. If the issue has not been reproduced yet, ask the user to run the app from Xcode and reproduce it once. If it was already reproduced, continue without asking for copied logs.

2. Capture a diagnostic bundle.

```bash
bash scripts/capture-apple-diagnostics.sh --tail 1000 --last 15m
```

Use `--no-sample` when a short process sample would be too intrusive. Use `--port <port>` only when the daemon port is already known.

3. Read the captured bundle from `diagnostics/apple-xcode/latest/`, starting with:

- `README.md`
- `capture-meta.txt`
- `diag.json`
- `status.json`
- `log-files/group-swift-daemon.log`
- `log-files/legacy-swift-daemon.log`
- `oslog-AgentDeck.log`
- `process/pgrep-agentdeck.txt`

If `oslog-AgentDeck.log`, `process/pgrep-agentdeck.txt`, or `process/sample-*.txt` says `Operation not permitted`, `Cannot get process list`, or similar sandbox failure, follow `AGENTS.md` Agent working agreements for execution-policy failures. Retry the capture after access is resolved; unreadable evidence cannot establish a hang, threading, startup, or process-lifecycle diagnosis.

4. Correlate the evidence before editing code:

- Check whether the app is using the in-process Swift daemon or an external Node daemon.
- Confirm the actual daemon port and whether `/status` and `/diag` agree.
- Compare Xcode-era OSLog lines with `DaemonLogger` file lines.
- For hangs, inspect `process/sample-*.txt` before changing threading or I/O code.
- For App Store-sensitive areas, re-check the `AGENTS.md` App Store build invariants before proposing or making changes.

5. Keep diagnostic captures local. The root `diagnostics/` directory is gitignored and should not be committed.
