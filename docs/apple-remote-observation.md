# Apple remote observation — read-only monitoring

**Product implementation: 2026-11-09, unreleased.** Standard macOS/iOS targets now
include the read-only product path. The checkpoints below describe the earlier
development experiment; they do not attest this new implementation or Production.

## Product contract and operation

Mac Settings → Remote monitoring explicitly enables publication from the app's
currently pinned local daemon, whether Swift-owned or a Node client. It follows
that daemon's actual endpoint; a selected LAN host, capture fixture or stale
roster cannot become this Mac's publisher. The app owns the scheduler outside
Dashboard window lifetime. Closing the window leaves sharing enabled; quitting
or sleeping the Mac stops new observations. An unavailable source publishes
unknown counts, never a fabricated empty roster or task-success claim.

iPhone/iPad has independent Direct and Remote tabs, including before local
onboarding or pairing is completed. Direct opens the paired-Mac dashboard.
Remote shows shared Mac activity in place over iCloud. Counts, source time and
opaque attention IDs remain the default. A separate **Share session and usage
details** setting on the Mac adds up to 24 live session rows with agent type,
state, start time and observed child/background counts. It also adds account
allowance percentages with their original observation and reset times. Codex
uses the Mac app's native account reader and existing Codex folder grant in
either daemon mode. In external mode, z.ai comes from the pinned local Node
daemon's timestamped provider reading. In standalone mode, it comes from the
Mac app's provider reader. Claude has no native account allowance source.
Percentages describe each reported window. Ended windows disappear.
Aggregate-only clients continue to read the same encrypted snapshot field.
Turning off detailed sharing replaces that snapshot with counts only on the
next successful publication. An offline reader can retain its last saved
observation until it reconnects or the observation expires.

Remote never populates DashboardState, exposes approval controls, or sends a
command. Session titles, paths, questions, transcripts and provider credentials
stay local.
Both devices use the same Apple Account. Remote receiving and visible alerts
each require explicit user actions. Normal active refresh is coalesced to 60
seconds; foreground return, pull/button refresh and notification hints can refresh
sooner. Background execution and push delivery are not guaranteed.

Product storage is isolated from PoC consent/data in local
`remote-observation-v1-Development` / `remote-observation-v1-Production` files and
the private custom zone `RemoteObservationV1`. Build identity and signed CloudKit
environment must agree. Consent, caches and pending cleanup never move between
Development and Production, even on the same Apple Account; both environments
require separate enrollment. Account binding hashes include the environment.
It uses new record types
`ObservationSnapshot` and `AttentionEvent`; existing probe records/subscriptions
are not imported or deleted. Snapshot `latest` has one installation owner and
increasing revisions with compare-and-save. Counts and event content use a new
encrypted `payload` field; routing, version, revision and retention dates are
clear. JSON dates are UTC integer milliseconds; CloudKit date fields are Dates.
The schema and indexes are defined by the additive
[schema fragment](../apple/CloudKit/remote-observation-v1.ckdb).

An initial roster establishes a baseline without notifying existing waits.
Subsequent episodes use stable random IDs persisted before upload. Snapshot and
event mutations commit atomically. An uncertain save is reconciled by fetching
the same event ID; resolved, expired or source-unconfirmed episodes may update
an existing record but may not create a catch-up alert. Explicit non-waiting
evidence resolves an event. Disappearance after a disconnect alone does not.
Only event creation matches the visible subscription; resolution updates do not
create another alert. Subscription IDs include installation and reader IDs, so
stopping one receiver does not delete another receiver's subscription.

On alert tap, the Remote tab refreshes the event and current snapshot. It shows
waiting, resolved, expired, sharing stopped or unconfirmed. An unavailable/deleted
record stays unconfirmed. Alerts already queued by Apple may arrive after their
event resolved; no banner cancellation or exactly-once delivery is promised.

Stop sharing persists disabled consent and a durable stop intent before network
work, cancels old operations, waits for them to settle, then publishes a disabled
snapshot. Delete additionally removes the installation's subscriptions and the
product zone (all its summary/events), then checks absence. Offline/uncertain
outcomes retain the original-account intent across restarts; they are never
reported as confirmed deletion. An independent small revocation marker prevents
an older enabled journal being restored if a larger journal write fails.
Stop receiving clears the local reader immediately and retains any failed
subscription deletion for retry. Account-change notifications revoke consent,
clear local episode mappings/cache and keep disabled installation binding and
cleanup scoped to the original account. Unknown account status withholds cache
without treating it as logout. Pending cleanup must finish under its original
account before enabling another account in this first single-account product.

Readers hide counts after seven days, preserve original source time, and mark
observations historical after three minutes. Attention expires after five minutes;
event records are eligible for deletion after 24 hours. Both active clients run
bounded, indexed event cleanup. CloudKit does not provide field-based TTL. The
single latest snapshot remains until replaced or explicitly deleted, even after
the reader hides its expired content; expiry is not a physical-erasure promise.
Apple backup retention is outside the app's deletion guarantee.

## Notification compatibility

The product Remote receiver subscribes to `AttentionEvent` in the private
`RemoteObservationV1` zone, scoped to the publisher installation ID. The older
CloudKit PoC writes `AttentionProbe` in the default zone. A successful PoC save
cannot validate product notification delivery. Standard macOS and iOS builds
now share the product contract; the PoC iOS configuration keeps its legacy
screen and delegate together to avoid offering an incompatible Remote receiver.

Integration preserves the V1 container, environment-specific journal paths,
installation/receiver IDs, subscription names and integer-millisecond payload
format used by the existing Remote client. It does not reset local pairing,
migrate PoC consent or re-enable explicitly stopped sharing. The Watch PoC
reader and complications remain a separate legacy summary path; forwarded
notifications depend on the iPhone product subscription, not that Watch reader.

The transport regression test publishes through the Mac store and reads through
a separate receiver against one injected database, checking the subscription's
zone, record type, installation predicate and stable receiver ID. This proves
source compatibility, not actual APNs presentation or Watch forwarding. No new
physical-device acceptance is claimed by this integration.

## Production preparation and acceptance

Source preparation is not schema deployment, provisioning, upload or delivery.
No container/schema/profile/account mutations are performed by local verification.

1. Export the existing Development and Production schemas with `xcrun cktool
   export-schema --team-id QF36NDHYHD --container-id
   iCloud.bound.serendipity.agent.deck --environment development --output-file
   <private-working-path>` (repeat with `production`). Preserve all existing
   definitions. Merge the additive fragment into that export; **do not import
   the fragment alone or reset the shared container**. Validate with `xcrun
   cktool validate-schema --team-id QF36NDHYHD --container-id
   iCloud.bound.serendipity.agent.deck --environment development --file
   <merged-schema-path>` before an authorized Development import. Authentication
   uses the developer's normal management-token flow; never put tokens in this
   repository, command-line examples, logs or app UI.
