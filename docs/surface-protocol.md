---
id: spec.surface-protocol
title: AgentDeck Surface Protocol v1
description: The stable external boundary for independent dashboards, control surfaces, portable readers, and display-only clients without exposing AgentDeck's entire internal daemon API.
category: Specs
locale: en
canonical: true
status: stable
owner: Surface protocol maintainers
reviewed: 2026-08-24
revision: 2026-08-24
source_of_truth: docs/surface-protocol.md
validators: [pnpm docs:check, pnpm test]
---

# AgentDeck Surface Protocol v1

AgentDeck is both a product family and a surface platform. Official dashboards,
firmware, and deck integrations can coexist with independently maintained readers,
panels, and control applications, but that does not make every daemon message a
public API.

This document defines the stable external boundary: **AgentDeck Surface Protocol
v1**. It is an allow-listed contract over the existing authenticated daemon
transports. The full TypeScript union in
[`shared/src/protocol.ts`](../shared/src/protocol.ts) remains the implementation
wire for first-party clients. Events or commands absent from a Surface profile are
internal even when an external client can observe them on the socket.

The existing wire is not renamed, removed, or reinterpreted by this contract.
Current AgentDeck apps, plugins, and firmware continue to use it unchanged.

## 1. Product and ownership boundary

### Official AgentDeck products

Official products are maintained and released by the AgentDeck project:

- macOS AgentDeck Dashboard;
- iOS and Android AgentDeck Companion apps;
- AgentDeck ESP32 Dashboard Firmware, including InkDeck;
- official Elgato Stream Deck and Ulanzi Studio integrations.

Official status describes ownership and release responsibility. It does not grant a
client extra network privileges; official and independent clients cross the same
authentication boundary.

### Compatible Companion Projects

Compatible Companion Projects are separate products that use an AgentDeck Surface
profile while retaining their own name, repository, releases, issue tracker, and
product decisions. Current reference cases are:

- **Pocket Daily Reader**, an offline-first reader in a separate repository. It
  uses `portable-reader/v1`; AgentDeck is a background sync source, not its visible
  product shell.
- **Bitfocus `companion-module-agentdeck`**, an independently maintained control
  integration targeting `companion-control/v1`.

Compatibility never implies that AgentDeck maintains the project, that the project
may use AgentDeck trademarks as its own identity, or that its issues belong in the
AgentDeck tracker.

## 2. Compatibility levels

The level is recorded in the integration manifest and displayed with the project.
It is independent of the profiles and capabilities the client uses.

| Level                   | Meaning                                                                                             | Required evidence                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Community**           | Independent project listed as useful to AgentDeck users. Compatibility is maintained by its author. | Own repository and issue tracker, declared Surface profile, basic security and attribution review.                                                           |
| **Verified Compatible** | Independent project passed the published conformance suite against named AgentDeck daemon versions. | Schema-valid manifest, passing fixtures and negative cases, verification date and evidence URL. Re-test is required when the declared profile major changes. |
| **Official**            | Maintained and released by the AgentDeck project.                                                   | AgentDeck-owned release channel plus the same conformance gates.                                                                                             |

“Verified Compatible” is a compatibility statement, not an endorsement or transfer
of ownership. A listing can move back to Community when its evidence becomes stale.
A level never bypasses pairing, authorization, action gating, or OTA identity checks.

## 3. Protocol model

Surface Protocol v1 uses existing daemon port `9120` and existing authentication:

- WebSocket for live profiles;
- `GET /feed` and `POST /outbox` for a wake-sync-sleep reader;
- optional WebSocket Inbox as an invalidation channel for a portable reader.

There is no unauthenticated Surface route. Loopback and paired-LAN behavior stays as
defined in [`docs/daemon.md`](daemon.md). Discovery identifies an endpoint and never
carries a credential.

Each client chooses one primary profile per connection or HTTP sync. Capabilities
refine that profile; they do not grant access outside it.

| Profile                | Transport                         | Stable baseline                                                       | Typical client                           |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `dashboard-live/v1`    | WebSocket                         | live session roster, connection state, usage, and timeline projection | rich dashboard                           |
| `companion-control/v1` | WebSocket                         | live roster plus capability-gated, correlated session control         | Bitfocus or hardware control integration |
| `portable-reader/v1`   | HTTP pull/push; optional WS Inbox | Card Feed, Glance, conditional pull, and offline Outbox               | Pocket Daily Reader                      |
| `display-only/v1`      | WebSocket                         | connection state and bounded session projection; no commands          | status panel or sign                     |

