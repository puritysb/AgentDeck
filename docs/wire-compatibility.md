---
id: spec.wire-compatibility
title: Wire Compatibility Contract
description: What may change on the daemon↔client wire without breaking software already in users' hands — change classes, the retain-on-absent merge rule, freshness axes, and how to introduce a genuinely breaking change.
category: Specs
locale: en
canonical: true
status: stable
owner: Bridge maintainers
reviewed: 2026-08-09
revision: 2026-08-09
source_of_truth: shared/src/protocol.ts
validators: [pnpm test, pnpm generate-protocol]
---
# Wire Compatibility Contract

`docs/protocol.md` lists **what** the daemon and its clients say to each other. This document says **what you are allowed to change about it**, because most of AgentDeck's consumers are software we cannot update: apps on the App Store, a plugin on the Elgato Marketplace, firmware flashed onto boards on someone's desk.

Scope is the daemon↔client surface: the dashboard WebSocket, the daemon's HTTP routes, discovery, and the ESP32 serial link. The Gateway frame protocol has its own contract in `docs/gateway-protocol.md`; the authentication boundary has its own in [Daemon Hub → LAN security model](daemon.md). This document does not restate either.

## 1. The compatibility surface

Every change ships into a fleet that is already running. As of 2026-08-09:

| consumer | shipped as | updatable by us? |
|---|---|---|
| iOS / iPadOS companion | App Store 1.0.4 | no — user updates, on Apple's schedule |
| macOS app (+ in-process Swift daemon) | App Store 1.0.4 | no |
| Stream Deck plugin | Elgato Marketplace 1.0.2 | no — DRM-signed, review-gated |
| Ulanzi D200H plugin | Ulanzi Marketplace 1.0.3 | no |
| ESP32 firmware | flashed; WiFi OTA where reachable | partly — a board that is off, or serial-only, keeps its old build |
| Node CLI / bridge | npm 1.0.15 | yes — `npx @agentdeck/setup@latest` |

Only the last row updates when we say so. Design every wire change for the other six.

## 2. What the version rule does and does not promise

The repository rule is that numeric `X.Y.Z` versions are mutually compatible exactly when `X.Y` matches, and `pnpm verify-version` enforces it.

That rule is about **field-level** evolution, and it is silent about everything in §3 that is not field-level. Every consumer in the table above is `1.0.x`, so `verify-version` will call them all compatible no matter what you do to the shape of a payload. A green `verify-version` is not evidence that a wire change is safe.

## 3. Change classes

### Safe — additive, ignored by clients that do not know them

- **A new optional field on an existing message.** Swift `Codable`, Kotlin, and the TS types all ignore unknown keys.
- **A new top-level event `type`.** `BridgeEventParser.parse` returns `nil` for an unrecognised `type` and logs it; the other surfaces dispatch the same way. An old client silently skips the event.
- **A new value in an open-ended string field** where the consumer already has a `default` branch — `StreamDeckDeviceInfo.family` is deliberately `String` rather than an enum for exactly this reason.

### Breaking — even though it looks additive

- **A new *kind of row* in an existing collection.** `sessions_list` is the canonical trap. Every shipped client treats each element as a session: it is sorted into the deck, **consumes a physical key**, counts toward session totals, and is tappable. A client that has never heard of your discriminator field cannot opt out of rendering the row. This is what blocked PR #163, which appended synthetic `codex-goal:<threadId>` entries: correct in the new code, and a corrupted deck on every 1.0.x client.
- **A new session-id namespace.** Ids are normalised (`rawSessionId` / `sameSession`), matched by prefix after devices truncate them to 31 characters (`resolveSessionIdPrefix`), and pattern-matched in several surfaces. A new prefix silently misses all of it.
- **Reinterpreting an existing field.** Worse than removing it: consumers keep parsing successfully and act on the old meaning. There is no error to notice.
- **Removing a field.** This is a consumer migration, not a deletion — see issues #145 → #149, where dropping the pairing token from discovery made three independent clients destroy their own stored credential, because each treated absence as "clear it". Grep the **consumers**, and specifically the code that *stores* the value.

### The rule behind the last two

> **Absence means "no information". It never means "empty".**