2. Verify encrypted Bytes `payload` on both new types from creation. Verify
   queryable `AttentionEvent.installationID` for subscriptions and
   `AttentionEvent.deleteAfter` for cleanup. Merge/promotion must preserve probe
   and unrelated container schema. Promote schema/indexes in CloudKit Console;
   export Production again and compare the actual result. Development records
   and account subscriptions do not migrate to Production.
3. Attach the existing container to both bundle IDs and renew the distribution
   profiles. `Release` selects CloudKit Production and iOS APNs production;
   Debug selects Development. Inspect actual signed entitlements, not source
   plist text. The existing archive gate now runs
   `python3 apple/scripts/verify-remote-observation.py <app> --environment
   Production`; it fails on missing/wrong container, service, environment,
   macOS Sandbox, iOS APNs environment or development-debug entitlement.
   Unsigned build identity checks explicitly do not attest signing readiness.
4. Run `pnpm verify:quick` and native changed suites for source changes. Before
   delivery run `pnpm verify:full --record`, the Apple release workflow and the
   Release archive guard. Select a version/build under the existing release
   decision process; this implementation does not allocate a delivery version.
5. With the signed TestFlight pair, verify explicit enrollment on the same
   account, one actual wait, its resolution, expiration, and opening each alert
   on cellular without LAN. Verify foreground/locked/force-quit, Focus/denial,
   Mac sleep/quit, Swift/Node handover and non-default local port, both offline
   stop/delete retries after relaunch, account switching, full iCloud storage,
   and cached cold start with/without local identity. Never use real request
   approvals to test this read-only cloud route.
6. Record 20 spaced eligible events: observation, save acknowledgement,
   manually observed iPhone/Watch presentation, tap and fetch; report median/p95,
   missing/duplicate and resolved-before-delivery counts. The experiment target
   remains 19/20 within 30 seconds under normal eligible conditions, not an SLA.
7. Review App Privacy against the actual signed feature: private iCloud counts,
   opaque installation/event IDs and dates for app functionality; no analytics,
   provider credentials or session text. The existing manifest already declares
   Other User Content and Product Interaction for functionality; confirm the
   portal's identifier/linkage answers and privacy-policy wording before submit.
   Updated [reviewer notes](../apple/APP_REVIEW_NOTES.md) and the
   [TestFlight checklist](testflight-qa-checklist.md) describe this scope.