The `/v1` suffix is the profile's major version. Compatible additions stay within
that major. A semantic break requires a new profile major that runs in parallel.

### Rollout status

As of 2026-08-24, the Node daemon implements the `portable-reader/v1` runtime:
all-or-nothing HTTP identity headers on Feed, Outbox, Glance Frame, and pull OTA;
capability intersection; header-driven Pocket projection; ordered/idempotent Outbox;
full-tuple OTA staging and download; and bounded `surface_welcome` negotiation.
Headerless clients and `surface=pocket-reader` retain their previous baseline.
Resumable OTA clients may offer `ota.resume-206`; negotiated clients receive
`206 Partial Content` for `?from=` downloads, while older clients receive the
same remaining bytes with status `200` so an already persisted partial image can
still converge instead of requiring SD-card recovery. `GET /esp32/fw` also
accepts an optional `limit=<bytes>` cooperative response budget, clamped to
32–512 KiB. Current Pocket Daily requests 128 KiB so it can yield to input
between bursts; legacy clients omit it and receive 256 KiB to reduce reconnects.
For firmware carrying a `CrossPoint version` build identity, a later Feed whose
`AgentDeck-Client-Version` matches that identity acknowledges installation and
clears the persisted stage. The daemon re-fingerprints the staged file before
accepting that acknowledgement, preserving a rebuilt-in-place image.
On a dual-homed daemon host, Surface Feed, Glance Frame, and pull OTA may return
`307` to the host interface sharing the device's Wi-Fi path. Outbox is handled
on the accepted interface for compatibility with Pocket builds that predate
explicit POST replay; current clients can replay its idempotency-keyed body but
are not required to do so. Successful clients cache the redirected GET origin
as their next preferred route.

The in-process Swift daemon serves a weather-only Card Feed envelope, validates the
same eight Pocket identity headers, and negotiates a bounded subset:
`feed.pull`, `feed.conditional`, and `glance.read`. It does not grant Outbox,
Glance Frame pixels, pull OTA, device telemetry, or Inbox and therefore must not
advertise full Node portable-reader conformance. WebSocket Inbox is not implemented
or granted by either daemon. Pocket Daily remains
Community / untested until a named release is exercised against the live conformance
suite; implementation does not itself promote the integration.

## 4. Registration and negotiation

### WebSocket registration

Live clients keep sending the existing `client_register`. A Surface-aware client
adds an optional `surface` object; old daemons ignore it and old clients do not send
it.

```json
{
  "type": "client_register",
  "clientType": "companion",
  "clientLabel": "Bitfocus Companion — AgentDeck",
  "surface": {
    "protocol": 1,
    "clientId": "io.bitfocus.companion.agentdeck",
    "clientVersion": "1.16.0",
    "productId": "io.bitfocus.companion.agentdeck",
    "profiles": [
      {
        "id": "companion-control/v1",
        "capabilities": ["sessions.read", "usage.read", "permission.decide", "prompt.select", "review.run"]
      }
    ]
  }
}
```

A negotiating daemon selects one offered profile and the intersection of known
capabilities, then replies only to that connection:

```json
{
  "type": "surface_welcome",
  "protocol": 1,
  "profile": "companion-control/v1",
  "capabilities": ["sessions.read", "usage.read", "permission.decide", "prompt.select", "review.run"],
  "serverVersion": "1.0.24"
}
```

`surface_welcome` is a new event type, so current clients safely ignore it. Until
all supported daemons emit it, a v1 client may enter **legacy baseline mode** after
a bounded timeout: it may use only the baseline messages listed for its profile,
must treat every optional capability as unavailable, and must fail closed on control
whose actionability cannot be proven. A Verified Compatible result records whether
the tested daemon used negotiated or legacy baseline mode.

Negotiation rules:

1. the protocol major and profile major must be exact matches;
2. unknown profiles are not silently mapped to a broader profile;
3. unknown capabilities are ignored, never treated as granted;
4. control is enabled only by the server-returned capability intersection;
5. no welcome or a rejected offer leaves a client read-only except for the documented
   legacy baseline;
