# AgentDeck for Ulanzi D200H / D200X — Getting started

AgentDeck puts your AI coding sessions (Claude Code, Codex, OpenCode, Kiro and
others) on your Ulanzi keys: one key per session, its live state on the key,
and your answer sent back with a press.

The plugin is a **thin client**, like an OBS plugin. It draws what a small
AgentDeck program on the same computer, the *daemon*, reports, and it sends your
key presses back to it. The plugin itself bundles no daemon, touches no USB HID
and collects no analytics. Setup is therefore two things: run the daemon, then
use your agents as usual.

## Step 1 — run the AgentDeck daemon

Follow the section for your computer.

### Windows

1. Install [Node.js](https://nodejs.org/) 22 or later, if you do not have it.
2. Open Windows Terminal, PowerShell or Command Prompt and run:

   ```text
   npx -y @agentdeck/setup --yes
   ```

That one line installs the `agentdeck` command, starts the daemon now and at
every sign-in (a per-user scheduled task, no administrator rights needed), and
installs the reporting hooks for the coding agents it finds on this computer.

- **PowerShell says "running scripts is disabled on this system" (`npx.ps1`).**
  Run the same line in Command Prompt (`cmd.exe`), or type `npx.cmd` in place of
  `npx`. Nothing else needs to change.
- **"npx is not recognized".** Node.js is missing or the terminal predates the
  install. Install Node.js, then open a new terminal window.
- **Keys still OFFLINE.** Run the command again; it is safe to repeat. Then run
  `agentdeck status` to see whether the daemon is up and which port it uses.

### macOS

Pick one path; each is complete on its own.

- **macOS 26 or later, no terminal.** Install the free
  [AgentDeck Dashboard from the Mac App Store](https://apps.apple.com/app/id6784822497)
  and open it. The app carries its own daemon: nothing else to install, no
  account, no Node.js. It is not offered on every storefront.
- **Any macOS, from Terminal.** With [Node.js](https://nodejs.org/) 22 or later:

  ```bash
  npx -y @agentdeck/setup --yes
  ```

  This installs the `agentdeck` command, starts the daemon now and at every login
  (a LaunchAgent), and installs the reporting hooks for the coding agents it
  finds.

Codex sessions started in the ChatGPT app appear too, once Codex integration is
registered: the Terminal setup does it for you, and the App Store app asks in
Settings.

- **Keys still OFFLINE.** With the app, check that it is running; its icon is in
  the menu bar. With the Terminal path, run the command again (it is safe to
  repeat), then `agentdeck status`.

Both paths serve the same local connection on port 9120, which is what the
plugin talks to. Nothing leaves the computer.

## Step 2 — start an agent

In any project folder, start your agent the way you normally do:

```bash
claude          # or: codex, opencode
```

There is no AgentDeck-specific command. Sessions reach AgentDeck through
**hooks**: small entries in each agent's own settings that report what the
session is doing. The step 1 command installs them for Claude Code, Codex,
OpenCode and Kiro, for whichever of those it finds. **If you install an agent
after running setup, run the step 1 command again** so that agent gets its hooks
too.

As soon as the session reports in, a key turns into that session.

## Step 3 — fill your keys

Drag the **AgentDeck** action onto every key you want AgentDeck to use. It is
the only action; each key decides for itself what to show, and the layout spreads
over exactly the keys you placed. There is nothing to configure per key.

What the keys show before everything is running is itself a guide:

| The keys show | It means |
|---|---|
| One dark **OFFLINE** card across all keys | The plugin cannot reach the daemon. Do step 1. |
| **HUB READY** and **NO SESSION** | The daemon runs, but no agent session exists yet. Do step 2. |
| One key per session | Everything works. |

## What the keys do

- **Session keys.** One key per session, showing the agent, the project and
  whether it is working, waiting for you, or done. A session waiting for you
  (a permission, a choice, a diff to review) is amber, and amber is the only
  state that animates.
- **Press a session key** to open it. **BACK**, labelled with the session's
  name, returns to the list. The next key shows what the session is doing. When
  the agent asks a question, its answers appear as keys: press one to answer.
  The last key is **Stop**, where the session allows it.
- **Usage keys** show how much of your Claude and Codex subscription limits is
  used in the current 5-hour and 7-day windows, with the time until each resets.
- **More sessions than keys:** the last key becomes **MORE** and pages through
  the rest.

## Still stuck

1. **Is the daemon running?** Open the Mac App Store app, or run
   `agentdeck status` in a terminal.
2. **Is it the same computer?** The plugin only talks to the daemon on this
   computer (`127.0.0.1`). A daemon on another machine is not reachable by
   design.
3. **Port taken?** `agentdeck status` reports the port actually in use. The
   daemon moves to the next free port when 9120 is occupied, and the plugin
   looks there too.
4. **The setup panel says no session, but the keys show sessions?** Trust the
   keys. Older daemons cannot report a session count to the panel; updating with
   the step 1 command fixes the panel.

## What differs between the two macOS daemons

Everything above works with either. One capability does not:

| | Mac App Store app | `npx -y @agentdeck/setup --yes` |
|---|---|---|
| Session keys, states, steering, stop | Yes | Yes |
| Codex rate limits | Yes | Yes |
| **Claude subscription 5h / 7d quota gauges** | **Relayed only** | Yes |
| Voice key delivery to an observed session | Queued until the session's next turn ends | Delivered live |

The Claude row is a policy boundary, not a missing feature: Anthropic's terms
prohibit third-party routing through subscription credentials, so the sandboxed
app has no standalone path to those numbers and shows them only when a CLI
daemon supplies them. Full matrix:
[docs/appstore-feature-matrix.md](../../docs/appstore-feature-matrix.md).

## Support

- Issues: <https://github.com/puritysb/AgentDeck/issues>
- Overview and device catalog: <https://puritysb.github.io/AgentDeck/>

## Background for reviewers

This page is the "Full guide" linked from the plugin's setup panel (opened in
the system browser through the SDK's `openUrl`). It exists because Ulanzi's
internal testers reported (2026-08-05) that dragging the action onto a key left
them with no idea what to do next. The Ulanzi Studio QA round of 2026-10-19
(plugin 1.8.1 on Windows) led to the current shape: separate Windows and macOS
instructions, a setup command that starts the daemon (`--yes`), the hooks note,
and the table of what the keys show before a session exists. The earlier version
of this page said a running daemon with no session shows OFFLINE; the deck
actually shows HUB READY / NO SESSION in that case.

AgentDeck is an independent project, not affiliated with or endorsed by Ulanzi,
Anthropic, OpenAI, or any other third party mentioned. All trademarks belong to
their owners.
