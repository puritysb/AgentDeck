# Changelog

All delivery channels share one compatibility major. New minor versions identify
named product-wide feature milestones; patches complete or improve existing
capabilities, including performance, onboarding and rendering parity. Targets
ship independently with channel-prefixed tags. Published identities are immutable.
Root `VERSION` is the compatibility anchor, not a minor/patch ceiling.
See [RELEASING.md](RELEASING.md#choosing-a-version) for classification and receipts.

**This file is the source of every GitHub Release body.** `scripts/release-notes.mjs`
looks up a delivery tag here and renders the release page from what it finds;
`pnpm verify-release-version` refuses a tag with no entry. So a heading has to
name its channel: the channels no longer share a patch number — npm is at
1.0.21 while Apple is at 1.0.7 — and a bare `## 1.0.7` is ambiguous the moment a
second channel reaches it. Write `## <YYYY-MM-DD> — <Channel> <version>`, and
list every channel in the heading when one round is cut across several.

Entries below `## 2026-08-07 — npm 1.0.8` predate that rule and are kept as
written, under the shared numbering of the time. They are not looked up by tag.

Work that has landed but not shipped goes under `## Unreleased`, which no tag can
match (the lookup needs a channel label and a version in the heading) and which
the release cut renames to the real heading. It exists because the alternative
that kept happening is worse: entries written only at cut time meant the round
that shipped Kiro observation across five channels announced it nowhere, and the
1.2.1 cut had to reconstruct #282–#289 from a commit log first.

### Known gaps

These versions shipped without an entry and are not reconstructed here, because
inventing a changelog after the fact states things nobody measured:
`npm 1.0.9`–`1.0.18`, `apple 1.0.4`–`1.0.6`, `android 1.0.5`–`1.0.8`,
`streamdeck 1.0.4`–`1.0.5`, `esp32 1.0.2`–`1.0.4`, `ulanzi 1.0.2`.
Their content is recoverable from the commit range between their tags.

One of them has no tag to recover it from. **`npm 1.0.14` is live on the
registry and was never tagged** — it was published from `8ee5a764` (the commit's
`bridge/package.json` reads `1.0.14`, and its timestamp matches the registry's
publish time to the second) and superseded by 1.0.15 six minutes later, so the
tag step never ran. It is left untagged deliberately: pushing `npm-v1.0.14` now
would fire the release workflow against a version npm already holds, and this
file's own rule forbids reconstructing its notes. The commit above is the
record. `npm 1.0.16` (`37c674b8`) is a different case and needs nothing — it was
bumped, superseded by 1.0.17, and never published, so it exists only in git.

## Unreleased

- Node daemon: a change to a timeline row that is already on disk is now saved as well (#625). An LLM summary or an evaluation score that arrives after the first write, or an approval's allowed/denied result, used to stay in memory only, so a clean restart with no newer row brought back the old values. The macOS app's daemon already saved these.

- Android and ESP32 e-ink: the background-work standby state (`STBY n`, #616) shipped in npm 1.9.5 and in the macOS app 1.9.4, and awaits each target's own delivery.

- ESP32 WiFi provisioning: a board parked on USB serial is no longer sent the WiFi credentials it already holds on every serial reopen, lease resume and daemon restart. Each of those provisions woke a radio the board then had to park again. A provision now carries a credential id: an HMAC keyed by the pairing token, never a bare hash of the password. The board stores the id beside the credentials and reports it as `device_info.wifiCredId`, over USB only, and both daemons skip a board whose id matches. Boards that persist a provision (IPS10, T-Display-S3-Pro, NM-EPD-420, EPD47) now also receive changed credentials, which they never did. Older firmware and older daemons keep the old behaviour, and rotating the pairing token re-provisions each board once. Neither daemon writes WiFi credentials to a serial port before a board has identified itself on that connection. On most boards a provision now also reaches flash when it follows a failed captive-portal save; it used to be held in RAM only and lost at the next reboot.

- ESP32 T-Embed: 16 KB of internal RAM is now held back from ordinary allocations, for the WiFi driver and the other allocations that can only use internal RAM to fall back on when routine heap churn has used up the rest. In a WiFi firmware update on T-Embed, internal RAM fell to 1.5 KB and one WiFi driver allocation failed (the transfer survived it); in an update with the reserve, none failed. That is one run each, so it is a first reading, not proof. Other boards stay as they were until each is measured with the reserve. `device_info` reports its size, what is free in it and how far it has been drawn down (`internalReserveKb`, `internalReserveFreeKb`, `internalReserveMinKb`), and the existing heap figures leave it out.

- iOS app: connection and discovery logs no longer print the pairing token or its prefix. The macOS correction is included in the Apple 1.9.2 candidate; this iOS change awaits a separate delivery.

- iOS app: timeline rows reuse one grouped history per render, reducing repeated classification work in busy dashboards. The macOS correction is included in the Apple 1.9.2 replacement; iOS delivery is separate.

- ESP32 firmware: Wi-Fi provisioning acknowledgements report whether a board joined, saved the credentials for later, or failed. The corresponding Node/macOS setup routes are included in the candidates below; new firmware delivery is separate.

- ESP32 firmware: stop mDNS before parking the Wi-Fi radio, fixing a crash on rejoining after USB reprovisioning. The responder starts again after the board has an address.

- ESP32 IPS10: compress the ocean background without changing its pixels, reducing the measured firmware image from 99.2% to 92.4% of its OTA slot. Wake-word detection now requires a longer sustained match, and a voice turn with no speech ends after 3.5 seconds instead of 6; the voice tuning still needs physical acceptance.

## 2026-10-29 — Apple 1.9.4

This delivery targets macOS. iPhone and iPad remain on their existing release.

- Fix an unexpected quit a moment after the built-in daemon took port 9120 back: after the AgentDeck CLI daemon stopped, or after launching while the port was briefly still held. Re-checking the installed Claude Code hooks during that restart updated the menu bar from a background thread. The check now runs on the main thread. Observed on 1.9.2 (9401).
- Put long-running background work (an idle teammate, a dev server left running) on standby instead of keeping the session "working". A long-running process counts as active for 10 minutes from its first sighting and as standby after that; a job such as a subagent stays active until it ends (#616).
- OpenCode: a STOP, prompt or approval sent from a device right after OpenCode reconnected is no longer handed to the dropped connection and lost (#617). An approval that cannot be queued no longer clears the Allow/Deny prompt, so the request stays answerable (#618).
- APME: open a task's review directly from the Work board and from recent activity. The review separates the AI estimate, judge model, rubric and recorded reasoning from your own verdict and an optional note. Comparisons, per-evaluation judge settings and report exports are corrected.

Dot remains excluded from the App Store build.

## 2026-10-28 — npm 1.9.5, Stream Deck 1.8.2, Ulanzi 1.8.2

- OpenCode: a STOP, prompt or approval sent from a device right after OpenCode restarted or briefly lost its connection to the daemon could be handed to the dropped connection and silently lost. The npm daemon now withdraws a long-poll whose connection closed and returns any undelivered commands to the queue for the live poller (#617). A device approval the daemon cannot queue is logged and the prompt stays answerable.

- Sessions: an idle Claude session no longer reads "Waiting for N background tasks" for a day because a teammate is idling between messages or a dev server is still running. Background work now has a kind: a job (subagent, workflow, unknown type) stays active until it ends; a long-running process (shell, monitor, teammate, cloud session, Codex terminal, Hermes process) is active for 10 minutes from its first sighting and on standby after that. Standby work never holds the session working and shows as `STBY n` beneath any active `BG n` on Stream Deck and Ulanzi keys (#616). The macOS app, Android and ESP32 e-ink show it once their own updates ship; other ESP32 displays, the terrarium and Pixoo do not show standby yet.

- APME: the Work board opens a task's review directly, separating the AI estimate, judge model, rubric, recorded reasoning and done/missed items from your own verdict (completed, partial, incorrect or clear) and an optional note. Your feedback is kept as an append-only history; it never rewrites AI scores or trains a judge. Task detail now explains a missing reply, an intentional exclusion, disabled evaluation and a recorded judge failure separately, and the latest judge attempt is recorded with its outcome. Judge inputs keep the first request, the latest result and recorded validation/error tool events within a fixed budget. This ships in the npm daemon's report; the macOS app gains it, and opens the matching task from its recent activity rows, in its next delivery after 1.9.3.

- APME: model comparisons are withheld when there is not enough task evidence, and unknown pricing stays unknown instead of reading as free. Copied report links drop query, fragment and embedded credentials. The Mac app's per-evaluation judge settings arrive with its next delivery.

- Stream Deck: restarting the plugin preserves the profile the user selected. Bundled profiles still activate on first installation. Usage actions are now named Model Limit, Usage Dial and Usage Dial 2 to describe their function; existing action IDs and placements are preserved.

- Stream Deck: with the opt-in Codex approval hold installed, a deck's Allow and Deny keys answer the held Codex approval. Separately started Codex sessions in the same project keep their own keys instead of being merged, and a stale Codex quota estimates its renewal by calendar month.

- Ulanzi: replacing keys or switching pages no longer leaves blank keys or duplicates a key position. Session order stays stable as new sessions arrive, duplicate rows are removed, and the detail BACK key names its session. The setup panel shows the daemon's session count, opens its guide in the browser and gives separate Windows/macOS setup instructions. Checked in Ulanzi Studio 3.4.4 on macOS with a D200H attached: keys render on a new page, filling a row, adding to the next row, replacing a key and switching pages leave no blank or duplicate keys, and the plugin details show its icon and version. Key presses on the hardware and Windows Ulanzi Studio were not exercised.

- Stream Deck and Ulanzi: a weekly-only Claude usage snapshot clears an older 5-hour reading instead of retaining a stale tile.

- Stream Deck and Ulanzi decks: two sessions of the same agent in the same project no longer draw identical keys. Each gets a short session-id tag (`chezmoi #5f8f`), the start of the id shown by Claude Code's `/status`, and the detail INFO tile names the tagged session, so the session a voice prompt will reach is identifiable. A lone session looks as before (#544).

## 2026-10-27 — npm 1.9.4

- Include the full project license in all four npm packages. Verify the packed license against the repository source before publication.

## 2026-10-26 — npm 1.9.3

- Recover failed Codex jobs left in WORKING when their terminal hook is missing, using explicit current-turn completion or interruption records; unreadable or uncertain observations never imply completion.
- Protect daemon data and controls from unrelated browser pages on the same computer. Same-machine trust now validates the host and origin; paired devices and native local clients retain their supported paths. Previously exposed pairing tokens are not automatically revoked: Node users can rotate the token and re-pair devices, but complete revocation across Node/Swift handover remains separate.
- Show Attention only for a real human response: automatic Codex reviews, Claude processing and quoted prompt text no longer create false waiting states. Keep independently started Codex sessions separate, even in the same project, and estimate stale renewal dates by calendar month.
- Preserve conversation history during tool-heavy turns, close interrupted turns correctly and deliver session history to USB/Wi-Fi boards under the identifier they requested. Pixoo subagent activity no longer disappears behind tool events.
- Record Claude replies against the correct APME turn, omit request-free background notices from grading, capture OpenCode models and expose coverage diagnostics. Reference-judge comparisons remain explicit, with project selection and a reviewed dry run before sending task material.
- Improve Claude permission signals and Windows responses; add opt-in Codex approval controls with bounded fallback to the agent's own prompt. Preserve an existing Claude status line, with reversible installation and relay behavior.
- Route Wi-Fi setup through the owning daemon, validate credentials and report supported board acknowledgements. Avoid redundant provisioning when compatible firmware reports a matching credential ID; older firmware remains compatible.
- Keep absent BLE panels in one retrying worker, repair session-targeted cmux delivery, and support an experimental opt-in observed-session relay. Two-computer and Windows-worker relay acceptance remains separate.
- Make setup fall back to a user-owned npm prefix when global installation is denied, retain useful errors and give host-specific next steps.

## 2026-10-26 — Apple 1.9.3

This delivery targets macOS. iPhone and iPad remain on their existing release.

- Show Attention for requests that need a person, without promoting automatic Codex reviews, Claude processing or quoted prompt text into false alerts.
- Detect real OpenClaw approval requests consistently in the standalone Mac daemon.
- Preserve separately started Codex sessions instead of merging sessions that share a project.
- Estimate stale Codex quota renewal dates by calendar month.
- Recover from temporary local address reservations during server startup with bounded retries, retaining the existing fallback when the port is occupied or its state cannot be confirmed.
- Improve local server responsiveness when the Mac dashboard starts in the background, and resume automatic recovery after delayed shutdown.

Dot remains excluded from the App Store build.

## 2026-10-26 — Android 1.10.2

- Keep work and usage visible together on six-inch e-ink screens, with readable portrait and landscape layouts, independent scrolling and persistent scroll indicators.
- Expand provider scopes inline, retain readable quiet sessions and show recent finished work without hiding the active roster.
- Improve Frame inhabitants with distinct working, waiting and resting behavior, articulated canonical creatures, stable placement and clear crowded-scene counts.
- Preserve reading positions, session-specific history and layouts during rotation and larger system text.

## 2026-10-22 — Apple 1.9.2

**macOS 1.9.2 / 9401 was publicly released on October 24 at 07:07:56 KST.**
The [read-only ASC run](https://github.com/puritysb/AgentDeck/actions/runs/40044777874)
confirmed `READY_FOR_SALE` and submission `COMPLETE`; the
[official Mac App Store listing](https://apps.apple.com/kr/app/agentdeck/id6784822497?platform=mac)
independently confirmed public availability. The released build replaces the
withdrawn 9301 submission and includes the
dashboard Keychain correction from [#599](https://github.com/puritysb/AgentDeck/pull/599)
and the Settings rendering correction from [#600](https://github.com/puritysb/AgentDeck/pull/600).

**Post-release acceptance, October 25:** the actual Store-signed, sandboxed
9401 installation passed the Swift replay with **15 assertions and 71 WebSocket
roster frames**, including terminal expiry and synthetic-row cleanup. Operator
reports of Settings/3D restoration, physical deck buttons and sleep/wake recovery
are separate from that automated evidence. See the
[public release and acceptance record](RELEASING.md#2026-10-24-macos-192-9401-public-release).
npm 1.9.3 remains unpublished; this macOS release does not change the iOS release.

Before release, all 25 automatic full-verification gates passed in **26m 3s**;
source CI passed 13 checks with TTGO skipped. The Store artifact passed signing and archive
checks, and a Development-signed derivative with equivalent code/resources
passed the scoped Settings, 3D restoration and minimize/restore checks.
The [submission run](https://github.com/puritysb/AgentDeck/actions/runs/39969655330)
confirmed the exact 9401 build and release copy on October 23; that day's
[readback](https://github.com/puritysb/AgentDeck/actions/runs/39969780932)
recorded Waiting for Review. These are historical submission checkpoints,
superseded by the public release above.

**Earlier delivery: macOS 1.9.2 / 9301 was submitted after the Claude accuracy reassessment.**
Standalone macOS no longer promotes status-line documents into account quota;
Claude session observation remains available. The earlier 33% / 9% receipt
proved collection, not current-account accuracy. See the
[decision and replacement record](RELEASING.md#macos-192-claude-accuracy-reassessment-2026-10-23).

The [replacement upload](https://github.com/puritysb/AgentDeck/actions/runs/39892713289)
from `7e3d3033` succeeded at **2026-10-23 03:15:06 UTC**. The package's actual
Info.plist identifies **1.9.2 / 9301**; strict Apple Distribution signing for
team `QF36NDHYHD`, package signing and App Store/Dot exclusion checks passed.
All 25 automatic full-verification gates passed in **21m 56s**, and source CI
reported 13 passes with the TTGO target compile check skipped. The
[preparation readback](https://github.com/puritysb/AgentDeck/actions/runs/39894326306)
confirmed build 9301 Valid, its exact version association, automatic release
after approval and matching English, Korean, Japanese and reviewer text.
Apple recorded the [submission](https://github.com/puritysb/AgentDeck/actions/runs/39894729567)
at **12:23:33 KST on October 23**. The
[final readback](https://github.com/puritysb/AgentDeck/actions/runs/39894803126)
confirmed **Waiting for Review** and `AFTER_APPROVAL`. The 9301 submission was
later withdrawn and was never publicly released.
Earlier runtime checks retain their build-specific scope; see the
[replacement delivery record](RELEASING.md#macos-192-replacement-delivery-2026-10-23).

Earlier, at **10:13 KST on October 23**, macOS **1.9.2 / 9201** was submitted and entered
**Waiting for Review**, replacing the cancelled 1.9.1 / 8601 submission.
That build was **not publicly released**; its submission was withdrawn, with
`DEVELOPER_REJECTED` confirmed by [ASC readback](https://github.com/puritysb/AgentDeck/actions/runs/39886718986)
at **10:55:45 KST**. The [macOS upload run](https://github.com/puritysb/AgentDeck/actions/runs/39879934528)
from `6d1b3238` succeeded, and [ASC readback](https://github.com/puritysb/AgentDeck/actions/runs/39881726973)
confirmed build 9201 Valid. npm 1.9.3 remains unpublished, and the released iOS
app is unchanged. See the [delivery record](RELEASING.md#macos-192-delivery-2026-10-23).
This cumulative security and stability patch includes the fixes merged through
`4b839281`; it is not a #583-only backport. Other device/plugin updates remain
under Unreleased until their own delivery.

Earlier October 23 candidate acceptance: the signed **macOS 1.9.2 / 9101** export from
`5c87f1a5` includes the startup and timeline snapshot corrections. Clean-source
full verification and source CI passed. A Development-signed derivative with
the same Release code and resources was installed on Mac Studio. Cold Shortcuts
List Waiting Sessions and Count completed after the output permission was
allowed, and a saved reference to a terminated session required reselection
without opening another session. Stale and missing rosters returned explicit
unavailable errors rather than a successful empty result. Clicking the actual
macOS notification opened the requested session's timeline. Under the Swift
owner, a real Claude turn and fresh status-line relay were observed, and
Settings/Dashboard navigation passed. A later session-matched Swift snapshot
recorded Claude usage at 33% for 5 hours and 9% for 7 days. Dashboard gauge
rendering remains unverified because Claude is hidden by the user's existing
provider selection; that preference remains unchanged.
Earlier intermittent UI-access timeouts under the Node owner remain unexplained.
Physical deck-button and sleep/wake checks were skipped and remain unverified.
Runtime acceptance remains partial, as recorded in the
[October 23 follow-up](RELEASING.md#macos-192-authorization-and-acceptance-follow-up-2026-10-23).
Builds 8901 and 9001 from `2121b334` predate the snapshot correction; 8801 from
`e21b817b` also predates the startup correction. They remain comparison evidence
for their own source. The four accepted npm 1.9.3 tarballs are unchanged.

Source CI passed across all four workflows. The submitted **9201** archive
passed archive/package signing and Dot gates.
A derivative made by replacing its signing passed comparison against that
9201 Store app. Its cold Shortcuts List Waiting Sessions plus Count returned
0 in **3.56 seconds**, launching a new app process while the Node owner stayed
running; Dashboard, Settings and return navigation also passed. These are
additional 9201 checks. Builds 9101 and 9201 are not byte-identical, and full
semantic equivalence between them has not been established; the earlier
acceptance results retain their recorded build scope.

- macOS app: dashboard setup prompts no longer query the Keychain on the main thread for an Admin API setting they do not use, removing unnecessary synchronous work while the dashboard renders (#599). This correction is included in build 9401, not the earlier 9301.

- macOS app: the optional aquarium renderer pauses while Settings is frontmost or the dashboard is minimized or fully hidden, then resumes without changing the user's 3D preference or session state. This targets the Settings delay reproduced with background 3D rendering. Build 9401 includes the correction and passed scoped runtime checks using a Development-signed derivative of its Store code/resources.

- macOS app: busy timelines no longer regroup and classify the entire history for each visible row. Rows, detail panels and scrolling now share one render snapshot, preserving session filters and completed-task state while reducing main-thread work.

- Security, Node daemon and macOS app: a web page open in a browser on the same computer can no longer use the daemon as if it were a local program. Both daemons let any connection from the same machine in without the pairing token, and a browser connects from the same machine too. A page could open the daemon's WebSocket, read the session roster and timeline, and send device commands. It could post hooks or a shutdown with a plain-text form post. Through a host name that re-resolves to the computer itself, it could read `/health` and the pairing token in it. The macOS app also answered every request with `Access-Control-Allow-Origin: *`, so on a Mac running the app any page could read the pairing token with one ordinary request. A same-machine request now keeps that trust only when its `Host` names this computer. A WebSocket, or a request that changes something, must also carry no `Origin` or the daemon's own. Any other request needs the pairing token, as a device on the network does. A computer's bare name or a domain name no longer counts as this computer, because the network's DNS answers those; `localhost`, its IP addresses and its own `.local` name do. A session bridge's status page no longer copies a value from the address bar into its script, which let any site open that page and run its own script with the bridge's trust. The CLI, hooks, deck plugins, ESP32 boards and the APME dashboard work as before, including the dashboard opened through a port forward such as `ssh -L`. Another site's page can now read only `/setup-status`, the Node daemon's `/display-state` and the Pixoo preview frames. The Node daemon's APME API and a session bridge's event stream carry prompts and task history, and they are no longer readable cross-origin. The update does not revoke a pairing token a page may already have read. For a Node-owned daemon, `agentdeck token rotate` replaces the Node token and accepted ring, followed by `agentdeck daemon restart` and device re-pairing. This is not complete revocation across Node/Swift handover: the macOS app has no rotation control and its adoption path can retain the previous token in its accepted ring.

- macOS app: a hook whose text contains `Upgrade: websocket`, such as a turn in a session about WebSockets, is no longer dropped. The app's daemon looked for that phrase anywhere in a request, body included, and sent such a hook down its WebSocket path, where it was discarded.

- macOS app: a request whose body is not UTF-8 now reaches its route. The app's daemon decoded the whole request as text, so a body that was not UTF-8, such as a protobuf telemetry batch, turned the request into one for its root page with every header dropped. Only the request line and headers are read as text now. A Codex OTLP exporter that sends protobuf gets the 415 the route was written to send, and the ESP32 Wi-Fi setup route refuses such a body with 400, as the Node daemon does.

- Node daemon timeline: chat rows survive again on every device. Since Claude Code's per-tool hook rows were added to the timeline (2026-09-17, readable only by a surface that opts in, which no AgentDeck app or board does), they filled the shared 200-row buffer: on 2026-10-18 they held 138 of its rows, leaving one prompt and no reply from nearly 24 hours of work, so a reconnecting device or a daemon restart replayed almost no conversation. Those rows are now evicted first. A busy Claude session's Detail view no longer comes back empty. A long turn is closed against its prompt again: its reply no longer arrives without a start time, and a turn that ends with no reply text gets its closing row. A session that exits mid-turn has that turn closed at once instead of spinning until the turn watchdog notices. The Swift daemon never added these rows and is unchanged.

- Node daemon, ESP32 boards: Claude's per-tool rows no longer reach a board on USB, and the T-Embed knob's History view fills on USB and WiFi. The per-tool rows no longer reach a serial board's timeline. They are for surfaces that opt in, and boards never do; over WiFi the daemon already dropped them, but the serial path sent every one, so a board on a cable showed `Read completed`-style rows that the same board on WiFi never saw, and lost turn rows to them from its 64-row ring. The six rows a board is seeded with when it connects are now the newest six it may show, where during a busy turn they used to be six tool rows. The T-Embed knob's History view now fills, on a cable and over WiFi. On USB its query for one session's rows went to a command handler that ignored it; over WiFi the answer came back under the session's full id, which the knob, holding the 31-byte id its roster gave it, discarded. A long reply as the session's newest row no longer empties the answer either: rows are cut to board size before the frame budget, as they are at connect.

- Node daemon, Pixoo64: a session's subagent orbits stay up while its children work. The panel finds them in its last 96 timeline rows, and Claude's per-tool rows, two per tool call from any session, pushed the dispatch row out after about 50 tool calls. The panel no longer keeps those rows.

- Claude status-line relay: the installers preserve an existing status line and relay its document to the local daemon. With none configured, this remains opt-in because a custom status line hides Claude Code's footer hints. Node retains its existing status-line/OAuth scheduling and cross-source precision repair. Standalone macOS records receipt diagnostics but omits account quota derived from these documents: they cannot identify the account or original observation time, and idle expiry or resumed state can otherwise appear fresh. Claude sessions and controls remain available, and the user's provider-display preference is preserved. Uninstall restores the original status line verbatim.

- APME: a Claude turn's reply now lands on the turn its Stop closes. The Node daemon used to choose the turn by its timeline, which drops `<task-notification>` prompts and loses a long turn's prompt behind its own tool rows; those replies went to the previous turn and were dropped there (247 of 1,145 Claude Stop turns over 30 days kept no reply). A running turn displaced by a message Claude Code queued for it (a task notification, an agent or cross-session message) is now closed as `injected` rather than counted as a lost Stop, which had made Claude's Stop loss read 35% instead of 8%. New `agentdeck apme coverage` shows, per agent, how many finished turns kept their reply and model and how much of the work was judged.

- APME: a task opened only by background-job notices (`<task-notification>`) is no longer judged. Nobody asked for anything in it, so the judge had no request to grade against: over 30 days, 64 of 70 such Claude tasks had been judged, at a mean 0.77 against 0.91 for the rest. The Work board now shows them as `not graded · background-task notice, no request`, `agentdeck apme coverage` counts them as `notice-only`, and the Node daemon withdraws their earlier verdicts at startup. A task containing any prompt someone typed, or another session's message, is still judged.

- ESP32 Wi-Fi setup, macOS app and Node daemon: credentials entered in the macOS app now reach the boards. The ESP32 sheet in Settings wrote a message no firmware reads to the first USB port it found, a port the app's daemon was already holding, and saved nothing for that daemon, so a board plugged in later got nothing either. The sheet now hands the credentials to whichever daemon holds the port, which saves them, sends them to every board on USB at once, and the sheet shows each board's answer: joined at an address, saved until the board is off USB, or the reason it could not. Firmware that supports the richer acknowledgement also reports whether the board joined; older firmware keeps its existing response behavior. `agentdeck wifi-setup` uses the same route on the daemon registered for this user, or the one `--port` names, so new credentials no longer wait for a daemon restart; it sends nothing to a port the registered daemon no longer serves. Both daemons check the credentials first: a network name of up to 32 bytes, a password of 8–63 bytes or a 64-digit hex key, and no control characters. The route answers only a caller on this machine holding the pairing token, and never returns the password.

- Codex approvals from a device, opt-in. `agentdeck daemon install --codex-approvals` (or the new toggle in the Codex block under Settings → Integrations in the macOS app) adds a second handler to AgentDeck's Codex `PermissionRequest` hook. When Codex is about to ask to run a command and a device is connected, Codex first waits up to 25 seconds for Allow or Deny from a deck, showing `Running hook` in the terminal. If nobody answers, it shows its own prompt as usual. Codex asks you to review the new hook the next time it starts. Nothing changes unless you opt in, and `--no-codex-approvals` removes the handler. A daemon that predates the handler answers it at once, so Codex prompts as before. Inside a session started with `agentdeck claude`, `agentdeck codex` or `agentdeck opencode`, Codex also prompts as before.

- APME: standalone OpenCode turns now record the model that answered. The observer plugin (v5, refreshed by `agentdeck daemon install`) sends the assistant message's model and provider with each stop; before it, none of the 39 finished OpenCode turns in 30 days had a model. The provider names the endpoint, so a Qwen model served by a local MLX server scores as local rather than as Qwen's. The macOS app's daemon now also stamps the model a Codex or OpenCode stop reports, which it previously ignored.

- Node daemon BLE panels (Timebox Mini, iDotMatrix): a panel that is switched off or out of range no longer makes its sync client quit and respawn every minute or two. The client read the missing panel as a dead daemon and exited after 30 s, so the daemon started a new Python process about 900 times a day (measured for an absent Timebox on 2026-10-18). It now keeps retrying in the same process, pausing 3 s and doubling to 30 s between attempts, and still exits when the daemon stops answering. Changing or removing the iDotMatrix in settings while its panel is not connected still takes effect within 30 s, without a daemon restart.

- macOS app: the T-Embed knob's History view now fills, on a cable and over WiFi. On USB the app's daemon passed the knob's query for one session's rows to a command handler that ignored it; on both transports the answer came back under the session's full id, which the knob, holding the 31-byte id its roster gave it, discarded. A board now gets back the id it asked with. Over WiFi the answer is now also shaped like every other frame a board receives, rows cut to the board's buffers and the frame to about 3.5 KB, where it used to send up to 16 full rows that could overrun the board's 4 KB buffer. The app now also writes its timeline file atomically, so a quit or crash in the middle of a write can no longer leave a cut-off file that starts the timeline empty.

- Node daemon: an experimental, opt-in observed-session relay shares worker sessions with a hub and routes supported session controls back over the worker's existing outbound connection. Unavailable workers expire, and controls remain restricted to the worker's own advertised sessions. Two-daemon loopback tests pass; two-computer, SSH-forwarded and Windows-worker acceptance remains separate.

- Node daemon voice and session control: cmux sessions receive prompts through their native surface route; target selection follows the intended session rather than whichever terminal happens to be focused. Existing terminal routes and session-ID targeting remain in place. A LaunchAgent-owned daemon needs cmux Automation mode (see [voice setup](docs/voice-setup.md)); the standalone macOS app does not run cmux.

- macOS app: click an attention notification to open its session, or use Shortcuts to list sessions waiting for a response and open one in the Dashboard. Opening a session leaves its prompt unanswered and keeps the hardware control target unchanged. An unavailable roster is reported as unavailable, rather than as an empty waiting list.

- macOS app: the optional experimental Collaboration view shows observed messages between sessions, with matching currents in the aquarium. Only explicit requests for a reply start a waiting timer; uncertain replies and missing peers remain unconfirmed. The view does not infer a dependency from sessions sharing a project.

- macOS app: recover the preferred connection after interrupted or exhausted retries, keep healthy WebSockets open beyond the former two-minute limit, and avoid treating a slow local daemon as an absent one. Connection and discovery logs omit pairing tokens. The separate Node timeline fix above prevents tool rows from displacing conversation history; the Swift daemon did not have that tool-row eviction problem.

- macOS app voice: dictated prompts addressed to an OpenClaw Gateway session now reach that session. Delivery diagnostics distinguish sent, queued and undeliverable prompts, including observed agents that have no prompt delivery path in the standalone app.

- macOS app: stopping or changing daemon settings during startup now invalidates the old startup before a replacement can take over. A late completion, readiness callback or retry cannot restore the old port or network posture, undo a newer stop, or remove the replacement daemon's registry record. Seven service and four production-helper regressions cover the correction. The signed 1.9.2 / 8901 export and full automatic checks passed; Mac Studio runtime acceptance remains partial.

- macOS build: split the communication graph's position calculations into explicitly typed intermediate values so the Xcode 26.3 release compiler can build the app. Node positions and layout rules are unchanged.

- Claude permission attention, Node daemon and macOS app: the PermissionRequest hook displays the request when Claude is about to ask, with Notification retained as a fallback. It preserves the identity of an already answerable request. A hook that disconnects releases an undecided hold so the agent can continue its normal prompt flow.

- Windows Claude hooks: approval, question and STOP responses now reach Claude instead of being discarded. Hooks also avoid a separate health probe before every event.

- Node setup: an unwritable global npm directory falls back to a user-owned installation, and installation errors retain their useful cause. Setup checks whether Claude actually runs, detects Ulanzi Studio, gives host-specific next steps and offers daemon installation during interactive setup.

- ESP32 provisioning, daemon side: Node and macOS recognize a board's credential ID and avoid sending unchanged Wi-Fi settings again when compatible firmware reports that ID. Older firmware retains the existing provisioning behavior; the matching firmware changes await their own release.

- Node APME: explicit reference-judge and agreement commands compare local evaluations with a Codex reference run. Review the dry-run selection and use a project filter before starting a reference run, which sends the selected task material to Codex. This is not an automatic background evaluation.

## 2026-10-14 — npm 1.9.2

- Keep a large official creature on iDotMatrix with one readable status/count line instead of four competing numeric rows. Working sessions, background jobs, child agents and CI waits remain distinct.
- Show human attention immediately, preserve a concurrent error cue, and return to current activity after brief conversation or arrival scenes. Rotate only real owners of the displayed category.
- Preserve missing background telemetry, clear explicit zero, and mark partly known totals as lower bounds. Node and native Swift share generated artwork and executable state/pixel parity tests.

## 2026-10-13 — ESP32 1.9.2

- Restore readable TC001 LED output by pinning the physically verified FastLED 3.7.0 driver. The floating dependency had selected 3.10.7, which produced an almost fully lit panel despite healthy data reception.
- Report matrix page, lit-pixel count and driver version in serial diagnostics so a running render loop is not mistaken for correct physical output. Other boards retain their existing display behavior.
- Make TC001 reset times stationary and readable: retain the quota label beside the countdown (`5H 2H48M`), remove the `R` prefix and percentage rail from time readings, and allow four seconds to read each countdown. The center button now freezes the inner reading phase as well as page rotation; fresh values and creature animation continue.

## 2026-10-13 — Android 1.10.1

- Keep dashboard history inspection local to each screen, separate from hardware control focus. Selecting or clearing a session no longer changes another dashboard's timeline.
- Include every declared member of a folded Codex session and normalize Swift/Node session IDs consistently. Reset the timeline scroll position when the selected session changes.
- Make native 3D creatures selectable by their visible bounds; keep empty-water viewing mode and expose a clear-filter action on LCD and e-ink dashboards.

## 2026-10-13 — Apple 1.9.1

- Pending macOS build revision, October 14: replace the four-row iDotMatrix summary with a permanent creature and readable live state/count, matching npm 1.9.2. The previously submitted iOS build is unchanged.

- Keep timeline rows inside their touch area so the clear-filter button responds reliably on iPhone.

- Preserve the local CLI daemon’s timeline when the Mac app takes over, and reconnect the dashboard as soon as its listener is ready instead of waiting for device discovery.

- Separate per-dashboard creature/history inspection from hardware control focus. Restore Codex ID/member matching, reset stale filter scroll positions and provide an explicit clear action.

- Setup, connection selection and QR pairing flows recover more clearly from
  offline or incomplete connection attempts.
- Swift APME startup preserves partially known costs and avoids repeating the
  legacy cost backfill on every database open.
- Device renderers complete background-work count presentation using shared
  generated rules. iDotMatrix shows waiting, working, background and live totals.
- Dot remains excluded from both App Store targets.

## 2026-10-13 — npm 1.9.1

- Preserve the Mac app’s recent timeline during CLI takeover; keep the app serving if its history cannot be read.

- Normalize Swift Codex hook IDs and observed Node IDs in both directions when serving session history.

- Complete background-work propagation to physical session keys, ESP32, Pixoo,
  Timebox and iDotMatrix without combining tasks with the child-agent census.
- iDotMatrix reports live background tasks beside waiting, working and live
  sessions. Unknown values stay unknown; explicit zero clears completed work.

## 2026-10-13 — ESP32 1.9.1

- Pin TC001 to the official ESP32 toolchain used by the prior release so a local pioarduino installation cannot silently change its compiler/framework.

- Complete bounded background-work movement on LCD panels and stable task counts
  and state on e-ink panels.
- TC001 alternates usage percentages with time remaining until reset, retaining
  the provider mark and usage rail. Window labels `5H` and `7D` no longer stand
  in for reset countdowns.

## 2026-10-13 — Stream Deck 1.8.1

- Complete session-key background-work indicators and retain counts across
  partial state updates without carrying them into another session.
- Preserve the development installation when validating Marketplace packages.

## 2026-10-13 — Ulanzi 1.8.1

- Complete session-key background-work indicators and refresh keys when the
  background state changes.
- Expire stale Dot companion state instead of retaining outdated display data.
- Existing keypad support is unchanged; Dial encoders are not supported.

## 2026-10-13 — Android 1.10.0

- Background work now reaches Android, ESP32, Pixoo, Timebox, iDotMatrix and
  physical session keys. LCD aquariums show bounded movement around the owning
  session; Android and firmware e-ink surfaces prioritize stable counts and state.
  Background tasks remain separate from the child-agent census.
- iDotMatrix replaces its recent-result tally with a live background-task count,
  beside waiting, working and live-session counts. Missing counts remain unknown;
  explicit zero clears running work. Approval and error scenes keep priority.
- TC001 usage pages alternate each window's percentage with time remaining until
  reset, keeping the provider mark and usage rail visible. Window lengths such as
  `5H` and `7D` no longer stand in for reset countdowns.
- Android 3D uses one frame scheduler with GPU-adaptive resolution and a thermal
  rendering budget, keeping dashboard text crisp while reducing animation stalls.
- Android preserves counts by session identity across partial updates and rejects
  malformed count fields without dropping the session roster. Reconnecting clears
  stale counts. Completion motion is bounded and honors reduced-motion settings.
- Apple keeps all Dot code excluded from Store builds. The device renderers share
  generated presentation rules with the terminal daemon and native displays.


## 2026-10-12 — npm 1.9.0, Android 1.9.0, ESP32 1.9.0

- Android adds skippable guided setup: choose a dashboard appearance, preview an
  empty habitat offline, connect a computer, and understand when live sessions
  are ready. LCD tablets and e-ink readers share the flow with panel-appropriate
  rendering. Existing installations retain their settings and can reopen the
  guide from Settings.
- Android keeps host selection and per-computer pairing credentials through
  reconnection. Pairing codes target the chosen computer; ambiguous discovery
  requires a choice. Completing setup does not replace a selected host with USB.
- The npm daemon tracks background work per session across agents, corrects hook
  attribution and managed-session identity, folds OpenCode child sessions and
  prevents duplicate timeline activity. OpenClaw steering targets the user's
  conversation instead of the last speaker. Hermes setup diagnostics explain
  missing or unreachable receivers.
- The npm daemon avoids full-table cost backfills on every start and preserves
  partially known costs across restarts. macOS display-state probes run
  asynchronously with deadlines, keeping slow host commands off the daemon
  event loop.
- The CLI dashboard uses the Tide console. Pixoo gains Tide rendering and paced
  scene uploads; Timebox gains expressive faces, and compact displays match
  activity to the correct session.
- T-Display-S3-Pro supports portrait and landscape orientation. Stale Hermes
  activity clears across firmware surfaces.
- Non-Apple surfaces retain the opt-in local Dot companion development paths.
  This release does not provide a managed public relay or claim a completed
  cloud service; App Store macOS/iOS builds continue to exclude Dot entirely.

- EPD47 and NM-EPD-420 e-ink panels refresh less and say when they last did.
  EPD47 updates drive only the pixels that changed, in the rows that changed,
  instead of erasing and redrawing every inked pixel; a clean panel no longer
  flashes just because ten minutes passed. NM no longer runs two 13-second
  cycles back to back, and neither panel repaints a frame identical to the one
  already shown. Both print an "as of HH:MM" stamp from the host clock
  (`display_state.hostHm`, sent by both daemons), and "since HH:MM" while
  offline.
- EPD47 and NM show a waiting decision without a key press first, and the NM
  decision page keeps all three options on screen (the last one, usually Deny,
  used to fall off). The EPD47 home lists every other session with its agent
  and state instead of repeating the primary one.
- ESP32 boards on USB serial keep their WiFi radio off again after the daemon
  re-sends credentials; the two e-ink panels had stayed on WiFi and USB at once.
  The e-ink panels also stay off WiFi at boot while USB serial is present.

## 2026-10-12 — Apple 1.9.0

- A skippable first-use flow lets Mac users choose their aquarium appearance,
  enable their chosen agent integrations with explicit file-access consent, and
  explore optional devices. iPhone/iPad adds appearance selection, bounded Mac
  discovery, approval and QR pairing, and offline preview/retry paths.
- Background work stays attached to its owning session. Small jar companions
  orbit agent creatures, with additional tasks shown as pearl moonlets. Counts
  and completion states follow the shared background-work tracker.
- Improve session identity, hook attribution and timeline deduplication, including
  managed sessions and reconnection. Multi-daemon host selection and pairing
  recovery no longer retain the wrong connection.
- Add the Tide scene to native Pixoo rendering, expand Timebox facial states and
  improve compact device activity/timeline rendering.
- About and integration handshakes use the installed app's actual version/build.
- App Store macOS/iOS artifacts exclude all Dot integration at compile time.
  Dot development continues through explicit preview configurations in the same
  repository; release CI checks the actual compiled artifacts and rejects previews.

## 2026-10-06 — npm 1.8.0, Apple 1.8.0, Android 1.8.0, ESP32 1.8.0, Stream Deck 1.8.0, Ulanzi 1.8.0

Coordinated 1.8.0 release. Store review and public availability are tracked
separately for each channel in the
[release status](https://github.com/puritysb/AgentDeck/blob/master/RELEASING.md#delivery-readback-2026-10-06).

- Stream Deck and D200H show each observed session's reported model, reasoning
  effort and permission mode separately, using the agent's own vocabulary.
  Activity cards show available task, subagent and context information without
  borrowing another session's state.
- OpenClaw MODEL and THINKING keys open a paged picker of values reported by the
  Gateway. Changes apply to the conversation whose settings were displayed;
  clearing an override returns to the reported default. Refusals and unavailable
  connections stay visible. Claude and Codex remain readout-only.
- Timeline on Apple and Android keeps ordinary tool activity beneath its
  originating request, alongside the final response. Tool details expand inside
  the turn; approvals, subagent events and activity without a known prompt stay
  separate. Busy concurrent sessions no longer split a request from its reply
  after 40 intervening groups, and Android updates no longer overwrite another
  known session or run within the same second ([#461](https://github.com/puritysb/AgentDeck/issues/461)).
- Android Timeline selects visible turns by their latest activity, so a new
  response remains visible even when its request is older. Selection and expanded
  details stay attached to the same turn after reordering.
- Android tablet HUD text uses natural line height instead of inheriting the
  larger body-text spacing, while preserving font size and accessibility scaling.
- Node and macOS exclude confirmed Codex subagents from fallback telemetry
  discovery and remove early phantom project rows without hiding normal sessions.
- Installed npm build identity includes resolved shared and hooks dependencies,
  including hoisted package layouts, so restart checks identify the actual code.
- OpenClaw folds the tool calls of one turn into one updating summary, with
  bounded command and result evidence. Failures take priority over successful
  calls in the detail budget, and omitted details are explicitly marked.
- Show observed Claude/Codex/OpenCode/Hermes CI watch requests separately from agent activity.
  Background waits survive the end of an agent turn; foreground tool completion,
  tool failure, re-invocation and session end clear the applicable wait explicitly.
  Hook evidence alone has unknown CI status. The Node daemon can query explicitly identified GitHub
  checks with bounded requests and recognize owned watcher-process exit.
  Session lists and deck keys include complete check counts when available.
  The original GitHub Octocat orbits the waiting agent in native 3D and Canvas
  aquariums; small matrix displays use its generated compact glyph. LCD/e-ink
  keep readable CI activity, with permission requests retaining priority.
  APME records CI relations and separates foreground blocking time from active
  turn time; background checks never subtract active time or alter `end_source`.
  Hermes exports bounded CI intent and hashed invocation identities without raw
  commands or tool arguments. Concurrent sessions retain independent CI timeline rows;
  Swift broadcasts accepted annotations immediately and retains model attribution
  on runs, turns and tasks.
- Keep canceled 3D asset loads retryable instead of leaving a permanent error
  after initial dashboard updates. Explicit development data-directory overrides
  no longer import the user's existing daemon registry or credentials. Keep macOS
  Timeline details upright over the 3D scene with an explicit Copy action, and
  scale Android CI captions to device density above the Timeline. E-ink paper
  dashboards show CI waits even for idle rows and refresh when CI evidence changes.
- Preserve the original creature features across 2D, native 3D and device glyphs:
  Claude has black eyes, OpenClaw has black eyes with its original bright teal highlights, Codex
  has an opaque white `> _`, and OpenCode retains its central opening. Monochrome
  screens preserve the source contours with contrasting ink and paper.
- ESP32 TTGO pins its validated library versions and gains a real-target Linux
  compile check, preventing fresh dependency resolution from overflowing static
  DRAM during release ([#468](https://github.com/puritysb/AgentDeck/pull/468)).
- Keep the aquarium snail on its authored rock-foraging path and preserve its
  feeler animation, instead of moving it around an unrelated screen-wide circuit.
- Keep daemon start/stop/restart service control within the configured data
  directory, so an isolated QA daemon cannot unload the user’s global service.
  Refuse foreign-owned targets before touching their supervisor.
- Verify clean npm tarball installation, native bindings, installed hooks,
  concurrent sessions, device reconnects and restart persistence with the new
  packaged acceptance command. Setup tarballs no longer include compiled tests.
- Recover rejected z.ai credentials through Integrations, including when the
  Mac app follows the local Node daemon. Distinguish invalid credentials from
  transport failure and verified usage from successful key storage (#459).
- Keep Swift-to-Node daemon handover within a shared yield budget, reject a
  Swift process as successful Node startup, and align Kiro turn-state policy
  across both daemons (#451).
- Windows Codex hooks report the actual launcher PID through bounded native
  ancestry lookup; unrelated or unreadable evidence does not invent identity
  (#452).
- Clarify the Hermes-capable receiver requirement and expand live lifecycle,
  delegated-child and Windows Ulanzi transport regression evidence (#453–#455).

## 2026-10-04 — npm 1.7.0, Android 1.7.0, ESP32 1.7.0, Stream Deck 1.7.0, Ulanzi 1.7.0

- ESP32 WiFi OTA reaches boards the daemon is driving over USB. Those boards
  turn their WiFi radio off while serial is active, so `agentdeck esp32-ota`
  used to fail with "No online WiFi ESP32 target". The daemon now closes that
  one board's serial port, waits for it to join WiFi, updates it, and reopens
  the port.
- OpenClaw: all the tool calls of one turn fold into a single timeline row
  (`openclaw ×16 · channels, agents.main, … · 1 failed`) that updates in
  place, with the full list in its detail. A config walk no longer buries the
  question and the reply.
- Hermes Agent appears on every surface: the macOS/iOS and Android aquariums
  (the Nous girl mermaid; Android gets a lightweight 3D resident), the Stream
  Deck and D200H keys, the TUI session list, Pixoo, Timebox, iDotMatrix, the
  LED matrix, the ESP32 LCD terrariums, HUDs and cards, and the e-ink screens.
  Small surfaces draw the official Nous girl mark, generated from
  `design/brand/hermes.svg`. The macOS app's own daemon now ingests Hermes
  observer hooks too. An observed Hermes row is never chosen as the ESP32
  voice target: it is read-only.
- Hermes swims as a mermaid in every terrarium without the 3D aquarium
  (Android 2D and e-ink terrariums, ESP32 boards, Pixoo 64): the official Nous
  girl head over a kelp tail, instead of a floating head. Keys, lists and
  cards keep the plain mark.
- Like OpenClaw, a running Hermes CLI stays on screen while its process
  lives, and Hermes sorts first with OpenClaw in every session list.
- A Hermes conversation now closes when its Hermes process exits, so
  `hermes -z` one-shot runs no longer linger as idle sessions for 30 minutes.

- Codex: once a plan window (5h or weekly) is exhausted and the account still
  holds purchased credits, every usage surface shows the remaining balance
  (`62.5K CREDITS LEFT`) in place of the exhausted window, with the time the plan
  window resets. A zero balance shows nothing. Where a surface has room, the
  Luna reserve stays beside it; a single-reading surface shows credits first.
- Stream Deck / D200H: the Luna tile's `100% LEFT` no longer clips its final
  letter; `LEFT` is set smaller than the number.
- Stream Deck / D200H: when the usage row is crowded, z.ai's 5H and MCP windows
  share one key. Each press switches it between both readings, 5H only and MCP
  only, the same way the Claude weekly key switches with its per-model cap. A
  row with room still gives each window its own key.

- Stream Deck remembers an explicitly selected usage provider across temporary
  missing data and reconnects, including Claude Extra and Codex Credits.
- Ulanzi connects to a healthy WSL2 daemon on loopback port 9120 even without a
  Windows daemon registry. Registry ports are checked through bounded health
  requests instead of treating a Linux PID as a Windows process. Custom ports
  still use daemon.json; unrelated port scanning is not enabled.
- Codex POSIX lifecycle hooks send their actual launching PID. Hermes cancelled
  turns retain their interruption label, Gateway tools retain conversation
  context, and expired Gateway sessions close their pending evaluation run.

## 2026-10-03 — Apple 1.7.0

- Add Hermes mermaid rendering to Apple aquariums and device previews. Hermes
  sessions are read-only; App Store installations receive them through an
  already configured relay, without an in-app installer or subprocess.
- Improve Codex hook/OTel ownership and background-thread filtering, fold
  attributable headless work into its parent, and preserve user-owned TOML
  when configuring observation. POSIX lifecycle hooks now report the launching
  Codex process ID so child work can be attributed without an argv guess.
- Recover OpenCode pending requests across directories and reconnects, and
  improve Kiro transcript observation.
- Show purchased Codex credits when a plan window is exhausted. Consolidate
  each OpenClaw run's tool activity into one timeline row.
- Wake USB-connected ESP32 displays for Wi-Fi OTA and improve matrix displays.
- Reject malformed Hermes process IDs instead of probing a truncated or
  wrapped process number.

## 2026-09-28 — npm 1.6.0 · Apple 1.6.0 · ESP32 1.6.0 · Stream Deck 1.6.0 · Ulanzi 1.6.0

- E-ink firmware (TRMNL 7.5", NM-EPD-420, EPD47) follows the Paper Board: only sessions that need you or are working get a card, idle sessions share one line of glyph + name, the masthead counts sessions by state, and filler copy is gone. A line break in an agent's answer no longer overprints Korean text. TRMNL no longer replaces the board with an ANSWER page after every finished turn; KEY1 cycles board → aquarium → digest.
- NM-EPD-420 lists sessions by priority with the waiting question or live activity, and plays a short two-note chime through its speaker when a session starts waiting for you. EPD47's home shows usage with reset times, and state counts in its header.
- Timebox Mini gains an animated agent face; iDotMatrix shows waiting / working / result / live counts. Both stage a conversation: your message puts that agent on screen listening (ASK) until it replies, and the reply stays for 45 seconds (REPLY). Automated turns stay brief. The iDotMatrix CLI client no longer paints OFFLINE after a single missed frame request — only after 15 seconds without the daemon.
- Dashboards receive the same connect-time history from the Node and Swift daemons (the latest 100 readable rows); ESP32 boards receive several trimmed rows instead of one, and older boards are recognised from their first connect.
- Dashboards and devices share one session-state palette (green healthy, cyan working, amber needs you, red failure, grey quiet); aquarium name tags yield instead of covering creatures.
- Stream Deck and Ulanzi decks share the weekly usage keys; Stream Deck+ subscription dials are independent.
- IPS10: a local OpenClaw wake word and a separate, persistent personal voice conversation; warm local Whisper transcription with CLI fallback, speech-onset and endpoint handling, voice-activity gating against noise hallucinations, and bounded upload/reply transfers. Its dashboard becomes an English aquarium with conditional quota rings, a readable project deck and a task inspection workspace. SDIO transmit is protected from unaligned buffers.
- Sessions in a linked git worktree are labelled `Repository · worktree`; compact devices get shorter task labels; OpenClaw's personal activity appears from dispatch.
- CLI: launch an observed agent without a managed PTY; privacy-limited daemon connection diagnostics. The Stream Deck plugin keeps reachable daemons and counts pong replies as activity.
- E-ink refresh diagnostics count completed refreshes and full cycles and no longer interleave with protocol output; voice-stage diagnostics no longer report false I2C panics. Boards label z.ai windows by their length over serial too.

- Subscription quota colors: use one consumed-capacity scale on every dashboard (green below 70%, amber at 70–89%, red from 90%). Remaining values use the same severity; TTGO gets higher-contrast percentage text and TC001 restores colored numbers/rails. Timebox keeps quota pressure separate from its agent-status beacon.

- Apple and Android: show OpenClaw setup guidance only for explicit pairing or authentication failures. Reachability, reconnecting and unknown status no longer imply missing approval; connection timeouts no longer recommend replacing the token. Android now receives Gateway authentication status and displays actionable guidance.

- Apple and Android 3D dashboards: emphasize working agents with high-contrast WORKING badges, visible activity bars and stronger motion across all six creature types. Keep activity cues visible in viewing mode, respect reduced motion, and separate selection from the creature silhouette. Repair Claude Code's arm geometry, including leftover bevel fragments and overlapping cut surfaces that appeared broken during movement. Native activity tuning is generated from a shared definition.

- Stream Deck Classic/XL: use the full bottom row for subscription usage. Claude 5H/7D, one Codex window and two z.ai windows fit together on Classic without MORE; page only when the physical row overflows.
- Stream Deck+: select Claude, Codex or z.ai on either usage LCD. Explicit selections adjust the other dial to avoid duplication and survive plugin restart; hold E2 to resume automatic selection.
- Pixoo64 (Node and Swift daemons): display all three usage providers together, reserve room above their rows, and retain Claude when only its seven-day window is reported.
- TC001: retain work status while cycling provider usage with official marks, actual window-length labels and MCP quantity labels; omit stale Claude usage and clear retired z.ai readings on disconnect.

- CLI daemon startup allows up to 90 seconds on macOS for a silent preferred-port conflict (20 seconds elsewhere), retrying the actual listener and rechecking peers before fallback. This mitigates delayed app-to-CLI handoff without moving already connected fallback clients; hardware validation remains tracked in #370.

- ESP32: compact horizontal usage gauges on 86 Box, IPS 3.5 and round AMOLED; visible GLM usage on IPS 10 and NM-EPD-420; proportional card fills on TTGO; five-window layouts without clipping or array overflow on T-Display Pro.

## 2026-09-28 — Android 1.6.1

- Fix in-app updates on Android 10 (e.g. Crema): the downloaded update was refused as "signing certificate does not match" even when it was signed by the same key, because Android 9–10 report no signer for a downloaded package unless asked for its legacy signatures too. Devices on Android 11 and later were unaffected. A device still on 1.6.0 or earlier needs this update installed once by USB or Play; later updates work in the app.

## 2026-09-28 — Android 1.6.0

- E-ink readers (Crema, Pantone) get the Paper Board: sessions ranked by what they ask of you (needs you → working, each with its live activity → one line of idle sessions), usage grouped by provider with the plan beside it (`Codex  Pro · until Oct 10`) and aligned rows of window · bar · used · time left, and finished agent work — judged task summaries and answered turns, each listed once. Automated turns, abandoned tasks and prompts still waiting for an answer are not listed.
- The terrarium stays as its own zone, never under text: grey gradients on 16-level panels, colour on Kaleido, animating only while a creature is active; it yields about two fifths of its height when there is finished work to show. Colour e-ink adds session hues, usage severity colours and brand-colour marks. Each text zone refreshes on its own (sessions fast, usage and finished work slow).
- Dashboards and aquariums share one session-state palette (green healthy, cyan working, amber needs you, red failure, grey quiet) and one quota severity scale (green below 70%, amber 70–89%, red from 90%). Aquarium name tags yield instead of covering creatures behind them.
- 3D aquarium: working agents are easier to spot (WORKING badges, activity bars, stronger motion); Claude Code's arm geometry is repaired.
- OpenClaw setup guidance appears only for explicit pairing or authentication failures, and the dashboard now receives Gateway authentication status.
- Under the App Store (Swift) daemon, the Codex plan line reads the same as under the CLI daemon. Paired with the daemon's connect-history change, a tablet shows the same history whichever daemon it is attached to.
- Existing dashboard choices and the direct-install wireless update path are unchanged; Play installations continue to update through Play.

## 2026-09-23 — npm 1.4.2

- Fix observed Claude sessions remaining idle during hook-driven work (#367): merge lifecycle state and sanitized current tool into the matching session while preserving passive metadata.
- Track parallel tool calls separately, suppress ended sessions until SessionStart, and deliver the final roster update after rapid changes. Feed and WebSocket clients share the same snapshot.
- Publish hooks, shared, bridge and setup together. No wire-format, device firmware or deck-plugin update is required. Windows live-session validation remains pending reporter confirmation.

## 2026-09-23 — npm 1.4.1

- Recover Claude usage authorization more promptly: retry the first recovery after one minute, retain bounded backoff, and record the outcome of each attempt.
- Honor the configured `AGENTDECK_CLAUDE_CLI` executable during recovery, resolve relative paths, and reject unsupported Windows shell shims safely.
- Show fresh GLM credit-quota usage on compact iDotMatrix displays connected to the Node daemon; stale readings remain hidden.
- Publish hooks, shared, bridge and setup together at 1.4.1. Existing 1.x apps and device firmware remain compatible; no ESP32 firmware or deck-plugin update is included.

## 2026-09-23 — Android 1.5.0

- The optional 3D aquarium now uses the approved original agent models, including closed backs and animated limbs, instead of showing only a decorative habitat. Working sessions disturb nearby fish; the small snail travels behind the planted islands.
- Keep the foreground readable with up to eight residents, prioritizing the selected session and requests for input. The complete session list remains accessible; unrelated sessions are not merged merely because their project names match.
- Reduce tablet GPU load with bounded render resolution and shadow quality, keeping labels at display resolution and adapting animation cadence to thermal and power conditions.
- Refresh the planted habitat and solid fish fins. Reserve space for the timeline, hide it during aquarium viewing, and retain the standard dashboard if native model loading fails.
- Existing dashboard choices and the e-ink rendering/refresh path are preserved. Includes the previously prepared GLM display and wireless APK update improvements; Play installations continue to update through Play.

## 2026-09-23 — Apple 1.5.0

- macOS/iOS: choose the familiar dashboard or an optional 3D aquarium from Dashboard settings; preserve the selected layout across launches.
- Show live agent sessions as their original characters in a planted 3D habitat, with clearer working and attention states and readable information panels.
- Add reactive schooling fish with solid hinged fins and a smaller ground-roaming snail that passes behind rocks and plants.
- Preserve session selection, accessibility through the session roster, Reduce Motion and inactive-scene pausing, with a standard-dashboard fallback when 3D content cannot load.
- Improve fresh GLM credit-quota display on connected iDotMatrix devices.
- Make Collaboration easier to enter and navigate: surface confirmed related sessions with their current state and input requests first, while keeping task history separate from live activity. Revisit the latest eight tasks, retain a historical selection during refresh, and inspect task summaries with compact live-activity details.
- Bound the native foreground to eight residents, preserve the full session roster, and reserve scene space for attention and timeline panels on macOS and iOS.

## 2026-09-21 — Android 1.4.1

- E-ink usage rows explicitly identify GLM and include it in the provider summary.
- Direct-install APKs offer wireless update checks, verified downloads and Android's installation confirmation in tablet and e-ink settings. Google Play builds continue to update through Play.
- Update downloads verify the release checksum, package identity, newer version code and installed signing certificate before opening the installer.


## 2026-09-21 — npm 1.4.0 · Stream Deck 1.4.0 · Android 1.4.0 · ESP32 1.4.0 · Ulanzi 1.4.0

- Add optional z.ai Coding Plan usage across the Node daemon, Stream Deck keys and dials, Ulanzi keys, Android dashboards and ESP32 displays, including reset countdowns and MCP tool-call usage where space permits.
- Keep z.ai readings tied to the configured account; retire removed credentials and expired readings, and preserve consistent quota and subscription rows across session relays.
- Improve Stream Deck connection recovery by bounding initial handshakes, quarantining failed endpoints, retiring pending sockets before retry and cancelling retries on explicit disconnect.
- Improve compact three-provider layouts and provider selection while preserving existing action identifiers and profiles.
- Include Node daemon session ordering, asynchronous device probes and serial handover/flash preflight improvements accumulated since npm 1.3.5.
- npm: retire stale Codex Luna reserve status when fresh account limits recover after a reset.
- npm: reset accepted HTTP/SSE/WebSocket sockets before daemon teardown and wait for launchd job removal before restarting, improving Mac app/CLI handover and supervised restarts. Normal TCP expiry and the app’s existing retry cooldown can still delay canonical-port recovery.
- Apple 1.4.0 remains a separate submission. Ulanzi 1.4.0 replaces the pending review version; marketplace approval and public availability are tracked separately from these artifacts.

## 2026-09-21 — Apple 1.4.0

- Adds optional z.ai GLM Coding Plan usage on Mac and paired iPhone/iPad.
  Plan credit usage and MCP tool-call usage are labeled separately; macOS
  stores the optional key in Keychain. Replacing or removing a key retires
  the old account's readings without restarting the dashboard service.
- Makes macOS Codex observation setup recoverable: configuration conflicts
  and file-access failures now explain what happened, with retry and file
  reselection. An existing `[features]` section with `hooks = true` can
  coexist with observation. Unreadable files are never treated as empty;
  existing disabled hooks remain unchanged and require explicit correction.
- Refreshes Codex account quota independently of new rollout activity,
  including USB updates when Claude quota is absent.
- Preserves daemon-persisted observed-session ordering across the Swift and
  Node paths, including references expressed in either observed-session ID form.
- Improves live device previews with z.ai readings, MCP labels, provider marks,
  Claude scoped limits, and compact layouts that keep all three providers
  visible. Round-screen usage groups stay inside the screen boundary.
- Improves local device coordination with lowest-port serial ownership and
  flash-lease handling in the built-in macOS service.

The Codex support report led to reproducible setup and recovery fixes, but the
reporter's specific cause has not been confirmed. Account usage being connected
does not imply observation hooks are installed. This Apple release does not
publish a new daemon package, deck plugin, or firmware; those channels remain
independent. Cross-daemon z.ai sibling relay remains a follow-up.

## 2026-09-15 — npm 1.3.5

- Windows autostart launches the daemon without a persistent console window;
  Codex probe cleanup and ADB reverse polling also hide their child windows
  (#336, fixes #339). Thanks to @dudziakl for the fix and Windows reboot testing.
- Missing daemon registration preserves unknown supervision instead of stopping
  an answering daemon. The launcher waits for OS process creation before reporting
  success, and reports creation failures to Task Scheduler for retry.
- Protected Node health responses expose bounded broadcast-attempt counters for
  e-ink interval research (#338). These are server-wide attempts, not per-panel
  delivery or repaint counts; actual field measurement remains in #272.
- Windows Node 22/24/26 CI covers launcher and supervision regressions. The UTF-8
  hook test retains Korean path/payload assertions with a cold-start budget and
  detailed process-failure diagnostics.

Upgrade with `npx @agentdeck/setup@1.3.5 --yes` so the installed CLI re-registers
Windows autostart. Task Scheduler retries launcher failures; a later detached
Windows daemon crash requires a manual start or the next logon. No companion app,
deck plugin, or firmware update is required. High-load ownership issue #327
remains open.

## 2026-09-15 — npm 1.3.4

- Windows hooks run PowerShell from a managed script file, preserving stdin and
  literal variables when Claude launches hooks through Git Bash. Standalone Kiro
  installation creates the same dependency; migration repairs missing or changed
  scripts without rewriting already-current user settings (#329, fixes #331).
- Failed or slow process scans preserve the observed session roster and back off
  from scan completion. New tool activity recovers disconnected sessions and
  refreshes processing timeouts without dismissing hub permission prompts
  (#330, fixes #332).
- Windows source-checkout instructions invoke the built CLI directly and explain
  the difference between daemon autostart and a globally available command (#304).
- Thanks to @dudziakl and @jurri for the original fixes and documentation.

Upgrade with `npx @agentdeck/setup@1.3.4 --yes` to update the daemon and hooks.
No companion app, deck plugin, or ESP32 firmware upgrade is required for these
fixes. High-load daemon/serial ownership issue #327 remains open.

## 2026-09-13 — Apple 1.3.2

Bounds Claude and Codex hook port-file discovery to 200 ms per read. A protected
macOS app-container file can wait indefinitely for an OS access decision; hook
startup now continues to the existing healthy-port/fallback path instead of
blocking a real agent turn. Includes the provider-layout and approval-recovery
improvements from Apple 1.3.1.

## 2026-09-13 — ESP32 1.3.0, Apple 1.3.1, Android 1.3.1, npm 1.3.3

### Small displays have distinct everyday roles

- **TTGO T-Display:** starts as a usage meter. The left button (GPIO0) toggles
  Usage and Terrarium; GPIO35 rotates the current mode. Missing quota windows
  stay absent instead of appearing as empty gauges.
- **T-Embed CC1101:** opens an arrival-ordered waiting queue with the actual
  project and question. Turn to choose a request, press to open, then deliberately
  select an action. All sessions, history, and voice remain available.
- **T-Display-S3-Pro, landscape:** pin a project by ID, retain its last result
  until tapped, and browse every waiting request through a persistent count and
  paginated list. New activity does not steal the current page or result.
  The camera model keeps its portrait Pocket interface.
- Both interactive boards reject stale or disconnected replies and distinguish
  a sent command from an observed state update. Changed requests clear the
  selection; unconfirmed sends time out visibly.

### Hook discovery cannot block an agent indefinitely (npm)

Claude and Codex hook port-file reads have a 200 ms deadline, including protected
macOS container files. Existing Claude commands migrate automatically; all
co-owned installers emit the same bounded lookup. OpenCode uses bounded async
reads with at most one pending read per registry path, so an OS access prompt
cannot stall its event loop or accumulate filesystem workers.

### Provider usage follows the available data

Node and Swift retire stale Claude quota/subscription displays when no current
provider data supports them. Apple, Android, and ESP32 layouts adapt to the
available providers and windows. Compact subscription plan/date details live in
provider rows; upstream provider choices persist rather than changing underneath
an active dashboard.

### E-ink and diagnostics

ESP32 e-ink layouts retain session rows when recent work expands. ESP32 device
readback includes the Codex window percentages actually held by the board, making
missing-window diagnosis possible across serial and WiFi. Preview fixtures
preserve absent usage windows too.

### Apple approval queue recovery

The Swift daemon now preserves a surviving exec/plugin approval after another
approval resolves or expires, so a still-blocked request remains actionable.
The Node equivalent already shipped in npm 1.3.2.

Stream Deck and Ulanzi remain at 1.3.0: their only shared-source delta is optional
ESP32 diagnostic type metadata, with no plugin runtime behavior change.

## 2026-09-13 — npm 1.3.2

Three fixes from an adversarial review of the 1.3.0 delta, merged minutes after
1.3.1 was tagged and therefore not in it. Nothing else moves: Apple, Android,
Stream Deck, Ulanzi and ESP32 stay at their current versions.

### The daemon supervisor's probes could answer "dead" without having looked

`supervisorJobRunning`'s own contract is that `undefined` means "the supervisor
did not answer", which is not "it died" — the caller keeps waiting, bounded by
its ceiling. All three probes had a way to break it. `schtasks` localizes its
status **values**, not only its headers, so `/^Status:\s+Running/` failed to
match a running job on a non-English Windows and answered false: that made
`convergeInstalledSupervision` stop a healthy supervised daemon to "hand it
over", and collapsed `waitForRestartedDaemon`'s 180 s ceiling to its 20 s floor
for a false "daemon did not come back". The launchd `catch` returned false for
any `execFileSync` failure, a 5 s timeout under restart load included; only a
command that ran and exited non-zero carries a numeric `status`. systemd read
anything but `active` as dead, `activating` — restart backoff, seconds before
the daemon returns — included.

`supervisorPosture` answered `[]` when it could not read the unit, which reads
as "the unit bakes the default posture". A Windows scheduled task has no unit
file at all (the XML is deleted after `schtasks /Create`), so every `daemon
restart` on a `--local` machine compared its inherited `--local` against a
fabricated default, printed a claim about the task that was not true, and forked
an unsupervised daemon. It now answers `undefined`, which `routeDaemonLifecycle`
already treats as "no comparison to make".

### Closing one OpenClaw approval stopped showing the other

An exec approval and a plugin approval can be pending at once, and the deck
shows one at a time. Every close path emitted `spinner_start`/`idle`
unconditionally, and the daemon maps those straight onto the Gateway row's
state, so the row left `awaiting_permission` while a live approval was still
waiting: no surface rendered PERM, the user saw an idle deck, and the agent
stayed blocked. The survivor is now re-broadcast instead, which restores the
state and swaps the rendered question in one step. Two more in the same area: a
second plugin approval silently discarded the first, leaving it pending on the
Gateway with its timeline row stuck; and a failing `exec.approval.list` skipped
the plugin catch-up entirely because the two shared one `await` chain.

The Swift daemon had the same bug and also dropped the survivor from the row.
That fix is on `master` and ships with the next Apple build.

## 2026-09-12 — npm 1.3.1

### The OpenClaw health check answered wrong in both directions, and ran far too often

`checkGatewayHealth` is the only input that turns the OpenClaw row red from the
Node daemon, and it returned a bare boolean tilted both ways at once. `ENOENT`
— no `openclaw` on `PATH` — resolved **false**, so a surface whose process never
inherited the CLI's directory reported a Gateway it had not once contacted as
healthy. A timeout resolved **true**, so a doctor run that was merely slow was
reported as a failing Gateway. Both are "I could not look", and both now return
`known: false`, leaving the caller on its previous value exactly as
`resolveGatewayHealth` already did for the health-frame path. Only a run that
completed sets `hasError`, from its exit code, and the transition is logged so a
row that goes red leaves a trace.

The cadence was the other half of it. Measured against a live Gateway on
2026-09-12, `openclaw doctor` takes 8-9 s; on a 30 s interval that left the CLI
running about 30% of the time, and every run opened its own Gateway connection.
Over four days that one check accounted for 9,958 `channels.status` calls on
9,958 distinct connections — **99.5% of all Gateway RPC traffic** — at a mean of
441 ms and p99 740 ms, against 50-200 ms for calls that share a socket. The
default cadence is now 300 s, matching OpenClaw's own health monitor, and the
timeout moves from 15 s to 30 s so the measured 8-9 s command has real headroom.

## 2026-09-12 — ESP32 1.2.3

The TRMNL 7.5-inch firmware now reports its canonical `trmnl_75` board identity,
and release assets use that name. The daemons retain the legacy `inkdeck` alias
for existing firmware. Display behavior and protocol compatibility are unchanged.

## 2026-09-12 — npm 1.3.0, Apple 1.3.0, Android 1.3.0, Stream Deck 1.3.0, Ulanzi 1.3.0

### The daemon handover stops wedging the macOS app

Whenever the CLI daemon evicted the in-process Swift daemon, the macOS app could
be left with neither a daemon nor a client — permanently. Reproduced on
2026-09-07, 09-09 and 09-10, and caught in the wedged state the last time, so
this is a line and not a theory: `connectToExternalDaemon` had one failure exit
with no rescheduled `start()` while every other exit had one, and that same exit
set `port = 0`, which neutered the health check's own guard. The code that gives
up and the code that clears state shared a failure mode. The port is now
resolved known › registry › canonical port (zero is not an answer on any input),
the dead-end branch schedules a retry anyway because it is the branch that wedged
the app for 23 hours, and the four Node sites that evict a Swift daemon go
through one path that prefers `/stand-down` over `/shutdown` — a stand-down names
the port the app must become a client of. A handover stop names it too; a plain
`daemon stop` deliberately keeps `/shutdown`, because there "become a client" is
a lie and the app would re-promote after its yield window.

The app could also hold a listener it had no business holding: it sat in client
mode with three connections to the hub while owning `*:9121` and answering
nothing on it. A patient health probe had suspended while `start()` completed a
bind, and on waking it dropped a server it had not created by assigning `nil` —
but a started `NWListener` is retained until it is cancelled and holds the server
weakly, so the orphan outlived its owner, kept a session-bridge port for the life
of the process, and sent every connection it accepted to a nil receiver.
Ownership transitions are now epoch-guarded at all four exits.

### `agentdeck daemon restart` reports what actually came up

On any machine with daemon autostart installed, the supervisor's respawn
routinely wins the port back before the restart command's own child does. The
command was checking for the process id it had forked, so it printed a failure
over a daemon that was serving correctly — and the natural retry then stopped a
healthy daemon. It now verifies the daemon that answered: that one is running,
that it is not the one just stopped, and that it is serving the build on disk.

### Every surface could be told the wrong agent was working

The hub's global `state_update` was labelled `openclaw` whenever the Gateway
adapter was alive, while the global state machine underneath it is moved by every
observed Claude hook. With the Gateway idle, surfaces showed "OpenClaw ·
processing · Bash `cd …`" carrying a Claude session's command, and it healed
itself whenever the other sessions went quiet — which is what made it read as
intermittent. The frame is now stamped by whoever moved it: a hook session
produces an aggregate `daemon` frame with that session's id and project, the
Gateway produces an `openclaw` frame with its own state, model and tool, and
nobody-yet keeps `openclaw` while the link is alive. Consumers that gated the
OpenClaw model catalog on the old label accept both.

### Collaboration: readable history and reliable relation identity

The Dashboard's Collaboration panel keeps refresh status and retry above the
history, distinguishes missing records from failed or unsupported reads, and
lets you open a confirmed peer session and return. Ended observations fold away;
every capped list can expand. Relation rows show what was last observed rather
than presenting historical starts as current activity.

Both daemons now preserve relation identity, so two background jobs with the
same name remain separate when one ends. Unlinked launch requests are kept in a
separate section instead of vanishing when an unrelated child is resolved.
Older records without identity stay separate observations.

### The daemon's own health signals stop lying quietly

An OpenClaw Gateway health frame that carried no readable verdict was counted as
a failing one, so the crayfish went sick and the topology light went red for up
to five minutes at a time — the gap between health checks — with nothing on any
surface saying why. An unreadable frame is now no answer at all: the previous
verdict is kept, and every real transition is logged, on both daemons. A Gateway
that keeps restarting also says so now, naming the reason from OpenClaw's own
log rather than reporting eleven healthy reconnections.

Two long-running reapers that could never finish were closed off in the same
pass, and `agentdeck apme judge-health` reports whether the work that closed
actually received a verdict, rather than leaving that to be inferred from an
empty scorecard.

### A wake is a clock jump, not a late timer

Under load the five-second wake tick landed more than fifteen seconds late
routinely, and the detector read every such gap as a system wake: 123 firings on
2026-09-10 against zero sleep events in `pmset`'s log, one every one to four
minutes at the peak. Each firing ran the full device-recovery storm — mDNS
republish, pairing re-arm on every board, BLE workers restarted, usage refetch —
which starved the next tick, so the detector fed itself, and left `/health`
unanswered long enough for the macOS app to promote to a fallback port and stand
down three times in five minutes. Across a real suspend the wall clock jumps
while the monotonic clock does not; under load both advance together, and that
difference is now what a wake is read from. Windows' monotonic clock counts
through sleep, so there the gap rule stays, documented as the weaker instrument.

### The Work board no longer stalls the daemon for two minutes

An index added for the prune command became the best index SQLite could see for
the Work board's per-task tool count, so the planner walked every `kind='tool'`
row once per task — roughly 200 million row visits over multi-kilobyte payloads,
137,802 ms for one page on a live store, on a page the macOS app polls every
fifteen seconds. The database driver is synchronous on the daemon's main thread,
so for that whole time there was no event loop: `/health` went unanswered, the
macOS app promoted and stood down three times in five minutes, and the OpenClaw
link dropped on a ping timeout. A covering index brings the same page to 257 ms.
The regression test pins the query plan rather than a timing, because a timing
test passes on a small fixture whatever the plan.

Worth noting how it reached a daemon that had not changed: the index arrived
through the shared database file, from a CLI dry-run that ran the schema.

The npm release soak also found full-table scans in the 30-second evaluation
tick's closed-run and pending-turn queues. Two additional indexes keep queue
selection and ordering away from historical prompt/response payloads. Query-plan
tests cover the actual store methods and preserve their filtering and ordering.

### `agentdeck apme prune` reclaims evaluation-store disk space

Step and tool payloads were measured at 71% of a 2.33 GB `apme.sqlite` on one
desk, with no retention path and no way to reclaim the bytes.
`agentdeck apme prune [--older-than 30] [--apply] [--vacuum]` replaces payloads
older than the cutoff with a small marker instead of deleting rows, so every
reader keeps working. Runs, tasks, turns and evaluations are kept forever, rows
whose age is unknown are never candidates, and only tool events are pruned — the
other kinds hold small, load-bearing text. It is a dry run by default; `--apply`
runs in one transaction; `--vacuum` reclaims disk only when there is room to do
it safely. Nothing prunes in the background.

### Evaluation: the same settings file now produces the same verdict

Either daemon may hold the port, and both read one `settings.json`, so a
difference between them means the same configuration scores differently
depending on which one answered — with nothing in either log saying so. The
macOS daemon now resolves the local judge server's address from the same
`llm.mlx` setting the Node daemon uses (it previously read that setting for the
model but posted to loopback regardless, then dropped silently to the weaker
on-device judge), waits the same 90 seconds for a verdict, accepts the same
range of HTTP success codes, and records a fallback to the on-device judge in
its normal log instead of behind a debug flag — the last one is what made that
fallback's rate unmeasurable on that daemon at all.

The local judge also stops writing off a server capability on ambiguous
evidence: when a request succeeded after both a field was dropped **and** the
prompt was shortened, neither is now blamed, because the shortened prompt
explains the success by itself. The judge ladder retries per request and keeps
no memory of what an endpoint refused last time.

The task classifier runs one preference order on both daemons — `mlx`, then
Apple's on-device models, then the deterministic rules — and never reaches for a
paid backend. That order is deliberately not presented as a ranking: the
measurement that suggested otherwise ran 40 tasks against a server that had a
27B model loaded under a 15-second budget, which measures that afternoon's load
rather than the backends, so the order chosen is the one that changes the fewest
existing results while letting a Mac with no MLX server still get an LLM answer.

### The local judge scores only a model that is actually resident

A measurement script hot-swapped the operational model and drove GPU peak to
78.55 GB while `/health` still answered healthy. Residency, server availability
and the installed catalog are now three separate facts on the wire rather than
one blurred one, a per-endpoint admission gate holds a GPU failure in cooldown
instead of retrying into it, unknown stays explicitly unknown, and a legacy
`VRAM=0` never reads as "not loaded". The policy is shared between the two
daemons behind a byte-for-byte generator gate, with the same vectors replayed by
both test suites.

### OpenClaw runs are only opened when there is something to record

Over one measured week, 87 of 113 OpenClaw evaluation runs held nothing at all
and were closed half an hour later by the abandoned-run reaper. An assistant
message always produces telemetry to hand over, so "is there anything to
ingest?" was answered yes and the run was opened — and then everything in it was
discarded for want of an open turn. A run is now opened by the first event that
can actually be recorded, which also covers the connection-wide run that was
being opened at connect and usually stayed empty.

### OpenClaw: plugin approvals reach the deck, and the model catalog survives a busy restart

AgentDeck answered `exec.approval.*` — the Gateway blocking a tool-execution
call — but never rendered `plugin.approval.*`, the parallel surface a plugin or a
trusted agent runtime uses to ask a human something that is not a shell command.
A pending plugin approval sat on the Gateway with no PERM on any surface. Both
daemons now render it alongside exec approvals, from the installed OpenClaw
package's own type declarations rather than from an inferred shape.

The Node adapter also learned the model catalog only by spawning a CLI at
connect, on a five-second budget with one retry. On 2026-09-11 a daemon restart
landed as an Xcode build and a Gradle build started, both attempts timed out
although the command takes about 1.6 seconds idle, and every surface ran without
a catalog or a Gateway model name until the daemon was restarted again. The
catalog is now read over the socket the adapter already holds — the way the macOS
daemon has always read it — with the CLI kept as a fallback for a Gateway that
does not advertise the method, and both adapters retry on one ladder for as long
as the link lives.

### The macOS daemon log is capped

The Swift daemon's log was measured at 518 MB with no cap, 98% of it debug lines
that were being written whether or not debug logging was enabled. The logger now
rotates at 32 MB on its own write queue, keeping exactly one previous generation,
and the diagnostics view reads into that generation when the live file is short
right after a rotation.

### Usage gauges

A Codex usage window the API did not report is no longer drawn as a window at
0%, a gauge's position on the deck no longer depends on whether it happens to be
the binding limit, and a scoped limit's name no longer collides with a
three-digit percentage on the D200H's shared row.

### Stream Deck: the OFFLINE key can say why

A user saw the single word OFFLINE with no way to tell "no daemon registered
anywhere" from "found one but its process is gone" from "a live daemon is on a
fallback port we have not reached" — even though the plugin already held every
fact needed to separate them. Every action's Property Inspector now carries the
same status line: a plain-words daemon status, the resolved `daemon.json` path,
the port, how long ago it was probed, and a Retry that round-trips. The widget
also now uses the Property Inspector's own font instead of the webview's
defaults, which rendered it in Times New Roman.

### Android: whatever rotates draws the running glyph

Two timeline mirror bugs that the TypeScript and Swift surfaces had already
fixed. A starting task rotated the static checklist glyph instead of swapping in
the circular arrow, and a failed turn kept spinning next to the row explaining
the failure, because `error` was missing from Kotlin's completion list. The swap
rule now lives in shared code and is applied at both Android render sites.

### ESP32: InkDeck is now `trmnl_75`

The board is named after the kit it actually is — a Seeed TRMNL 7.5" OG DIY Kit
running AgentDeck firmware. `inkdeck` remains an accepted alias, because a board
already in the field reports the name it was flashed with and must stay
reachable by the update that renames it.

### Installing: the CLI link is reported honestly

`scripts/install.sh` swallowed `pnpm link --global`'s stderr, warned, and then
printed `agentdeck CLI linked` unconditionally — so on a pnpm that rejects the
command the installer reported a link it had not made, and the next `agentdeck`
either failed or silently resolved to an unrelated global install. It now
reports the real outcome, prints what pnpm actually said, and names the two
paths that do not depend on the link (`node bridge/dist/cli.js` and
`npx @agentdeck/setup`). The flag turns out to be undocumented and
version-dependent rather than simply gone, which is enough to stop depending on
it silently but not enough to name a replacement. Reported by @jurri.

## 2026-09-06 — npm 1.2.1, Apple 1.2.1, ESP32 1.2.2

### Collaboration view (Beta): who is doing what, and what is being waited on

A session whose turn has closed reads `idle` on every surface, and until now
that was the whole story even while six headless workers it had launched were
still running, a sibling session was exchanging messages with it, and a
20-minute background job it would be re-invoked by kept going. The daemon now
records those three shapes of divided work from evidence it can actually see —
a worker whose process descends from the session's process, a cross-session
message on the sender's tool call and the receiver's envelope, and a background
process whose command line names the session's scratchpad — and never from
shared project membership. The macOS Dashboard gains an opt-in **Collaboration · Beta**
switch in the title bar (the default **Habitat** view is unchanged): pick a session and the right rail shows its
latest task, confirmed child agents, spawned sessions, peer messages and the
jobs it is waiting on, with "turn closed · waiting on N" replacing a bare
`idle`. The roster row shows `⧗N` beside the subagent `+N`. The original view is
unchanged and remains the default.

Both daemons produce the evidence. The App Store daemon reads the process table
with `sysctl` and needs no subprocess; the session-to-process link on either
daemon is a new `X-AgentDeck-Pid` header the Claude hooks send, so rerun
`agentdeck daemon install` (npm) once after upgrading — the app refreshes its own
hooks on launch.

### A checklist item is not a child agent

A `TaskCompleted` hook (a TaskCreate/TaskUpdate item checked off) used to be
recorded as a finished subagent named "Subagent", so a session that ran no
children could show six completed branches. It is an annotation now, on both
daemons.

### Attention only when a human is really being waited for

A Claude session in `acceptEdits` or `default` mode showed PERM — "waiting for
you" — for tool calls its own terminal never asked about, then sat there for the
full 25-second hold before continuing on its own. The hold predictor understood
only the legacy `Bash(cmd:*)` spelling of a permission rule, while the
permission dialog writes `Bash(cmd *)`: on one measured machine that was 67 of
73 rules, so nearly every allowlisted call raised a false alert. The rule
matcher is now generated from one source for both daemons and follows the
documented syntax, including compound commands, the built-in read-only set, and
wrapper stripping. Every remaining uncertainty resolves to "do not hold": a
missed hold costs nothing, a false one costs a lie and a stall.

Claude's internal fork queries — the prompt suggestions and agent summaries it
runs for itself — emit a stop event with no matching start and no agent type.
Those were being counted as finished workers, so `wait for it…` and
`<no suggestion>` appeared as completed subagents. They are consumed silently
now. A folded Codex project row also keeps the member that is actually waiting
on you visible instead of hiding it behind a busy sibling.

### The usage panel says why a quota is missing

When Claude credentials expired, the subscription gauges went blank or stale
with no reason given, which is indistinguishable from a network blip. The
provider row now names the cause — authorization expired, unavailable, or a
temporary failure — and retracts it automatically once a reading succeeds. The
status is relayed to the app; the Node daemon can additionally ask your own
Claude CLI to renew the credential with one small, tool-free turn, throttled
across restarts.

### Evaluation only scores work that exists

A task with no captured agent reply, one that was only aborted, or a trivial
exchange is now retained as explicitly not graded rather than scored against
silence — on one week's data that was 69 of 182 judged tasks, including a
usage-limit abort that scored 0% on its own error notice. Judge replies that
were cut off by a token limit, or that came back empty, are rejected instead of
parsed. A single unparseable task can no longer stall the queue behind it, and
the daemon keeps its evaluation state across a restart instead of stranding
every open task for the reaper.

### IPS10: stable cards that keep their information

The IPS10 tablet keeps the equal-size project-room cards but restores the tool,
model and elapsed lines the previous layout dropped, shows the child and
coordination censuses in amber when the session is waiting, and picks its ten
cards deterministically — every session waiting on a human is kept, the newest
fill the rest, ordered by id — with `+N` in the header for the ones beyond the
cards. A state change never moves a card any more.

## 2026-09-04 — ESP32 1.2.1

### A pager chime now points at the session that needs you

The T-Embed CC1101 could play its deliberate two-note attention chime for a
Claude or Codex session while keeping the idle OpenClaw card in the center.
Audio and display had separate waiting detectors: the first watched every
session, while the second preferred the conversational assistant until the
operator turned the knob. The carousel now centers the exact session that
entered a response wait and follows its ID across roster reordering. It keeps
an in-progress detail/history cursor intact and names the other waiting session
in the footer instead.

The same waiting request also no longer becomes a new alert when USB or WiFi
briefly drops the roster. A fixed-size per-session latch survives empty roster
frames and rearms only after that session is explicitly observed outside an
awaiting state. Repeated broadcasts therefore stay silent; a genuinely new
question still rings once.

## 2026-09-02 — Ulanzi 1.2.0

Version note: Ulanzi jumps from 1.0.5 to 1.2.0 to rejoin the round's shared
minor — one number across every channel of this cut. The Marketplace's pending
review record (submitted as 1.0.4, later replaced in review by 1.0.5 — the
portal's own update note said so, against what this repo had recorded) is
superseded by this version; the store's published version remains 1.0.3, so
1.2.0 is the next thing its users see.

### OFFLINE means the daemon is unreachable, and nothing else

The daemon's aggregate `state:'disconnected'` also means "connected, but no
active session", so it was never sufficient to select the OFFLINE surface — a
healthy daemon waiting for work drew the same dark card as a dead socket. The
plugin now carries its own transport fact (`daemonConnected`) beside the
daemon's state, and only a real disconnect selects OFFLINE. The tutorial copy
follows in all nine locales: before setup, every key forms one dark OFFLINE
card, which is the plugin telling you the daemon is the missing piece.

### Usage keys follow the account's real windows

The bundled layout engine picks up the Codex limits work: the D200H has three
usage keys left of its clock, so when an account exposes four or five rolling
windows, same-provider 5H+7D pairs compact into one dual-readout key instead
of dropping a limit, and a scoped per-model cap contributes at most one tile.

## 2026-09-01 — Apple 1.2.0

### A device is approved by the operator, not by a code it cannot type

A reader with no camera and no cable used to have no way in: the daemon refused
its WebSocket at the handshake and logged the address, and nothing told anyone.
That refusal is now a prompt — the Pair a Device window shows WAITING TO
CONNECT with each knocking device, and the operator approves or dismisses it.
The device does nothing at all, which is also the stronger trust model: a code
trusts whoever knows a secret, an approval trusts a peer the operator pointed
at, and an attacker cannot approve themselves.

Identity is the device's random per-install id when it sends one, and the
address only when it does not — devices that predate the header keep working,
and the UI labels which kind a grant is, because only the device-scoped one
survives a DHCP lease change. A refused device is pointed at this approval flow
instead of at a CLI command its user may not have.

### Desktop Codex wears its own badge on the Mac daemon too

Codex Desktop fires the same lifecycle hooks as the TUI, and the Swift daemon
stamped every session `codex-cli` — while the Node daemon reads the rollout's
`session_meta.originator` and labels `codex-app`, so the same session wore a
different badge depending on which daemon owned the port. The Swift daemon now
reads the rollout head the same way (measured originators: "Codex Desktop"
vs "codex-tui"/"codex_cli_rs"/"codex_vscode"). The never-functional process
observer for the desktop app is deleted: it guarded on a bundle path the
shipped app does not use, matched zero processes in its whole life, and
reviving it would double-report sessions the hooks already push.

### The Mac daemon advertises the identity both daemons agreed on

The Swift daemon's Bonjour advertisement was a hand-typed literal —
`daemon-9120`, with a TXT record missing the host/user keys — while the
SSOT-following construction sat in a module nothing instantiated. The
mdns-identity drift gate compares pure functions and generated mirror bytes,
so a publisher that consults neither stayed green for the whole life of the
feature. The advertisement is now composed in one place from the shared
identity rules (`AgentDeck-<host>-<userTag>-<port>`, same TXT contract as the
Node daemon), the dead module is deleted, and a new gate drives the real
builder and scans the publisher's call site so a literal cannot come back
unnoticed.

### Epoch milliseconds on the wire are integers

The Swift daemon wrote the subagent census timestamp as a raw
`timeIntervalSince1970 * 1000`, so the wire carried `1788214664925.6821` —
and Android's strict decoder refused the whole `sessions_list` frame for it,
blanking the roster on any machine with a finished subagent. The producer now
emits integer epoch-ms everywhere (Android 1.2.0 carries the tolerant-decode
half of the same fix).

## 2026-09-01 — ESP32 1.2.0

### Two e-ink boards join the fleet

LilyGo T5 ePaper S3 (EPD47: 4.7″ 960×540, 16-level grayscale, GT911 touch) and
RockBase NM-EPD-420 (4.2″ tri-color) are now first-class boards with merged
factory images in the release matrix.

### EPD47: erase what was drawn, not the whole panel

The parallel driver assumes a white surface, and a "full" cycle used to mean a
whole-panel clear — several black/white inversions, so one tab press read as a
storm of flashes. The firmware now retains the previous 4-bit frame in PSRAM
and drives exactly that ink back to paper before each replacement, with a hard
anti-ghost sweep after four differential erases or ten minutes. The canvas also
stopped collapsing 16 grayscale levels to two, tab selection is arbitrated with
hysteresis so a jittery session count cannot thrash pages, and the touch grammar
drops the numeric prefixes that existed for the single-button cycle.

### NM-EPD-420: red is semantic, and the speaker was 18 dB too quiet

Red ink is spent on the one thing that needs attention (a decision face, a
session that needs you) instead of a permanent rail — the tri-color waveform is
already paid for on every repaint, so it costs nothing extra. The ambient floor
is 15 minutes with coarse-fact transitions (attention/working counts, link
state) bypassing it, because 100% of this board's repaints are full tri-color
cycles (measured 93/93). A changed working count bypasses only once it has
held for 90 seconds — the glance face's whole content is these counts, so a
settled change repaints while between-turns flapping stays coalesced. The speaker was configured correctly all along and set
18 dB too quiet.

### The paper says less, and what it says is legible

Field review of the flashed panels sent four pieces of chrome away. SYNCED is
gone — a healthy link says nothing, and OFFLINE (in the accent ink) is the one
word that earns space, which is how the Mac preview always drew it. The
BOOT/USER key legends are gone from the NM faces — the installed unit exposes
no usable buttons, so they were permanent instructions for controls the user
cannot press. The EPD47 footer no longer narrates the page arbiter
("HELD / 8m · QUEUE READY") into the same pixels as the event ticker. And
usage gauges are labeled Claude/Codex — the brand words every other surface
uses — instead of CLA/CDX initialisms.

Usage rows now follow the account's actual window shape (the Stream Deck dial
rule): a window the provider does not expose gets no empty frame anywhere — NM
glance rows, the EPD47 queue rail, focus gauges, and the limits provider
cards all give the surviving windows the freed width. A gauge at or past 90%
fills in the semantic accent (red on the tri-color glass).

Touch sessions on the EPD47 stay quiet (differential erases), and one hard
anti-ghost sweep now runs 12 seconds after the last tap — grayscale
differentials each leave a little pigment behind, so the sweep lands when its
flash costs the least attention instead of leaving the panel foggy until the
next scheduled clear.

A second field pass tightened the same surfaces. NM usage adopts the InkDeck
footer grammar at 400px: a brand glyph per provider, one row per window with
its reset countdown inline beside the gauge, replacing both the text labels
and the cryptic composite "RESET C5H …" line. The NM decide face labels its
BOOT/USER keys again — the unit does have keys on its top edge, and chrome
earns space exactly where it changes what the user does right now — while the
ambient glance stays unlabeled. The EPD47 footer shows up to two timeline
rows without colliding with the capability hint. And a milestone ticker row
replacing another on the InkDeck now spends one full flash: under a partial
waveform the old text ghosts beneath the new, which reads as overlapping
print, not as fading.

The EPD47 queue shows the whole roster — attention, then working, then idle —
instead of only active sessions, which had the largest panel in the fleet
showing the fewest rows; its footer timeline renders two lines of bold 9pt in
full ink, because the muted caption gray that works inside a card was illegible
from across a desk, and a 12pt budget measured from the Latin ascent overlapped
and clipped the Korean glyphs the ticker actually draws.

### Surface modes and pull-aware paper faces

Offline, sleeping, live, and interactive states are explicit surface modes with
refresh counters, instead of being inferred from whichever transport last
spoke; pull-aware paper faces serve XTEink and InkDeck-class readers, and panel
rotation/refresh policy is aligned with the first-party previews.

## 2026-09-01 — Stream Deck 1.2.0

### The Codex dial follows the windows the account actually exposes

The usage surfaces assumed the 5h rolling window was gone forever (it
disappeared upstream on 2026-07-12) and hardcoded that shape. Codex Plus
re-exposed it. The window list now follows what the account reports — Plus can
show 5h and 7d, Pro shows 7d alone — and a lone window fills the vacant half
with the subscription behind the quota instead of a dim "—" ghost.

### An approval key names what it approves, and why

Approval questions are usually shell commands, and an 18-character head cut
kept the verb every request shares while dropping the object that identifies
this one. Keys now summarize the question so the object survives, and show the
reason approval was demanded — the difference between "approve a sed" and
"approve a sed that policy flagged".

## 2026-09-01 — Android 1.2.0

Android's previous delivery is 1.0.10; the 1.0.12/1.0.13 numbers below were
prepared but never tagged or shipped, so their content ships here, renumbered to
join the coordinated 1.2.0 round. versionCode stays 15.

### One fractional timestamp emptied the whole session list

Every Android device was showing `Sessions 0` while the daemon held seven, and
the only trace was a `W/BridgeConnection: Unparsed WS message` line truncated at
200 characters. The subagent census carries `lastCompletedAt`, and the Swift
daemon writes it as `Date.timeIntervalSince1970 * 1000` without the `Int(...)`
its pairing routes apply — so the wire carries `1788214664925.6821`. Kotlin
declared it a plain `Long`, and kotlinx refuses a fractional number for one.

The census rides inside `SessionInfo`, so that refusal did not drop a field or a
row: it failed the whole `List<SessionInfo>` decode, `parseBridgeMessage`
returned null, and the frame was discarded. One session with a finished subagent
was enough to blank the roster, and on a busy machine that is the steady state —
measured on a Crema S, 242 consecutive `sessions_list` frames rejected while the
timeline beside it rendered every row in real time.

The timeline renders because `BridgeTimelineEntry` already defends its stamps
with `FlexibleLongSerializer`, whose body is exactly this case
(`doubleOrNull → toLong()`). The census was added later and missed it; it now
carries the same annotation.

The regression gate is a `sessions_list` frame captured verbatim off a live
daemon rather than composed from the decoder's own field list — a fixture built
from what the reader expects agrees with it forever and cannot catch a producer
emitting a shape the reader refuses, which is how this survived until a device
was looked at.

### A refusal is a holdoff, not a ban — so approval works without a restart

A daemon that closed us 4001 was remembered as refused until the app could
offer it a credential. Operator approval mints no token, so the one flow that
makes the endpoint dialable again could never retire the memory: the knock
stream stopped, the operator approved a device that never dialed back, and the
grant took effect only after an app restart. The refusal now expires on read
after a 30-second holdoff — an aged-out refusal buys exactly one redial, a
daemon that still refuses re-stamps it, so the steady state is one knock per
holdoff instead of the per-emission hammer the memory exists to stop.

### A device is approved as itself, and a focused session gets its creature back

The dashboard now names itself in the WebSocket handshake with a random
per-install id, so the Mac can approve THIS device rather than the address it
happens to hold. Approval by address was the only option available — the daemon
accepts or refuses before any frame, long before a client says what it is — and
behind NAT an address is shared, so approving one device approved everything
behind it. Devices that predate the header keep working: the daemon falls back
to address-scoped approval and labels which kind a grant is, because only one of
them survives a DHCP lease change.

### Creatures

A focused session stopped rendering its creature. The predicate meant to detect
an aggregate row — the daemon, or an OpenClaw session listing itself — asked
whether any sibling shared the primary's agent type, and the sibling list
contains the focused session itself, so it matched its own row and was true for
every typed session. All four primary creature branches are gated on it, and the
sibling loop skips the focused session by id, so the session you were looking at
had no creature from either path: one session in view meant none at all.

The tests that covered this passed by leaving the sibling list empty, a shape
the daemon never sends. They now build the list the way the wire does.

The same expression existed on two other surfaces and was narrowed with it. On
the terminal dashboard it decided whether to add the focused session at all, so
a second session of the same agent silently dropped its octopus. On macOS it
only fed the environment mood of a disconnected primary, which is why nothing
was visibly wrong there.

## 2026-08-31 — npm 1.2.0

This is a backward-compatible minor release. It keeps protocol compatibility
major 1 and delivers the daemon, Surface, and Work-board changes accumulated
since npm 1.1.0. Managed agent launchers still work in this release. They are a
legacy compatibility path with no removal date, not a capability-removal notice.

### Normal agent commands are now the default launch path

`agentdeck claude`, `agentdeck codex`, `agentdeck opencode`, and
`agentdeck monitor` now identify themselves as legacy compatibility commands in
help and print an actionable notice before starting their existing per-session
bridge. The recommended default for ordinary local sessions is `agentdeck daemon
install` followed by the agent's normal command. `agentdeck diag agents [--json]`
checks the installed Claude Code,
Codex, and OpenCode versions against AgentDeck's lifecycle compatibility
baselines without opening a PTY or requiring a running daemon.

The old commands are not tombstones: remote attach, `--weight`,
`AGENTDECK_COMMANDER_ARGS`, agent-specific `AGENTDECK_*_ARGS`, terminal UI
steering, and terminal telemetry still have no daemon-first equivalent. The
managed implementation and `node-pty` remain available while replacements are
designed and validated in Discussion #278 and issue #273. A 1.1 managed worker's
register/state frames remain accepted by the 1.2 daemon and continue to surface
as managed sessions.

Fresh macOS installs also repair the missing executable bit in the stable
`node-pty@1.1.0` `spawn-helper` before the first managed PTY launch. The upstream
tarball imports successfully but otherwise fails only at the first real spawn,
so import-only installation checks could report a broken compatibility path as
healthy.

### Portable readers receive complete, bounded content

The daemon now distributes the licensed Pocket Daily Japanese N3 learning
pack and an automatic reader font pack, serves large assets in bounded resume
segments, and drives pull-aware paper faces for XTEink and InkDeck-class
readers. Surface mode and refresh counters make offline, sleeping, live, and
interactive states explicit instead of inferring them from whichever transport
last spoke. E-ink rotation, hardware refresh policy, and offline/connected
interaction states are aligned across the reader firmware and first-party
previews.

### Work-board tasks have stable names and useful boundaries

APME derives deterministic task titles and folded action lines from shared
rules, applies a measured idle-gap boundary, reaches both Node and native daemon
topologies, and exposes session drill-down data. The generated dashboard and
native mirrors replay the same vectors so a task is named and grouped the same
way on every surface.

### Codex limits and daemon shutdown are more reliable

Codex live-limit reconciliation now resolves the account/limit family before
accepting a passive reading, uses the weekly reset as an anchor with bounded
jitter, and refuses per-model pools that cannot vouch for the account reading.
This prevents an active rollout from replacing the real weekly account limit
with a differently scoped pool. Daemon push sockets also shut down safely while
still connecting, so test and process teardown no longer leaks an asynchronous
WebSocket error.

## 2026-08-27 — Apple 1.1.0

### The standalone Mac daemon now speaks the complete portable transport

The macOS app no longer needs a Node daemon for Surface Feed, offline Outbox
replay, pull telemetry, or resumable firmware delivery. Its native Swift daemon
validates the same product identity, stores staged firmware inside the App
Container, serves bounded resume segments, and clears an update only after the
reader reports the installed build.

Surface-aware WebSocket clients now negotiate the dashboard, companion,
portable-reader, or display-only profile. The Swift daemon enforces both the
events it sends and the commands it accepts against that negotiated capability
set; legacy clients keep their existing wire behavior.

Node remains the richer content author: adaptive Pocket cards and rendered
Glance Frame pixels are not copied into the App Store app. The Apple release
adds the transport/runtime needed for standalone operation without adding a
subprocess, companion executable, or external service.

## 2026-08-26 — npm 1.1.0

This is the first release under the compatibility-major version policy. It stays
on protocol-compatible major 1, but uses a minor bump because the delivery since
1.0.24 contains several substantial backward-compatible features rather than one
isolated fix.

### Surface Protocol, resumable OTA and offline weather

Surface Protocol v1 gives low-power and intermittently connected displays a
bounded Feed/Outbox contract instead of requiring a continuous WebSocket. Pocket
firmware downloads can resume with negotiated segments, discover an update before
a full feed transfer, survive dual-homed hosts through subnet-aware redirects,
and close a staged update after the installed version reports back. The same feed
now carries a cached weather outlook, and `/health` exposes build identity for
deployment diagnostics.

### OpenClaw activity is observable and actionable

The daemon now subscribes to the Gateway events that carry user messages, tool
calls and assistant metadata. APME receives real turn boundaries, provenance,
per-message usage and tool results instead of mostly empty 30-minute runs. Approval
prompts can be answered from AgentDeck, including sessions reached through relays,
without inventing duplicate activity when Gateway event paths overlap.

### Codex dashboards show the sessions and limits that are actually active

Codex Plus once again renders its 5-hour window alongside 7-day usage, while Pro
renders only the 7-day window it actually supplies. TUI and compact dashboard
layouts use `windowMinutes` rather than positional assumptions. Codex App chats
whose rollout files remain open but inactive leave the active roster after 90
seconds; project duplicates are folded consistently across consumers. A cached
serial endpoint also no longer suppresses fresher Wi-Fi display traffic.

### Device identity and routing are more reliable

Adopted boards report their configured identity, network discovery stops
advertising addresses devices cannot reach, and relayed Codex limits reconcile
against the authoritative snapshot before reaching dashboards.

## 2026-08-25 — Ulanzi 1.0.5

The plugin no longer ships a native binary on any platform. The Ulanzi Studio
team reported that macOS raises "Apple could not verify this file" on Apple
Silicon for `resvgjs.darwin-arm64.node`, the SVG rasterizer 1.0.4 bundled.

### Why a signature was never going to be the fix

A loose native module inside a folder Ulanzi Studio downloads and unpacks has
nobody who can sign it in a way Gatekeeper will accept for the process that
loads it: we do not build Studio, and Studio does not build our dependency.
`@resvg/resvg-js` also required one `.node` per architecture, so the single
Marketplace bundle had to carry five — 18.5 MB of a 20 MB plugin, four of which
any given user cannot run.

### One WASM file instead of five binaries

`@resvg/resvg-wasm` is the same resvg version (2.6.2) and the same Rust core,
pinned in lockstep with the native one it replaces, and it ships as one 2.4 MB
file that is identical on every OS and CPU. Measured against the 1.0.4 renderer
over 34 tiles spanning both raster sizes, every session state and every agent —
`feGaussianBlur` glow included — the output is **byte-identical**: same RGBA,
same PNG hash. This is not a renderer swap, and there is nothing left for
Gatekeeper or SmartScreen to adjudicate.

The cost is ~3.6–3.9× per uncached render (2.2 ms → 7.9 ms at 144 px, 3.1 ms →
12.0 ms at 196 px, plus 15.6 ms once at startup), which sits behind the existing
256-entry raster cache and well inside the Studio→device link's own budget.

Fonts were already explicit bundled faces with `loadSystemFonts: false`, so this
is a `fontFiles` → `fontBuffers` change and not a typography change. They are
load-bearing now in a way they were not before — the WASM build has no
filesystem and therefore no system-font fallback — so the packaging step refuses
to build a bundle missing them, and refuses one containing any `.node`, `.dylib`,
`.so` or `.dll` anywhere in the tree rather than trusting a list of package names.

The upload archive drops from 9.15 MB to 1.39 MB, and the installed plugin from
20 MB to 3.5 MB.

## 2026-08-24 — Ulanzi 1.0.4

1.0.3 went live on the Ulanzi Marketplace on or before 2026-08-24 — the first
AgentDeck build that store has ever published, seventeen days after it was
submitted. It was also, by then, seventeen days behind the repository. This is
the catch-up release, and the portal's rebuilt update flow is what makes it
cheap: a new version is now a *review version* that leaves the published one
serving downloads while it is checked, so there is no longer a reason to sit on
plugin work during a review.

### The D200X is claimed, once, and only for what it does

`Devices` now declares `D200H` and `D200X`. Both present the same 14 LCD keys to
Ulanzi Studio, and the layout engine is already sized off the keys the user
placed rather than off a device model, so the keypad needed no new code — only
an honest declaration. The D200X's three rotary encoders are deliberately NOT
claimed: they need their own action and their own UX, and a plugin that lists a
device it half-supports is worse than one that lists fewer devices. Requested in
[#174](https://github.com/puritysb/AgentDeck/issues/174).

### Three agents the published build could not draw

The store's 1.0.3 predates Kiro entirely and predates the OpenClaw approval work.
This build carries the current renderers, so Kiro CLI, Kiro IDE and Antigravity
sessions arrive with their own marks instead of falling through to a neutral
tile, and an OpenClaw permission prompt is both readable and answerable from the
key — 1.0.3 rendered its options as an inert mirror of a prompt nobody could
reach, because the live-answer path was gated on a session being *observed* and
the Gateway row is not.

### German, Spanish and Portuguese

The plugin shipped five languages while the Marketplace listing has always
required seven. `de_DE.json`, `es_ES.json` and `pt_PT.json` close that gap for
the palette entry, the setup panel and the H5 tutorial, in the SDK's own file
layout. Separately, `zh_HK.json` still described a D200H-only plugin after the
other four were updated — a locale left behind by a one-line edit, which is the
failure a per-file sweep exists to catch.

## 2026-08-23 — npm 1.0.24

1.0.23 shipped the flashers. A hardware run over the fleet then found two
defects in them, and both had the same shape: a write that fully succeeded
reported as a failure, or was refused before it started. Neither could be seen
from a green test suite, because both live in the wire between the host and a
board.

### The board now reboots into the firmware you just wrote

1.0.23's own notes called a real per-board reset open work. This closes it.

esptool-js's non-USB-OTG hard reset is, in full, `sleep(100); setRTS(false)` — a
*release* with no *assert*. That works only if whatever ran before left EN
asserted: `--before default-reset` does, and a finished `writeFlash` does not. So
every flash left the chip parked in the flasher stub. The firmware never ran, the
post-write `device_info` read-back could not succeed however long it waited, and
the CLI told users to power-cycle a board that had been written perfectly.

Both flashers now drive the reset themselves, from one sequence in the board
SSOT rather than one per flasher. Measured 2026-08-23 across three boards
spanning both of esptool-js's adapter strategies and the no-stub path:

| sequence            | T-Display-S3-Pro (native USB) | 86 Box (CH340) | TTGO T-Display (CH340) |
|---------------------|-------------------------------|----------------|------------------------|
| `after(hard_reset)` | parked                        | parked         | parked                 |
| `R1 W250 R0`        | booted                        | parked         | —                      |
| `D0 R1 W100 R0`     | booted                        | booted         | booted                 |

The `D0` is load-bearing and only the CH340 boards reveal it: pulsing EN without
first driving IO0 high leaves them in download mode, which from outside is
indistinguishable from a board that failed to boot.

### TTGO T-Display can actually be flashed

1.0.23 offered it in the browser picker. It could not be written there, or
anywhere: it was pinned `--no-stub`, the ROM loader has no compressed flash
mode, and the write died at `Failed to enter compressed flash mode` — before a
single byte landed. Making compression conditional moved the failure exactly one
step, to `Failed to enter Flash download mode`.

The evidence recorded for that board only ever claimed that it *connects*.
Connecting is not writing, and a board's verification now has to name a
completed write. With the stub it writes and boots end to end — 2.6 MB in 138
seconds, MD5 verified against the chip, and the board came up reporting its own
version. It also fixes the size guard as a side effect: stubless, this board's
flash id reads `0xffffff` and no size can be checked at all.

`esp32/platformio.ini` keeps its `--no-stub`, deliberately. That pin drives
`esptool.py`, a different tool, and changing it on evidence gathered from
esptool-js would be the guess this whole round exists to stop making.

### Still open

Stubless writing itself. Every `--no-stub` board measured so far fails before
writing a byte, and that is its own investigation. No board offered in the
browser is stubless now, so this affects only the CLI-only boards.

The browser flasher at [/flash/](https://puritysb.github.io/AgentDeck/flash/)
deploys from `master` and already carries both fixes; this release is the
terminal half.

## 2026-08-23 — ESP32 1.0.8

A small screen that runs out of room used to just stop drawing sessions. The
T-Display Pro said `+N more`, the general HUD had no bound at all, and InkDeck's
fixed grid simply ended — so a session waiting on your input could vanish behind
a full screen with nothing saying it had. Every ESP32 surface now shares one
glance order — **input → working → quiet context** — and states what it left
out: `4 idle hidden`, `hidden: 2 input / 3 working`. What is dropped is now a
fact on screen rather than an absence.

InkDeck applies the same order past its card capacity and prints the per-state
hidden counts in its header. The dense terrarium keeps the names of sessions
that are working or waiting and folds only the idle tags, so the creatures and
the summary roster split the job instead of competing for the same pixels.

### The IPS 10.1 office says state in more than one channel

The tiny `w` / `z` / `?` letter codes are gone. Idle is still and dimmed with no
badge at all, working is a cyan spark with a floor halo, awaiting input is an
amber `!`, error a coral `!`. Shape, motion and contrast now carry the state
redundantly with colour, so it survives distance and a washed-out panel. In a
narrow cell the session card gives the one-line name priority over the
decorative glyph — `OpenCode` and `Antigravity` no longer break mid-name.

### Two rendering defects

- **TC001's awaiting-input pulse went black.** The brightness curve ran through
  its negative half, so the one state that must never be missed disappeared for
  part of every cycle. Floored at 45%.
- **The new bounds allocate nothing.** Fixed arrays and stack buffers only —
  a render loop that allocates is how a no-PSRAM board OOMs under exactly the
  crowded scene these bounds exist to handle.

### Verified

Pixel-exact simulator scenes for IPS 10.1 dense and permission, Box dense,
T-Display Pro crowded Sessions, TC001 permission, and InkDeck dense — plus a new
10-session `dense` scene kept for future regressions. The e-ink layout
regression tests pass, as do the PlatformIO builds for `ips35`, `box_86`,
`led8x32`, `inkdeck`, `t_display_pro` and `ips10`.

## 2026-08-22 — npm 1.0.23 · ESP32 1.0.7

Firmware was building correctly for ten boards every release and piling up
somewhere nobody could reach it. All 31 assets of `esp32-v1.0.6` were downloaded
zero times, no page linked them, and the only documented way in assumed a source
checkout with PlatformIO installed. This release is the way in.

### Flash from a browser — nothing to install

[**puritysb.github.io/AgentDeck/flash/**](https://puritysb.github.io/AgentDeck/flash/)
writes firmware to a board over USB from desktop Chrome or Edge. Pick a board,
plug it in, done — no checkout, no toolchain, no `esptool.py`. Safari, Firefox
and mobile browsers do not implement Web Serial; the page checks that *before*
rendering the flow and hands you the terminal command instead, in English,
Korean or Japanese.

Five boards are offered — 86 Box, InkDeck, TTGO T-Display, Ulanzi TC001,
T-Display-S3-Pro — each because a hardware run measured it. The other five are
listed too, disabled, with the reason on screen: a board missing from the picker
reads as "unsupported" and sends its owner to the wrong page.

### `agentdeck esp32 flash <board>`

The same write from a terminal, with the two things a web page cannot do:

- **It frees the serial port itself.** Every serial open toggles DTR/RTS and
  resets the board, so a running daemon is the commonest cause of a failed
  flash. The CLI takes a lease the daemon honours — a *file*, because the daemon
  that steals the port is the one that respawns underneath the write, and an
  in-process pause cannot span a respawn. The lease expires when it is read, not
  on a timer, so a flasher killed mid-write needs nothing to run to recover.
- **It asks the board to introduce itself after the write.** MD5 against the
  chip proves the bytes; an image with a wrong flash-size header passes that and
  then bootloops, so the port is reopened and the firmware's own `device_info`
  is read back. Treat a reply as confirmation and its absence as no
  information: esptool-js's hard reset is a *release* with no *assert*
  (`reset.js` `HardReset` is `sleep(100); setRTS(false)`), so on an adapter that
  does not leave EN asserted after the write it is a no-op and the chip stays
  parked in the flasher stub. Measured on 86box, 2026-08-22: silent for 200s
  with exclusive port access after four separate writes, then up in 2.0s the
  moment `esptool --after hard-reset` pulsed EN for real — the firmware was
  correct the whole time. So the command reports "power-cycle it" rather than a
  warning, and a real per-board reset is still open work. `ulanzi_tc001` skips
  the read-back entirely by name — its CH340 TX is broken in hardware.

`serialport` is an optional native dependency; without it the command says which
two things to install and points at the browser flasher.

### The write is refused when the board is wrong

Both tools identify the chip before writing, and neither has an override. An S3
image on a classic ESP32, or a 16MB-header image on an 8MB part, is how these
boards get bricked — and the recovery tool for a bricked board is the tool that
refused. The size check is directional: declaring *less* flash than the part has
is fine, and on InkDeck it is required. An unreadable flash id stays unknown
rather than becoming `detectFlashSize()`'s silent "4MB", and the surface says the
check was unavailable instead of implying it passed.

### ESP32 1.0.7 — one file, one offset

A release now ships `agentdeck-<board>-merged.bin`, written at `0x0` on **every**
chip, plus a `manifest.json` whose sizes and hashes are computed from the
artifacts. The previous asset set could not bring a board up: `boot_app0.bin` was
never published, so a stale otadata boots the previous slot; the bootloader
offset is chip-specific and this fleet spans three values, documented nowhere;
and an unstated flash size leaves a wrong header. A board that fails to build now
fails the release instead of shipping nothing quietly — the failure that left
three boards with no binaries at all in 1.0.1.

## 2026-08-22 — npm 1.0.22 · Apple 1.0.8

Codex usage was reporting the wrong number in two independent ways. Both are
producer-side, so every surface — dashboard, menubar, Stream Deck, D200H,
e-ink, ESP32 — is fixed by updating the daemon; no plugin reinstall or firmware
reflash is involved.

### Codex usage reported the wrong quantity, then no quantity at all

- **A per-model limit was published as the account's.** Codex writes several
  rate-limit *families* and each rollout line carries whichever one that request
  was metered against — `codex` and `premium` meter the account, while
  `codex_bengalfox` ("GPT-5.3-Codex-Spark") meters one model. Within a single
  session the family alternates hour to hour, and the readers took the newest
  line regardless, so the gauge showed Spark's 5h 0% / 7d 0% while the account
  sat at 13%. A named limit is now recognised as a scoped one and skipped; the
  readers keep scanning to the account-wide line behind it, and the live
  `codex app-server` query falls back to the unnamed family. When only scoped
  lines exist nothing is reported rather than 0% under the wrong label.
- **A plan change blanked every Codex gauge.** A snapshot stamped with a plan
  the account no longer holds is void, not merely old — but that check ran
  *after* the snapshot was chosen, so the one snapshot guaranteed to be
  discarded won on recency every time, while a valid one sat unread on disk.
  Plan agreement is now the primary ranking key and age only the tie-break, and
  a mismatch no longer lets a "fresh" rollout suppress the live query that
  carries the only usable number. Upgrading or downgrading a ChatGPT plan is the
  case this covers.
- `prolite` (ChatGPT Pro Lite) is named correctly instead of falling back to
  "ChatGPT Prolite", and the tier table is now generated for Swift and Kotlin
  from one source so the same account cannot read differently per surface.

### Also in npm 1.0.22

- Python BLE workers the OS kills for a revoked Bluetooth grant no longer
  respawn forever: three consecutive SIGABRT exits halt the loop and name the
  fix. A Rosetta (x86_64-only) interpreter is refused by reading the Mach-O
  header rather than by importing `bleak`, and such a venv is removed and
  rebuilt rather than reused.
- A failed usage fetch no longer launders itself as a fresh one, and a file
  cache whose TTL is an exact multiple of the poll interval no longer costs a
  whole extra interval.
- Firmware staged for a board that never pulls its feed is reported as staged
  rather than as delivered.

### Also in Apple 1.0.8

- The three daemon topologies (no daemon / in-process Swift / external Node
  with this app as its client) are a single state with explicit transitions, so
  a teardown while in client mode no longer clears the Claude quota, Codex rate
  limits and subscription rows — which is what editing any setting while
  attached to a Node daemon used to do.
- A relayed usage reading with no producer timestamp is treated as
  unknown-age instead of being restamped as just-fetched.
- Kiro's brand colours reached the design tokens, and its documentation caught
  up with the code that already observed it.

## 2026-08-19 — ESP32 1.0.6

One fix, and it is worth saying how it was found.

- The IPS 10.1" card header called a Kiro session `Agent`, while the office desk
  beside it — on the same screen, for the same session — said `Kiro`.
  `ui/agent_label.h` is the one place the firmware turns an agentType into a
  brand name and names this exact surface as its consumer, but `hud_bar.cpp`
  included it and then declared a private copy of the same map, written before
  Kiro existed. The local map is now a call to `agentShortLabel`: every other
  agent keeps its exact label, and an unknown agentType falls to its raw id
  rather than to `Agent`
  ([#235](https://github.com/puritysb/AgentDeck/pull/235)).

No compiler or test could have caught this. A label map with a `default` is
total — every input returns something — so what was missing was a distinction,
not a case. It was found by rendering the screen in `esp32/sim`, which compiles
these sources verbatim at each board's real resolution, and looking at it. That
also discharges the caveat 1.0.5 shipped with ("this is code that compiles, not
a screen that was looked at"): the boards were serial-attached and unflashable,
but the simulator never needed them.

**Only `ips_10` changes.** The edit sits behind
`BOARD_IPS10 && BOARD_HAS_VOICE_CAPTURE`, so every other board's image differs
from 1.0.5 by the version string alone. Firmware for all ten boards is published
here regardless, since a release set that skips boards is how three of them
ended up with no downloadable firmware at 1.0.1.

## 2026-08-18 — npm 1.0.21 · Apple 1.0.7 · Android 1.0.10 · Stream Deck 1.0.6 · ESP32 1.0.5

One round, cut across five channels from the same commit, so the entries are
grouped by what they change rather than by which artifact carries them.

### Kiro observation

- Observe Kiro sessions without being asked to manage them. Users run native
  `kiro-cli` or the Kiro IDE as usual and the daemon correlates the process with
  Kiro's own stores — the v2 app-data SQLite, or the v3 `sessions/` JSON plus
  `messages.jsonl` — read through a query-only handle that never touches auth or
  telemetry tables ([#198](https://github.com/puritysb/AgentDeck/pull/198),
  [#202](https://github.com/puritysb/AgentDeck/pull/202))
- Fill the Kiro timeline from Kiro's own transcript, because nothing else ever
  will. Kiro's global standalone hooks load and then fire for no CLI chat turn
  at all (measured on kiro-cli 2.18.1: a live turn produced zero hook markers
  while a hand-POSTed hook produced a timeline row normally), so both daemons
  poll the transcript instead. Two consequences are by design: a Kiro session
  appears seconds late rather than instantly, and it always reads `idle` —
  a transcript gains its assistant record only once the reply has landed, and
  claiming `processing` would be inventing a state
  ([#218](https://github.com/puritysb/AgentDeck/pull/218))
- Draw Kiro as Kiro, or as nothing — never as Claude. The surfaces that bucketed
  agents with a deny-list dressed every agent they predated as the bucket's
  owner, so Kiro sessions swam as Claude octopuses and took Claude's glyph and
  OpenCode's palette. Those buckets are allow-lists now, pinned by tests on the
  polarity rather than on the membership, so a future agent renders as neutral
  instead of as somebody else
  ([#216](https://github.com/puritysb/AgentDeck/pull/216))
- Give Kiro its name, mark, colour and terrarium creature across the dashboard,
  the decks and the ESP32 boards
  ([#205](https://github.com/puritysb/AgentDeck/pull/205),
  [#206](https://github.com/puritysb/AgentDeck/pull/206),
  [#217](https://github.com/puritysb/AgentDeck/pull/217))
- Capture Kiro's spoken reply instead of its redacted `Reasoning` placeholder,
  and keep the subject in a tool label rather than just the tool name
  ([#200](https://github.com/puritysb/AgentDeck/pull/200),
  [#204](https://github.com/puritysb/AgentDeck/pull/204))
- Count one Kiro chat as one session, tell an unreadable transcript apart from
  one nobody has typed into, and read the store from the sandboxed macOS app too
  — through a user-granted directory bookmark in Settings → Integrations, so
  with no grant it observes nothing rather than guessing
  ([#202](https://github.com/puritysb/AgentDeck/pull/202),
  [#207](https://github.com/puritysb/AgentDeck/pull/207),
  [#220](https://github.com/puritysb/AgentDeck/pull/220))
- Add `agentdeck diag kiro [--json]`, a daemon-free probe that is safe to paste
  into an issue: content-free, with report-scoped opaque keys for cwd and
  session identity ([#198](https://github.com/puritysb/AgentDeck/pull/198))

### Sessions, turns and subagents

- Count subagents at the hook and report them as `SessionInfo.subagents`
  (`active` / `peak` / `completed`). A parent whose turn closed is genuinely
  idle while its children work, so this is a second axis beside `state`, not a
  correction to it. Deriving it from timeline rows read near zero in exactly the
  fan-outs it describes — siblings of one workflow emit byte-identical rows in
  the same millisecond and were deduped to one, and eviction shed the dispatch
  row first. Measured on a real workflow session: 72 completions, peak 8
  concurrent, and zero surviving dispatch rows
  ([#219](https://github.com/puritysb/AgentDeck/pull/219))
- Say which company answered, without calling it a different agent. A Claude
  Code session pointed at another provider's endpoint is still Claude Code —
  same binary, hooks and transcript — so it keeps its `agentType`, and the fact
  that its weights came from somewhere else rides a separate signal that is set
  only when both sides are known and disagree
  ([#219](https://github.com/puritysb/AgentDeck/pull/219))
- Recover turns whose Stop hook never arrived, in observed sessions as well as
  managed ones — the previous release wired the watchdog only to PTY bridges,
  which covered none of the real traffic. Recovery re-enters the real Stop path
  rather than reimplementing it
  ([#194](https://github.com/puritysb/AgentDeck/pull/194))
- Tell a turn that never owed a Stop apart from one that lost it. A user cancel
  emits no hook at all, so counting it as a dropped Stop inflated the loss
  ratio with events that were never due; ESC cancels are now their own bucket
  and stay out of that ratio, detected both while the marker is still the
  transcript tail and on the commoner cancel-then-retype shape
  ([#195](https://github.com/puritysb/AgentDeck/pull/195),
  [#213](https://github.com/puritysb/AgentDeck/pull/213))

### Daemon

- Ask which user owns a daemon before adopting its token or shutting it down. On
  a shared host every same-machine privilege reached every account on the box:
  starting a CLI daemon shut down every colleague's macOS app, and a port scan
  registered one user's sessions with whoever answered first. Ownership is now a
  three-valued question answered at the point a peer is discovered; unproven
  ownership stays permissive, because refusing there is what breaks a whole
  paired fleet's authentication ([#215](https://github.com/puritysb/AgentDeck/pull/215))
- Give the CLI daemon a preferred port and make it wait for that port. A daemon
  bumped to a fallback had no record of the port it wanted, so a 14-second
  kernel hold on 9120 became permanent until someone restarted it by hand. The
  intent is persisted and only the user writes it (`agentdeck daemon port <n>`);
  the outcome never is, since recording the fallback would make it preferred
  forever after ([#212](https://github.com/puritysb/AgentDeck/pull/212))
- Make the daemon port window overridable, so a throwaway daemon can exist
  alongside the real one ([#211](https://github.com/puritysb/AgentDeck/pull/211))
- Surface the network posture in the macOS app as Settings toggles, matching the
  CLI's two axes, and tighten loopback mode's ADB reverse to USB transports
  only — a cable-carried tunnel terminates on the host's own loopback, but a
  wireless-debugging transport would carry it over the LAN
  ([#203](https://github.com/puritysb/AgentDeck/pull/203))
- Generate the Swift daemon's state-transition table from the shared TypeScript
  source. A row present in one daemon and absent in the other is a session that
  wedges on one platform and recovers on the other, with nothing in either log
  saying why ([#196](https://github.com/puritysb/AgentDeck/pull/196))

### OpenClaw

- Make an OpenClaw approval something the user can read and answer, rather than
  a prompt that renders without its question
  ([#214](https://github.com/puritysb/AgentDeck/pull/214))
- Say why an OpenClaw turn failed, and let the failed turn close its task
  instead of leaving it open — an open task is never judged
  ([#209](https://github.com/puritysb/AgentDeck/pull/209))

### macOS app — Apple 1.0.7

- Hide the Dock icon while no AgentDeck window is open, so a menu-bar-only user
  gets a menu-bar-only app. The rule is an allow-list of scene ids rather than a
  window count: `NSApp.windows` also holds the menu-bar panel and AppKit
  internals, so a count never reaches zero and the rule silently never fires
  ([#222](https://github.com/puritysb/AgentDeck/pull/222))

### Stream Deck plugin — 1.0.6

- Show up to four usage keys on 15-key and larger devices (Claude 5h and 7d,
  Fable, Codex 7d) instead of stopping at the first two
  ([#225](https://github.com/puritysb/AgentDeck/pull/225))

### Devices — ESP32 1.0.5

- Carry Kiro's colour, glyph and creature onto the boards
  ([#217](https://github.com/puritysb/AgentDeck/pull/217))
- Clamp Pixoo creatures above the active Usage HUD rows, so idle sprites stay
  visible instead of being drawn under the gauges
  ([#225](https://github.com/puritysb/AgentDeck/pull/225))

## 2026-08-15 — Android 1.0.9

### Android dashboard

- State the computer prerequisite on every disconnected screen, including the
  high-contrast e-ink layout: open AgentDeck Dashboard on a Mac or run
  `npx @agentdeck/setup` on macOS, Windows, or Linux
- Publish the unified first-connection path from 1.0.8 to Google Play: prefer
  USB when present, discover a daemon over Wi-Fi, allow code-based pairing on
  camera-less readers, and stop retry storms after an unpaired device is
  rejected
- Keep the 1.0.8 e-ink usage-limit clipping fix in the Play release

## 2026-08-14 — npm 1.0.20

### CLI and daemon — npm

Fixes two regressions that shipped in 1.0.19 when the terminal parser stopped
driving lifecycle state, plus follow-up hardening. 1.0.19 removed the parser
exit signals from the AWAITING states without adding hook-based replacements,
and removed the Claude missed-Stop recovery without a substitute — the second
of these was not called out in the 1.0.19 notes.

- Close a managed session's permission/option/diff prompt state when the user
  answers at the keyboard. 1.0.19 left such sessions wedged in "awaiting"
  forever (with the stale question still answerable from devices); prompts now
  exit on the turn's tool-activity hooks, on Stop, and on the next prompt
  submit. Guards keep a live prompt safe: a short grace after the prompt is
  drawn, a parallel sibling finishing never dismisses while the gated tool is
  still pending, a straggler tool-end after Stop never reopens a finished
  session, and the daemon hub's multiplexed state machine opts out of
  tool-activity recovery entirely
- Recover Claude turns whose Stop hook never arrives: a watchdog probes the
  transcript JSONL tail (never the screen) once the hook channel goes quiet
  and closes state, timeline, and the APME turn through a synthetic Stop. A
  genuine open prompt (`stop_reason: "tool_use"`) is never force-closed
- Recover a dropped `UserPromptSubmit`: tool-activity hooks arriving while
  IDLE now move the session to processing
- Warn once, on the timeline and in the session log, when a managed Codex
  session's terminal is active but no lifecycle hook or notify event ever
  arrives — hooks and notify share one curl/port path, so a stale port kills
  both silently
- Map only an explicit `error` key on `codex_stop` to an error row. A bare
  `message` is no longer treated as an error (it carries content on every
  other Codex event; neither key appears in any of 311 recorded real Stop
  payloads)
- Read the Codex lifecycle baseline from the package's `compatibleCodex`
  field instead of a hardcoded literal, and align the remaining
  architecture docs (protocol, APME pipeline) with the hook-primary design

## 2026-08-13 — npm 1.0.19

### CLI and daemon — npm

- Make lifecycle hooks and structured agent events the authority for session
  state, timelines, and APME turns. Terminal parsing is now limited to UI-only
  affordances that hooks do not expose, such as permission choices, model and
  project labels, cursor position, and Claude's mode and diff display
- Recover Claude responses from the Stop-hook transcript and Codex responses
  from lifecycle notifications plus rollout JSONL, removing the spinner and
  terminal-ring-buffer fallbacks without losing supported-path conversation
  capture
- Refresh Claude, Codex, and OpenCode integrations from
  `agentdeck daemon install`, so users can run `claude`, `codex`, and
  `opencode` directly. Managed `agentdeck <agent>` terminals remain optional
- Keep the AgentDeck 1.0 wire protocol unchanged. The supported lifecycle
  baselines are Claude Code 2.1.50 or newer and Codex CLI 0.141.0 or newer;
  explicitly disabling Codex hooks leaves managed terminal UI observation but
  not lifecycle timelines

## 2026-08-10 — Ulanzi 1.0.3

Backfilled after the fact from the `ulanzi-v1.0.2..ulanzi-v1.0.3` commit range,
so it lists only changes that provably touched `plugin-ulanzi/`.

- Ship the setup tutorial the Ulanzi review asked for, built on their SDK's own
  rails rather than a hand-rolled panel, with `en` / `ko_KR` / `ja_JP` copy
  ([#157](https://github.com/puritysb/AgentDeck/pull/157))
- Let the D200H animate, and give every key its own phase. Motion is baked into
  a looping GIF — Ulanzi Studio plays and loops it on the device, so a
  transition costs one push and steady-state motion costs nothing — which means
  every animated value has to return to its start on the same frame or the tile
  jumps once per loop. The phase rotation has one definition, because deriving
  it separately for "collect the frames" and "is this tile still current?" made
  every phase-shifted key read as permanently stale, so its encode was cancelled
  and requeued forever and the only symptom was that nothing animated
- Make the D200H voice key actually work — two bugs, both measured
  ([#158](https://github.com/puritysb/AgentDeck/pull/158))
- Measure what the D200H push path actually admits, and keep the plugin inside
  it rather than guessing at the limit

## 2026-08-07 — npm 1.0.8

### Setup — npm

- Let `npx @agentdeck/setup` finish on a machine with no coding-agent CLI.
  The installer refused to complete unless `claude` or `codex` was already on
  PATH — exactly the state of a computer that only has the Claude or ChatGPT
  desktop app installed, which is how the Ulanzi review team first met it.
  The CLIs were never a real prerequisite: the daemon and every device surface
  install and run without one, and sessions appear as soon as an agent does.
  The check now warns and points at the install commands instead of failing

## 2026-08-06 — 1.0.7

### Answering an agent's question from a device

- Answer AskUserQuestion from a device even when AgentDeck cannot reach the
  terminal. Until now the only working channel was typing into the session's
  own terminal, which needs subprocesses the sandboxed macOS daemon does not
  have — so on the App Store app every tap on a question was logged and
  dropped. Both daemons now hold the question's PreToolUse hook open and
  resolve it with the option the user picked, stated as the decision reason
  (the same channel STOP and the turn-end queue already use). It only engages
  when typing is unavailable, so nobody sitting at a reachable terminal waits
  for anything; an unanswered hold releases empty and Claude's own picker
  appears exactly as before — nothing ever proceeds on the user's behalf
- Ask each question of a multi-question prompt in turn. One AskUserQuestion
  call can carry up to four questions; only the first ever reached a device,
  and answering it left the old options on screen while the agent had moved on
  — so the next tap sent an index into a different list and silently picked the
  wrong answer. Questions are now presented one at a time and advance as each
  is answered, and a press carries the question it was answering so a late tap
  is dropped instead of misapplied
- Stop the deck from missing the follow-up question. The D200H compared two
  questions as identical (its repaint signature ignored per-session questions
  and options), opening a session blanked its live prompt with the daemon's
  global state, and both decks carried the previous question's page number into
  the new one
- Show the answer buttons as answerable in the Mac, iPhone/iPad and Android
  apps. They decided that from `controlMode` alone, so they refused sessions
  the daemon could answer and would have refused every held question too
- Select the option the user actually pressed. Typing an answer into a
  session's terminal sent the arrow keys and the Return that acts on them in
  one burst, and the picker resolved the Return against the cursor position
  from *before* the arrows — so every device answer silently chose the first
  option. Pressing "Blue" selected "Red". The keys are now paced apart, the
  way the dictated-prompt path already did it
- Require an answer to name the question it answers. Several surfaces map a
  hardware "approve" key to option 0 as a stand-in for a yes/no gate (ESP32
  mosaic, NFC approve tags). Against a permission gate that means something;
  against a four-way question it is a guess, and this path would have submitted
  it as the user's stated answer. A surface that renders the real choices can
  say which one it is answering; a binary approve key cannot, and is now
  refused rather than guessed at
- Hold a question only when some device can actually see it. The hold was keyed
  off "cannot type into this terminal", which is also true of a session the
  observer has not scanned yet — so the one case that stalled a terminal for
  the full hold was the case where nobody could answer
- Submit a grouped question instead of stranding it. A multi-question
  AskUserQuestion does not close when its last question is answered; it shows a
  "Review your answers → Submit answers" confirmation, which nobody was at the
  terminal to press, so the agent waited on a form the user could not see. The
  count that decides this is what Claude rendered, not what AgentDeck managed to
  parse — a question group dropped as malformed is still a tab in the user's
  form

### CLI and daemon — npm

- Archive the reply half of every conversation. `turns.response` was NULL for
  every recent hook-observed turn — the timeline showed the text while APME
  stored none of it, so the dashboard could not replay a conversation and the
  judge scored turns against silence. Both daemons now record the response on
  the branch that already has it
  ([#135](https://github.com/puritysb/AgentDeck/pull/135))
- Close runs abandoned by a daemon restart. Their tasks never closed, so they
  were never judged — 65 open tasks against 9 closed — and the existing orphan
  reaper only matched empty shells. The sweep also stopped stalling the daemon:
  covering indexes take it from 22s to 7ms on the real store
  ([#135](https://github.com/puritysb/AgentDeck/pull/135))
- Query Codex for the quota it can no longer write down. The rollout
  `rate_limits` block is a byproduct of a *successful* turn, so a passive read
  freezes one turn short of the wall and never sees usage spent on Codex Cloud
  or another machine; a throttled `codex app-server` query now backs it, and the
  fresher `capturedAt` wins ([#131](https://github.com/puritysb/AgentDeck/pull/131))
- Report whether the BLE panels are actually connected. Timebox Mini and
  iDotMatrix are driven by spawned Python clients that reconnect inside their
  own loop, so process liveness said nothing about the link and a powered-off
  panel still read as streaming; the clients now emit one status line per state
  change ([#132](https://github.com/puritysb/AgentDeck/pull/132))
- Start the Node summarizer on-device, matching the Swift daemon: the chain is
  now Foundation Models → MLX → Ollama → heuristic, so the same response no
  longer summarizes differently depending on which daemon happens to be up
- Stop offering embedding-only models as judge candidates — an embedder passed
  the setup screen and failed on the first real judge call
- Price local models correctly: `foundationModels:apple-intelligence` and
  `mlx-community/...` fell through to UNKNOWN_PRICE, which reads as *unpriced*
  rather than free, and grouped under provider `unknown` instead of `local`
- Trim `config/default-settings.json` to the keys a loader actually reads, with
  a drift gate — six of its seven top-level keys had no reader at all, and with
  no consumer nothing caught it claiming `judge.backend: mlx` while the code
  defaults to Foundation Models

## 2026-08-05 — npm 1.0.6

### CLI and daemon — npm

- Repair host push-to-talk end to end: the deck's hold-to-talk path now reaches
  the daemon's capture, transcription and reply legs as one working chain
  rather than a set of individually plausible halves, and a spoken reply is
  digested through one shared formatter
  ([#124](https://github.com/puritysb/AgentDeck/pull/124))
- Stop the Gateway model name from claiming rows that belong to other sessions
  ([#124](https://github.com/puritysb/AgentDeck/pull/124))

`1.0.5` shipped push-to-talk as a feature while that chain was still broken;
this is the patch that makes it work, so prefer it over `1.0.5`.

## 2026-08-05 — 1.0.5

### Android dashboard

- Target Android 16 (API 36). Google Play stops accepting uploads below API 36
  on 2026-08-31, and the app was still on 34 — under even the API 35 floor in
  force since 2025-08-31, so a bundle would have been rejected at upload rather
  than at review. The toolchain moved with it: AGP 8.13.2, Kotlin 2.3.21,
  Gradle 8.14.5, Compose BOM 2026.03.01
  ([#146](https://github.com/puritysb/AgentDeck/pull/146))
- Stop the two HUD rails from drawing through each other on phones. Tablets
  sized them against the screen; phones took a bare maximum width, so a 220dp
  session list and a 300dp topology rail overlapped by ~109dp on a 411dp
  display and the dashboard read as two interleaved columns of text
  ([#146](https://github.com/puritysb/AgentDeck/pull/146))
- Make the attention card opaque where it lands on those rails. At a 65% fill
  it was depth on a tablet and unreadable on a phone, with session names and
  quota figures showing through the agent's own question
  ([#146](https://github.com/puritysb/AgentDeck/pull/146))


### CLI and daemon — npm

- Validate the daemon port before a hook constructs a loopback URL, so a
  malformed or hostile port value cannot steer the request
  ([#105](https://github.com/puritysb/AgentDeck/pull/105))
- Discover iDotMatrix-protocol panels by advertised service UUID and known name
  families rather than the `IDM-` vendor prefix, so a rebranded but
  protocol-identical display (iPixel) is found by a scan instead of needing a
  hand-written address; `idotmatrixNamePrefixes` in `settings.json` widens the
  name fallback without a release
  ([#115](https://github.com/puritysb/AgentDeck/issues/115))
- Surface Claude per-model scoped usage limits, and date the Codex snapshot so a
  frozen percentage can no longer read as live
  ([#99](https://github.com/puritysb/AgentDeck/pull/99),
  [#121](https://github.com/puritysb/AgentDeck/pull/121))
- Resolve Claude usage OAuth credentials on Windows and Linux instead of only
  macOS ([#98](https://github.com/puritysb/AgentDeck/pull/98))
- Observe Codex Desktop sessions through OpenTelemetry and lifecycle hooks, and
  discover top-level Desktop rollouts without blocking scans
  ([#109](https://github.com/puritysb/AgentDeck/pull/109),
  [#111](https://github.com/puritysb/AgentDeck/pull/111))
- Track the interactive-prompt lifecycle through concurrent spinner redraws, so
  a queued prompt no longer leaves a session stuck awaiting
  ([#108](https://github.com/puritysb/AgentDeck/pull/108))
- Add an adaptive offline card feed with calendar events and an offline-reader
  projection, plus daemon-rendered glance frames for pull clients
  ([#110](https://github.com/puritysb/AgentDeck/pull/110),
  [#112](https://github.com/puritysb/AgentDeck/pull/112))
- Carry host push-to-talk from the deck through the daemon's voice ingest and
  egress path, including device audio replies
- Add `--weight` as an explicit deck/tab sort override, and
  `AGENTDECK_COMMANDER_ARGS` / `AGENTDECK_<AGENT>_ARGS` as env-var default
  session arguments ([#62](https://github.com/puritysb/AgentDeck/pull/62),
  [#93](https://github.com/puritysb/AgentDeck/pull/93))
- Add opt-in cross-machine session attach over the existing daemon socket
  ([#53](https://github.com/puritysb/AgentDeck/pull/53)) and a Linux systemd
  `--user` daemon unit ([#54](https://github.com/puritysb/AgentDeck/pull/54))
- Stage ESP32 firmware for pull OTA
  ([#113](https://github.com/puritysb/AgentDeck/pull/113))
- Show subagent work as activity rather than as separate sessions

## 2026-07-30 — 1.0.4

### Stream Deck plugin

- First-class Stream Deck XL (32 keys) and Stream Deck + XL (36 keys, 6 dials)
  support, with importable bundled profiles per device model
  ([#94](https://github.com/puritysb/AgentDeck/issues/94),
  [#97](https://github.com/puritysb/AgentDeck/pull/97))
- Windows joins macOS through a cross-platform system layer: media-key volume,
  Start-menu app launch, and browser fallbacks
  ([#96](https://github.com/puritysb/AgentDeck/pull/96))
- Adapt the Codex usage encoder to a single live window, and keep a session's
  detail from wearing the previous session's model
  ([#100](https://github.com/puritysb/AgentDeck/pull/100),
  [#124](https://github.com/puritysb/AgentDeck/pull/124))
- Wire the hold-to-talk VOICE key to the host's microphone

### Android dashboard

- Propagate live panel profile changes to the monitor service and daemon
  registration, and harden the e-ink DeviceProfile evidence so a reader is not
  misclassified ([#106](https://github.com/puritysb/AgentDeck/pull/106),
  [#107](https://github.com/puritysb/AgentDeck/pull/107))
- Surface Claude per-model scoped usage limits, and date the Codex snapshot so
  a frozen percentage cannot read as live
  ([#99](https://github.com/puritysb/AgentDeck/pull/99),
  [#121](https://github.com/puritysb/AgentDeck/pull/121))
- Unify device classification into a DeviceProfile SSOT
  ([#89](https://github.com/puritysb/AgentDeck/pull/89))
- Honour the `--weight` session sort override
  ([#62](https://github.com/puritysb/AgentDeck/pull/62))

### CLI and daemon

- Ship the iDotMatrix and Timebox Mini Python BLE clients in
  `@agentdeck/bridge` instead of resolving files that only exist in a source
  checkout
- Prepare optional BLE dependencies lazily under
  `~/.agentdeck/python-ble`, preserving npm installs as PyPI-free and keeping
  the environment across global package upgrades
- Report missing or unprepared BLE support with `agentdeck ble status` /
  `agentdeck ble setup` guidance instead of crashing on a missing Python
  executable or silently disabling daemon sync

## 2026-07-29 — 1.0.3

### macOS and iPhone/iPad — App Store

- Bound the iOS connection indicator and add an explicit no-Mac path, so a
  persistent Bonjour browse can no longer render as an endless "Searching for
  AgentDeck…" ([#114](https://github.com/puritysb/AgentDeck/pull/114)) — the
  correction for the 2026-08-04 Guideline 2.1(a) rejection of iPhone/iPad 1.0.2
- Discover iDotMatrix-protocol pixel panels by their advertised service UUID
  and known name families instead of the `IDM-` vendor prefix, so a rebranded
  but protocol-identical display (iPixel) appears in Scan
  ([#115](https://github.com/puritysb/AgentDeck/issues/115))
- Repair host push-to-talk in the in-process daemon: capture, transcription and
  the spoken reply form one working chain, stale capture files are swept, and
  the Gateway model name no longer claims rows belonging to other sessions
  ([#124](https://github.com/puritysb/AgentDeck/pull/124)). Delivery to an
  *observed* session remains the queued-directive ladder — a prompt dictated to
  an idle session waits for that session's next turn end
  ([feature matrix](docs/appstore-feature-matrix.md))
- Date the Codex usage snapshot so a frozen percentage cannot read as live
  ([#121](https://github.com/puritysb/AgentDeck/pull/121))

### Stream Deck plugin

- Restore Windows Marketplace installation instead of disabling an existing
  locally linked plugin when the macOS-only store manifest is applied
- Make Volume functional on Windows through built-in media keys and make
  Launcher/offline help open Start-menu apps or browser fallbacks, while
  preserving richer macOS volume readback and existing-tab focus

### CLI and daemon

- Stop the Node Bonjour publisher from claiming the Mac's own `.local` hostname
  and triggering macOS collision handling that renamed the computer on every
  daemon start
- Use a process-scoped service host that remains stable across sleep/wake and
  network recovery re-publication without mutating the system LocalHostName

### Android dashboard

- Preserve observed AskUserQuestion activity so attention prompts remain visible
  instead of being folded into low-signal tool noise
- Show Claude and Codex subagent work as decorative orbiting activity around the
  parent creature without creating extra sessions or control targets
- Pair subagent start/completion rows per parent session and expire orphaned
  activity so stale satellites do not remain on the dashboard

## 2026-07-22 — 1.0.2

### Ulanzi plugin — D200H

- Add a Property Inspector to the action. Ulanzi's review reported that dragging
  the action onto a key left testers with no instructions: the action declared no
  `PropertyInspectorPath`, so Ulanzi Studio showed its own "Setup / Click for
  guide" placeholder with nothing behind it. Clicking now opens getting-started
  steps for both daemons and a live check that says whether one is reachable
- Packaging refuses to build an archive whose manifest names a Property
  Inspector the package does not contain

### ESP32 firmware

- Ship firmware for **every board marked Shipping** — T-Embed CC1101,
  T-Display-S3-Pro and the Waveshare C6-LCD-1.47 had no downloadable binary in
  `1.0.1` because the release matrix listed seven boards while ten were
  supported
- Name each asset by the board's canonical id (`agentdeck-ips_10.bin`), the same
  string `agentdeck esp32-ota <target>` takes, so a downloaded file is directly
  the update target; add `SHA256SUMS.txt` and the Wi-Fi OTA instructions
- Restore linking on the ESP32-classic boards: the per-session option list had
  grown `g_state` past TTGO's DRAM segment, so TTGO and TC001 now cap that array
  at two entries — neither surface can render an option list
- Voice: push-to-talk on the IPS10 touch panel and the T-Embed encoder, with the
  reply spoken back through the board's own speaker where one exists
- Restore JC8012P4A1C touch: the vendor-derived clear sequence wrote `0x88`,
  while `0x80` is the Silead touch-count register that actually starts the
  panel's scan core
- InkDeck and XTeink glance rendering, camera show-and-tell on the Focus Strip,
  and a Pocket phone-style UI for the camera strip

### Daemon and timeline

- Keep the Node daemon discovery registry healthy while the process is running,
  restoring a missing, malformed, or stale `daemon.json` every ten seconds
- Preserve hook timeline ingestion when the daemon binds a fallback port instead
  of silently sending Claude Code and Codex lifecycle events to an empty port
- Avoid overwriting another live daemon's discovery record during self-repair

### macOS and Android timeline

- Keep a focused observed Claude, Codex, OpenCode, Antigravity, or Codex App
  session visible when session-list IDs carry an `observed:<provider>:` prefix
  but timeline events use the agent's raw session ID
- Mirror the same session-ID canonicalization in macOS, Android, and the Node
  per-session history query to prevent client-specific timeline gaps

### Stream Deck plugin

- **Published on the Elgato Marketplace** (approved 2026-07-28) — the plugin now
  installs in one click from
  [its Marketplace listing](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464)
  instead of requiring a checkout and `streamdeck link`
- Remove MODEL key tiles entirely from passively observed Claude, Codex, and
  OpenCode sessions; model information without a deliverable selection action
  no longer occupies a button-shaped surface in idle, processing, or awaiting
  states

## 2026-07-22 — 1.0.1

Maintenance release across independently delivered channels — reliability fixes
that landed after the 1.0.0 build (03ed5a94) went to the App Store. Channels ship
on their own schedules; the iOS companion carries its fix on a later train while
1.0.0 finishes review.

### macOS app — App Store

- Fix the dashboard failing to attach to its own in-process daemon (WS connect
  handler was being clobbered and ports were mis-probed)
- Remove an actor-isolated closure that could trap at runtime
- Display-sleep correctness: re-sync `display_state` to clients, disarm two dim
  traps, and make iDotMatrix "off" render actually dark
- Recover a wedged ESP32 serial port by backing off instead of resetting the board
- Stop dropping whole tail windows on a split UTF-8 character (restores the Codex
  usage gauge)

### Stream Deck plugin — Elgato Marketplace

- Keep observed-agent processing details capability-aware on every keypad size:
  show the current model once as an inert readout instead of filling every unused
  key with duplicate `MODEL` tiles
- Preserve the notify-only Codex contract: processing details expose no steering
  action that the observed session cannot deliver

### Ulanzi plugin — D200H

- Publish the current self-contained 1.0.1 bundle for every declared macOS and
  Windows architecture
- Keep D200H rendering dark while the host display sleeps instead of allowing a
  later session repaint to wake the keys

### iOS companion (ships after 1.0.0 review completes)

- Hold the screen awake while the paired Mac's display is on

## 2026-07-20 — 1.0.0

First public release. Previous 0.x versions were development and TestFlight-only builds.

### macOS / iOS app — App Store

The macOS app is **standalone**: it embeds an in-process Swift daemon and needs no
Node.js, no CLI, and no companion install. The iOS/iPadOS app is a read-only
companion that pairs with a Mac on the same network.

- Live session dashboard for Claude Code, Codex, OpenCode, and OpenClaw — state,
  tool calls, timeline, and token/usage gauges
- APME evaluation — per-turn scoring, cost accounting, and a Pareto-frontier model
  recommender
- Device Preview gallery — 17 hardware surfaces rendered without owning any hardware
- Local-network pairing over Bonjour with QR-code enrollment
- Voice input via on-device speech recognition
- Opt-in Claude Code hook installer

Sandboxed with no subprocess execution, no home-relative-path entitlement, and no
App Groups; the local WebSocket accepts same-machine and paired-companion clients only.

### Stream Deck plugin — Elgato Marketplace

- Session-per-button keypad layout with encoder dials and a live touch-strip timeline
- Renders an explicit OFFLINE state when no daemon is present
- Requires the Stream Deck app 6.9+

### Ulanzi plugin — Ulanzi Marketplace

- D200H Deck Dock support through a single dynamic action whose keys reflow by agent
  state (sessions, options, mode, stop, usage)
- Ships `@resvg/resvg-js` native binaries for every declared macOS/Windows target
- Requires Ulanzi Studio 2.1.4+

### CLI and daemon — npm (optional)

`npx @agentdeck/setup` installs the `agentdeck` CLI, daemon hub, and lifecycle hooks
for Claude Code, Codex, and OpenCode. This unlocks the Tier-2 surfaces the sandboxed
app cannot reach — ADB-bridged Android devices, serial/BLE matrix displays, and
ESP32 WiFi OTA. Everything in the App Store app works without it.

### Android app — GitHub Release (APK)

E-ink-first dashboard for CremaS, Onyx, Kobo, and tablets. Not distributed through
Google Play.

### ESP32 firmware — GitHub Release

Prebuilt firmware for 86 Box, IPS 3.5", Round AMOLED, IPS 10.1", InkDeck (7.5"
e-ink), and TTGO T-Display. Flash over USB, then update over WiFi with
`agentdeck esp32-ota <target>`.
