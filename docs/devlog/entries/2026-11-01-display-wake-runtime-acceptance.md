# 2026-11-01 — Display wake latency and installed runtime acceptance

Catalog exclusion: dated maintainer acceptance evidence, indexed by the devlog;
not a design specification.

The installed Mac app already contained newer Dot/Hermes UI than the Swift audit
branch. The display changes were ported onto `aa9202be` rather than replacing that
UI with the older audit build. The local installation remains version 1.9.5,
build 5, with Dot Preview enabled, the same Apple Development signing identity,
provisioning profile and entitlements. This is a local development update, not a
Store submission. Runtime fixes are `2cb093d4` and `281759c3`.

## Delay and recovery boundaries

The Node monitor's original two-second CG sample could miss a short transition.
Its five-second presence poll could also retain a recently observed lock after
CG reported the display awake. Applying `Promise.all` results together let an
unrelated slow power probe delay a completed presence observation. Actual logs
showed CG wake at 04:30:46.303 UTC and the next observed unlock at 04:30:48.523.
That is not evidence that the full earlier ten-second observation had one cause:
that older measurement had no paired Mac transition timestamp.

The monitor now samples CG every 250ms, applies independent successful probes as
they finish, and briefly rechecks presence after hardware wake. Rechecks are
bounded to two seconds and stop once the display is on. An observed lock is never
cleared merely because CG reports awake; unknown probe results retain state.
The independent wake reference and nonblocking test commands avoid counting
request/fade time or measurement-loop blocking as daemon latency.

Display/presence wake previously invoked full device recovery. A pre-fix isolated
Node process even opened two shared USB boards despite its no-device posture.
Display events now retain live transports in both runtimes; genuine system resume
still owns recovery. Node serial resume additionally checks that serial is running.
The affected temporary process was stopped. The final supervised shared restart
re-armed the boards using the unchanged shared token; all original 11 serial ports
were confirmed connected. Do not infer that a disabled module cannot be activated
through a recovery callback.

## Signed app and real device measurements

A sandboxed, signed derivative of the final current Release used private port
19450, with Gateway and device producers disabled. Only the Pantone and Lenovo USB
reverse tunnels were temporarily redirected. Their application data and saved
server addresses were not edited. Each phase restored the original tunnel.
The Lenovo QA package uses component `dev.agentdeck.qa180/dev.agentdeck.MainActivity`:
`am start` can print an activity error with exit status zero, so check its output.
An Android-client health projection is expected after a real device connects; it
is not an active hardware writer.

Times below are observed milliseconds after the independent Mac CG transition.
Pantone measures both LED engines' power bits; Lenovo measures the Android
brightness setting, not optical lux or a claim of LCD hardware power-off.

| Configuration | Pantone off/on | Lenovo brightness off/on |
| --- | ---: | ---: |
| Swift only | 440 / 847 | 245 / 663 |
| Node only | 239 / 841 | 237 / 848 |
| Node owner + Swift client | 398 / 1,001 | 241 / 1,055 |

The actual `/Applications/AgentDeck.app` was then updated with its old bundle
preserved for rollback. Exactly one supported `agentdeck daemon restart --no-build`
restarted the shared supervised service: PID 12363/build `8fe2909f2930` became
PID 63505/build `2e74dc230e94`, on port 9120. Its running CG helper was inspected
and uses the new 250ms sample. The actual installed app is connected as its client.

| Actual shared installation | Off | On |
| --- | ---: | ---: |
| Pantone LED power | 314ms | 1,466ms |
| Lenovo brightness | 379ms | 1,486ms |
| Pixoo brightness readback | 547ms | 1,514ms |

Original Node settings, pairing-token digest, network posture and all 11 serial
ports matched. All 200 original timeline rows remained byte-equivalent after
canonical JSON comparison. Pantone's entire captured vendor preset table,
Lenovo's brightness/mode/timeout and both USB mappings matched their originals;
Pantone rotation remained 0/0. Check restoration while the host is awake: a later
idle sleep legitimately reapplies the temporary close mode and is not lost data.
The check used a short-lived power assertion, not changed macOS power settings.

## Verification scope

Current runtime Quick passed 7,054 tests with 42 skipped. The macOS suite executed
1,388 tests: one unrelated saved-endpoint timing test failed under concurrent
build load, then its class passed on a focused rerun. The scoped arm64 Dot Preview
Release receipt is committed; it is not universal-archive or Store acceptance.
Real system sleep, other physical-device families and photometric measurements
are outside these display-only receipts. Existing Node/Swift wire repair cadences
remain as safety nets.