A client merging retain-on-absent (`s.x = e.x ?? s.x`) cannot distinguish "unchanged" from "cleared" unless you make the cleared case explicit.

## 4. Optional booleans must carry both signals

In a retain-on-absent protocol, a flag that is only ever sent when `true` can be set but never retracted. It latches, permanently.

Never write `x || undefined` or `x ? true : undefined` on the producer side. Emit the explicit `false`.

`usageStale` demonstrated both halves of this within eight days: 2026-07-17 added only the positive signal, and the missing negative signal then pinned a "stale" badge over live percentages on the macOS dashboard until relaunch (2026-07-25). Producers: `bridge/src/usage-event.ts`, `DaemonServer.buildUsageEvent`.

When a legacy producer may still omit the key, the consumer precedence is **explicit flag > data presence > retain** — never data-presence as a peer of the flag, since "had data, now stale" legitimately ships numbers alongside `true`.

## 5. Freshness is three axes, and none of them is a hard signal

Usage snapshots carry three independent qualifiers. Collapsing any of them into "hide the gauge" is a bug:

| axis | question | signal | consumer behaviour |
|---|---|---|---|
| **stale** | has this *window* ended? | `resetsAt` in the past | drop the gauge — the number describes a window that no longer exists |
| **age** | how old is this *reading*? | `capturedAt`, compared against the **consumer's own** clock | keep rendering, dimmed, with the age in place of the countdown |
| **plan** | was this minted under a plan the account still holds? | snapshot `planType` vs live tier | void — an explicit windowless snapshot on the wire |

Two rules that fall out:

- **Age is derived at the consumer, never shipped as a producer-computed boolean.** Such a flag freezes between pushes exactly like the number it qualifies — which is how a 4-hour-old 94% once read as live.
- **A missing `capturedAt` is "unknown", not "old".** Never dim on an absent stamp.

The grace window for a just-reset gauge is 1 hour, in `adjustUsagePercent` (TS) and `formatResetTime(graceSeconds:)` (Swift). Adding a fourth rule at a fourth layer with a different constant is what PR #161 attempted; if the policy is wrong, change it where it already lives.

## 6. Introducing a genuinely breaking change

Two supported routes. Pick one; do not skip straight to emitting.

1. **Capability negotiation.** Clients already announce themselves with `client_register` (`clientType`, `clientLabel`, `devices`). Gate the new payload on a client having asked for it, and emit nothing to everyone else. Costs one field; makes the change invisible to the fleet.
2. **A new event type.** Unknown `type` values are dropped by every shipped client (§3), so a separate event is inherently safe where a new row in an existing collection is not.

Both keep the old shape intact. Bumping `X.Y` is not a third option while `1.0.x` clients are live — nothing in the fleet re-negotiates on a version change.

## 7. Constraints inherited from the auth boundary

Full model in [Daemon Hub → LAN security model](daemon.md). Three invariants constrain wire design and are repeated here only because they are easy to violate from a message-shape change:

- **Discovery names an endpoint; it never carries a credential.** mDNS TXT, the UDP 9121 beacon, and the unauthenticated `GET /health` advertise `authRequired` and nothing secret.
- **Never add an unauthenticated route.** Unauthenticated LAN peers reach exactly one: minimal `GET /health`.
- **Compare bridges by endpoint (host+port), never by full URL string** — a paired URL carries `?token=`, and a full-string compare against a tokenless discovered URL never matches.

## 8. Review checklist

For any diff touching `shared/src/protocol.ts` or a payload builder:

- [ ] Does it add a **row kind** or an **id namespace** to an existing collection? → §6 first.
- [ ] Does any new boolean have an explicit `false` path? → §4.
- [ ] Does a removed or renamed field have a consumer sweep, including code that *stores* it? → §3.
- [ ] Is a new cross-surface constant defined once with a drift gate, rather than mirrored by hand? → CLAUDE.md, "Cross-platform rules are SSOT-first".
- [ ] Were the generated mirrors regenerated (`pnpm generate-protocol`) — remembering that a comment-only edit still drifts them?
- [ ] Would a 1.0.x client that has never heard of this change render something wrong, or merely render nothing?

The last question is the one that matters. "Renders nothing" is a safe change. "Renders something wrong" is not.