6. a reconnect negotiates again; grants are connection-scoped and are not persisted as
   authority.

### HTTP registration

`portable-reader/v1` carries its declaration on every request because the device
does not keep a connection open. The following request headers are stable and
non-secret:

| Header                       | Value                                     |
| ---------------------------- | ----------------------------------------- |
| `AgentDeck-Surface-Protocol` | `1`                                       |
| `AgentDeck-Surface-Profile`  | `portable-reader/v1`                      |
| `AgentDeck-Client-Id`        | reverse-DNS implementation id             |
| `AgentDeck-Client-Version`   | client release version                    |
| `AgentDeck-Product-Id`       | stable product id, distinct from hardware |
| `AgentDeck-Capabilities`     | comma-separated capability tokens         |
| `AgentDeck-Board`            | hardware/firmware target, when applicable |
| `AgentDeck-Update-Channel`   | product update channel, when applicable   |

Existing query parameters (`surface`, `sig`, `board`, `batt`, `mv`, `rssi`) remain
valid. Headers are preferred for identity because request logs routinely include
URLs. The existing token transport is unchanged and must never be copied into a
manifest, capability, discovery record, or diagnostic fixture.

No Surface headers means legacy mode. If any one Surface header is present, all eight
are required and the request fails closed on a wrong protocol/profile/product tuple.
Repeated `productId`, `board`, or `updateChannel` query values are correlation only:
they must equal the headers and never override them.

## 5. Capability registry

Capability names are lowercase dotted tokens. Their meaning is immutable once
published. New names are additive; changing a name's meaning requires a new name or
profile major.

| Capability              | Meaning                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `sessions.read`         | consume the bounded `sessions_list` projection                                           |
| `usage.read`            | request and consume `usage_update`                                                       |
| `timeline.read`         | consume timeline events and request per-session history                                  |
| `display-state.read`    | consume host display/dim state                                                           |
| `session.focus`         | focus or clear focus for a named session                                                 |
| `permission.decide`     | answer a live `requestId` gate with Allow or Deny                                        |
| `prompt.select`         | select a wire option with session and question correlation                               |
| `session.prompt`        | send bounded prompt text to a named, controllable session                                |
| `session.interrupt`     | interrupt a named, controllable session                                                  |
| `session.escape`        | send Escape to a named, controllable session                                             |
| `review.run`            | request and consume an independent review result                                         |
| `feed.pull`             | retrieve Card Feed over HTTP                                                             |
| `feed.conditional`      | echo `deckSig` and accept `unchanged` responses                                          |
| `outbox.push`           | push persisted offline decisions and process terminal results                            |
| `glance.read`           | render the optional daemon-authored Glance block                                         |
| `weather.snapshot.read` | persist the bounded provider-attributed weather outlook                                  |
| `weather.cues.display`  | schedule daemon-authored weather cues while disconnected                                 |
| `weather.cues.notify`   | request local attention for an unexpired cue, subject to user permission and quiet hours |
| `inbox.ws`              | receive a bounded feed-invalidated hint over WebSocket                                   |
| `ota.feed`              | receive a product-isolated pull-OTA advert in Card Feed                                  |
| `device.telemetry`      | send bounded battery/link telemetry with a pull                                          |

Capabilities state what a client can exchange, not what a product must render.
Pocket Daily may consume Glance while intentionally omitting AgentDeck branding and
live session rows from its own home screen.

## 6. Profile contracts

### dashboard-live/v1

Baseline daemon-to-client messages are `connection`, `sessions_list`,
`usage_update`, `timeline_event`, and `timeline_history`. The client sends
`client_register`, `query_usage`, and—when `timeline.read` is granted—
`query_session_timeline`.

This profile is for a rich live dashboard, not a promise that every field of the
internal `state_update`, APME, voice, device-module, or layout events is public.
Unknown top-level events and unknown optional fields must be ignored.

### companion-control/v1

The read baseline is `connection`, `sessions_list`, `usage_update`,
`review_status`, and `review_result`. Commands are separately capability-gated:

- `permission_decision` requires `permission.decide` and a live `requestId`;
- `select_option` requires `prompt.select`, `liveAnswerable: true`, the session id,
  the displayed wire index, and a `question` echo;
- `focus_session` / `clear_session_focus` require `session.focus`;
- `review_run` requires `review.run`;
- prompt, interrupt, and escape operations require their respective capabilities
  and a named session.

`state: awaiting_*` alone is never authority. A client keeps a decision visible
until the daemon confirms a new state and invalidates all pending control on
disconnect or stale timeout. Arbitrary `session_command.command.type` values are
outside v1 even though the internal daemon currently accepts an open object.

### portable-reader/v1

This profile makes a disconnected reader useful and honest:

1. `GET /feed?surface=pocket-reader` pulls a bounded `CardFeedResponse`;
2. `POST /outbox` pushes decisions recorded before UI removal;
3. `glance` is optional and full-response only;
4. `live`, `day`, and `info` action classes govern cached behavior;
5. `deckSig` is persisted and echoed with `?sig=` for conditional pull;
6. `unchanged: true` means keep the saved cards and Glance, re-anchor time, and
   sleep without rewriting the cache;
7. each Outbox result is terminal when acknowledged, including `expired`,
   `unknown_card`, and `rejected`;
8. `board`, `productId`, and capabilities identify different facts and never
   substitute for one another.

#### Seven-day offline weather

`glance.weather` remains backward compatible with the current/today/tomorrow
fields and may add `issuedAt`, `validUntil`, `timeZone`, `source`, up to seven
`days`, and up to eight `cues`. The daemon normalizes provider data and authors
the cues; a constrained reader never infers a notification threshold from raw
forecast points.

A `portable-reader/v1` client that negotiates `weather.snapshot.read` receives
a compact five-day projection (`date`, WMO `code`, min/max temperature, and an
optional real provider probability). Clients without that capability retain
the current/today/tomorrow baseline, so the richer ribbon is additive.

- `deckSig` covers the complete weather snapshot and cue list. An `unchanged`
  response retains the persisted copy.
- Cue times are epoch-ms. A reader schedules only with a trusted clock anchored
  by `serverTime`.
- `(id, revision)` is the delivery-dedup key. A full replacement cancels
  previously cached cues that are no longer present.
- A cue may enter ambient UI at `displayAt`; local attention may occur at
  `notifyAt` only when `weather.cues.notify` was negotiated and the user allowed
  it. Local quiet-hours always win, and a missed/past `notifyAt` is never replayed.
- A cue is never newly displayed or notified after `expiresAt`. Forecast UI is
  hidden or explicitly marked stale after `validUntil`.
- Provider attribution is cached with the snapshot. A Verified Compatible
  client claiming weather support must expose its text and URL (a QR/About view
  is acceptable for a display without a browser). Optional provider-supplied
  dark/light mark URLs let capable color surfaces render the required trademark;
  the attribution text remains the offline fallback.
- Probability is optional because global providers may supply precipitation
  amount but no probability. Clients never manufacture a percentage.

Both public daemons use the keyless MET Norway Locationforecast service for the
portable snapshot and respect its `Expires`/`Last-Modified` cache contract. The
Swift app may separately use native WeatherKit for its own local Dashboard, but
Apple Weather data is not exported as the portable feed or persisted for the
reader's seven-day offline window. A public-provider failure serves a
future-bearing persisted MET snapshot until its own `validUntil`; it does not
silently switch the reader's provider.

The complete v1 Card Feed shapes are the `CardFeedResponse`, `FeedCard`,
`CardFeedGlance`, `OutboxPushRequest`, and `OutboxPushResponse` subset in
[`shared/src/protocol.ts`](../shared/src/protocol.ts). The constrained-firmware
mapping and byte budgets remain in
[`docs/esp32-client-contract.md`](esp32-client-contract.md).

#### Optional WebSocket Inbox

This capability is reserved but not active in the 2026-08-24 runtime. The Node
daemon deliberately removes `inbox.ws` from Pocket's negotiated intersection, and
the published Pocket manifest does not request WebSocket transport. The following
shape defines the intended invalidation-only boundary, not a current grant.

`inbox.ws` is an invalidation channel, not a second feed. After normal registration,
the daemon may send:

```json
{
  "type": "surface_inbox",
  "profile": "portable-reader/v1",
  "message": {
    "id": "01J5Y8W7Y3K5J8H2Q0N7B6M4F2",
    "kind": "feed_changed",
    "deckSig": "4a7c12ef",
    "createdAt": "2026-08-24T03:15:00Z"
  }
}
```

The only v1 kind is `feed_changed`. It tells the reader to schedule `GET /feed`;
it never carries cards or permission decisions. Duplicates are harmless, delivery is
best-effort, and a sleeping device loses nothing because HTTP remains authoritative.

### display-only/v1

Baseline messages are `connection` and `sessions_list`. `usage_update`, timeline,
and display state are opt-in capabilities. The client sends only
`client_register` plus read refresh requests whose capability was granted. It never
sends session, prompt, approval, review, utility, voice, or OTA commands.

## 7. OTA identity and isolation

An update target is the tuple:

```
(productId, board, updateChannel)
```

- `productId` identifies the product/firmware line, for example
  `dev.agentdeck.dashboard-firmware` or `io.pocketdaily.reader`.
- `board` identifies the hardware and image geometry, for example `inkdeck`,
  `xteink_x3`, or `xteink_x4`.
- `updateChannel` identifies the product-owned release stream, such as `stable`,
  `beta`, or `nightly`.

All three values must match before an OTA advert is returned or an image is staged,
downloaded, or installed. Matching `board` alone is insufficient: two products can
run on the same board and still have incompatible partitions, boot policy, assets,
or user-data ownership.

Rules:

1. manifests declare product ids, supported boards, and allowed channels;
2. a daemon indexes new OTA stages by the full tuple and never falls back across
   product ids or channels;
3. a feed advert repeats the tuple and its artifact digest; clients reject a partial
   or mismatched identity before download;
4. changing a product id is a new product line, not a rename;
5. `board` remains the device-registry and hardware diagnostic key;
6. existing AgentDeck firmware that predates product identity may use an explicit
   `dev.agentdeck.dashboard-firmware + board + stable` legacy mapping;
7. once a client supplies `productId`, legacy board-only lookup is disabled for that
   request and device;
8. Pocket Daily artifacts are built and released from the Pocket Daily repository;
   AgentDeck never publishes or substitutes them.

The current board-only `fw` object remains readable for legacy firmware. The additive
Surface form is:

```json
{
  "fw": {
    "productId": "io.pocketdaily.reader",
    "board": "xteink_x4",
    "updateChannel": "stable",
    "size": 1847296,
    "md5": "8ff9c4f89ac2d26d1f32d4672f1d77f2"
  }
}
```

Node CLI staging examples:

```bash
# Safest for an independent product: resolve one exact identity from its manifest.
agentdeck esp32-ota xteink_x3 --firmware firmware.bin --stage \
  --manifest /path/to/agentdeck-surface.json

# Equivalent explicit form.
agentdeck esp32-ota xteink_x3 --firmware firmware.bin --stage \
  --product-id io.pocketdaily.reader --update-channel stable
```

X3/X4 staging without either form is rejected. The manifest must resolve exactly one
matching tuple; ambiguity is an error. AgentDeck stages a user-supplied artifact but
does not build, sign, release, or re-label Pocket Daily firmware.

## 8. Integration manifest

Every listed integration should publish an `agentdeck-surface.json` file. The draft
schema is
[`schemas/surface-protocol/v1/integration-manifest.schema.json`](../schemas/surface-protocol/v1/integration-manifest.schema.json).
Reference fixtures are alongside it and are illustrative drafts; they do not claim
that either independent repository has already adopted the file.

The manifest records:

- integration id, name, version, ownership, repository, issue tracker, license, and
  maintainers;
- compatibility level and conformance evidence;
- profiles, transports, and requested capabilities;
- product ids and, for firmware products, the permitted OTA identity tuples;
- support boundaries and whether legacy baseline mode is required.

A manifest is metadata, never authority. The daemon validates the live registration,
authenticates the connection, intersects capabilities, and evaluates each action
against current session state.

## 9. Evolution and deprecation

Safe v1 changes are limited to:

- a new optional field with retain-on-absent semantics;
- a new top-level event ignored by old clients and gated by a capability when it
  changes behavior;