Apple references: [schema management and cktool](https://developer.apple.com/icloud/ck-tool/),
[encrypted fields](https://developer.apple.com/documentation/cloudkit/ckrecord/encryptedvalues),
[zone-scoped query subscriptions](https://developer.apple.com/documentation/cloudkit/ckquerysubscription/zoneid),
[schema language](https://developer.apple.com/documentation/cloudkit/integrating-a-text-based-schema-into-your-workflow).

## Earlier development experiment

**Decision date: 2026-11-01. Status: development-only transport, automatic
publication and durable storage implemented. The user-assisted iPhone/Watch
notification route is verified; final local-control and cold-start physical
acceptance are recorded below. Not released.** This document owns the proposed PoC
contract and acceptance plan. The [feature matrix](appstore-feature-matrix.md)
owns availability; [introduction copy](marketing/apple-remote-observation.md)
must retain the planned label until measured delivery evidence exists.

## Decision and product value

Keep observation and provider credentials on the user's computer. Opt-in macOS
publishing writes a small summary and attention events to the user's CloudKit
private database. The iPhone reads that database and registers a visible query
subscription; Apple forwards eligible iPhone notifications to Apple Watch.

Choose this before an AgentDeck-operated relay: the first audience uses a Mac,
iPhone and paired Watch under one Apple Account. CloudKit removes the need to
operate account registration, device-token storage, an APNs provider key, a
public API and a retry service. Private storage counts against the user's iCloud
quota. This is not unlimited storage, guaranteed delivery, or a promise of zero
development/support cost. Existing Apple signing and distribution requirements
still apply. iCloud storage exhaustion and request throttling are normal errors.

The value hypothesis is **local work needing attention alongside trustworthy
observations of provider allowance**. A Codex percentage alone does not justify
another widget beside the user's existing ChatGPT usage widget. Cross-provider
comparison follows later; no claim about absent competitor features is required.
Neither CloudKit nor a paid relay can refresh local observations while the Mac
app is stopped. A provider credential hosted in the cloud is a different product
and is outside this decision.

Alternatives deferred: an operated relay until non-Apple publishers/readers or
cross-account sharing justify it; VPN/direct daemon exposure because it does
not solve background notification delivery; third-party notification services
because they require another user service and do not establish the native reader.

## Scope

| Included in the first PoC | Deferred |
|---|---|
| One Mac app, one iPhone, its paired Watch, same iCloud account | Multi-Mac aggregation, team sharing, Node-only cloud publishing |
| Explicit sharing consent and a debug test event | Automatic enrollment or remote control/approval |
| Real response-wait transitions and aggregate working/waiting counts | Completion/failure inference and task-success claims |
| One available Codex account quota reading with original provenance/time | New provider logins, server-side quota polling, usage forecasting |
| Read-only iPhone summary and cached historical view | iPhone widget extension, direct-to-Watch push (a development Watch reader was added 2026-11-14; see [Watch reader](#watch-reader-development)) |
| Account changes, disable/delete, finite retries, stale-data UI | Notification service extension and custom key recovery |

Codex quota is optional evidence: absent, untrusted or timestamp-less readings
produce unavailable UI, not a new fetch implementation or synthetic numbers.
After transport acceptance, an iPhone widget can reuse the reader; only after
that should a Watch target/complication be considered. iPhone delivery forwarding
does not establish Watch independence when the phone is powered off.

## Existing integration points

The current [AgentStateHolder](../apple/AgentDeck/State/AgentStateHolder.swift)
receives both the embedded Swift daemon and the external Node daemon's frames.
Its guarded `sessionsList` branch already constructs `AttentionSessionSnapshot`
and calls [AttentionNotifier](../apple/AgentDeck/App/AttentionNotifier.swift).
Publish from this app layer, not from `DaemonServer`, and do not require Node.
Restrict PoC publishing to the app's preferred local daemon; selecting a different
LAN host stops publishing instead of silently uploading another machine's data.

| Component / file | Planned change |
|---|---|
| `apple/project.yml` | Declare one shared CloudKit container for macOS/iOS; platform-specific entitlements and development/production profiles; preserve bundle ID and deployment targets |
| `apple/AgentDeck/Resources/AgentDeck.entitlements` | Generated macOS CloudKit entitlement additions from project.yml; retain Sandbox |
| New iOS entitlement file | CloudKit and APNs capability using provisioning-selected environment; do not copy macOS Sandbox keys |
| `AgentDeckApp.swift` | App-lifetime publisher/reader wiring, iOS UIApplication delegate, account-change handling; no Dashboard-window lifetime dependency |
| `AgentStateHolder.swift` | Pass validated roster and normalized quota observations; invalidate on disconnect/endpoint switch; no cloud await in frame processing |
| `AttentionNotifier.swift` | Extract a pure wait-transition evaluator where behavior can be shared; preserve existing local notification behavior |
| New `RemoteObservation/` Swift files | Codable projection, freshness rules, publisher actor, CloudKit store, reader/cache, read-only view |
| `NotificationPermission.swift` + iOS delegate | Reuse authorization decision logic; iOS-specific Settings routing, register for remote notifications, visible notification/tap handling |
| Settings + iOS navigation | Explicit sharing/receiving controls, bounded refresh, delete state, remote screen reachable without LAN discovery |
| `AgentDeckTests` | Inject clock/store/connection state; exercise transitions, retries, account changes and stale projections |

CloudKit operations belong to an independent actor with immutable Sendable input.
UI updates are MainActor-owned; daemon state remains DaemonActor-owned. Do not
expand the unchecked-sendable state holder into a cloud transport. Reader state
must not populate the live `DashboardState` or enable steering controls.

The macOS publisher is app-owned: a daemon handover invalidates the roster and
quota until new evidence arrives, but does not mint another cloud identity. A
persisted random installation UUID identifies this Mac app; never use hostname,
serial number, LAN address or daemon pairing token as its public identifier.

## Setup and trust

1. Register/select a single team-owned CloudKit container. Proposed identifier:
   `iCloud.bound.serendipity.agent.deck`; verify availability and existing team
   configuration before creation. CloudKit container creation is durable.
2. Attach the container to both existing app targets. Keep the bundle identifier
   `bound.serendipity.agent.deck`. Regenerate affected signing profiles.
3. Start with Development. Prepare record types/indexes and subscriptions there;
   promote the schema and indexes before a Production/TestFlight test. A schema
   deployment is not a migration of development records or user subscriptions.
4. Mac Settings explains exactly which fields leave the machine and requires
   explicit enablement. iPhone separately enables receiving and requests visible
   notification permission. Check `accountStatus` and surface actionable errors.
5. Create the iPhone's deterministic subscription ID idempotently for the current
   account. Register for remote notifications; CloudKit manages its APNs routing.
   Do not operate an APNs token database or embed a provider signing key.

The private database's Apple Account authorization is the MVP trust boundary;
there is no separate AgentDeck account or remote LAN token. On account switch,
cancel requests, invalidate asynchronous completions with a generation guard,
clear the previous account's reader cache and outbox, and require new publishing
consent. Do not upload old-account queued data to a newly signed-in account.
An account-change notification retains a disabled local writer binding (opaque
installation ID, account hash and revisions), while clearing queued episodes and
session mappings. Only explicit enablement after verifying that same account can
reuse the binding; a different verified account gets a new installation ID.

## Data contract v1

Use a custom private record zone `RemoteObservationV1`. Define the following
record types in Development before production schema promotion. All date fields
below are CK Date values; the portable Codable projection uses UTC epoch-ms
integers. Counters/revisions are integers. Unknown is explicit null/unavailable,
never zero. The consumer rejects unsupported schema versions without replacing
its last readable historical record. Enforce a 16 KiB encoded snapshot bound.

| Record | Identity and clear routing fields | Protected content |
|---|---|---|
| `ObservationSnapshot` | deterministic installation ID; `schemaVersion`, `installationID`, `revision`, `publishedAt`, `expiresAt` | encoded summary in a new `encryptedValues` field |
| `AttentionEvent` | random persistent event UUID; `schemaVersion`, `installationID`, `occurredAt`, `expiresAt`, `resolvedAt` | minimal kind (`test` or `needsResponse`) and optional opaque local reference in encrypted content |

Summary fields: `rosterObservedAt`, nullable `workingCount` and `waitingCount`,
`sourceState` (observed/unavailable/disabled), and optional quota with provider,
account-generation reference, plan, limit family, original `capturedAt`, reported
window lengths, used percentage and reset time. Keep only the allow-listed
Codex account family; model-specific pools do not become account quota. Never
copy the full WS frame. An unavailable/retired quota is an explicit replacement,
not an omitted field that leaves an old number live. Provider observation time
must survive upload and download unchanged.

Index only clear fields needed for the event query and cleanup (installation,
occurrence/expiry as applicable). Do not query/index encrypted fields. Creation
of every AttentionEvent for the selected installation matches one
`CKQuerySubscription` with `.firesOnRecordCreation`. It uses a constant visible
alert ("AgentDeck has an update to review") and default sound. Resolution updates
do not match creation and do not produce a second alert. Fetch events on open;
push is a change hint, not the authoritative event log.

Private DB is not a blanket end-to-end-encryption claim. Use CloudKit encrypted
fields from schema creation; explain that protection/key availability depends on
Apple's documented account protection settings. The first PoC contains no task
text. Mandatory Apple-unreadable content under every supported account setting
would require a separate client-key design and is not claimed here.

Never upload project names, prompts, answers, commands, paths, transcript text,
provider credentials, LAN tokens or raw session IDs. A random local reference
is scoped to this installation and cannot authorize a command. Logs contain
phase/error/duration and a test correlation ID, not records, tokens or payloads.

## Publication and event state machine

The numeric defaults in this section are the proposed PoC policy. Implement them
once in a shared Apple policy type with an injected clock, consumed by publisher
and reader. Existing provider validity rules override generic display thresholds.
Before any non-Apple consumer is added, move portable policy to the repository's
generated shared SSOT path rather than copying constants.

- On opt-in, take a fresh roster baseline. Existing waits appear in the summary
  without generating a historical alert; subsequent observed wait episodes alert.
- Observe the existing local awaiting predicate (alive, awaiting, nonempty question)
  but transmit neither question nor its hash. Generate an event UUID on the first
  transition; persist the local episode-to-event association before submitting.
  A repeated frame or changed question during the same wait is not a new episode.
- Keep at most one outstanding save pipeline per installation. Use record change
  tags / compare-and-save, persist increasing revision, and reject stale in-flight
  completions after endpoint/account/generation change. Resolve an ambiguous save
  by fetching that event ID before retrying its creation.
- Publish an initial summary, then coalesce changes to one save per 60 seconds.
  Important wait transitions and quota invalidations bypass coalescing. While
  enabled and running, a 60-second publication tick can prove publisher contact,
  but must not advance roster/quota observation time without new source evidence.
- Network operation deadline: 15 seconds with cancellation and completion guard.
  Retry transient errors with jittered exponential backoff, starting at 5 seconds,
  capped at 5 minutes; honor a longer CloudKit retry-after. Authentication/quota
  errors become visible recoverable states rather than busy retry loops.
- Keep one latest pending summary and at most 32 attention episodes, persisted
  locally and scoped to account+installation. Overflow sets a diagnostic count;
  the fresh summary remains authoritative. Never create a catch-up alert flood.
- On reconnection, validate the current roster first, publish the current summary,
  then submit only still-waiting events younger than 5 minutes. Resolved, unknown
  or older unsent episodes do not generate alerts. An accepted earlier event is
  updated as resolved when matching evidence exists. Absence after a disconnect
  alone is not proof of resolution.

An event `expiresAt` is a reader/publisher rule, **not APNs expiration control**.
CloudKit may already have enqueued a visible alert when the event resolves or is
deleted. Do not promise banner cancellation, one alert per observed event, or
silent-push execution after force quit. On tap, fetch the record and current
summary; show resolved/expired/unavailable honestly, with historical time.

## Offline presentation and retention

Track source observation time, server record modification time and phone fetch
time separately. A successful fetch does not refresh the original observation.
Use server modification time only as contact evidence, never as quota evidence.
Treat implausible future source timestamps as unknown freshness, not fresh forever.

| Evidence | Reader presentation |
|---|---|
| Recent valid roster | Counts with original observation time |
| Roster older than 3 minutes | Last observed counts, prominently historical; no assertion that the Mac is asleep |
| Publisher contact recent, roster old/unavailable | Publisher connected; source status unconfirmed |
| Quota aged/ended/retired | Existing provider-specific presentation rules; no synthetic zero/full allowance |
| Reset time passes without a reading | Reset was expected; confirmation needed |
| Missing observation timestamp | Freshness unknown |
| Phone fetch fails | Cached historical view + bounded error/retry; never an endless spinner |
| Explicit sharing disable received | Sharing stopped; historical data labeled accordingly |

Use the existing [usage rules](../.claude/rules/usage-quota.md) for account family,
plan mismatch, age and window retirement. Do not add percentages across machines,
providers or unlike windows. The UI does not predict task capacity from quota.

Snapshot reader expiry: 7 days after publication; event retention: 24 hours;
unsent attention eligibility: 5 minutes. These are different clocks. CloudKit
records do not acquire automatic TTL from an expiry field. Both active clients
run bounded cleanup on activation and periodically while running. After expiry,
readers immediately hide expired content even if physical deletion has not run.
Physical removal is opportunistic when a client next has access, not guaranteed
at the deadline. The phone purges its cache on the same expiry/account rules.

On the Mac, "Stop sharing" stops scheduling publication, cancels in-flight saves
and attempts a disabled summary. Mac-only "Delete remote data" also removes this
installation's records and the receiving subscription, and clears its outbox.
Cancellation cannot undo a committed cloud write: after outstanding operations
settle or time out, reconcile server state and repeat deletion before claiming
completion. If offline, retain only the account-scoped deletion intent and show
pending deletion. On iPhone, "Stop receiving" deletes the subscription and clears
the local cache; it does not claim to stop the Mac publisher. A reader that finds
its snapshot deleted clears the corresponding cache. Already delivered
notifications cannot be remotely guaranteed erased. Apple backup retention is
outside the app's deletion guarantee; do not promise instant forensic erasure.

## Implementation sequence and acceptance gates

Stage A Development delivery and Stage B manual real-roster/wait delivery are
verified. Stage C automatic publication and durable cache/outbox are implemented
and undergoing integrated device acceptance. Provider quota and stages D–E
remain deferred. See the dated checkpoints below for evidence and limits.

| Stage | Work | Exit criterion |
|---|---|---|
| A — transport spike | Existing targets, CloudKit setup, debug test event, iOS permission/subscription/delegate, tiny record viewer | Mac writes; iPhone on cellular reads; eligible visible alert reaches iPhone/Watch without LAN |
| B — local source | Guarded state-holder projection, wait episode persistence, optional trustworthy Codex quota, app-lifetime publisher | One event per observed episode, menu-bar-only operation, Swift-owner and Node-client cases, disconnect invalidation |
| C — resilience/privacy | Account and generation guards, cleanup, cache, disable/delete, finite retry, historical display | Matrix below passes with no stale-as-live display or cross-account replay |
| D — product evaluation | 20 spaced normal events plus disruption trials; compare usefulness with existing usage widget | Useful local attention context, measured delays/duplicates/stale alerts, explicit go/no-go |
| E — later widget | One iPhone WidgetKit extension using same reader and time policy; App Group only if needed | Normal OS budgets, no developer-mode refresh assumptions; Watch extension is a separate follow-up |

Before implementation: create an isolated worktree; keep the feature matrix marked
planned; inspect current signing configuration; read matching Swift, release,
usage and design rules. Run the repository Apple build workflow rather than
inventing Xcode commands. Proposed file/type names above are the work breakdown,
not files already created. No new verification gate is introduced by this design;
if implementation adds one, update the verification catalog in the same change.

Unit/integration tests use fake time/store, not the user's CloudKit account:
wait enter/repeat/resolve/reenter; ambiguous-save retry; conflict/order; partial
failure; deadline; queue cap; endpoint switch; shutdown; account change during
save; missing/future timestamps; quota retirement; expiry; disable/delete offline.
Tests must drive real state transitions, not merely reproduce constants.

For code changes run `pnpm verify:quick` and `pnpm verify:changed` for Apple suites.
For deployment run `pnpm verify:full --record`, the applicable Apple deployment
workflow and device preflight. Release additionally needs the Release archive
gate and accurate reviewer/privacy descriptions. Production/TestFlight must be
verified separately from Development, including schema indexes, entitlement
environment and subscription creation for each account.

### Device acceptance matrix

Use one Mac, an iPhone with Wi-Fi disabled/cellular enabled, and its paired Watch.
Record app build/commit, OS versions, CloudKit environment, account alias (no email),
network, Focus/notification settings, phone/watch lock/wear state and wall clocks.
Do not alter the shared daemon or sign out a user's primary Apple Account just
to test a case; use the supported deployment workflow and a dedicated test account
or fixture for disruptive cases.

| Case | Required observation |
|---|---|
| iPhone unlocked/active | Delivery follows Apple's device selection; no requirement for both screens to alert |
| iPhone locked, Watch worn/unlocked | Watch displays the forwarded alert when settings permit |
| Watch locked/unworn | iPhone fallback behavior recorded |
| iPhone background / force quit | Visible alert behavior measured independently of background handler execution |
| Focus, notification denial, summary scheduling | Suppression/delay distinguished from CloudKit save failure |
| Phone offline, event subsequently resolved, phone reconnects | Delayed banner behavior measured; tap shows resolved/expired status; no claim of guaranteed recall |
| Mac internet lost, wait enters and resolves before reconnect | No new catch-up alert for the resolved wait; fresh summary restored |
| Mac sleeps/crashes, app menu-bar-only, daemon hands over | Historical display, app-lifetime publication, no fabricated empty roster or duplicated wait |
| Original quota ages or reset time passes while offline | No fresh stamp, zero/full fabrication, or unsupported provider fallback |
| iCloud signed out/full/throttled, app account switches | Finite error state, previous cache cleared, queued content never crosses accounts |
| Sharing disabled / delete while offline | No new writes; pending deletion is honest and completes on authorized reconnect |
| Production signed build | Same route verified with production schema/subscription/profile, separately from Development |

For 20 normal, spaced events record local observation, CloudKit save completion,
visible notification time/location, tap and reader fetch completion; summarize
median/p95, missing/duplicate and resolved-before-delivery counts. Initial
evaluation target: at least 19/20 display within 30 seconds in normal eligible
conditions. This is a small-sample PoC threshold, not a reliability claim or SLA.
APNs/CloudKit can coalesce notifications. Watch display is manually observed;
no invented end-to-end delivery receipt. Content-free correlation IDs suffice.

Hard acceptance: no credentials/text leakage, no cross-account replay, no
unbounded retries, no old quota rendered as current, and no source disappearance
reported as task success. If late alerts create unacceptable interruption or
the normal-condition target fails, record no-go for the current CloudKit alert
experience before adding widgets; investigate configuration and platform limits
before considering a separately operated relay. Repeating local quota percentages
without useful local work context is also a product no-go.

## Publication and operational boundary

The current shipped app remains a LAN companion with macOS local notifications.
This document selects a PoC architecture, not a shipping date, paid plan or uptime
promise. Do not add Watch App Store badges or claim widgets/remote approvals.
Before release, update Apple review notes (currently describing local-only
notifications), privacy disclosures, settings help and release materials with
the measured scope. Do not rewrite those current-build claims as if cloud code
already exists. No App Groups are needed for the first PoC; no version bump,
container creation, signing mutation, runtime restart or upload occurs here.

## Primary references

Checked for the design on 2026-11-01; SDK/provisioning details must be verified
again during the transport spike.

- [Private CloudKit database and storage ownership](https://developer.apple.com/documentation/cloudkit/ckcontainer/privateclouddatabase)
- [Query subscriptions and coalesced notifications](https://developer.apple.com/documentation/cloudkit/ckquerysubscription)
- [Subscription notification configuration](https://developer.apple.com/documentation/cloudkit/cksubscription/notificationinfo-swift.property)
- [Encrypted fields and query restrictions](https://developer.apple.com/documentation/cloudkit/ckrecord/encryptedvalues)
- [CloudKit subscription troubleshooting](https://developer.apple.com/library/archive/qa/qa1917/_index.html) — archived diagnostic guidance, not a current simulator capability matrix
- [Watch notification forwarding](https://developer.apple.com/documentation/watchos-apps/taking-advantage-of-notification-forwarding)
- [WidgetKit push updates](https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications)

## Stage A transport implementation and current evidence

Use `AgentDeck_CloudKitPoC_macOS` and `AgentDeck_CloudKitPoC_iOS` with
`CloudKitPoCDebug`. Standard Debug/Release do not define
`AGENTDECK_CLOUDKIT_POC`; the experimental screen is compiled out. The Mac probe keeps daemon startup inert automatically. It opens only the
synthetic transport screen. `AGENTDECK_CLOUDKIT_TEST_SEND=1` is a development-only
launch option to submit one test when that screen appears, not an App Store setup
instruction.

This spike uses temporary record types `ObservationProbe` (fixed latest pointer)
and `AttentionProbe` (UUID creation events) in the default private zone. They are
separate from contract-v1 real-data records. No session data or quota is sent.
Latest is saved before the alert event; a partial failure can therefore leave a
readable latest test without an alert. The UI distinguishes cloud-save success
from notification delivery. Fetching preserves original occurrence/expiry times;
a 5-minute expiry changes the display to historical, not the server's APNs queue.
There is no automatic retry or persistent outbox in this manual spike.

On the iPhone, enable test notifications first; then send a test from the Mac.
Use Fetch latest test to distinguish database access from notification display.
The permission and subscription steps are explicit. Account changes clear the
in-memory view; no persisted cache is introduced yet. Test records are synthetic
and have no automatic CloudKit TTL: remove them in the development container
when the experiment ends. Full cleanup controls belong to Stage C before real
observation data is enabled.

Recorded on 2026-11-01:

- Initial iPhone signing failed because the cached profile lacked iCloud/Push.
  Automatic provisioning retry produced development entitlements for the selected
  container, and installation on the connected iPhone 14 Pro Max succeeded.
- Swift 6 rejected main-actor notification delegate witnesses with non-Sendable
  parameters. Marking the notification methods nonisolated fixed that diagnostic.
- Signed macOS build returned success. Device install succeeded, but launching
  the iPhone was denied because it was locked. User unlock/notification consent
  and actual CloudKit subscription, database save and Watch display remain pending.
- Initial quick checks encountered missing worktree JS dependencies; dependencies
  were repaired and verification was rerun. Full test outcomes must be read from
  the current verification receipts, not inferred from successful installation.

Do not advance the roadmap's Stage A checkbox or enable real session publishing
until a successful record save/read and eligible Watch forwarding are observed.

Latest live observation: Mac test submission timed out with
`NSURLErrorDomain/-1001`. The busy state ended and a retry was available; a second
attempt was made. iPhone permission was approved by the user, but CloudKit
subscription success and Watch receipt have not yet been confirmed. Do not infer
cloud readiness from permission approval. The earlier Mac entitlement override
was corrected after inspecting the signed binary; its actual CloudKit/Push
entitlements now match the PoC configuration. Timeout and duplicate-completion
regression tests passed (2/2) in a standalone Swift 6 XCTest harness after making
CloudKit container construction lazy, avoiding account access in pure timing tests.

Mac retry result: the real PoC screen subsequently displayed "Saved to CloudKit;
notification delivery is not confirmed" with the original test time. This proves
the latest-record and event-save pipeline completed, not iPhone/Watch delivery.

Stage A user-assisted acceptance: on 2026-11-01 the user confirmed iPhone visible
notification and Fetch latest test, then locked the phone/wore and unlocked the
Watch and confirmed the next test alert on Watch. This verifies a single real
route; 20-event latency sampling, disruption trials and Production remain pending.
macOS and iOS changed-area native suites passed. Quick checks passed after
repairing dependencies except the design ratchet's system Bash incompatibility;
the ratchet passed separately with Homebrew Bash (89 tracked violations, baseline
89). Keychain-dependent daemon E2E was skipped by the standard macOS policy.

## Stage B manual real-summary checkpoint

The Mac experiment can explicitly connect to `ws://127.0.0.1:9120` without starting
or taking over the daemon. It accepts only fresh, endpoint-matching full rosters,
projects working/waiting counts and original receipt time, and displays a local
preview. A separate button shares exactly that summary once. No automatic upload is enabled; real wait alerts require an explicit manual
share action. Stop local observation terminates the source;
Delete shared summary removes the probe record with a visible failure state if
cloud deletion is not confirmed.

The temporary `RosterProbe/stage-b-latest` record stores JSON summary bytes in
CloudKit `encryptedValues`. It is still an isolated default-zone probe, not the
contract-v1 production schema. It contains no raw session IDs, questions or paths.
The iPhone fetches/decrypts it, keeps the original timestamp and derives historical
state locally after 3 minutes. Expired summaries omit the count values. The
in-memory reader survives a failed fetch; persistent cold-start cache and
account-scoped cleanup remain Stage C work. No quota window is fabricated when
its provenance/validity contract has not yet been connected.

Observed real data on 2026-11-01: the Mac preview showed 2 working and 0 waiting;
manual encrypted save succeeded; the user confirmed the same real summary and
original time on iPhone. The event reducer separately passed baseline, repeated
frame, resolution/reentry, unknown-gap and identifier-exclusion tests. Five PoC
regression tests passed in both standalone Swift 6 and the dedicated macOS Xcode
scheme. The full quick tier passed with Homebrew Bash; standard macOS/iOS native
changed suites also passed. These do not prove unattended publication, durable
outbox, provider quota, Production, widgets or independent Watch operation.

Remaining implementation order: account-scoped durable event/outbox integration
and explicit sharing controls; actual wait episode publication/resolution;
provenance-preserving optional quota; persistent reader/expiry/deletion recovery;
disruption/20-event measurements; only then widgets. Keep Stage B unchecked until
its actual wait notification and optional-source acceptance are recorded.

The manual real-summary checkpoint also gained eligible wait publication: a
32-item in-memory queue retains opaque episode IDs and original times, removes
resolved episodes and prunes entries older than 5 minutes. Each manual share
saves the summary first, revalidates a fresh local roster, then saves pending
events under stable IDs using the proven generic AttentionProbe subscription.
Repeated saves update the same event instead of generating another creation.
The initial roster is a baseline and generates no historical wait alert. Account
change stops the local source and clears this in-memory queue. This is not the
durable unattended publisher: restart persistence, automatic scheduling and
full account-scoped outbox recovery still require Stage C integration. The subsequent user-assisted real-wait check is recorded below.

User-assisted offline check: the user confirmed the iPhone retained the real
summary and original time in airplane mode and changed freshness to historical
after the source-age threshold. This checks the in-memory reader, not cold-start
offline restoration.

Real-wait follow-up: the user created a real local wait; the Mac read 2 working /
1 waiting. An explicit current-wait manual action published its episode and the
user confirmed a new phone/Watch notification, even though the Mac timed out.
This is evidence of an ambiguous acknowledgement, not a failed server write.
The save path now accepts a successful per-record server acknowledgement and
the UI labels timeouts as unknown rather than failed. Stable episode IDs are
retained for retries in this process. Restarts still discard the in-memory queue;
no durable exactly-once or automatic delivery claim is made.

### Local response interface follow-up

The real wait exposed a separate local-control gap: the OpenCode v5 observer
forwarded only the question title, so the daemon had neither choices nor a native
reply channel. The v6 source now forwards bounded structured questions and sends
validated single-choice answers through OpenCode’s existing SDK transport. This
is independent of CloudKit; no remote approval path or decision payload is added.
Stream Deck observed-option paging also now advances the actual option offset.

An isolated OpenCode 1.18.35 instance with a local model fixture exercised a real
question tool: two original labels/descriptions reached the observer/reducer; a
stale question echo was refused; selecting the original label reached the real
native reply endpoint, emitted `question.replied`, and finished the turn with an
empty upstream pending-question list. A second isolated actual OpenCode run
also exercised a harmless Bash permission wait through the existing native
`permission_respond` → one-time (`once`) approval path and completed the turn.
The fixture used a separate loopback
receiver and temporary OpenCode configuration/data; it did not answer or restart
the user’s existing session. This proves native transport and reducer/queue
integration, not an installed Stream Deck hardware acceptance.

Single-question/single-choice prompts are supported. Multi-question, multi-select
and custom text stay display-only. Sending disables further choices until
upstream resolution; an uncertain reply allows an explicitly labelled retry. A
readable pending-question list retires stale waits; failed reads retain them.
Shared vectors pin the TypeScript/Swift shape and numeric limits. Compatible
observer code must be loaded by a subsequent OpenCode start before the installed
user session can gain this channel; its already-loaded observer is left intact.

### Account-change and receiving cleanup checkpoint

The probe now cancels in-flight record writes on an iCloud account change and
checks the account generation before submitting each record and after its
acknowledgement. Callers retain the account lease across a multi-record share,
so an old queued summary cannot adopt a new account’s authorization. A dedicated XCTest drives the real two-record publication
sequence with a delayed first acknowledgement: switching accounts cancels that
operation and prevents the following alert record from being submitted. All nine
CloudKit/projection regression tests pass in the dedicated native PoC scheme.
This guards an active process; durable account-scoped outbox/cache remains open.

The iPhone probe also has an explicit disable action: stop this device’s remote
notification registration, clear its in-memory reader, then attempt to delete
the deterministic experiment subscription. Failed deletion remains visible and
retryable. This subscription is shared by the experiment in the current iCloud
account, so the UI states that deletion scope. This action has not been invoked
on the user’s phone during unattended development.

### Unattended development review state

Source is isolated on `codex/cloudkit-observation-design`. Existing user OpenCode
sessions, the installed Stream Deck plugin and the primary checkout are not
restarted or switched during this follow-up. The new device-choice path is
verified against an isolated actual OpenCode process, not the already-running
v5 observer. Review/integration should therefore distinguish the tested source
from the installed runtime.

Local quick verification passed (7,093 tests, with platform skips); macOS XCTest
passed 1,396 tests with three skips; standard macOS Release and iOS checks also
passed. The standard daemon E2E remains skipped by the macOS Keychain policy.
The isolated native OpenCode test uses a local model fixture and its own
loopback receiver, so it establishes the native observer/queue/reply path without
claiming the full production daemon or hardware path.

Remaining acceptance: install the integrated observer/daemon/plugin together,
start a fresh OpenCode session, and exercise actual Stream Deck and native-device
choices. Multi-question/multi-select/custom text remain terminal-only. The new
iPhone disable action and physical account-switch handling need device checks.
At that checkpoint, unattended scheduling, durable outbox/cache, quota,
disruption measurements and widgets were follow-ups. The next implementation
checkpoint supersedes scheduling and persistence status; quota and widgets
remain deferred.

Quota export has a concrete source-contract prerequisite: the current native
`CodexRateLimits` wire model carries capture time, plan and limit ID, but no
account-generation reference or explicit account-live/passive provenance. As the
[quota rules](../.claude/rules/usage-quota.md) record, a passive rollout can label
a model pool as the account limit. The remote reader therefore does not promote
that block into a trustworthy subscription widget. Add producer-owned provenance
and retirement evidence before exporting it; preserve unavailable rather than
publishing plausible percentages.

### Automatic publication and durable storage implementation

The development-only Mac probe now has explicit automatic sharing. It retains
a random installation ID, increasing snapshot revision, local episode mapping,
one bounded 32-event outbox and retry state in an atomic account-scoped file.
CloudKit’s verified user-record identity scopes saved consent; a changed account
requires enablement again. No account identity or local session ID is uploaded.
A restored roster starts a new baseline while retaining still-waiting pending
episode IDs. Unknown/disconnected sources never drain the outbox. Events older
than five minutes or resolved before sending are dropped.

The app-owned publisher survives closing its view; a PoC menu-bar view retains
access to Stop sharing. Its activity assertion prevents App Nap while enabled
but allows normal system sleep. It coalesces normal snapshots
to 60 seconds and sends eligible new waits sooner. Transient errors use bounded
5-second-to-5-minute jittered backoff and honor longer CloudKit retry-after.
Authentication, quota and competing installation ownership pause automatic
sharing. Before retrying an uncertain attention write it fetches that same ID.
Snapshot compare-and-save preserves CloudKit change tags and rejects stale
revisions or another installation; an existing single-Mac probe can be adopted.
The temporary probe record names remain in use; this does not claim the final
custom-zone Production schema or 24-hour event cleanup.

The phone persists only summary counts, original time and account-scope metadata,
with atomic writes, owner-only permissions, backup exclusion and iOS file
protection. Cold-start offline restoration requires a matching locally available
iCloud identity token; when that token is unavailable, the file remains private
and unread until CloudKit verifies the account online. Account mismatch, expiry,
confirmed cloud deletion and explicit receiving disable clear the cache. No fetch
advances source time. A separate local dashboard entry in the PoC uses the
existing LAN connection and controls; cloud data cannot enable answers.

The dedicated PoC gate now runs in changed/full verification and Apple CI;
standard Store configurations keep this code excluded. Hosted tests cannot
restore saved sharing consent or contact the service. Record reads, as well as
mutations, cancel on their deadline/account invalidation.

Regression coverage adds real disk reload, expired/future/corrupt/oversized
cache rejection, unknown-vs-mismatched identity handling, stable outbox IDs,
reconnect baseline behavior, coalescing and retry-after. Physical acceptance
results are recorded separately from these source-level checks.


### Integration and storage acceptance checkpoint

The source was integrated into the persistent main checkout and the supervised
Node daemon, installed Stream Deck runtime and separate Mac/iPhone PoC were
updated. Development PoC installation preserves the App Store Mac app and the
phone's existing data. Installed-runtime hashes, rather than a build alone,
distinguish the plugin actually running.

A fresh actual OpenCode TUI with the emitted observer reached the real daemon.
The iOS simulator selected `Phone acceptance` through the normal local dashboard;
OpenCode returned that exact original label and moved to its real harmless Bash
permission wait. This proved the question UI/daemon/native reply path. Physical
phone acceptance first encountered an old pairing token; only that test phone's
normal per-device approval was renewed. A later device lock prevented completing
modified-build UI acceptance and must not be counted as a pass.

The real permission wait exposed another gap: its request ID was present but
choices and `liveAnswerable` were absent. Both daemons now expose canonical
one-time choices; native clients address the permission ID, while Stream Deck's
session option route checks the echoed question before mapping its index to a
decision. Missing native polling, invalid indices, stale question echoes and
superseded permission IDs cannot authorize a tool. The shared choices generate
the Swift mirror. No persistent `always` grant or CloudKit command is added.

Physical reader evidence showed a successful cloud fetch followed by a durable
write failure, then no summary on relaunch. iOS had incorrectly inherited the
macOS-only legacy home-root path. The central path resolver now selects
`Library/Application Support/AgentDeck` inside the iOS data container. The PoC's
local storage check exercises atomic write/read with the real protection and
backup-exclusion settings without contacting CloudKit or changing the reader.
That check passed in a dedicated iOS simulator. Storage errors now expose only
their Foundation domain/code. Physical filesystem and account-bound relaunch
must be repeated after unlocking the phone; simulator success does not attest
iPhone Data Protection behavior.

When a locally available iCloud token cannot restore a saved reader immediately,
startup now verifies the CloudKit account online and loads the original cached
summary without fetching a newer snapshot. With no verified identity offline,
it preserves the file and withholds its contents. A local dashboard remains
usable while the independent cloud check is pending.

On the Mac, automatic sharing saved actual encrypted counts, resumed after
process relaunch, and preserved explicit Stop across another relaunch. Transient
cloud outcomes also exercised the retained-ID/backoff status. These observations
prove server save and publisher lifecycle, not notification presentation.
A Stream Deck host restart recovered a deployment whose URI stop request had
not stopped the old process; the replacement runtime hash was verified. Automated
Virtual Stream Deck clicks did not establish SDK key-input acceptance, so a
physical key press remains a separate lab result.

The reproducible [OpenCode/device lab runner](../apple/DeviceAcceptance/README.md)
records screenshots, accessibility trees, returned question labels and tool
results. A local model fixture drives an actual new TUI; it never fabricates a
hook or answers another running session. Quota provenance, widgets, the final
Production schema and 24-hour cloud event cleanup remain deferred.


Final local UI follow-up: the installed Node daemon and emitted observer completed
an actual OpenCode question and harmless one-time Bash permission through the
iOS simulator UI. OpenCode returned the original `Phone acceptance` label and
`agentdeck_device_acceptance_probe` output; the UI test passed in 32.4 seconds.
A failed ordinary tap and successful label-area diagnostic led to explicit full
button-label hit shapes in both attention views. The final test uses ordinary
taps, waits for enabled/hittable controls, and has no label-coordinate fallback.
It starts only after the real question and response channel are present; model
request emission alone was an insufficient readiness signal. The PoC Close
control now has a separate header so it cannot cover the question context.
This result completes the simulated UI/native transport acceptance while keeping
physical iPhone/cache and Stream Deck key acceptance explicitly pending.


Account-status retention guard: `couldNotDetermine`, temporary unavailability
and restrictions do not prove logout. Those responses refuse cloud access while
preserving the account-scoped disk reader; only confirmed `noAccount` or an
identity change clears it. A native model test writes a real reader file,
exercises all three unverified statuses, and then confirms that `noAccount`
removes it. Account-change notifications continue to revoke saved sharing
consent. Publisher pause messages distinguish ownership, quota and authorization
so a retry does not hide the actual cause.

### Final integrated acceptance

The clean integrated `9c59666b` source passed the complete default
`verify:full --record` run: 26 automatic gates passed, two platform/policy gates
were skipped and three lab gates remained unattested. TypeScript coverage passed
with 7,101 tests; macOS XCTest passed 1,402 tests (three skips), DotPreview passed
1,422 (eight skips), and the CloudKit suite passed 17. Store, iOS, preview and PoC
builds, firmware checks and clean npm package acceptance passed. The committed
[receipt](../verification/receipts/2026-11-01-9c59666.json) describes that exact
source; it does not attest physical controls or notification presentation.

The final integration was also installed on the phone and separate Mac PoC.
A new actual OpenCode session again completed the original `Phone acceptance`
choice and harmless one-time Bash approval through ordinary simulator UI taps;
the returned tool results and the local storage round-trip both passed. The
completed fixture's process and daemon row were removed. Review artifacts remain
local in `diagnostics/cloudkit-integration-acceptance/`. Physical phone UI/cache
acceptance remains blocked by its passcode lock, and physical Stream Deck key
input remains unattested.

Longer-running acceptance observed an iCloud account-change notification; this
does not independently prove that the person switched accounts. Consent was
correctly revoked, but deleting all writer metadata made a later same-account
enablement conflict with its own CloudKit snapshot. The follow-up retains only
the disabled account-scoped writer binding, clears old events/session mappings
and still requires verified identity plus explicit consent. It also revokes a
saved enabled flag when the notification precedes startup restoration.

The `4b0c9ca7` follow-up passed quick verification and the changed PoC gates
(18 native tests), then a clean scoped full-tier rerun of coverage, both PoC
configurations and documentation. Its [six-gate receipt](../verification/receipts/2026-11-01-4b0c9ca.json)
complements the preceding complete run; it does not relabel six checks as a new
26-gate run. This follow-up changes only the development Mac PoC and its lab
fixture. The signed Mac PoC was rebuilt, verified and installed again.

### Physical control and reader acceptance — 2026-11-01

The previously pending physical checks passed on the installed development
candidates. SBiPhone (iPhone 14 Pro Max) passed three XCUITest cases: the real
local cache file round-trip, CloudKit summary restoration after terminate/launch,
and a new actual OpenCode question followed by one-time Bash approval. The
reader retained `2 working · 0 waiting` and the original `11:13 PM` source time
after relaunch, with an explicit local-cache restoration status.

On the physical Stream Deck+, the user pressed the test session key, then
`Deck acceptance`, then `Allow once`. The host preview showed the actual choice
and approval layouts; OpenCode returned the exact original label followed by
`agentdeck_device_acceptance_probe`. A separate phone session returned
`Phone acceptance` and the same harmless command output through ordinary app
taps. The installed plugin identity was `7b0f554baeac`.

Both bounded test processes and their daemon rows were removed. No new product
failure was found; auto-lock delayed runner startup and required unlocking just
before execution. Evidence is local in
`diagnostics/cloudkit-integration-acceptance/physical/`. These results supersede
the earlier physical-control/cache pending state. This is development acceptance;
Production delivery, offline cold-start variations, physical account switching,
and long-duration disruption measurements remain separate checks.

### Watch reader (development)

Added 2026-11-14. At the PM's request a read-only Watch reader was built ahead of the iPhone
widget instead of after it. It is a separate watchOS target, not a change to
the gate order for anything that ships: it is not embedded in the iOS app and
belongs to no App Store archive.

- Targets: `AgentDeck_watchOS` (`bound.serendipity.agent.deck.watchkitapp`,
  watchOS 10+, runs independently of the iPhone app) with the embedded
  WidgetKit extension `AgentDeckWatchWidgets` (circular, rectangular, inline
  and corner complications). Scheme `AgentDeck_CloudKitPoC_watchOS`. Both
  targets always compile the PoC sources (`AGENTDECK_CLOUDKIT_POC`) and carry
  only the Development CloudKit entitlement for the same container; no push
  entitlement, no App Group.
- Source: the Watch reads the `RosterProbe/stage-b-latest` summary from the
  private database over its own network path, using the same
  `CloudKitProbeStore` (moved unchanged into `CloudKitObservationStore.swift`),
  `RemoteReaderCache` and freshness policy as the iPhone. Alerts still arrive
  by Apple's iPhone forwarding; the Watch registers no subscription, so there
  is no second alert per event.
- Presentation: `RemoteGlance` is the one rule for both the app and the
  complications — a wait outranks work, "All clear" needs an observed empty
  roster, historical evidence is muted with its original time, and expired,
  missing or future-dated evidence shows no count. Complication timelines add
  entries at the historical and expiry boundaries so the face ages without a
  fetch; a failed fetch shows "—", never a guessed count.
- Account rules match the iPhone reader: cache restore requires the same iCloud
  identity, an account change or missing account clears it, and a deleted
  summary clears it. The Watch never connects to a daemon and cannot answer.

Verified: watchOS simulator build of the app and embedded extension;
`RemoteGlanceTests` plus the existing PoC suites (21 tests) in the iOS PoC
scheme; simulator screens for no iCloud account, 2 waiting/3 working,
historical 4 working and all clear (DEBUG `-AgentDeckWatchFixture
waiting,working,ageSeconds`). **Not verified:** signed install on a physical
Watch (Automatic signing must first register the two new bundle IDs with the
container), a real CloudKit fetch on the Watch, complication rendering on a
face, and the complication refresh budget.

PR review also covers missed account-change notifications: the verified owner
is checked against the cache before every fetch, even when a restored summary
is already visible. A changed owner clears the old counts even if the next
fetch fails; same-account offline reads preserve the source observation time.
Cache-write failures remain visible, and account changes reset refresh throttling.
These cases and the shared glance rules run in the macOS CloudKit PoC gate.
The changed/full verification tiers and Apple CI also build the Watch app and
check that its complication executable is embedded. These automated checks do
not replace physical Watch account switching, offline cold starts, face rendering,
background refresh measurements, or forwarded-alert acceptance.

Review verification (2026-11-14): all 27 selected macOS PoC XCTest cases
passed, including the four Watch model regressions. The updated app and embedded
complication built for watchOS Simulator. An isolated Series 11 46 mm simulator
on watchOS 27 rendered waiting/working, historical, expired-without-counts and
observed-empty states. This is simulator evidence, not physical Watch acceptance.
