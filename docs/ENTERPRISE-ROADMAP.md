# Enterprise Roadmap

Improvement plan for the scenario AgentDeck was never designed for: **many users, each
running their own daemon, on one corporate network — and sometimes on one machine.**

Everything below was read out of the current tree (2026-08-15, `master` @ `7f6d2538`).
Line references are anchors, not quotes; re-grep before editing.

> **Status (2026-08-17).** The shared-*subnet* half has shipped — items 6, 7, 9,
> 10, 12 and 16 in §7, plus `daemon start --local/--loopback`, `daemon install
> --enterprise`, posture inheritance across `daemon restart`, and the Swift
> daemon's Settings-driven posture (item 12). See
> [docs/daemon.md § Enterprise and shared-network posture](daemon.md#enterprise-and-shared-network-posture).
>
> The shared-*machine* half (§1.2–§1.4, §2.1–§2.2 — UID checks, unique mDNS
> instance names, pair-then-pin) is **deliberately not done**: this deployment
> has many users on one network, none sharing a host. Those items stay written
> down here because the day one machine is shared, they are the first five
> things that break. Nothing below was deleted just because it was deferred.

Difficulty is **S** (< 1 day), **M** (1–3 days), **L** (> 3 days, or crosses a
generated-mirror / release boundary).

---

## 0. The assumption that breaks

AgentDeck's security and discovery model rests on one sentence, written down in
`CLAUDE.md`:

> **One machine has one pairing token, and the daemon currently serving the port is its
> custodian.**

That is true for the product as designed — a home desk, one human, a fleet of LAN
gadgets. In a company it fails on both axes at once:

| Axis | Home assumption | Office reality |
|---|---|---|
| Machine | 1 user | Shared devbox / jump host / fast user switching / SSH multi-login |
| Subnet | 1 daemon | 5–50 daemons advertising the same service, same name, same beacon |
| Trust | "same machine ⇒ same person" | Same machine ⇒ *a different employee* |
| LAN devices | The point of the product | Usually absent; the LAN surface is pure attack surface |

The fixes split cleanly along that line: **§1–§2 close the multi-tenant holes** (must
fix before anyone deploys this at work), **§3–§5 give an admin an off switch** for the
LAN behaviour they don't want, and **§6** answers Robin.

---

## 1. Port conflict — and the trust that rides on it

### 1.1 What the code actually does

Port window is 20 ports, shared by daemons *and* session bridges
(`bridge/src/session-registry.ts:66-70`):

```
BASE_PORT = 9120, MAX_PORT = 9139
findAvailablePort({ reserveDaemon: true })   // sessions start at 9121
```

`isPortFree` binds `0.0.0.0` (`session-registry.ts:228-237`), so it does detect a port
another OS user holds. Allocation itself is **correct**. Exhaustion throws rather than
colliding (`session-registry.ts:249`).

So the mechanical answer to "does 9120 conflict?" is: *yes, and it is handled.* The
problems are what happens **after** the fallback.

### 1.2 P0 — a second OS user's daemon adopts the first user's pairing token

`agentdeck daemon start` probes the canonical port, and on finding any daemon there
**adopts its pairing token** (`bridge/src/cli.ts:703` → `bridge/src/auth.ts:142`):

```ts
if (adoptPeerToken(incumbent.pairingToken)) { … }   // writes ~/.agentdeck/auth-token
```

It can read `pairingToken` because the full `/health` payload
(`bridge/src/daemon-server.ts:1471`) is served to any **local** connection, and
`isLocalConnection` (`bridge/src/auth.ts:164-176`) is a pure IP test — it knows nothing
about UID. On a shared host, user B's `daemon start` silently copies user A's
credential into user B's home directory.

That was a *feature* when the two daemons were the Node CLI and the sandboxed macOS app
belonging to the same human. With two humans it is a credential leak with no log line
the victim ever sees.

**Fix**: gate the adopt on same-UID ownership of the incumbent. The peer's PID is
already in the health payload; resolve its UID (`process.getuid()` vs `ps -o uid= -p`,
or `libproc` on Swift) and refuse to adopt across users, logging why. **M** · ~2 days
including the Swift mirror (`AuthManager.adoptPeerToken`).

### 1.3 P0 — a second OS user's CLI can stand down the first user's daemon

Same call site (`bridge/src/cli.ts:710`): if the incumbent is a Swift daemon, the CLI
POSTs `/stand-down`. That route sits behind the same local-is-trusted gate. Any local
user can demote any other local user's daemon to client mode, and `/shutdown`
(`session-registry.ts:~480`) can stop it outright.

The Swift side is symmetric and worse, because it is automatic:
`reclaimCanonicalPortIfNeeded` (`apple/AgentDeck/Daemon/DaemonService.swift:707`) polls
the canonical port, and on seeing a healthy daemon there **stands itself down and
connects as a client** (`DaemonService.swift:718-720`). User B's macOS app, running on
a fallback port, will attach itself to user A's daemon and render user A's sessions,
prompts, and project names in user B's dashboard.

**Fix**: same UID check on the operator routes (`/shutdown`, `/stand-down`,
`/pair/open`, `/pair/status`, `/pair/close`), and a UID check on the reclaim/stand-down
decision before `connectToExternalDaemon`. **M** · ~2 days (two daemons, plus tests
that drive the real state machine — a truth table over the predicate is not a gate; see
`ConnectionOverlayTests` for the pattern).

### 1.4 P0 — a session bridge with no daemon of its own joins someone else's

`findDaemonPortAsync` (`session-registry.ts:530-565`) falls back to scanning the whole
window for `mode: 'daemon'` when the caller's own `daemon.json` is missing or stale.
For a user who has never run `agentdeck daemon start`, the first hit is a **coworker's**
daemon. The session registers there; that coworker's Stream Deck can then focus it and
inject keystrokes into the PTY (`observed-inject.ts` / `observed-steering.ts`).

Note what is *already* right and should not be changed: the hook installer resolves the
port through `$HOME/.agentdeck/daemon.json` (`hooks/src/install.ts:66`), which is
per-user and therefore correct.

**Fix**: the scan must confirm ownership before attaching — same UID, or an explicit
`--daemon-host`/token. Refuse-and-explain is the right failure, not silent attach.
**S** · ~1 day.

### 1.5 P1 — 20 ports is thin for a shared box

Daemons and session bridges draw from one 20-port window. Five users with three
sessions each exhausts it and the twenty-first process throws. Nothing is corrupted, but
the error ("Stop an existing session first") names the wrong cause.

**Fix**: make the window configurable (`AGENTDECK_PORT_WINDOW=9200-9219`, plus a
persistent `daemonPort` for the CLI to match the Swift app's `AppPreferences.daemonPort`
at `apple/AgentDeck/App/AppPreferences.swift:44`), and make the exhaustion message name
the real cause when other UIDs hold ports. **S** · ~1 day.

### 1.6 P2 — machine-global side effects

- `adb reverse` (`bridge/src/adb-reverse.ts:5`) maps a device-side `9120` to the host
  port. `adb` itself is one server per machine: two users' daemons fight over the same
  device and the last writer wins. Worth a startup warning, not a redesign. **S**
- `bridge/src/pixoo/pixoo-settings.ts:11` (and the timebox/idotmatrix twins) read
  `homedir()/.agentdeck` directly, ignoring `AGENTDECK_DATA_DIR`. Harmless today,
  wrong under any per-user relocation an admin would attempt. **S**

---

## 2. mDNS / broadcast interference

### 2.1 P0 — every daemon publishes the *same* mDNS instance name

Node (`bridge/src/mdns.ts:148`) and Swift (`apple/.../MdnsModule.swift:43`) both
publish:

```
name: `${projectName}-${port}`      // projectName is the literal 'AgentDeck' for daemons
                                    // → "AgentDeck-9120" on every machine in the office
```

An mDNS instance name is required to be unique **per network segment**, not per host.
Fifty daemons therefore fight over one name. The Node side does not rename on conflict:
`isNonFatalMdnsError` (`mdns.ts:41`) matches `"already in use on the network"`,
`invalidateMdnsInstance` destroys the responder, and the 5-second recovery timer
(`MDNS_RECOVERY_INTERVAL`, `mdns.ts:9`) republishes — **forever**. On a busy subnet this
is a permanent republish storm, one per daemon, and no daemon stays reliably resolvable.

There is prior art for how bad naming here gets: issue #67, where the responder's
hostname claim renamed users' Macs. `MDNS_SERVICE_HOST` was made process-unique for
exactly that reason (`mdns.ts:21`) — the **instance name** never got the same treatment.

**Fix**: make the instance name identify the host and the user
(`AgentDeck-<shortHostname>-<uidHash>-<port>`), keep the TXT `v: '3'` contract, and add
`host`/`user` TXT keys so clients can filter. Both daemons must move together; the TXT
schema version is already documented as a lockstep contract. **M** · ~2 days including
the ESP32/Apple/Android read side.

### 2.2 P0 — clients pick a daemon with no identity filter

The ESP32 takes the **first** service whose TXT says `agent=daemon`
(`esp32/src/net/mdns_discovery.cpp:41-57`). In an office that is an arbitrary
colleague's daemon; the board then dials it, gets closed 4001 for lack of a token, and
retries forever with nothing on screen the user can act on. `discoverDaemons`
(`bridge/src/mdns-discover.ts:99-104`) is the same shape — it returns every confirmed
daemon and the caller takes the head unless `hostHint` is set.

**Fix**: pair-then-pin. A board that holds a credential must prefer the endpoint it is
paired with and must not roam to an unpaired daemon just because it answered first. The
credential rules from #145/#149 already say "a known endpoint inherits the credential it
is paired with" — this is the missing selection half. **M** · ~2 days, firmware +
`mdns-discover.ts` + the two mobile discovery paths.

### 2.3 P1 — UDP beacons multiply

`advertiseUdpBroadcast` (`bridge/src/broadcast.ts:28-30`) sends to
`255.255.255.255:9121` **and** the `/24` broadcast address every **2 seconds**. Fifty
daemons = 50 pps of broadcast that every host on the segment must take an interrupt for,
and that many corporate WLAN controllers rate-limit or flag.

Two things make this worse than it looks:

- **Nothing in this repository consumes it.** No UDP 9121 listener exists in `esp32/`,
  `apple/`, or `android/` — the beacon exists for the external XTeink fork. So on a
  corporate LAN it is pure noise today.
- **The Swift daemon has no broadcast module at all** (`apple/AgentDeck/Daemon/Modules/`
  has no `BroadcastModule.swift`). The two daemons already disagree; codifying "off by
  default" costs nothing in parity.

**Fix**: default the broadcast module **off**, opt in via settings for the fork's users;
and back the interval off when no client has ever been seen. **S** · ~0.5 day.

### 2.4 P2 — every ESP32 board claims one `.local` hostname

`MDNS.begin("agentdeck-display")` (`esp32/src/net/mdns_discovery.cpp:13`) is a fixed
string. Two boards on a subnet — trivially true once two employees own one — collide on
`agentdeck-display.local`. Suffix it with the MAC. **S** · ~0.5 day, but it is firmware,
so it costs an OTA cut (`agentdeck esp32-ota`) and a binary delta note.

---

## 3. `AGENTDECK_LOOPBACK_ONLY` — currently one line deep

Today the flag does exactly one thing (`bridge/src/daemon-server.ts:2895`):

```ts
const bindHost = process.env.AGENTDECK_LOOPBACK_ONLY === '1' ? '127.0.0.1' : '0.0.0.0';
```

The startup log (`daemon-server.ts:2941`) promises "LAN devices cannot connect", which
is true of *inbound* traffic and says nothing about what the daemon still emits. With
the flag set, the daemon continues to:

- publish `_agentdeck._tcp` over multicast (`MdnsModule.shouldActivate` returns true for
  anything but explicit `false` — `bridge/src/modules/mdns-module.ts:16`);
- send the 2-second UDP broadcast beacon (`broadcast-module.ts:20`);
- sweep the LAN for Pixoo devices (§5);
- start BLE scans (`idotmatrix-module.ts:16`, `timebox-module.ts:13`).

It advertises a service nobody on the LAN can reach. For an enterprise that is the
worst of both worlds: the noise without the function.

**Fix**: make the flag mean *loopback-only*, not *bind-only* — force
`{ mdns: false, broadcast: false, pixoo: false, timebox: false, idotmatrix: false }`
and skip the adb reverse, then say so in the startup line. Keep the env var as the
low-level primitive and layer the CLI flag (§4) on top. **S** · ~1 day.

**Also**: the flag does not exist on the Swift side at all. The macOS App Store build
has no way to be told "loopback only" — it cannot read process env meaningfully. It
needs an `AppPreferences` toggle wired to the same module set, surfaced in Settings.
**M** · ~2 days.

---

## 4. `agentdeck daemon start --local`

`--local` exists on `claude` / `codex` / `opencode` / `monitor`
(`bridge/src/cli.ts:453, 494, 553, 610`) but **not** on `daemon start`
(`cli.ts:677-682`, options are `-p / -d / -f / --wake-word`). The daemon is the only
process that actually runs hardware modules, so the flag is missing from the one command
where it matters.

Two defects to fix in the same pass:

1. **The `--local` module record is incomplete.** All four call sites write
   `{ mdns: false, adb: false, serial: false, pixoo: false, timebox: false }` —
   `idotmatrix` is absent, and `initModules` defaults an absent key to `'auto'`
   (`bridge/src/modules/index.ts:49`). `IDotMatrixModule.shouldActivate` returns true
   whenever auto-discover is on, which is the default
   (`idotmatrix-settings.ts:65-67`). So `agentdeck claude --local` — documented as
   "Disable all device modules" — still spawns the Python BLE client. `broadcast` is
   likewise absent from the record and only saved by the forced overlay in
   `bridge/src/index.ts:458-459`.

   Root cause is the shape: an allow-list of literal keys drifts every time a module is
   added. Replace it with a derived "all off" record built from the module registry, so
   a new module cannot be forgotten. **S** · ~0.5 day.

2. **Add the flag to the daemon**, meaning the union of §3: loopback bind, no mDNS, no
   broadcast, no LAN sweep, no BLE, no adb. Persist it (`--local` written into
   `daemon.json` / settings) so `daemon install`'s LaunchAgent / Scheduled Task /
   systemd unit inherits it — an enterprise install is an autostart install, and a flag
   that only works when typed by hand is not deployed. **M** · ~1.5 days across the
   three service writers (`bridge/src/windows-service.ts`, `linux-service.ts`, the macOS
   LaunchAgent path).

Recommended spelling, since "local" is already overloaded and an admin will want the
*posture* not the module list:

```
agentdeck daemon start --local          # existing meaning: no device modules
agentdeck daemon install --enterprise   # loopback bind + no discovery + no sweep + no BLE
```

with `AGENTDECK_ENTERPRISE=1` as the env equivalent, so it can be set fleet-wide by MDM.

---

## 5. Pixoo auto-discovery off by default

Current behaviour, on by default (`isPixooAutoDiscoverEnabled` returns true unless
`pixooAutoDiscover: false` — `bridge/src/pixoo/pixoo-settings.ts:59`):

1. **A call to a Chinese cloud endpoint.** `discoverDevices()` fetches
   `https://app.divoom-gz.com/Device/ReturnSameLANDevice`
   (`bridge/src/pixoo/pixoo-client.ts:378`). Unannounced third-party egress from a
   developer machine is a compliance finding on its own in most enterprises.
2. **A full `/24` sweep.** 254 hosts, concurrency 40, 600 ms timeout
   (`bridge/src/pixoo/pixoo-discover.ts:88-92`) — an HTTP probe against every address on
   the subnet. That is, to a corporate IDS, a horizontal port scan. Executed by every
   developer's machine, on every daemon start.
3. **The Swift daemon does it too**, and repeats it: `autoDiscoverIfNeeded`
   (`PixooModule.swift:1105`) at startup and `attemptRediscoverIfStuck`
   (`PixooModule.swift:563`) every 300 s while a configured device is unreachable, at
   concurrency 32.

The comment at `pixoo-discover.ts:14` already names the hazard — "avoid grabbing a
neighbour's frame on a shared LAN" — and solves only the *ownership* half by requiring
zero configured devices. The *scanning* half is unguarded.

**Fix**, in priority order:

- Flip the default to **off**; `agentdeck pixoo scan` (`cli.ts:2106`) stays as the
  explicit opt-in, which is where a scan belongs — user-initiated, in the foreground,
  with output. **S** · ~0.5 day, both daemons + the Swift `attemptRediscoverIfStuck`
  path.
- Make the cloud call opt-in separately from the sweep. They are different disclosures.
  **S**
- Gate both behind `--enterprise` unconditionally, regardless of the settings file, so
  an admin's posture cannot be overridden by a user editing `settings.json`. **S**

Same reasoning applies to the BLE auto-scans (`idotmatrix`, `timebox`) — lower urgency
because BLE does not cross the corporate network, but they should ride the same switch.

---

## 6. Robin's three asks — feasibility

These came in as external product feedback. Assessed against the tree, not against
intent.

### 6.1 "ChatGPT compatibility"

**Partly shipped; the gap is Windows and is already scoped.**

macOS already observes Codex sessions launched from the ChatGPT desktop app: one
`app-server` pid holds one open rollout file per conversation, and the desktop app fires
the `codex_*` lifecycle hooks from `~/.codex/config.toml` carrying `session_id` + `cwd`.
That is the measurement recorded in **issue #143**, which is open and assigned-by-ask to
the Windows contributor.

Three holes, all in `bridge/src/passive-observer.ts`, all Windows-only:

| Hole | Current | Needed |
|---|---|---|
| Process scan | `ps -ww -eo …` | `Get-CimInstance Win32_Process` |
| pid → rollout | `lsof` / `/proc/<pid>/fd` | Windows handle enumeration, or hooks-as-identity |
| Host-app resolution | matches `/*.app/` only | `ChatGPT.exe` shape |

**Verdict: feasible, M–L (~4–6 days)**, and the *unmeasured* part is the risk, not the
code: whether the Windows ChatGPT client bundles Codex the same way and reads
`%USERPROFILE%\.codex\config.toml` is unknown. Measure the producer before porting
anything. If "ChatGPT compatibility" instead means the ChatGPT web/app *without* Codex —
no local process, no rollout file, no hooks — then it is **not feasible**: there is
nothing on the machine to observe.

### 6.2 "Install with npx alone"

**Already true, with three honest caveats.**

`npx @agentdeck/setup` (`setup/src/setup.ts`) installs the bridge, writes the Claude
hooks, seeds the data dir, and prints next steps. It does not require Stream Deck — the
check is a soft warning and names the alternatives (`setup.ts:131`). Codex and Claude
are both accepted as the agent.

Caveats an enterprise will hit:

1. **`node-pty` may build from source.** The prebuilt path is tried first
   (`setup.ts:169-190`) and only falls back to a source build, which needs Xcode CLT on
   macOS or `build-essential` on Linux. On a locked-down corporate machine that fallback
   is where the install dies.
2. **It is not fully one-command.** The user still runs `agentdeck daemon install`
   afterward (`setup.ts:483-496`). Folding that in behind a flag is **S**.
3. **`npx` reaches the public npm registry.** Behind an internal mirror this needs
   `--registry`; worth documenting rather than fixing.

**Verdict: shipped. To make it enterprise-grade — `--enterprise --yes` doing setup +
daemon install + loopback posture in one line — S, ~1 day**, and it is the natural
delivery vehicle for §4.

### 6.3 "China App Store"

**Feasible but expensive, and the blockers are regulatory, not technical.**

- **ICP filing (备案) is mandatory.** Since 2023 Apple requires an ICP filing number for
  any app distributed on the China storefront, and a filing requires a **Chinese
  business entity or a licensed local publisher**. AgentDeck is a personal hobby project
  by a Korean individual. This is the hard blocker and no code change moves it.
- **Localization does not exist.** There is no `.lproj` anywhere in `apple/`, and the
  only `strings.xml` is Android's. The design-system carries `ko`/`ja` reader
  translations but the app itself is not localized. zh-Hans is **M**, ~3 days, and is
  wasted work until the filing question is answered.
- **A network-capable app draws extra scrutiny.** The app binds a LAN listener and
  speaks to LAN hardware. The existing App Store invariants
  (`docs/appstore-feature-matrix.md`, `apple/APP_REVIEW_NOTES.md`) are written for a
  reviewer reading English; they would need a China-specific pass.
- **Ironically, §5 helps here.** The Divoom cloud endpoint
  (`app.divoom-gz.com`) is a third-party data flow that a China review would want
  declared. Turning it off by default removes the disclosure.

**Verdict: not actionable on the current entity. Recommend declining with the reason,
and revisiting only if a local publisher relationship appears.** If the underlying ask is
"Chinese users can't install it", the npm path (§6.2) already works there and costs
nothing.

---

## 7. Prioritized backlog

**P0 — multi-tenant correctness. Nothing ships to an office until these land.**

| # | Item | Diff | Est. |
|---|---|---|---|
| 1 | UID check before `adoptPeerToken` (§1.2) | M | 2d |
| 2 | UID check on `/shutdown`, `/stand-down`, `/pair/*`, and the Swift reclaim decision (§1.3) | M | 2d |
| 3 | Daemon port-scan fallback must not attach to another UID's daemon (§1.4) | S | 1d |
| 4 | Unique mDNS instance name per host+user, both daemons (§2.1) | M | 2d |
| 5 | Clients prefer their paired endpoint over first-seen (§2.2) | M | 2d |

**P1 — the enterprise off switch.**

| # | Item | Diff | Est. | Status |
|---|---|---|---|---|
| 6 | `AGENTDECK_LOOPBACK_ONLY` disables discovery + sweeps + BLE, not just the bind (§3) | S | 1d | **done** — `network-posture.ts`; revised 08-17: ADB reverse survives loopback (USB tunnel into the host's own loopback, same test as serial) |
| 7 | `--local` record derived from the module registry; fixes the `idotmatrix` leak (§4.1) | S | 0.5d | **done** — `allModulesOff()`; the leak was also in the *default* session record, not only `--local` |
| 8 | `daemon start/install --enterprise`, persisted into the autostart unit (§4.2) | M | 1.5d | **done** — argv-baked into all three writers; `daemon restart` inherits via `/health` |
| 9 | Pixoo auto-discovery default off, cloud call opt-in separately (§5) | S | 1d | **done** — default off (Node + Swift); `pixoo scan --no-cloud` splits the two disclosures |
| 10 | UDP broadcast default off; back off when unused (§2.3) | S | 0.5d | **superseded** — off under `--local`/`--loopback`; a global default-off still open (§2.3) |
| 11 | Configurable port window + persistent CLI daemon port (§1.5) | S | 1d | open |
| 12 | Swift-side enterprise posture toggle in Settings (§3) | M | 2d | **done** (08-17) — Settings → Local server toggles → `DaemonPosture` (loopback bind, Bonjour skipped, module registration gated deny-by-default); posture rides Swift `/health` for `qr`/`pair`/`restart` parity |

**P2 — cleanup.**

| # | Item | Diff | Est. | Status |
|---|---|---|---|---|
| 13 | ESP32 mDNS hostname suffixed with MAC (§2.4) — costs an OTA cut | S | 0.5d | open |
| 14 | Device settings honour `AGENTDECK_DATA_DIR` (§1.6) | S | 0.5d | open |
| 15 | Warn when `adb reverse` collides with another user (§1.6) | S | 0.5d | open |
| 16 | `npx @agentdeck/setup --enterprise --yes` one-liner (§6.2) | S | 1d | **done** — `--enterprise` implies `--yes` and runs `daemon install --enterprise` |

**Robin's asks.**

| # | Item | Diff | Est. | Verdict |
|---|---|---|---|---|
| 17 | Windows ChatGPT/Codex observation (issue #143) | M–L | 4–6d | Feasible; measure Windows first |
| 18 | npx-only install | — | shipped | Item 16 polishes it |
| 19 | China App Store | L | — | Blocked on ICP filing; decline for now |

Rough totals: **P0 ≈ 9 days**, **P1 ≈ 7.5 days**, **P2 ≈ 2.5 days**.

---

## 8. Notes for whoever implements this

- **The UID checks are one predicate, not five.** Put it in `bridge/src/auth.ts` beside
  `isLocalConnection` and mirror it once into Swift. Five hand-written copies is how
  `rawSessionId()` drifted into three different agent lists.
- **Test the state machine, not the predicate.** A truth table over
  `isSameUserDaemon()` stays green while the call site forgets to call it. Drive
  `daemon start` against a fixture daemon owned by a different UID.
- **`--enterprise` must survive `daemon install`.** A posture that only applies when
  typed by hand is not a posture. The LaunchAgent / Scheduled Task / systemd writers are
  three separate files.
- **Don't fold the enterprise switch into `--local`.** They answer different questions:
  `--local` means "no hardware", `--enterprise` means "no LAN behaviour at all". Some
  offices will want hardware on a lab subnet with discovery off.
- **The mDNS rename touches the TXT contract** (`v: '3'`), which is documented as
  lockstep between the two daemons and read by firmware. Bump it together or not at all.

## 9. Open questions

1. **Is the shared-machine case real for us, or only the shared-subnet case?** The P0
   list is ordered for "both". If nobody ever runs two users on one box, items 1–3 drop
   to P1 and the total halves. Worth answering before starting.
2. **Does anyone still consume the UDP beacon?** If the XTeink fork has moved on, the
   broadcast module can be deleted rather than defaulted off.
3. **What is the enterprise actually deploying — the CLI, the App Store app, or both?**
   The Swift work (items 12, and half of 2 and 4) is only needed for the app.