- a new capability token;
- a new optional manifest property;
- tighter prose that does not reinterpret existing values.

The following require a new profile major or a parallel event:

- removing or renaming a field;
- changing a field's meaning, unit, polarity, or identifier namespace;
- adding a new row kind to an existing collection;
- making an optional field required;
- broadening a control capability;
- changing the meaning of an Outbox terminal status or action class;
- weakening the OTA identity tuple.

Unknown optional fields and unknown top-level event types must be ignored. Optional
booleans are emitted in both polarities; absence means “no information,” never false
or clear. Control clients fail closed on unknown values.

No v1 baseline message is removed during the v1 lifetime. A deprecation is announced
in this document, the schema, and `surface_welcome`, and remains supported for at least
180 days and two Node daemon releases, whichever is later. Marketplace apps and flashed
firmware may lag longer, so a v2 path runs beside v1 until measured fleet evidence makes
retirement safe.

## 10. Schema, fixtures, and conformance

The manifest and portable-reader schemas establish the versioned public subset without
importing the entire internal protocol schema:

```
schemas/surface-protocol/v1/
├── integration-manifest.schema.json
├── portable-reader.schema.json
├── portable-reader-outbox-request.schema.json
├── portable-reader-outbox-response.schema.json
└── fixtures/
    ├── bitfocus-companion.json
    ├── pocket-daily-reader.json
    └── portable-reader/
        ├── weather-seven-day.json
        ├── unchanged.json
        ├── outbox-request.json
        ├── outbox-response.json
        └── surface-welcome.json
```

`portable-reader.schema.json` bounds the public Card Feed/Glance shape, including seven
weather days and eight cues. The two Outbox schemas independently validate the HTTP
request and its positional terminal acknowledgements. Unknown optional properties stay
allowed so an additive v1 producer does not break a tolerant client. The checked-in
examples are secret-free canonical conformance fixtures, not a claim about a daemon or
integration release that has not been named and tested.

`weather-seven-day.json` and `unchanged.json` are secret-free, sanitized Node
portable-feed captures; `surface-welcome.json` is pinned byte-for-byte to the Node
negotiator in its runtime test. Outbox fixtures exercise the same pure applier used by
the HTTP route. A release conformance report still captures fresh frames from the
specific daemon build under test. Swift's documented weather-only subset needs its
own evidence, but full `portable-reader/v1` conformance evidence is required only if
Swift later claims the complete profile.

The current runner is
`pnpm vitest run scripts/__tests__/surface-protocol-manifest.test.ts
scripts/__tests__/surface-protocol-portable-reader.test.ts`. Future live-profile schemas
belong in this same directory only when their allow-listed event projections are ready;
absence of a whole-internal-wire schema is deliberate.

The conformance runner should test:

- manifest validation and unique ids/capabilities;
- negotiation intersection, unknown profile/capability behavior, and legacy baseline;
- unknown event and optional-field tolerance;
- explicit false retraction and retain-on-absent merging;
- action correlation (`requestId`, session id, question echo, live actionability);
- Card Feed full/unchanged responses, Glance omission, action classes, ordered
  terminal Outbox results, idempotency, and bounded payloads;
- auth refusal and token redaction in fixtures/logs;
- full-tuple OTA isolation, including same-board/different-product negative cases;
- both daemon implementations wherever the profile is supported.

A Verified Compatible report names the manifest digest, integration release, daemon
implementation/version, selected profile, capability intersection, fixture set, test
timestamp, and result. A screenshot or a successful socket connection is not a
conformance result.

## 11. Relationship to existing contracts

- [`shared/src/protocol.ts`](../shared/src/protocol.ts): internal implementation
  wire and source for the currently mapped public subsets.
- [`docs/protocol.md`](protocol.md): internal daemon/client event reference.
- [`docs/wire-compatibility.md`](wire-compatibility.md): fleet-safe evolution rules
  that Surface Protocol inherits.
- [`docs/esp32-client-contract.md`](esp32-client-contract.md): constrained C/C++
  mapping for display and portable-reader clients.
- [`docs/daemon.md`](daemon.md): authentication, discovery, and network posture.

When these documents appear to conflict for an external integration, this Surface
Protocol document decides what is public, while the narrower security and constrained
firmware rules still apply within their domains.
