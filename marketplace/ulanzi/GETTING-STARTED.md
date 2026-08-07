# AgentDeck for D200H — Getting started

Written for Ulanzi Studio reviewers and first-time users. Ulanzi's internal
testers reported (2026-08-05) that dragging the action onto a key left them with
no idea what to do next, which is the gap this page fills.

## What this plugin is, and why an empty key is expected

AgentDeck is a **thin client**, in the same sense as an OBS plugin: it draws
what a local AgentDeck daemon reports and sends your key presses back to it. The
plugin bundles no daemon, touches no USB HID, and collects no analytics.

So on a machine where AgentDeck is not running yet, the keys are *supposed* to
look inert — the center key shows **OFFLINE · Open AgentDeck** with the install
command underneath. That is the plugin working correctly and telling you the
daemon is the missing piece. Two steps fix it.

## Step 1 — get the AgentDeck daemon running

Either path is complete on its own. Pick one.

**macOS 26+, no terminal** — install the free
[AgentDeck Dashboard from the Mac App Store](https://apps.apple.com/app/id6784822497)
and open it. The app carries its own daemon; there is nothing else to install,
no account, and no Node.js. It requires macOS 26 or later, and it is not offered
on every storefront — on an earlier macOS, or where the listing is unavailable,
take the terminal path below. It is complete on its own, not a fallback.

**macOS or Windows, from a terminal** — with Node.js 22+ installed:

```bash
npx @agentdeck/setup
```

That installs the `agentdeck` CLI, starts the local daemon, and registers the
lifecycle hooks for whichever agent CLI is already present.

Both paths serve the same local WebSocket on port 9120, which is what this
plugin connects to. Nothing leaves the machine.

## Step 2 — start an agent session

The deck mirrors real work, so it stays empty until there is some. In your own
terminal, start any supported agent the way you normally would:

```bash
claude          # or: codex, opencode
```

No AgentDeck-specific command is needed — the hooks installed in step 1 report
the session automatically. Within a second or two the OFFLINE key is replaced by
one key per live session.

If you only want to *see* the plugin render without running an agent, the
Mac App Store app's built-in Device Preview draws every surface, D200H included,
with simulated sessions.

## Step 3 — read and use the keys

Fill as many keys as you like with the single **AgentDeck** action; each key
reflows on its own as work happens. There is nothing to configure per key.

| On the key | Meaning |
|---|---|
| Agent mark + project name | Which session this key is bound to |
| Green | Idle — waiting for your next prompt |
| Blue | Processing — the agent is working |
| **Amber** | **Waiting on you** — a permission, an option, or a diff to approve. This is the only state that animates |
| Grey | Disconnected |
| OFFLINE | No daemon reachable, or no session yet (see steps 1 and 2) |

Pressing a key focuses that session; when a session is waiting on you, the key
becomes the answer control — pick an option, allow or deny, switch mode, or
stop. The usage keys show quota with reset countdowns.

## What differs between the two daemons

Everything above works with either. One capability does not:

| | Mac App Store app | `npx @agentdeck/setup` |
|---|---|---|
| Session keys, states, steering, stop | Yes | Yes |
| Codex rate limits | Yes | Yes |
| **Claude subscription 5h / 7d quota gauges** | **Relayed only** | Yes |
| Voice key delivery to an observed session | Queued until the session's next turn ends | Delivered live |

The Claude row is a policy boundary, not a missing feature: Anthropic's terms
prohibit third-party routing through subscription credentials, so the sandboxed
app has no standalone path to those numbers and displays them only when a CLI
daemon supplies them. Full matrix:
[docs/appstore-feature-matrix.md](../../docs/appstore-feature-matrix.md).

## If the keys still say OFFLINE

1. **Is the daemon running?** Open the Mac App Store app, or run
   `agentdeck status` in a terminal.
2. **Is it the same machine?** The plugin only talks to `127.0.0.1:9120`. A
   daemon on another computer is not reachable by design.
3. **Port taken?** `agentdeck status` reports the port actually in use; the
   daemon picks the next free one when 9120 is occupied, and the plugin follows
   the same discovery.
4. **Nothing to show?** A running daemon with no agent session still shows
   OFFLINE on the D200H, because there is no session to draw. Start an agent
   (step 2).

## Support

- Issues: <https://github.com/puritysb/AgentDeck/issues>
- Overview and device catalog: <https://puritysb.github.io/AgentDeck/>

AgentDeck is an independent project, not affiliated with or endorsed by Ulanzi,
Anthropic, OpenAI, or any other third party mentioned. All trademarks belong to
their owners.
